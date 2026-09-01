import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { TaskboardDatabase } from "../server/database.mjs";
import { LocalAutomationScheduler } from "../server/automation-scheduler.mjs";
import {
  buildTaskboardAutomationName,
  buildTaskboardAutomationPrompt,
  buildTaskboardAutomationSpec,
  buildTaskboardTaskRunPrompt,
  parseTaskboardAutomationHostRequest,
  taskboardAutomationPolicyOperation,
} from "../shared/taskboard-automation.mjs";

const baseRequest = {
  id: "host-request-1",
  action: "automation",
  requestId: "iframe-request-1",
  operation: "ensure-active",
  taskboardProjectId: "local",
  codexProjectId: "/Users/example/Documents/ppt-skill",
  codexProjectKind: "local",
  codexHostId: "local",
  projectName: "PPT Skill",
  workspacePath: "/Users/example/Documents/ppt-skill",
  skillPath: "/Users/example/taskboard/skills/manage-taskboard",
  enabledByUser: true,
  quotaAware: false,
  intervalMinutes: 5,
  model: "opus",
  reasoningEffort: "high",
};

test("the automation host request accepts local project automation options", () => {
  assert.deepEqual(
    parseTaskboardAutomationHostRequest(baseRequest),
    { ...baseRequest, remoteProjects: [], modelProfileId: null },
  );
  assert.equal(
    parseTaskboardAutomationHostRequest({ ...baseRequest, operation: "delete" }),
    null,
  );
  assert.equal(
    parseTaskboardAutomationHostRequest({ ...baseRequest, codexProjectKind: "remote" }),
    null,
  );
  assert.equal(
    parseTaskboardAutomationHostRequest({ ...baseRequest, unknownField: true }),
    null,
  );
  assert.equal(
    parseTaskboardAutomationHostRequest({ ...baseRequest, intervalMinutes: 7 }),
    null,
  );
  assert.equal(
    parseTaskboardAutomationHostRequest({
      ...baseRequest,
      modelProfileId: "kimi-profile",
    }).modelProfileId,
    "kimi-profile",
  );
  assert.equal(
    parseTaskboardAutomationHostRequest({ ...baseRequest, modelProfileId: 42 }),
    null,
  );
});

test("a missing codex project id falls back to the workspace path", () => {
  const { codexProjectId: _omitted, ...withoutProjectId } = baseRequest;
  const parsed = parseTaskboardAutomationHostRequest(withoutProjectId);
  assert.equal(parsed.codexProjectId, baseRequest.workspacePath);
});

test("the automation prompt drives the local claude controller through taskctl", () => {
  const prompt = buildTaskboardAutomationPrompt(baseRequest);
  assert.match(prompt, /manage-taskboard/);
  assert.match(prompt, /CLAUDE_THREAD_ID/);
  assert.match(prompt, /issue list --project local --status todo --json/);
  assert.match(prompt, /--binding-thread-id "\$CLAUDE_THREAD_ID"/);
  assert.match(prompt, new RegExp(`--binding-codex-project-id ${JSON.stringify(baseRequest.codexProjectId)}`));
  assert.match(prompt, /--binding-codex-project-kind "local"/);
  assert.match(prompt, /--binding-codex-host-id "local"/);
  assert.match(prompt, /在本会话内完成实现和验证/);
  assert.match(prompt, /需要时[^\n]*project readme get local --json/);
  assert.ok(!prompt.includes("强制要求"));
  assert.ok(!prompt.includes("send_message_to_thread"));
  assert.ok(!prompt.includes("create_thread"));
  assert.ok(!prompt.includes("wait_threads"));
});

test("the task run prompt makes the controller aware of the project readme", () => {
  const request = parseTaskboardAutomationHostRequest({
    ...baseRequest,
    operation: "run-task",
    issueId: "PPT-42",
  });
  const prompt = buildTaskboardTaskRunPrompt(request);
  assert.match(prompt, /issue get PPT-42 --json/);
  assert.match(prompt, /需要时[^\n]*project readme get local --json/);
  assert.ok(!prompt.includes("强制要求"));
  assert.match(prompt, /--binding-thread-id "\$CLAUDE_THREAD_ID"/);
});

test("automation names and specs stay stable", () => {
  assert.equal(buildTaskboardAutomationName(baseRequest), "Taskboard 自动认领 · local");
  assert.deepEqual(buildTaskboardAutomationSpec(baseRequest), {
    name: "Taskboard 自动认领 · local",
    model: "opus",
    reasoningEffort: "high",
    rrule: "RRULE:FREQ=MINUTELY;INTERVAL=5",
  });
});

