import { signalProcessTree } from "../shared/process-tree.mjs";
import { normalizeClaudeEvent, spawnClaudeTurn } from "./ai-chat-process.mjs";
import { ApiError } from "./database.mjs";

const DAY_MS = 24 * 60 * 60 * 1_000;
const CHECK_INTERVAL_MS = 60 * 60 * 1_000;
const STATUS_LABELS = {
  backlog: "积压事项",
  todo: "待办",
  in_progress: "处理中",
  in_review: "等你确认",
  blocked: "遇到阻碍",
  done: "完成",
  canceled: "取消",
};

function isDue(summary) {
  if (!summary.attemptedAt) return true;
  return Date.now() - new Date(summary.attemptedAt).getTime() >= DAY_MS;
}

function buildPrompt(project, tasks) {
  const counts = Object.fromEntries(Object.keys(STATUS_LABELS).map((status) => [
    STATUS_LABELS[status],
    tasks.filter((task) => task.status === status).length,
  ]));
  const recentCutoff = Date.now() - 7 * DAY_MS;
  const issues = tasks.filter((task) => (
    (task.status !== "done" && task.status !== "canceled")
    || new Date(task.activityUpdatedAt).getTime() >= recentCutoff
  )).map((task) => ({
    id: task.identifier,
    title: task.title,
    status: STATUS_LABELS[task.status],
    priority: task.priority,
    labels: task.labels,
    dueDate: task.dueDate,
    updatedAt: task.activityUpdatedAt,
  }));
  return [
    "你是 Claude Code。请根据下面的任务面板快照，为项目负责人写一段项目总结。",
    "要求：只输出一段 60 至 120 字的简体中文；直接说明当前进展、主要风险或阻碍、下一步重点；不要使用标题、列表或 Markdown；不要调用工具。",
    JSON.stringify({
      project: project.name,
      generatedForDate: new Date().toISOString().slice(0, 10),
      counts,
      issues,
    }),
  ].join("\n\n");
}

export class ProjectSummaryService {
  constructor(options) {
    this.database = options.database;
    this.claudeExecutable = options.claudeExecutable;
    this.workspacePath = options.workspacePath;
    this.processEnv = options.processEnv ?? process.env;
    this.active = new Map();
    this.closed = false;
    this.timer = setInterval(() => void this.refreshDueProjects(), CHECK_INTERVAL_MS);
    this.timer.unref();
    void this.refreshDueProjects();
  }

  get(projectId) {
    if (!this.database.getProject(projectId)) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' was not found`);
    }
    const summary = this.database.getProjectSummary(projectId);
    if (isDue(summary)) void this.refresh(projectId);
    return {
      projectId,
      summary: summary.summary,
      updatedAt: summary.generatedAt,
      refreshing: this.active.has(projectId),
      error: summary.error,
    };
  }

  refresh(projectId) {
    const current = this.active.get(projectId);
    if (current) return current.promise;
    const active = { child: null, promise: null };
    active.promise = this.#generate(projectId, active)
      .finally(() => this.active.delete(projectId));
    this.active.set(projectId, active);
    return active.promise;
  }

  async refreshDueProjects() {
    for (const summary of this.database.listProjectSummaries()) {
      if (isDue(summary)) await this.refresh(summary.projectId);
    }
  }

  async #generate(projectId, active) {
    try {
      const project = this.database.getProject(projectId);
      if (!project) return;
      const tasks = this.database.listTasks({ projectId, archived: "false" });
      let generatedSummary = "";
      let terminalError = "";
      const pendingTools = new Map();
      const { child, completion } = spawnClaudeTurn({
        executable: this.claudeExecutable,
        args: [
          "--print",
          "--output-format",
          "stream-json",
          "--verbose",
          "--permission-mode",
          "plan",
          "-",
        ],
        prompt: buildPrompt(project, tasks),
        env: this.processEnv,
        cwd: this.workspacePath,
        onRawEvent: (raw) => {
          for (const normalized of normalizeClaudeEvent(raw, pendingTools)) {
            if (
              normalized.kind === "event"
              && normalized.type === "agent_message"
              && normalized.content
            ) {
              generatedSummary = normalized.content.replace(/\s+/g, " ").trim();
            }
            if (normalized.kind === "event" && normalized.type === "turn.failed") {
              terminalError = normalized.content || "Claude Code 生成失败";
            }
          }
        },
      });
      active.child = child;
      const result = await completion;
      if (result.exitCode !== 0 || terminalError) {
        throw new Error(terminalError || `Claude Code 退出码 ${result.exitCode}`);
      }
      if (!generatedSummary) throw new Error("Claude Code 没有返回项目总结");
      this.database.saveProjectSummary(projectId, generatedSummary);
    } catch (error) {
      if (!this.closed) {
        this.database.saveProjectSummaryError(
          projectId,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  async close() {
    this.closed = true;
    clearInterval(this.timer);
    const active = [...this.active.values()];
    for (const entry of active) signalProcessTree(entry.child, "SIGTERM");
    await Promise.allSettled(active.map((entry) => entry.promise));
  }
}
