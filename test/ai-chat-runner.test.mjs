import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { TaskboardDatabase } from "../server/database.mjs";
import { AiChatService } from "../server/ai-chat.mjs";
import {
  ComposerCatalog,
  composerCandidatesForSurface,
  discoverAiCatalog,
  loadSlashCommands,
} from "../server/ai-chat-catalog.mjs";
import {
  buildClaudeArgs,
  buildClaudePrompt,
  normalizeClaudeEvent,
} from "../server/ai-chat-process.mjs";

async function waitFor(predicate, timeout = 8_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for condition");
}

async function writeFakeClaude(directory) {
  const executable = path.join(directory, "fake-claude.mjs");
  await writeFile(executable, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
if (process.env.FAKE_CLAUDE_CAPTURE_PATH) {
  appendFileSync(process.env.FAKE_CLAUDE_CAPTURE_PATH, JSON.stringify({
    args,
    threadId: process.env.CLAUDE_THREAD_ID ?? null,
    launcherKeys: Object.keys(process.env).filter((name) => name.startsWith("CLAUDE_TASKBOARD_")),
  }) + "\\n");
}

const sessionIdIndex = args.indexOf("--session-id");
const resumeIndex = args.indexOf("--resume");
const sessionId = sessionIdIndex >= 0
  ? args[sessionIdIndex + 1]
  : resumeIndex >= 0
    ? args[resumeIndex + 1]
    : "99999999-9999-9999-9999-999999999999";

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
  emit({ type: "system", subtype: "init", cwd: process.cwd(), session_id: sessionId, tools: ["Bash"] });
  if (prompt.includes("FAIL_TURN")) {
    emit({ type: "result", subtype: "error_during_execution", is_error: true, session_id: sessionId, result: "boom" });
    process.exit(0);
  }
  emit({
    type: "assistant",
    message: { role: "assistant", content: [
      { type: "text", text: "Working on it." },
      { type: "tool_use", id: "call_1", name: "Bash", input: { command: "echo hello" } },
      { type: "tool_use", id: "call_2", name: "TodoWrite", input: { todos: [
        { content: "step one", status: "completed" },
        { content: "step two", status: "in_progress" },
      ] } },
    ] },
    session_id: sessionId,
  });
  emit({
    type: "user",
    message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "call_1", content: "hello\\n" },
      { type: "tool_result", tool_use_id: "call_2", content: "" },
    ] },
    session_id: sessionId,
  });
  if (prompt.includes("PERMISSION_DENIED")) {
    emit({ type: "system", subtype: "permission_denied", tool_name: "Bash", message: "Contains simple_expansion" });
  }
  emit({ type: "assistant", message: { role: "assistant", content: [
    { type: "text", text: "Done." },
  ] }, session_id: sessionId });
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: sessionId,
    result: "Done.",
    usage: { input_tokens: 10, cache_read_input_tokens: 20, output_tokens: 5 },
  });
});
`);
  await chmod(executable, 0o755);
  return executable;
}

async function createServiceFixture(options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-claude-runner-"));
  const claudeHome = path.join(directory, "claude-home");
  await mkdir(path.join(claudeHome, "skills"), { recursive: true });
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  const executable = await writeFakeClaude(directory);
  const capturePath = path.join(directory, "capture.jsonl");
  const service = new AiChatService({
    database,
    claudeExecutable: executable,
    claudeHome,
    manageTaskboardSkillPath: path.join(claudeHome, "skills", "manage-taskboard", "SKILL.md"),
    processEnv: {
      ...process.env,
      FAKE_CLAUDE_CAPTURE_PATH: capturePath,
      CLAUDE_TASKBOARD_INSTANCE_TOKEN: "should-not-leak",
    },
    killGraceMs: 250,
    resolveContext: async () => ({
      workspacePath: directory,
      addDirectories: [],
      project: database.getProject("local"),
      issue: undefined,
    }),
    ...options,
  });
  return { directory, claudeHome, database, service, executable, capturePath };
}

test("buildClaudeArgs maps sandbox modes and session identity to CLI flags", () => {
  const base = { origin: { workspacePath: "/work" } };
  assert.deepEqual(buildClaudeArgs({ ...base, sandbox: "read-only" }, [], "11111111-1111-1111-1111-111111111111"), [
    "--print", "--output-format", "stream-json", "--verbose",
    "--permission-mode", "plan",
    "--session-id", "11111111-1111-1111-1111-111111111111",
    "-",
  ]);
  assert.deepEqual(buildClaudeArgs({ ...base, sandbox: "workspace-write" }, [], null), [
    "--print", "--output-format", "stream-json", "--verbose",
    "--permission-mode", "acceptEdits", "--allowedTools", "Bash", "WebSearch", "WebFetch",
    "-",
  ]);
  assert.deepEqual(buildClaudeArgs({ ...base, sandbox: "danger-full-access" }, [], null), [
    "--print", "--output-format", "stream-json", "--verbose",
    "--dangerously-skip-permissions",
    "-",
  ]);
  assert.deepEqual(buildClaudeArgs({
    ...base,
    sandbox: "workspace-write",
    model: "opus",
    reasoningEffort: "high",
    claudeThreadId: "22222222-2222-2222-2222-222222222222",
  }, ["/extra"], "33333333-3333-3333-3333-333333333333"), [
    "--print", "--output-format", "stream-json", "--verbose",
    "--permission-mode", "acceptEdits", "--allowedTools", "Bash", "WebSearch", "WebFetch",
    "--add-dir", "/extra",
    "--model", "opus",
    "--effort", "high",
    "--resume", "22222222-2222-2222-2222-222222222222",
    "-",
  ]);
});

test("buildClaudePrompt embeds taskboard context, skill dispatch, and attachments", () => {
  const prompt = buildClaudePrompt({
    origin: {
      projectId: "local",
      projectName: "全局",
      workspacePath: "/work/project",
      issueIdentifier: "TASK-7",
    },
  }, {
    message: "please proceed \uFFFC",
    skills: [{ id: "release", name: "release", path: "/skills/release" }],
    attachmentPaths: ["/tmp/attachment-1-brief.txt"],
  }, "/skills/manage-taskboard");
  assert.match(prompt, /manage-taskboard/);
  assert.match(prompt, /project_id: local/);
  assert.match(prompt, /issue_identifier: TASK-7/);
  assert.match(prompt, /workspace_path: \/work\/project/);
  assert.match(prompt, /Use the "release" skill/);
  assert.match(prompt, /\/tmp\/attachment-1-brief\.txt/);
  assert.match(prompt, /<user_message>\nplease proceed Use the "release" skill/);
});

test("normalizeClaudeEvent maps stream-json records to board events", () => {
  const pending = new Map();
  assert.deepEqual(
    normalizeClaudeEvent({ type: "system", subtype: "init", session_id: "abc" }, pending),
    [{ kind: "thread.started", threadId: "abc" }],
  );
  assert.deepEqual(normalizeClaudeEvent({ type: "system", subtype: "thinking_tokens" }, pending), []);
  assert.deepEqual(
    normalizeClaudeEvent({ type: "system", subtype: "permission_denied", tool_name: "Bash", message: "nope" }, pending),
    [{
      kind: "event",
      type: "error",
      role: "activity",
      content: "nope",
      data: { status: "warning" },
    }],
  );

  const assistantEvents = normalizeClaudeEvent({
    type: "assistant",
    message: { content: [
      { type: "text", text: "hello" },
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "echo hi" } },
      { type: "tool_use", id: "t2", name: "Write", input: { file_path: "/work/a.ts" } },
      { type: "tool_use", id: "t3", name: "WebSearch", input: { query: "docs" } },
      { type: "tool_use", id: "t4", name: "TodoWrite", input: { todos: [
        { content: "one", status: "completed" },
        { content: "two", status: "pending" },
      ] } },
      { type: "tool_use", id: "t5", name: "Read", input: { file_path: "/work/b.ts" } },
      { type: "thinking", thinking: "hidden" },
    ] },
  }, pending);
  assert.equal(assistantEvents.length, 6);
  assert.deepEqual(assistantEvents[0], {
    kind: "event",
    type: "agent_message",
    role: "assistant",
    content: "hello",
    data: { status: "completed" },
  });
  assert.equal(assistantEvents[1].type, "command_execution");
  assert.equal(assistantEvents[1].data.command, "echo hi");
  assert.equal(assistantEvents[2].type, "file_change");
  assert.deepEqual(assistantEvents[2].data.files, ["/work/a.ts"]);
  assert.equal(assistantEvents[3].type, "web_search");
  assert.equal(assistantEvents[3].data.query, "docs");
  assert.equal(assistantEvents[4].type, "todo_list");
  assert.equal(assistantEvents[5].type, "mcp_tool_call");
  assert.equal(assistantEvents[5].data.tool, "Read");
  assert.equal(pending.size, 5);

  const resultEvents = normalizeClaudeEvent({
    type: "user",
    message: { content: [
      { type: "tool_result", tool_use_id: "t1", content: "hi\n" },
      { type: "tool_result", tool_use_id: "t9", content: "orphan" },
    ] },
  }, pending);
  assert.equal(resultEvents.length, 2);
  assert.equal(resultEvents[0].type, "command_execution");
  assert.equal(resultEvents[0].data.status, "completed");
  assert.equal(resultEvents[0].data.output, "hi\n");
  assert.equal(pending.size, 4);

  const completed = normalizeClaudeEvent({
    type: "result",
    subtype: "success",
    is_error: false,
    usage: { input_tokens: 1, cache_read_input_tokens: 2, output_tokens: 3 },
  }, pending);
  assert.equal(completed[0].type, "turn.completed");
  assert.deepEqual(completed[0].data.usage, {
    input_tokens: 1,
    cached_input_tokens: 2,
    output_tokens: 3,
  });

  const failed = normalizeClaudeEvent({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    result: "boom",
  }, pending);
  assert.equal(failed[0].type, "turn.failed");
  assert.equal(failed[0].content, "boom");
});

test("a claude turn persists events, binds the session id, and completes the run", async () => {
  const fixture = await createServiceFixture();
  try {
    const thread = await fixture.service.createThread({ projectId: "local" });
    const run = await fixture.service.startTurn(thread.id, { message: "hello there" });
    const finished = await waitFor(() => {
      const current = fixture.service.getRun(run.id);
      return current.status === "completed" ? current : null;
    });

    assert.equal(finished.exitCode, 0);
    const updatedThread = fixture.service.getThread(thread.id);
    assert.match(updatedThread.claudeThreadId, /^[0-9a-f-]{36}$/);

    const events = fixture.database.listAiChatEvents(thread.id);
    assert.equal(events.at(0).type, "user_message");
    const types = events.map((event) => event.type);
    assert.ok(types.includes("agent_message"));
    assert.ok(types.includes("command_execution"));
    assert.ok(types.includes("todo_list"));
    assert.ok(types.includes("turn.completed"));

    const captures = (await readFile(fixture.capturePath, "utf8")).trim().split("\n").map(JSON.parse);
    const capture = captures.at(-1);
    assert.equal(capture.threadId, updatedThread.claudeThreadId);
    assert.deepEqual(capture.launcherKeys, []);
    assert.ok(capture.args.includes("--session-id"));
    assert.ok(capture.args.includes("stream-json"));
  } finally {
    await fixture.service.close();
    fixture.database.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("a resumed turn passes --resume with the stored session id", async () => {
  const fixture = await createServiceFixture();
  try {
    const thread = await fixture.service.createThread({ projectId: "local" });
    const firstRun = await fixture.service.startTurn(thread.id, { message: "first" });
    await waitFor(() => fixture.service.getRun(firstRun.id).status === "completed");
    const sessionId = fixture.service.getThread(thread.id).claudeThreadId;

    const secondRun = await fixture.service.startTurn(thread.id, { message: "second" });
    await waitFor(() => fixture.service.getRun(secondRun.id).status === "completed");
    const captures = (await readFile(fixture.capturePath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.ok(captures.at(-1).args.includes("--resume"));
    assert.equal(fixture.service.getThread(thread.id).claudeThreadId, sessionId);
  } finally {
    await fixture.service.close();
    fixture.database.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("a failed turn records the error and run failure", async () => {
  const fixture = await createServiceFixture();
  try {
    const thread = await fixture.service.createThread({ projectId: "local" });
    const run = await fixture.service.startTurn(thread.id, { message: "FAIL_TURN please" });
    const finished = await waitFor(() => {
      const current = fixture.service.getRun(run.id);
      return current.status === "failed" ? current : null;
    });
    assert.match(finished.error, /boom|failed/);
    const events = fixture.database.listAiChatEvents(thread.id);
    assert.ok(events.some((event) => event.type === "turn.failed"));
  } finally {
    await fixture.service.close();
    fixture.database.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("danger-full-access turns require per-turn confirmation and settings are validated", async () => {
  const fixture = await createServiceFixture();
  try {
    const thread = await fixture.service.createThread({ projectId: "local", sandbox: "danger-full-access" });
    await assert.rejects(
      () => fixture.service.startTurn(thread.id, { message: "go" }),
      (error) => error.code === "DANGER_CONFIRMATION_REQUIRED",
    );
    const run = await fixture.service.startTurn(thread.id, {
      message: "go",
      dangerFullAccessConfirmed: true,
    });
    await waitFor(() => fixture.service.getRun(run.id).status === "completed");
    const captures = (await readFile(fixture.capturePath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.ok(captures.at(-1).args.includes("--dangerously-skip-permissions"));

    await assert.rejects(
      () => fixture.service.createThread({ projectId: "local", sandbox: "no-sandbox" }),
      (error) => error.code === "INVALID_SANDBOX",
    );
    await assert.rejects(
      () => fixture.service.createThread({ projectId: "local", model: "nope" }),
      (error) => error.code === "INVALID_MODEL",
    );
  } finally {
    await fixture.service.close();
    fixture.database.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("the composer catalog discovers skills, agents, and commands from the filesystem", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-composer-catalog-"));
  try {
    const claudeHome = path.join(directory, "claude-home");
    const userSkills = path.join(claudeHome, "skills", "release-skill");
    await mkdir(userSkills, { recursive: true });
    await writeFile(path.join(userSkills, "SKILL.md"), [
      "---",
      "name: release-skill",
      "description: Release workflow",
      "---",
      "# Release",
    ].join("\n"));
    await mkdir(path.join(claudeHome, "agents"), { recursive: true });
    await writeFile(path.join(claudeHome, "agents", "reviewer.md"), [
      "---",
      "name: reviewer",
      "description: Reviews code changes",
      "---",
      "You review code.",
    ].join("\n"));
    await mkdir(path.join(claudeHome, "commands"), { recursive: true });
    await writeFile(path.join(claudeHome, "commands", "deploy-check.md"), [
      "---",
      "description: Check the deployment",
      "---",
      "Run deployment checks.",
    ].join("\n"));

    const catalog = new ComposerCatalog({ claudeHome });
    const skillSurface = await catalog.candidates({ workspacePath: directory, trigger: "@", query: "release" });
    const skillCandidate = skillSurface.candidates.find((candidate) => candidate.kind === "skill");
    assert.equal(skillCandidate.label, "release-skill");
    assert.equal(skillCandidate.description, "Release workflow");

    const agentSurface = await catalog.candidates({ workspacePath: directory, trigger: "@", query: "reviewer" });
    const agentCandidate = agentSurface.candidates.find((candidate) => candidate.kind === "agent");
    assert.equal(agentCandidate.label, "reviewer");

    const slashSurface = await catalog.candidates({ workspacePath: directory, trigger: "/", query: "new" });
    assert.ok(slashSurface.candidates.some((candidate) => candidate.command === "/new"));
    assert.ok(!slashSurface.candidates.some((candidate) => candidate.command === "/compact"));

    const references = await catalog.resolveReferences({
      workspacePath: directory,
      revision: skillSurface.revision,
      nodes: [
        { type: "text", text: "hello" },
        { type: "skill", candidateRef: skillCandidate.candidateRef, label: "release-skill" },
        { type: "agent", candidateRef: agentCandidate.candidateRef, label: "reviewer" },
      ],
    });
    assert.equal(references[1].name, "release-skill");
    assert.ok(references[1].path.endsWith("release-skill"));
    assert.equal(references[2].developerInstructions, "You review code.");
    catalog.close();

    const commands = await loadSlashCommands(claudeHome, directory);
    assert.deepEqual(commands, [{
      id: "deploy-check",
      label: "/deploy-check",
      description: "Check the deployment",
      insertText: "/deploy-check ",
    }]);

    const aiCatalog = await discoverAiCatalog({
      workspacePath: directory,
      processEnv: { ...process.env, CLAUDE_CONFIG_DIR: claudeHome },
    });
    assert.ok(aiCatalog.models.some((model) => model.slug === "default"));
    assert.ok(aiCatalog.skills.some((skill) => skill.id === "release-skill"));
    assert.deepEqual(aiCatalog.sandboxes, ["read-only", "workspace-write", "danger-full-access"]);

    const customCatalog = await discoverAiCatalog({
      workspacePath: directory,
      processEnv: {
        ...process.env,
        CLAUDE_CONFIG_DIR: claudeHome,
        CLAUDE_TASKBOARD_MODELS: JSON.stringify([{ slug: "glm-5.3", supportedReasoningEfforts: ["low", "high"] }]),
      },
    });
    assert.deepEqual(customCatalog.models, [{
      slug: "glm-5.3",
      displayName: "glm-5.3",
      description: "",
      defaultReasoningEffort: "low",
      supportedReasoningEfforts: ["low", "high"],
      serviceTiers: [],
    }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("composer candidates for the issue surface keep insert-only slash actions", async () => {
  const response = {
    contractVersion: "composer.v1",
    revision: "r1",
    candidates: [
      {
        kind: "slashAction",
        candidateRef: "slash:open-model-menu",
        trigger: "/",
        label: "Model",
        description: "Choose the model",
        group: "Commands",
        selectable: true,
        command: "/model",
        insertionText: "/model",
        dispatch: { type: "client", handlerId: "open-model-menu" },
      },
      { kind: "skill", candidateRef: "skill-1", trigger: "@", label: "A skill" },
    ],
    sources: [],
  };
  const surfaced = composerCandidatesForSurface(response, "issue-composer", null, "model");
  assert.equal(surfaced.candidates.length, 2);
  const slashCandidate = surfaced.candidates.find((candidate) => candidate.kind === "slashAction");
  assert.equal(slashCandidate.command, "/model");
  assert.equal(slashCandidate.dispatch, undefined);
  assert.deepEqual(slashCandidate.selection, { type: "insertText", text: "/model" });
  const chatSurface = composerCandidatesForSurface(response, "ai-chat");
  assert.equal(chatSurface, response);
});

test("a composer-format turn with only text nodes starts without a message field", async () => {
  const fixture = await createServiceFixture();
  try {
    const thread = await fixture.service.createThread({ projectId: "local" });
    const run = await fixture.service.startTurn(thread.id, {
      contractVersion: "composer.v1",
      revision: "unused",
      document: { version: 1, nodes: [{ type: "text", text: "hello from composer" }] },
    });
    const finished = await waitFor(() => {
      const current = fixture.service.getRun(run.id);
      return current.status === "completed" ? current : null;
    });
    assert.equal(finished.exitCode, 0);
    const events = fixture.database.listAiChatEvents(thread.id);
    assert.equal(events.at(0).type, "user_message");
    assert.equal(events.at(0).content, "hello from composer");
  } finally {
    await fixture.service.close();
    fixture.database.close();
    await rmWithRetryIfPresent(fixture.directory);
  }
});

async function rmWithRetryIfPresent(directory) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 29) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}
