import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { signalProcessTree } from "../shared/process-tree.mjs";
import { ApiError } from "./database.mjs";
import {
  ComposerCatalog,
  discoverAiCatalog,
  loadSlashCommands,
  resolveAiWorkspace,
} from "./ai-chat-catalog.mjs";
import {
  buildClaudeArgs,
  buildClaudePrompt,
  modelProfileEnvironment,
  modelProfileSettingsArg,
  normalizeClaudeEvent,
  spawnClaudeTurn,
} from "./ai-chat-process.mjs";

const SANDBOXES = new Set(["read-only", "workspace-write", "danger-full-access"]);
const ERROR_CONTENT_LIMIT = 65_536;
const AGENT_DISPATCH_PROTOCOL = "taskboard.agent.v1";

function cappedError(value) {
  const message = value instanceof Error ? value.message : String(value ?? "");
  return message.slice(0, ERROR_CONTENT_LIMIT);
}

function agentDispatchText(agent) {
  return [
    `Taskboard private agent dispatch (${AGENT_DISPATCH_PROTOCOL}):`,
    `Dispatch this request to the Claude Code subagent ${JSON.stringify(agent.name)}.`,
    agent.developerInstructions
      ? `Subagent instructions (follow them for this request):\n${agent.developerInstructions}`
      : "",
    "This is Taskboard product-private routing context, not user-visible text.",
  ].filter(Boolean).join("\n");
}

function signalProcessGroup(child, signal) {
  signalProcessTree(child, signal);
}

function wait(milliseconds) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}

export class AiChatService {
  constructor(options) {
    this.database = options.database;
    this.claudeExecutable = options.claudeExecutable;
    this.claudeHome = options.claudeHome;
    this.manageTaskboardSkillPath = options.manageTaskboardSkillPath;
    this.processEnv = options.processEnv ?? process.env;
    this.models = options.models;
    this.killGraceMs = options.killGraceMs ?? 1_000;
    this.composerCatalog = options.composerCatalog ?? new ComposerCatalog({
      claudeHome: this.claudeHome,
      issueSlashCommands: () => loadSlashCommands(this.claudeHome),
    });
    this.resolveContext = options.resolveContext ?? (async (projectId, issueId) => {
      const resolved = await resolveAiWorkspace(projectId, this.claudeHome, this.database);
      let issue;
      if (issueId !== undefined) {
        issue = this.database.getTask(issueId);
        if (!issue || issue.projectId !== projectId || issue.archivedAt != null) {
          throw new ApiError(
            404,
            "AI_CHAT_ISSUE_NOT_FOUND",
            `Task '${issueId}' is not an active task in project '${projectId}'`,
          );
        }
      }
      return { ...resolved, issue };
    });
    this.active = new Map();
    this.listeners = new Map();
    this.completions = new Map();
    this.boardBaseUrl = options.boardBaseUrl ?? null;
  }

  setBoardBaseUrl(baseUrl) {
    this.boardBaseUrl = typeof baseUrl === "string" && baseUrl.trim() ? baseUrl.trim() : null;
  }

  listThreads() {
    return this.database.listAiChatThreads();
  }

  getThread(threadId) {
    const thread = this.database.getAiChatThread(threadId);
    if (!thread) {
      throw new ApiError(
        404,
        "AI_CHAT_THREAD_NOT_FOUND",
        `AI chat thread '${threadId}' does not exist`,
      );
    }
    return thread;
  }

  getThreadSnapshot(threadId) {
    const thread = this.getThread(threadId);
    return {
      thread,
      events: this.database.listAiChatEvents(threadId),
      runs: this.database.listAiChatRuns(threadId),
    };
  }

  getRun(runId) {
    const run = this.database.getAiChatRun(runId);
    if (!run) {
      throw new ApiError(404, "AI_CHAT_RUN_NOT_FOUND", `AI chat run '${runId}' does not exist`);
    }
    return run;
  }

  subscribe(threadId, listener) {
    let listeners = this.listeners.get(threadId);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(threadId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(threadId);
    };
  }

