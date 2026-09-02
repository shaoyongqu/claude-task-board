import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { signalProcessTree } from "../shared/process-tree.mjs";
import {
  buildTaskboardAutomationName,
  buildTaskboardAutomationPrompt,
  buildTaskboardScheduledRunPrompt,
  buildTaskboardTaskRunPrompt,
  taskboardAutomationPolicyOperation,
} from "../shared/taskboard-automation.mjs";
import { dueDateDeadline, nextScheduleOccurrence } from "../shared/schedule.mjs";
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

// Issue schedules are scanned on a short cadence so cron granularity (one
// minute) fires within seconds of the configured time, and occurrences that
// came due while the server was stopped are picked up immediately on restart.
const SCHEDULE_SCAN_INTERVAL_MS = 30_000;
const SCHEDULE_SCAN_START_DELAY_MS = 5_000;
// Upper bound on scheduled executions running at once; excess occurrences
// wait in a FIFO queue. Manual run-task executions and the per-project tick
// loop (which claims at most one todo per tick) are not counted against it.
const MAX_CONCURRENT_SCHEDULED_RUNS = 3;
// Scheduled issues live in exactly three statuses: todo, in_progress, and
// in_review. Any other status (done, canceled, blocked, backlog) pauses the
// schedule without consuming occurrences; reactivating the issue re-arms the
// next occurrence from that moment.
const SCHEDULED_FIRE_STATUSES = new Set(["todo", "in_progress", "in_review"]);
const SCHEDULER_ACTOR = {
  type: "agent",
  id: "taskboard-scheduler",
  name: "Taskboard 定时执行",
  avatarUrl: null,
};
export class LocalAutomationScheduler {
  constructor(options) {
    this.database = options.database;
    this.claudeExecutable = options.claudeExecutable;
    this.skillPath = options.skillPath;
    this.processEnv = options.processEnv ?? process.env;
    this.killGraceMs = options.killGraceMs ?? 1_000;
    this.boardBaseUrl = options.boardBaseUrl ?? null;
    this.persistPath = options.persistPath ?? null;
    // Broadcasts task changes caused by scheduled fires (move + schedule
    // advance) so board clients refresh outside any HTTP request.
    this.onTaskChanged = options.onTaskChanged ?? null;
    this.entries = new Map();
    // Board-triggered executions of individual issues; keyed by issueId so
    // multiple issues can run concurrently, independent of the tick loop.
    this.taskRuns = new Map();
    // FIFO of due scheduled occurrences waiting for a free run slot.
    this.scheduleQueue = [];
    this.queuedScheduleTaskIds = new Set();
    this.scheduleScanTimer = null;
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
    // Rounds left running by a previous server process have no controller
    // behind them anymore; close them out before new ones start.
    const interrupted = this.database.interruptRunningScheduleRuns();
    if (interrupted > 0) {
      console.warn(`[taskboard] ${interrupted} 个执行轮次因服务重启标记为已中断`);
    }
    let offset = 0;
    for (const entry of this.entries.values()) {
      if (entry.request.enabledByUser && !entry.timer && !this.closed) {
        this.#scheduleTick(entry, 1_000 + offset);
        offset += 2_500;
      }
    }
    this.#armScheduleScan(SCHEDULE_SCAN_START_DELAY_MS);
  }

