import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { signalProcessTree } from "../shared/process-tree.mjs";
import {
  buildTaskboardAutomationName,
  buildTaskboardAutomationPrompt,
  buildTaskboardTaskRunPrompt,
  taskboardAutomationPolicyOperation,
} from "../shared/taskboard-automation.mjs";
import {
  modelProfileEnvironment,
  modelProfileSettingsArg,
  spawnClaudeTurn,
} from "./ai-chat-process.mjs";
import { ApiError } from "./database.mjs";
import { getQuotaStatus } from "./quota.mjs";

// Replaces the Codex app-server automation cron: each enabled project gets a
// local timer that spawns one headless `claude -p` controller turn per tick.
// The controller claims and completes at most one todo per tick through
// taskctl, attributed via CLAUDE_THREAD_ID. When a finished round leaves todos
// waiting, the next tick follows after a short delay instead of a full idle
// interval, so queued todos are picked up without the configured wait.
//
// Scheduler state is persisted to <dataDirectory>/automation-configs.json so
// enabled automations survive server restarts: entries are re-armed by
// resume() when the server starts listening.

// Follow-up delay after a successful round that left todos waiting.
const FOLLOW_UP_TICK_MS = 60_000;
export class LocalAutomationScheduler {
  constructor(options) {
    this.database = options.database;
    this.claudeExecutable = options.claudeExecutable;
    this.skillPath = options.skillPath;
    this.processEnv = options.processEnv ?? process.env;
    this.killGraceMs = options.killGraceMs ?? 1_000;
    this.boardBaseUrl = options.boardBaseUrl ?? null;
    this.persistPath = options.persistPath ?? null;
    this.entries = new Map();
    // Board-triggered executions of individual issues; keyed by issueId so
    // multiple issues can run concurrently, independent of the tick loop.
    this.taskRuns = new Map();
    // Session ids of controller turns this process spawned and can still see
    // alive. Process liveness is the most precise "running" signal for the
    // board's own sessions — no transcript heuristics or hooks needed.
    this.liveThreads = new Set();
    this.closed = false;
    this.#loadPersisted();
  }

  setBoardBaseUrl(baseUrl) {
    this.boardBaseUrl = typeof baseUrl === "string" && baseUrl.trim() ? baseUrl.trim() : null;
  }

  // Whether a controller turn spawned by this scheduler is still running for
  // the given Claude session id.
  isThreadLive(threadId) {
    return this.liveThreads.has(threadId);
  }