  async #catalogForWorkspace(workspacePath) {
    const catalog = await discoverAiCatalog({
      workspacePath,
      claudeHome: this.claudeHome,
      processEnv: this.processEnv,
    });
    if (this.models && this.models.length > 0) catalog.models = this.models;
    return catalog;
  }

  async getCatalog(projectId, resolvedContext) {
    const resolved = resolvedContext ?? await this.resolveContext(projectId);
    return this.#catalogForWorkspace(resolved.workspacePath);
  }

  async getComposerCandidates({ projectId, threadId, trigger, query }) {
    let thread;
    if (threadId !== undefined) {
      try {
        thread = this.getThread(threadId);
      } catch (error) {
        if (error instanceof ApiError && error.code === "AI_CHAT_THREAD_NOT_FOUND") {
          throw new ApiError(
            400,
            "INVALID_COMPOSER_QUERY",
            "Composer thread does not exist",
          );
        }
        throw error;
      }
      if (projectId !== undefined && thread.origin.projectId !== projectId) {
        throw new ApiError(
          400,
          "INVALID_COMPOSER_QUERY",
          "Composer thread does not belong to the selected project",
        );
      }
      projectId = thread.origin.projectId;
    }

    if (projectId === undefined) {
      return this.composerCatalog.candidates({ workspacePath: null, trigger, query });
    }

    let resolved;
    try {
      resolved = await this.resolveContext(projectId, thread?.origin.issueId);
    } catch (error) {
      if (error instanceof ApiError && ["PROJECT_NOT_FOUND", "AI_CHAT_ISSUE_NOT_FOUND"].includes(error.code)) {
        throw new ApiError(400, "INVALID_COMPOSER_QUERY", "Composer project is invalid");
      }
      throw error;
    }
    if (thread && resolved.workspacePath !== thread.origin.workspacePath) {
      throw new ApiError(
        400,
        "INVALID_COMPOSER_QUERY",
        "Composer thread workspace no longer matches the selected project",
      );
    }
    return this.composerCatalog.candidates({
      workspacePath: resolved.workspacePath,
      trigger,
      query,
    });
  }

  async createThread(input) {
    const resolved = await this.resolveContext(input.projectId, input.issueId);
    const catalog = await this.getCatalog(input.projectId, resolved);
    const model = this.#resolveModel(catalog, input.model);
    const reasoningEffort = input.reasoningEffort ?? model.defaultReasoningEffort;
    this.#validateReasoningEffort(model, reasoningEffort);
    const sandbox = input.sandbox ?? "workspace-write";
    this.#validateSandbox(sandbox);

    const issue = resolved.issue;

    return this.database.createAiChatThread({
      title: input.title ?? issue?.identifier ?? "New conversation",
      origin: {
        projectId: resolved.project.id,
        projectName: resolved.project.name,
        workspacePath: resolved.workspacePath,
        ...(issue ? { issueId: issue.id, issueIdentifier: issue.identifier } : {}),
      },
      model: model.slug,
      modelProfileId: input.modelProfileId !== undefined
        ? input.modelProfileId
        : issue?.modelProfileId ?? null,
      reasoningEffort,
      sandbox,
    });
  }

  async updateThread(threadId, changes) {
    let thread = this.getThread(threadId);
    const changesSettings = ["model", "reasoningEffort", "sandbox"].some(
      (key) => Object.hasOwn(changes, key),
    );
    const wasActive = changesSettings && this.#threadIsActive(thread);

    if (Object.hasOwn(changes, "sandbox")) this.#validateSandbox(changes.sandbox);
    if (Object.hasOwn(changes, "model") || Object.hasOwn(changes, "reasoningEffort")) {
      const catalog = await this.getCatalog(thread.origin.projectId);
      thread = this.getThread(threadId);
      const model = this.#resolveModel(catalog, changes.model ?? thread.model);
      const reasoningEffort = changes.reasoningEffort ?? thread.reasoningEffort;
      this.#validateReasoningEffort(model, reasoningEffort);
    }
    if (wasActive || (changesSettings && this.#threadIsActive(thread))) {
      throw new ApiError(
        409,
        "THREAD_BUSY",
        `AI chat thread '${threadId}' has a running turn`,
      );
    }

    return this.database.updateAiChatThread(threadId, changes);
  }

  deleteThread(threadId) {
    const thread = this.getThread(threadId);
    if (this.#threadIsActive(thread)) {
      throw new ApiError(
        409,
        "THREAD_BUSY",
        `AI chat thread '${threadId}' has a running turn`,
      );
    }
    return this.database.deleteAiChatThread(threadId);
  }

  async startTurn(threadId, input) {
    let thread = this.getThread(threadId);
    if (this.#threadIsActive(thread)) {
      throw new ApiError(
        409,
        "THREAD_BUSY",
        `AI chat thread '${threadId}' has a running turn`,
      );
    }
    // Composer-turn payloads carry a document instead of a message string and
    // are validated in #prepareComposerTurn.
    if (input?.contractVersion !== "composer.v1") this.#validateTurnInput(input);
    if (thread.sandbox === "danger-full-access" && input.dangerFullAccessConfirmed !== true) {
      throw new ApiError(
        400,
        "DANGER_CONFIRMATION_REQUIRED",
        "danger-full-access must be confirmed for every turn",
      );
    }

    const resolved = await this.resolveContext(
      thread.origin.projectId,
      thread.origin.issueId,
    );
    const catalog = await this.getCatalog(thread.origin.projectId, resolved);

    thread = this.getThread(threadId);
    if (this.#threadIsActive(thread)) {
      throw new ApiError(
        409,
        "THREAD_BUSY",
        `AI chat thread '${threadId}' has a running turn`,
      );
    }
    if (thread.sandbox === "danger-full-access" && input.dangerFullAccessConfirmed !== true) {
      throw new ApiError(
        400,
        "DANGER_CONFIRMATION_REQUIRED",
        "danger-full-access must be confirmed for every turn",
      );
    }
    const model = this.#resolveModel(catalog, thread.model);
    this.#validateReasoningEffort(model, thread.reasoningEffort);
    if (resolved.workspacePath !== thread.origin.workspacePath) {
      // A thread bound to a workspace that no longer exists on disk adopts the
      // project's current workspace instead of being stuck forever.
      const previousExists = thread.origin.workspacePath
        ? await stat(thread.origin.workspacePath).then(() => true, () => false)
        : false;
      if (previousExists) {
        throw new ApiError(
          409,
          "PROJECT_WORKSPACE_CHANGED",
          "The project's device workspace no longer matches this conversation",
        );
      }
    }

    const isComposerTurn = input?.contractVersion === "composer.v1";
    let selectedSkills = [];
    let agentDispatches = [];
    let userMessage = input.message;
    if (isComposerTurn) {
      const prepared = await this.#prepareComposerTurn(thread, input, resolved);
      selectedSkills = prepared.selectedSkills;
      agentDispatches = prepared.agentDispatches;
      userMessage = prepared.message;
    } else {
      const skillIds = input.skillIds ?? [];
      const availableSkills = new Map(
        catalog.skills
          .filter((skill) => skill.id !== "manage-taskboard")
          .map((skill) => [skill.id, skill]),
      );
      for (const skillId of skillIds) {
        if (!availableSkills.has(skillId)) {
          throw new ApiError(400, "INVALID_SKILL", `Unknown or unavailable skill '${skillId}'`);
        }
      }
      selectedSkills = skillIds.map((skillId) => availableSkills.get(skillId));
    }

    const attachments = input.attachments ?? [];
    const {
      temporaryDirectory,
      attachmentPaths,
    } = await this.#writeTurnAttachments(attachments);
    try {
      const resumingThreadId = thread.claudeThreadId;
      const turnSessionId = resumingThreadId ?? randomUUID();
      const modelProfile = this.database.resolveModelProfile(thread.modelProfileId);
      // A profile with an explicit model drives Claude Code through
      // ANTHROPIC_MODEL, so the --model alias flag must not override it.
      const argThread = modelProfile?.model ? { ...thread, model: "default" } : thread;
      const args = buildClaudeArgs(argThread, resolved.addDirectories, turnSessionId);
      const profileSettings = modelProfileSettingsArg(modelProfile);
      if (profileSettings) args.splice(args.length - 1, 0, "--settings", profileSettings);
      const prompt = buildClaudePrompt(
        thread,
        {
          message: userMessage,
          skills: selectedSkills,
          attachmentPaths,
        },
        this.manageTaskboardSkillPath,
      );
      const run = this.database.createAiChatRun({ threadId });
      this.#emit(threadId, { type: "ai.run", run });
      const userEventData = {};
      if (isComposerTurn) {
        userEventData.contractVersion = "composer.v1";
        userEventData.revision = input.revision;
        userEventData.document = input.document;
        if (agentDispatches.length > 0) {
          userEventData.dispatchProtocol = AGENT_DISPATCH_PROTOCOL;
          userEventData.agentDispatches = agentDispatches.map(({ nodeIndex, id, name }) => ({
            nodeIndex,
            id,
            name,
          }));
        }
      } else if (input.skillIds?.length > 0) {
        userEventData.skillIds = input.skillIds;
      }
      if (attachments.length > 0) {
        userEventData.attachments = attachments.map(({ filename, contentType, size }) => ({
          filename,
          contentType,
          size,
        }));
      }
      const userEvent = this.database.insertAiChatEvent({
        threadId,
        runId: run.id,
        type: "user_message",
        role: "user",
        content: isComposerTurn
          ? input.document.nodes.map((node) => (
            node.type === "text" ? node.text : `@${node.label}`
          )).join("")
          : input.message,
        data: Object.keys(userEventData).length > 0 ? userEventData : undefined,
      });
      this.#emit(threadId, { type: "ai.event", event: userEvent });

      let startedThreadId = null;
      let terminalOutcome = null;
      let terminalError = "";
      let pendingError = "";
      const pendingTools = new Map();
      const turnEnv = {
        ...this.processEnv,
        CLAUDE_THREAD_ID: turnSessionId,
      };
      const extraEnv = {
        ...modelProfileEnvironment(modelProfile),
        ...(this.boardBaseUrl ? { CLAUDE_TASKBOARD_URL: this.boardBaseUrl } : {}),
      };
      const { child, completion } = spawnClaudeTurn({
        executable: this.claudeExecutable,
        args,
        prompt,
        env: turnEnv,
        cwd: resolved.workspacePath,
        extraEnv,
        onRawEvent: (raw) => {
          for (const normalized of normalizeClaudeEvent(raw, pendingTools)) {
            if (normalized.kind === "thread.started") {
              if (
                normalized.threadId !== turnSessionId
                || (startedThreadId && normalized.threadId !== startedThreadId)
              ) {
                throw new Error("Claude Code returned an unexpected session id");
              }
              startedThreadId = normalized.threadId;
              this.database.updateAiChatThread(threadId, { claudeThreadId: normalized.threadId });
              continue;
            }
            const event = this.database.insertAiChatEvent({
              threadId,
              runId: run.id,
              type: normalized.type,
              role: normalized.role,
              content: normalized.content,
              data: normalized.data,
            });
            if (normalized.type === "turn.completed" && terminalOutcome === null) {
              terminalOutcome = "completed";
            } else if (normalized.type === "turn.failed") {
              terminalOutcome = "failed";
              terminalError ||= normalized.content;
            } else if (normalized.type === "error") {
              pendingError ||= normalized.content;
            }
            this.#emit(threadId, { type: "ai.event", event });
          }
        },
      });

      const active = { child, threadId, interrupted: false, temporaryDirectory };
      this.active.set(run.id, active);
      const finalization = completion.then(
        (result) => this.#finishRun({
          run,
          active,
          result,
          resumingThreadId,
          startedThreadId: () => startedThreadId,
          terminalOutcome: () => terminalOutcome,
          terminalError: () => terminalError,
          pendingError: () => pendingError,
        }),
        (error) => this.#finishRun({
          run,
          active,
          error,
          resumingThreadId,
          startedThreadId: () => startedThreadId,
          terminalOutcome: () => terminalOutcome,
          terminalError: () => terminalError,
          pendingError: () => pendingError,
        }),
      );
      this.completions.set(run.id, finalization);
      void finalization.finally(() => this.completions.delete(run.id)).catch(() => {});
      return run;
    } catch (error) {
      if (temporaryDirectory) {
        await rm(temporaryDirectory, { recursive: true, force: true });
      }
      throw error;
    }
  }

  async interrupt(runId) {
    let run = this.getRun(runId);
    if (run.status !== "running") return run;

    const active = this.active.get(runId);
    if (!active) {
      run = this.database.updateAiChatRun(runId, {
        status: "interrupted",
        error: "Interrupted",
        finishedAt: new Date().toISOString(),
      });
      this.#emit(run.threadId, { type: "ai.run", run });
      return run;
    }

    active.interrupted = true;
    signalProcessGroup(active.child, "SIGTERM");
    const timer = setTimeout(() => {
      if (this.active.has(runId)) signalProcessGroup(active.child, "SIGKILL");
    }, this.killGraceMs);
    timer.unref();

    const completion = this.completions.get(runId);
    if (completion) {
      await Promise.race([completion.catch(() => {}), wait(this.killGraceMs + 25)]);
    }
    return this.getRun(runId);
  }

  async close() {
    const entries = [...this.active.entries()];
    for (const [, active] of entries) {
      active.interrupted = true;
      signalProcessGroup(active.child, "SIGTERM");
    }

    const completions = entries
      .map(([runId]) => this.completions.get(runId))
      .filter(Boolean);
    if (completions.length > 0) {
      const settled = Promise.allSettled(completions);
      await Promise.race([settled, wait(this.killGraceMs)]);
      for (const [runId, active] of entries) {
        if (this.active.has(runId)) signalProcessGroup(active.child, "SIGKILL");
      }
      await settled;
    }
    this.composerCatalog.close();
    this.listeners.clear();
  }

  #resolveModel(catalog, requestedModel) {
    const model = requestedModel === undefined
      ? catalog.models[0]
      : catalog.models.find((candidate) => candidate.slug === requestedModel);
    if (!model) {
      throw new ApiError(
        400,
        "INVALID_MODEL",
        requestedModel === undefined
          ? "No Claude Code model is configured"
          : `Unknown model '${requestedModel}'`,
      );
    }
    return model;
  }

  #validateReasoningEffort(model, reasoningEffort) {
    if (
      model.supportedReasoningEfforts.length > 0
      && !model.supportedReasoningEfforts.includes(reasoningEffort)
    ) {
      throw new ApiError(
        400,
        "INVALID_REASONING_EFFORT",
        `Reasoning effort '${reasoningEffort}' is not supported by model '${model.slug}'`,
      );
    }
  }

  #validateSandbox(sandbox) {
    if (!SANDBOXES.has(sandbox)) {
      throw new ApiError(
        400,
        "INVALID_SANDBOX",
        "'sandbox' must be read-only, workspace-write, or danger-full-access",
      );
    }
  }

  #validateTurnInput(input) {
    if (
      !input
      || typeof input.message !== "string"
      || input.message.length > 100_000
      || (
        input.message.trim() === ""
        && input.contractVersion !== "composer.v1"
        && (!Array.isArray(input.attachments) || input.attachments.length === 0)
      )
    ) {
      throw new ApiError(
        400,
        "INVALID_MESSAGE",
        "A message or at least one attachment is required",
      );
    }
    if (
      input.skillIds !== undefined
      && (
        !Array.isArray(input.skillIds)
        || input.skillIds.length > 20
        || input.skillIds.some((skillId) => typeof skillId !== "string" || !skillId)
      )
    ) {
      throw new ApiError(
        400,
        "INVALID_SKILL",
        "'skillIds' must contain at most 20 skill ids",
      );
    }
  }

  async #prepareComposerTurn(thread, input, resolved) {
    if (thread.sandbox === "danger-full-access" && input.dangerFullAccessConfirmed !== true) {
      throw new ApiError(
        400,
        "DANGER_CONFIRMATION_REQUIRED",
        "danger-full-access must be confirmed for every turn",
      );
    }
    if (resolved.workspacePath !== thread.origin.workspacePath) {
      throw new ApiError(
        409,
        "PROJECT_WORKSPACE_CHANGED",
        "The project's device workspace no longer matches this conversation",
      );
    }

    const nodes = input.document.nodes;
    const unsupportedIndex = nodes.findIndex((node) => !["text", "skill", "agent"].includes(node.type));
    if (unsupportedIndex >= 0) {
      throw new ApiError(
        422,
        "COMPOSER_NODE_UNSUPPORTED",
        `Unsupported composer node at index ${unsupportedIndex}`,
        { nodeIndex: unsupportedIndex },
      );
    }
    const attachments = input.attachments ?? [];
    if (
      nodes.every((node) => node.type !== "text" || node.text.trim() === "")
      && !nodes.some((node) => node.type === "skill" || node.type === "agent")
      && attachments.length === 0
    ) {
      throw new ApiError(
        400,
        "INVALID_COMPOSER_DOCUMENT",
        "A composer message or at least one attachment is required",
      );
    }

    const resolvedReferences = nodes.some((node) => node.type === "skill" || node.type === "agent")
      ? await this.composerCatalog.resolveReferences({
        workspacePath: resolved.workspacePath,
        revision: input.revision,
        nodes,
      })
      : nodes.map(() => null);

    let message = "";
    const selectedSkills = [];
    const agentDispatches = [];
    for (const [nodeIndex, node] of nodes.entries()) {
      if (node.type === "text") {
        message += node.text;
        continue;
      }
      const reference = resolvedReferences[nodeIndex];
      if (node.type === "skill") {
        selectedSkills.push({ id: reference.name, name: reference.name, path: reference.path });
      } else {
        agentDispatches.push({
          nodeIndex,
          id: reference.stableId,
          name: reference.name,
          dispatchText: agentDispatchText(reference),
        });
      }
    }
    if (agentDispatches.length > 0) {
      message = [
        message,
        ...agentDispatches.map((dispatch) => dispatch.dispatchText),
      ].filter(Boolean).join("\n\n");
    }
    return { selectedSkills, agentDispatches, message };
  }

  async #writeTurnAttachments(attachments) {
    if (attachments.length === 0) {
      return { temporaryDirectory: null, attachmentPaths: [] };
    }
    const temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "claude-taskboard-ai-turn-"),
    );
    try {
      const attachmentPaths = [];
      for (const [index, attachment] of attachments.entries()) {
        const attachmentPath = path.join(
          temporaryDirectory,
          `attachment-${index + 1}-${attachment.filename}`,
        );
        await writeFile(attachmentPath, attachment.data, { flag: "wx", mode: 0o600 });
        attachmentPaths.push(attachmentPath);
      }
      return { temporaryDirectory, attachmentPaths };
    } catch (error) {
      await rm(temporaryDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  #threadIsActive(thread) {
    return Boolean(thread.currentRun)
      || [...this.active.values()].some((active) => active.threadId === thread.id);
  }

  async #finishRun({
    run,
    active,
    result,
    error,
    resumingThreadId,
    startedThreadId,
    terminalOutcome,
    terminalError,
    pendingError,
  }) {
    let status;
    let publicError = null;
    if (active.interrupted) {
      status = "interrupted";
      publicError = "Interrupted";
    } else if (error) {
      status = "failed";
      publicError = cappedError(error) || "Claude Code turn failed";
    } else if (terminalOutcome() === "failed") {
      status = "failed";
      publicError = terminalError() || "Claude Code reported a failed turn";
    } else if (result.exitCode !== 0) {
      status = "failed";
      const stderrTail = typeof result.stderr === "string" && result.stderr.trim()
        ? `: ${result.stderr.trim().split("\n").slice(-4).join(" | ").slice(0, 2_000)}`
        : "";
      publicError = result.exitCode === null
        ? `Claude Code exited due to signal ${result.signal ?? "unknown"}`
        : `Claude Code exited with code ${result.exitCode}${stderrTail}`;
    } else if (terminalOutcome() !== "completed") {
      status = "failed";
      publicError = pendingError() || "Claude Code exited without reporting turn completion";
    } else if (!resumingThreadId && !startedThreadId()) {
      status = "failed";
      publicError = "Claude Code did not provide a session id";
    } else {
      status = "completed";
    }

    try {
      if (status === "failed" && terminalOutcome() !== "failed") {
        const errorEvent = this.database.insertAiChatEvent({
          threadId: run.threadId,
          runId: run.id,
          type: "error",
          role: "error",
          content: cappedError(publicError),
          data: { status: "failed" },
        });
        this.#emit(run.threadId, { type: "ai.event", event: errorEvent });
      }
      const updated = this.database.updateAiChatRun(run.id, {
        status,
        exitCode: result?.exitCode ?? null,
        error: publicError === null ? null : cappedError(publicError),
        finishedAt: new Date().toISOString(),
      });
      this.#emit(run.threadId, { type: "ai.run", run: updated });
      return updated;
    } finally {
      this.active.delete(run.id);
      if (active.temporaryDirectory) {
        await rm(active.temporaryDirectory, { recursive: true, force: true });
      }
    }
  }

  #emit(threadId, event) {
    for (const listener of this.listeners.get(threadId) ?? []) {
      try {
        listener(event);
      } catch {}
    }
  }
}