test("automation policy pauses without todos and stays active while work remains", () => {
  assert.equal(taskboardAutomationPolicyOperation(baseRequest, {
    explicit: true,
    hasTodo: false,
    currentStatus: "ACTIVE",
  }), "pause");
  assert.equal(taskboardAutomationPolicyOperation(baseRequest, {
    explicit: true,
    hasTodo: true,
    currentStatus: undefined,
  }), "ensure-active");
  assert.equal(taskboardAutomationPolicyOperation(
    { ...baseRequest, enabledByUser: false },
    { explicit: true, hasTodo: true, currentStatus: "ACTIVE" },
  ), "pause");
  assert.equal(taskboardAutomationPolicyOperation(
    { ...baseRequest, quotaAware: true },
    { explicit: true, hasTodo: true, quotaState: "blocked", currentStatus: "ACTIVE" },
  ), "pause");
});

async function createSchedulerFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-automation-e2e-"));
  const workspacePath = path.join(directory, "workspace");
  await mkdir(workspacePath, { recursive: true });
  const capturePath = path.join(directory, "capture.jsonl");
  const executable = path.join(directory, "fake-claude.mjs");
  await writeFile(executable, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const capturePath = ${JSON.stringify(capturePath)};
const sessionIdIndex = process.argv.indexOf("--session-id");
const sessionId = sessionIdIndex >= 0 ? process.argv[sessionIdIndex + 1] : null;
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  appendFileSync(capturePath, JSON.stringify({
    args: process.argv.slice(2),
    threadId: process.env.CLAUDE_THREAD_ID ?? null,
    promptLength: prompt.length,
  }) + "\\n");
  const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
  emit({ type: "system", subtype: "init", session_id: sessionId });
  emit({ type: "result", subtype: "success", is_error: false });
});
`);
  await chmod(executable, 0o755);
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  const scheduler = new LocalAutomationScheduler({
    database,
    claudeExecutable: executable,
    skillPath: path.join(directory, "skills", "manage-taskboard"),
    processEnv: process.env,
    killGraceMs: 250,
  });
  const request = parseTaskboardAutomationHostRequest({
    ...baseRequest,
    workspacePath,
    codexProjectId: workspacePath,
    skillPath: path.join(directory, "skills", "manage-taskboard"),
    operation: "apply-policy",
  });
  return { directory, workspacePath, capturePath, database, scheduler, request };
}

test("the local scheduler runs one claude controller turn for a todo", async () => {
  const fixture = await createSchedulerFixture();
  try {
    const userActor = { type: "user", id: "u", name: "U", avatarUrl: null };
    fixture.database.createTask({
      projectId: "local",
      title: "Claim me",
      description: "",
      status: "todo",
      priority: "medium",
      labels: [],
      actor: userActor,
      assignee: userActor,
      startDate: null,
      dueDate: null,
    });

    const applied = await fixture.scheduler.handleRequest(fixture.request);
    assert.equal(applied.item.status, "ACTIVE");
    assert.equal(applied.policy.codexProjectId, fixture.workspacePath);

    const capture = await waitForCapture(fixture.capturePath, 8_000);
    assert.match(capture.threadId, /^[0-9a-f-]{36}$/);
    assert.ok(capture.args.includes("--session-id"));
    assert.ok(capture.promptLength > 200);

    await fixture.scheduler.close();
    fixture.database.close();
  } finally {
    await rmWithRetry(fixture.directory);
  }
});

test("the local scheduler stays armed without todos and spawns nothing", async () => {
  const fixture = await createSchedulerFixture();
  try {
    const applied = await fixture.scheduler.handleRequest(fixture.request);
    assert.equal(applied.item.status, "ACTIVE");
    assert.notEqual(applied.item.nextRunAt, null);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await assert.rejects(
      () => waitForCapture(fixture.capturePath, 1),
      (error) => error.message.includes("Timed out"),
    );
    await fixture.scheduler.close();
    fixture.database.close();
  } finally {
    await rmWithRetry(fixture.directory);
  }
});

async function waitForCapture(capturePath, timeout) {
  const { readFile } = await import("node:fs/promises");
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const source = await readFile(capturePath, "utf8");
      const firstLine = source.trim().split("\n")[0];
      if (firstLine) return JSON.parse(firstLine);
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for the controller capture file");
}

async function rmWithRetry(directory) {
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