  #armScheduleScan(delayMs = SCHEDULE_SCAN_INTERVAL_MS) {
    if (this.scheduleScanTimer) clearTimeout(this.scheduleScanTimer);
    this.scheduleScanTimer = null;
    if (this.closed) return;
    this.scheduleScanTimer = setTimeout(() => {
      this.scheduleScanTimer = null;
      void this.#scanSchedules().finally(() => this.#armScheduleScan());
    }, delayMs);
    this.scheduleScanTimer.unref();
  }

  // Periodic scan for due issue schedules. next_at lives in the database, so
  // occurrences that expired while the server was down are seen by the first
  // scan after restart and fire immediately (catch-up).
  async #scanSchedules() {
    const due = this.database.listDueScheduledTasks(new Date().toISOString());
    for (const task of due) {
      if (this.taskRuns.has(task.identifier) || this.queuedScheduleTaskIds.has(task.id)) continue;
      if (this.#scheduledFireHoldReason(task)) continue;
      const blockReason = this.#scheduledFireBlockReason(task);
      if (blockReason) {
        this.#skipScheduledOccurrence(task, blockReason);
        continue;
      }
      this.scheduleQueue.push(task.id);
      this.queuedScheduleTaskIds.add(task.id);
    }
    this.#drainScheduleQueue();
  }

  // Why a due occurrence is on hold: it must not fire AND must not be
  // consumed — paused statuses keep their schedule, and an occurrence past
  // the issue's due date waits for the date to be extended.
  #scheduledFireHoldReason(task) {
    if (!SCHEDULED_FIRE_STATUSES.has(task.status)) return `paused (${task.status})`;
    if (
      task.schedule.type !== "once"
      && task.dueDate
      && task.scheduleNextAt
      && new Date(task.scheduleNextAt).getTime() > dueDateDeadline(task.dueDate)
    ) {
      return "next occurrence is past the due date";
    }
    return null;
  }

  // Why a due occurrence must not start right now but should still advance to
  // its next occurrence: a live execution of the issue (manual run,
  // auto-claimed controller, or an in-flight conversation run) means this
  // occurrence is skipped — the issue is already being worked.
  #scheduledFireBlockReason(task) {
    if (task.threadId && this.isThreadLive(task.threadId)) return "already executing";
    if (this.database.hasRunningAiChatRunForIssue(task.id)) return "already executing";
    const project = this.database.getProject(task.projectId);
    if (!project?.workspacePath) return "project has no workspace";
    return null;
  }

  // Consume the occurrence without running it: advance (or exhaust) the
  // schedule so the next scan does not immediately re-consider it.
  #skipScheduledOccurrence(task, reason) {
    if (reason !== "already executing") {
      console.warn(`[taskboard] 定时执行跳过 ${task.identifier}（${reason}）`);
    }
    const next = nextScheduleOccurrence(task.schedule, Date.now());
    const updated = this.database.recordTaskScheduleRun(
      task.id,
      next === null ? null : new Date(next).toISOString(),
      next === null,
    );
    if (updated) this.onTaskChanged?.(updated);
  }

  #scheduledRunCount() {
    let count = 0;
    for (const run of this.taskRuns.values()) {
      if (run.origin === "schedule") count += 1;
    }
    return count;
  }

  #drainScheduleQueue() {
    while (this.scheduleQueue.length > 0 && this.#scheduledRunCount() < MAX_CONCURRENT_SCHEDULED_RUNS) {
      const taskId = this.scheduleQueue.shift();
      this.queuedScheduleTaskIds.delete(taskId);
      const task = this.database.getTask(taskId);
      if (!task || task.scheduleNextAt === null || task.scheduleNextAt > new Date().toISOString()) continue;
      if (this.#scheduledFireHoldReason(task)) continue;
      const blockReason = this.#scheduledFireBlockReason(task);
      if (blockReason) {
        this.#skipScheduledOccurrence(task, blockReason);
        continue;
      }
      this.#startScheduledRun(task).catch((error) => {
        console.warn(`[taskboard] 定时执行启动失败 ${task.identifier}:`, error);
      });
    }
  }

  // Fire one scheduled occurrence: bind the issue to a fresh session (the
  // same move a board-triggered run performs), advance the schedule, then
  // spawn a controller turn for just that issue with the issue's own model.
  async #startScheduledRun(task) {
    const project = this.database.getProject(task.projectId);
    const workspacePath = project?.workspacePath ?? null;
    if (!workspacePath) {
      this.#skipScheduledOccurrence(task, "project has no workspace");
      return;
    }
    const automationEntry = [...this.entries.values()].find((entry) => (
      entry.request.taskboardProjectId === task.projectId
    )) ?? null;

    const sessionId = randomUUID();
    let binding = task;
    let updated = null;
    for (let attempt = 0; attempt < 2 && updated === null; attempt += 1) {
      try {
        updated = this.database.moveTask(
          binding.id,
          binding.version,
          "in_progress",
          undefined,
          sessionId,
          {
            threadId: sessionId,
            codexProjectId: workspacePath,
            codexProjectKind: "local",
            codexHostId: "local",
            workspacePath,
          },
          SCHEDULER_ACTOR,
        );
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== "VERSION_CONFLICT") {
          console.warn(`[taskboard] 定时执行绑定失败 ${task.identifier}:`, error);
          this.#skipScheduledOccurrence(binding, "binding failed");
          return;
        }
        const fresh = this.database.getTask(task.id);
        if (!fresh) return;
        binding = fresh;
      }
    }
    if (!updated) {
      // Two version conflicts in a row: the issue is being edited concurrently;
      // give up this occurrence instead of fighting for the binding.
      this.#skipScheduledOccurrence(binding, "binding conflict");
      return;
    }

    const next = nextScheduleOccurrence(binding.schedule, Date.now());
    const refreshed = this.database.recordTaskScheduleRun(
      binding.id,
      next === null ? null : new Date(next).toISOString(),
      next === null,
    );
    this.onTaskChanged?.(refreshed ?? updated);

    const request = {
      issueId: binding.identifier,
      taskboardProjectId: binding.projectId,
      codexProjectId: workspacePath,
      codexProjectKind: "local",
      codexHostId: "local",
      projectName: project.name,
      workspacePath,
      remoteProjects: [],
      skillPath: this.skillPath ?? undefined,
      enabledByUser: false,
      quotaAware: false,
      intervalMinutes: automationEntry?.request.intervalMinutes ?? 5,
      model: automationEntry?.request.model ?? "default",
      modelProfileId: automationEntry?.request.modelProfileId ?? null,
      reasoningEffort: automationEntry?.request.reasoningEffort ?? "medium",
    };
    const issueModelProfile = this.database.resolveModelProfile(binding.modelProfileId ?? null);
    const issueReasoningEffort = binding.reasoningEffort ?? request.reasoningEffort;
    // The round record: one independent execution with its own session,
    // status, and lifetime — separate from every other round of this issue.
    const scheduleRun = this.database.createScheduleRun(binding.id, {
      threadId: sessionId,
      trigger: "schedule",
    });
    const run = {
      issueId: binding.identifier,
      taskId: binding.id,
      threadId: sessionId,
      origin: "schedule",
      scheduleRunId: scheduleRun.id,
      startedAt: new Date().toISOString(),
      child: null,
      running: null,
      lastError: null,
    };
    this.taskRuns.set(binding.identifier, run);
    this.liveThreads.add(sessionId);
    run.running = new Promise((resolve) => {
      const { child, completion } = this.#spawnControllerTurn(
        request,
        sessionId,
        buildTaskboardScheduledRunPrompt(request, scheduleRun.sequence),
        { modelProfile: issueModelProfile, reasoningEffort: issueReasoningEffort },
      );
      run.child = child;
      completion.then(
        (result) => {
          this.database.finishScheduleRun(scheduleRun.id, {
            status: result.exitCode === 0 ? "completed" : "failed",
            error: result.exitCode === 0 ? null : `Claude Code 退出码 ${result.exitCode ?? "unknown"}`,
          });
          resolve();
        },
        (error) => {
          run.lastError = error instanceof Error ? error.message : String(error);
          this.database.finishScheduleRun(scheduleRun.id, { status: "failed", error: run.lastError });
          resolve();
        },
      );
    });
    void run.running.then(() => {
      this.liveThreads.delete(sessionId);
      if (this.taskRuns.get(binding.identifier) === run) this.taskRuns.delete(binding.identifier);
      const refreshed = this.database.getTask(binding.id);
      if (refreshed) this.onTaskChanged?.(refreshed);
      this.#drainScheduleQueue();
    });
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
    // Scheduled issues are invisible to auto-claim: they fire on their own
    // timetable, so claiming them would run them ahead of their time.
    return tasks.some((task) => task.schedule === null);
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

  #spawnControllerTurn(request, sessionId, prompt, overrides = {}) {
    const modelProfile = overrides.modelProfile !== undefined
      ? overrides.modelProfile
      : this.database.resolveModelProfile(request.modelProfileId ?? null);
    const reasoningEffort = overrides.reasoningEffort !== undefined
      ? overrides.reasoningEffort
      : request.reasoningEffort;
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
    if (reasoningEffort) args.push("--effort", reasoningEffort);
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
    // A board-triggered execution of one specific issue runs with that
    // issue's own model selection and effort (falling back to the automation
    // policy's effort), not the policy's profile: the issue's choice is the
    // designated model for this run and stays pinned for its whole lifetime.
    const issueModelProfile = this.database.resolveModelProfile(task.modelProfileId ?? null);
    const issueReasoningEffort = task.reasoningEffort ?? request.reasoningEffort;
    // Manual executions join the same round history as scheduled ones so the
    // issue's execution timeline stays complete.
    const scheduleRun = this.database.createScheduleRun(task.id, {
      threadId: sessionId,
      trigger: "manual",
    });
    const run = {
      issueId: request.issueId,
      taskId: task.id,
      threadId: sessionId,
      origin: "manual",
      scheduleRunId: scheduleRun.id,
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
        { modelProfile: issueModelProfile, reasoningEffort: issueReasoningEffort },
      );
      run.child = child;
      completion.then(
        (result) => {
          this.database.finishScheduleRun(scheduleRun.id, {
            status: result.exitCode === 0 ? "completed" : "failed",
            error: result.exitCode === 0 ? null : `Claude Code 退出码 ${result.exitCode ?? "unknown"}`,
          });
          resolve();
        },
        (error) => {
          run.lastError = error instanceof Error ? error.message : String(error);
          this.database.finishScheduleRun(scheduleRun.id, { status: "failed", error: run.lastError });
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
    if (this.scheduleScanTimer) {
      clearTimeout(this.scheduleScanTimer);
      this.scheduleScanTimer = null;
    }
    this.scheduleQueue.length = 0;
    this.queuedScheduleTaskIds.clear();
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