  #loadPersisted() {
    if (!this.persistPath) return;
    let persisted = null;
    try {
      persisted = JSON.parse(readFileSync(this.persistPath, "utf8"));
    } catch {
      return;
    }
    if (!Array.isArray(persisted)) return;
    for (const record of persisted) {
      if (!record || typeof record !== "object") continue;
      if (!record.id || !record.request) continue;
      const request = {
        ...record.request,
        skillPath: this.skillPath ?? record.request.skillPath,
      };
      this.entries.set(record.id, {
        id: record.id,
        name: buildTaskboardAutomationName(request),
        request,
        timer: null,
        nextRunAt: null,
        running: null,
        lastError: null,
      });
    }
  }

  #persist() {
    if (!this.persistPath) return;
    try {
      const payload = [...this.entries.values()].map((entry) => ({
        id: entry.id,
        request: entry.request,
      }));
      mkdirSync(path.dirname(this.persistPath), { recursive: true });
      writeFileSync(this.persistPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    } catch {}
  }

  // Re-arm persisted enabled automations after the server starts listening.
  resume() {
    let offset = 0;
    for (const entry of this.entries.values()) {
      if (entry.request.enabledByUser && !entry.timer && !this.closed) {
        this.#scheduleTick(entry, 1_000 + offset);
        offset += 2_500;
      }
    }
  }

  #sanitizeItem(entry) {
    return {
      id: entry.id,
      // A controller turn in flight keeps the automation active even though
      // its timer is only re-armed once the turn finishes.
      status: entry.timer || entry.running ? "ACTIVE" : "PAUSED",
      model: entry.request.model,
      modelProfileId: entry.request.modelProfileId ?? null,
      reasoningEffort: entry.request.reasoningEffort,
      rrule: `RRULE:FREQ=MINUTELY;INTERVAL=${entry.request.intervalMinutes}`,
      nextRunAt: entry.timer ? entry.nextRunAt : null,
    };
  }

  #policy(entry) {
    const request = entry.request;
    return {
      automationId: entry.id,
      codexProjectId: request.codexProjectId,
      codexProjectKind: request.codexProjectKind,
      codexHostId: request.codexHostId,
      workspacePath: request.workspacePath,
      enabledByUser: request.enabledByUser,
      quotaAware: request.quotaAware,
      intervalMinutes: request.intervalMinutes,
      model: request.model,
      modelProfileId: request.modelProfileId ?? null,
      reasoningEffort: request.reasoningEffort,
    };
  }

  #hasTodo(request) {
    const tasks = this.database.listTasks({
      projectId: request.taskboardProjectId,
      status: "todo",
      archived: "false",
    });
    return tasks.length > 0;
  }

  #findEntry(request) {
    const name = buildTaskboardAutomationName(request);
    const matching = [...this.entries.values()].filter((entry) => (
      entry.name === name
      && (!request.automationId || entry.id === request.automationId)
    ));
    return matching[0] ?? null;
  }

  #ensureEntry(request) {
    const existing = this.#findEntry(request) ?? this.#findEntry({ ...request, automationId: undefined });
    if (existing) {
      existing.request = {
        ...request,
        skillPath: this.skillPath ?? request.skillPath,
      };
      this.#persist();
      return existing;
    }
    const entry = {
      id: randomUUID(),
      name: buildTaskboardAutomationName(request),
      request: {
        ...request,
        skillPath: this.skillPath ?? request.skillPath,
      },
      timer: null,
      nextRunAt: null,
      running: null,
      lastError: null,
    };
    this.entries.set(entry.id, entry);
    return entry;
  }

  #stopTimer(entry) {
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
      entry.nextRunAt = null;
    }
  }

  #scheduleTick(entry, delayMs) {
    this.#stopTimer(entry);
    if (this.closed) return;
    entry.nextRunAt = Date.now() + delayMs;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void this.#tick(entry);
    }, delayMs);
    entry.timer.unref();
  }

  async #tick(entry) {
    if (this.closed || entry.running) {
      if (!this.closed) this.#scheduleTick(entry, entry.request.intervalMinutes * 60_000);
      return;
    }
    const request = entry.request;
    if (!request.enabledByUser) return;
    const fullIntervalMs = request.intervalMinutes * 60_000;
    let followUp = false;
    let exitCode = null;
    let failure = "";
    let turnSessionId = null;
    try {
      if (!this.#hasTodo(request)) {
        entry.lastError = null;
        // Stay armed: ticks are cheap when there is nothing to claim, and the
        // next todo is picked up automatically on a later tick.
        if (!this.closed) this.#scheduleTick(entry, fullIntervalMs);
        return;
      }

      const sessionId = randomUUID();
      turnSessionId = sessionId;
      this.liveThreads.add(sessionId);
      entry.running = new Promise((resolve) => {
        const { child, completion } = this.#spawnControllerTurn(
          request,
          sessionId,
          buildTaskboardAutomationPrompt(request),
        );
        entry.child = child;
        completion.then(
          (result) => {
            exitCode = result.exitCode;
            resolve();
          },
          (error) => {
            failure = error instanceof Error ? error.message : String(error);
            resolve();
          },
        );
      });
      await entry.running;
      entry.lastError = failure
        || (exitCode === 0 ? null : `Claude Code 退出码 ${exitCode ?? "unknown"}`);
      followUp = !entry.lastError && this.#hasTodo(request);
    } catch (error) {
      entry.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      entry.running = null;
      entry.child = null;
      if (turnSessionId) this.liveThreads.delete(turnSessionId);
    }
    // An unexpected failure must not leave the automation disarmed with its
    // switch still on, so every completed tick re-arms the next one.
    if (!this.closed) {
      this.#scheduleTick(entry, followUp ? FOLLOW_UP_TICK_MS : fullIntervalMs);
    }
  }

  #spawnControllerTurn(request, sessionId, prompt) {
    const modelProfile = this.database.resolveModelProfile(request.modelProfileId ?? null);
    const args = [
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      "Bash",
      "WebSearch",
      "WebFetch",
      "--session-id",
      sessionId,
    ];
    const profileSettings = modelProfileSettingsArg(modelProfile);
    if (profileSettings) args.push("--settings", profileSettings);
    args.push("-");
    return spawnClaudeTurn({
      executable: this.claudeExecutable,
      args,
      prompt,
      env: { ...this.processEnv, CLAUDE_THREAD_ID: sessionId },
      cwd: request.workspacePath,
      extraEnv: {
        ...modelProfileEnvironment(modelProfile),
        ...(this.boardBaseUrl ? { CLAUDE_TASKBOARD_URL: this.boardBaseUrl } : {}),
      },
      onRawEvent: () => {},
    });
  }

  // Board-triggered execution of one specific issue: bind it to a fresh
  // session so the card tracks it like an auto-claimed todo, then spawn a
  // controller turn for just that issue. Runs concurrently with the tick loop
  // and with executions of other issues.
  async #runTask(request, context) {
    const task = this.database.getTask(request.issueId);
    if (!task || task.projectId !== request.taskboardProjectId) {
      throw new ApiError(404, "TASK_NOT_FOUND", `No issue '${request.issueId}' exists in this project`);
    }
    if (task.archivedAt !== null) {
      throw new ApiError(409, "TASK_ARCHIVED", "Archived tasks cannot be executed");
    }
    if (task.status !== "in_progress") {
      throw new ApiError(409, "TASK_NOT_IN_PROGRESS", "Move the issue to in_progress before executing it");
    }
    if (this.taskRuns.has(request.issueId)) {
      return { item: this.#sanitizeTaskRun(request.issueId) };
    }

    const sessionId = randomUUID();
    const updated = this.database.moveTask(
      task.id,
      task.version,
      "in_progress",
      undefined,
      sessionId,
      {
        threadId: sessionId,
        codexProjectId: request.codexProjectId,
        codexProjectKind: "local",
        codexHostId: "local",
        workspacePath: request.workspacePath,
      },
      context.actor ?? { type: "user", id: "local-user", name: "本地用户", avatarUrl: null },
    );
    const run = {
      issueId: request.issueId,
      taskId: task.id,
      threadId: sessionId,
      startedAt: new Date().toISOString(),
      child: null,
      running: null,
      lastError: null,
    };
    this.taskRuns.set(request.issueId, run);
    this.liveThreads.add(sessionId);
    run.running = new Promise((resolve) => {
      const { child, completion } = this.#spawnControllerTurn(
        request,
        sessionId,
        buildTaskboardTaskRunPrompt(request),
      );
      run.child = child;
      completion.then(
        () => resolve(),
        (error) => {
          run.lastError = error instanceof Error ? error.message : String(error);
          resolve();
        },
      );
    });
    void run.running.then(() => {
      this.liveThreads.delete(sessionId);
      if (this.taskRuns.get(request.issueId) === run) this.taskRuns.delete(request.issueId);
    });
    return { item: this.#sanitizeTaskRun(request.issueId), task: updated };
  }

  #sanitizeTaskRun(issueId) {
    const run = this.taskRuns.get(issueId);
    return {
      issueId,
      status: run ? "running" : "idle",
      threadId: run?.threadId ?? null,
      startedAt: run?.startedAt ?? null,
    };
  }

  #terminateTask(request) {
    const run = this.taskRuns.get(request.issueId);
    if (!run) return { item: this.#sanitizeTaskRun(request.issueId) };
    if (run.child) signalProcessTree(run.child, "SIGTERM");
    return {
      item: {
        issueId: request.issueId,
        status: "terminating",
        threadId: run.threadId,
        startedAt: run.startedAt,
      },
    };
  }

  async handleRequest(request, context = {}) {
    if (this.closed) {
      throw new ApiError(409, "AUTOMATION_CLOSED", "The automation scheduler is shutting down");
    }

    if (request.operation === "list") {
      const items = [...this.entries.values()]
        .filter((entry) => entry.name === buildTaskboardAutomationName(request))
        .map((entry) => this.#sanitizeItem(entry));
      return { items };
    }

    const previous = this.#findEntry(request);
    if (request.operation === "pause") {
      if (!previous) return { error: "not-found" };
      this.#stopTimer(previous);
      previous.request = {
        ...previous.request,
        ...request,
        skillPath: this.skillPath ?? previous.request.skillPath,
      };
      this.#persist();
      return { item: this.#sanitizeItem(previous), policy: this.#policy(previous) };
    }

    if (request.operation === "ensure-active") {
      const entry = this.#ensureEntry(request);
      this.#scheduleTick(entry, 250);
      this.#persist();
      return { item: this.#sanitizeItem(entry), policy: this.#policy(entry) };
    }

    if (request.operation === "apply-policy") {
      const entry = this.#ensureEntry(request);
      const hasTodo = this.#hasTodo(request);
      const quota = request.quotaAware ? await getQuotaStatus(this.processEnv) : null;
      const operation = taskboardAutomationPolicyOperation(request, {
        explicit: true,
        hasTodo,
        previousQuotaState: quota?.state ?? "available",
        quotaState: quota?.state ?? "available",
        currentStatus: entry.timer ? "ACTIVE" : "PAUSED",
      });
      if (operation === "pause" && request.enabledByUser && !hasTodo) {
        // Keep the timer armed: a tick with no todos costs nothing, and the
        // next todo is claimed automatically when it appears.
        this.#scheduleTick(entry, 250);
      } else if (operation === "pause") {
        this.#stopTimer(entry);
      } else if (operation === "ensure-active") {
        this.#scheduleTick(entry, 250);
      }
      this.#persist();
      return {
        item: this.#sanitizeItem(entry),
        policy: this.#policy(entry),
        ...(quota ? { quota } : {}),
        ...(hasTodo ? {} : { pausedReason: "no-todo" }),
      };
    }

    if (request.operation === "run-task") {
      return await this.#runTask(request, context);
    }

    if (request.operation === "terminate-task") {
      return this.#terminateTask(request);
    }

    throw new ApiError(400, "INVALID_AUTOMATION_OPERATION", `Unsupported operation '${request.operation}'`);
  }

  async close() {
    this.closed = true;
    for (const entry of this.entries.values()) {
      this.#stopTimer(entry);
      if (entry.child) signalProcessTree(entry.child, "SIGTERM");
    }
    for (const run of this.taskRuns.values()) {
      if (run.child) signalProcessTree(run.child, "SIGTERM");
    }
    const running = [
      ...[...this.entries.values()].map((entry) => entry.running),
      ...[...this.taskRuns.values()].map((run) => run.running),
    ].filter(Boolean);
    await Promise.allSettled(running);
    for (const entry of this.entries.values()) {
      if (entry.child) signalProcessTree(entry.child, "SIGKILL");
    }
    for (const run of this.taskRuns.values()) {
      if (run.child) signalProcessTree(run.child, "SIGKILL");
    }
    this.entries.clear();
    this.taskRuns.clear();
    this.liveThreads.clear();
  }
}
