import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createTaskboardServer } from "../server/index.mjs";

async function createServerFixture(host = "127.0.0.1") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-ai-server-"));
  const workspacePath = path.join(directory, "workspace");
  await mkdir(workspacePath);
  const workspace = await realpath(workspacePath);
  const claudeHome = path.join(directory, "claude-home");
  const claudeExecutable = path.join(directory, "fake-claude.mjs");
  await writeFile(claudeExecutable, `#!/usr/bin/env node
const args = process.argv.slice(2);
const sessionIdIndex = args.indexOf("--session-id");
const resumeIndex = args.indexOf("--resume");
const sessionId = sessionIdIndex >= 0
  ? args[sessionIdIndex + 1]
  : resumeIndex >= 0
    ? args[resumeIndex + 1]
    : "session-1";
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
  emit({ type: "system", subtype: "init", session_id: sessionId, cwd: process.cwd() });
  emit({ type: "assistant", message: { role: "assistant", content: [
    { type: "text", text: "ok" },
  ] }, session_id: sessionId });
  emit({ type: "result", subtype: "success", is_error: false, session_id: sessionId });
});
`);
  await chmod(claudeExecutable, 0o755);
  const skillsDirectory = path.join(claudeHome, "skills", "real-skill");
  await mkdir(skillsDirectory, { recursive: true });
  await writeFile(path.join(skillsDirectory, "SKILL.md"), [
    "---",
    "name: real-skill",
    "description: Real skill",
    "---",
    "# Real skill",
  ].join("\n"));
  const localProjectDirectory = path.join(claudeHome, "projects", "local");
  await mkdir(localProjectDirectory, { recursive: true });
  await writeFile(path.join(localProjectDirectory, "session.jsonl"), JSON.stringify({
    type: "user",
    cwd: workspace,
    sessionId: "00000000-0000-0000-0000-000000000001",
    timestamp: new Date().toISOString(),
  }));
  const app = createTaskboardServer({
    dataDirectory: directory,
    claudeExecutable,
    claudeHome,
    skillPath: "/fixture/manage-taskboard/SKILL.md",
    processEnv: {
      ...process.env,
      CLAUDE_TASKBOARD_MODELS: JSON.stringify([{
        slug: "claude-real",
        displayName: "Claude Real",
        description: "",
        defaultReasoningEffort: "low",
        supportedReasoningEfforts: ["low", "high"],
      }]),
    },
  });
  const address = await app.listen({ host, port: 0 });
  return {
    app,
    baseUrl: `http://127.0.0.1:${address.port}`,
    directory,
    workspace,
    claudeHome,
    async close() {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function privateLanAddress() {
  return Object.values(os.networkInterfaces())
    .flat()
    .find((entry) => {
      if (entry?.family !== "IPv4" || entry.internal) return false;
      const [first, second] = entry.address.split(".").map(Number);
      return first === 10
        || (first === 172 && second >= 16 && second <= 31)
        || (first === 192 && second === 168)
        || (first === 169 && second === 254);
    })?.address;
}

async function requestFrom(address, port, pathname) {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({
      host: address,
      port,
      path: pathname,
      headers: { host: `${address}:${port}` },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      }));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

async function request(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: { "content-type": "application/json", ...options.headers },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : undefined };
}

test("loopback AI API freezes server-owned origin and rejects injected execution fields", async () => {
  const fixture = await createServerFixture();
  try {
    const meta = await request(fixture.baseUrl, "/api/meta");
    assert.equal(meta.body.capabilities.localAiChat, true);
    const catalog = await request(fixture.baseUrl, "/api/local/ai/catalog?projectId=local");
    assert.equal(catalog.response.status, 200);
    assert.equal(catalog.body.models[0].slug, "claude-real");
    assert.equal(catalog.body.skills[0].id, "real-skill");

    const injected = await request(fixture.baseUrl, "/api/local/ai/threads", {
      method: "POST",
      body: { projectId: "local", workspacePath: "/tmp/evil", argv: ["--dangerously-bypass-approvals-and-sandbox"] },
    });
    assert.equal(injected.response.status, 400);
    assert.equal(injected.body.error.code, "UNKNOWN_FIELD");

    const created = await request(fixture.baseUrl, "/api/local/ai/threads", {
      method: "POST",
      body: {
        projectId: "local",
        model: "claude-real",
        reasoningEffort: "high",
        sandbox: "read-only",
      },
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.thread.origin.workspacePath, fixture.workspace);
    const threadId = created.body.thread.id;

    const invalidSkill = await request(fixture.baseUrl, `/api/local/ai/threads/${threadId}/turns`, {
      method: "POST",
      body: { message: "hello \uFFFC", skillIds: ["invented-skill"] },
    });
    assert.equal(invalidSkill.response.status, 400);
    assert.equal(invalidSkill.body.error.code, "INVALID_SKILL");

    const turn = await request(fixture.baseUrl, `/api/local/ai/threads/${threadId}/turns`, {
      method: "POST",
      body: { message: "hello \uFFFC", skillIds: ["real-skill"] },
    });
    assert.equal(turn.response.status, 202);
    assert.equal(turn.body.run.threadId, threadId);

    let snapshot;
    for (let index = 0; index < 100; index += 1) {
      snapshot = await request(fixture.baseUrl, `/api/local/ai/threads/${threadId}`);
      if (snapshot.body.runs[0]?.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.match(
      snapshot.body.thread.claudeThreadId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    assert.equal(snapshot.body.events.some((event) => event.content === "ok"), true);
  } finally {
    await fixture.close();
  }
});

test("non-local AI threads reject projects without an available workspace", async () => {
  const fixture = await createServerFixture();
  try {
    const project = await request(fixture.baseUrl, "/api/projects", {
      method: "POST",
      body: {
        id: "missing-workspace",
        name: "Missing workspace",
        workspacePath: path.join(fixture.directory, "missing-workspace"),
      },
    });
    assert.equal(project.response.status, 201);

    const created = await request(fixture.baseUrl, "/api/local/ai/threads", {
      method: "POST",
      body: { projectId: "missing-workspace" },
    });
    assert.equal(created.response.status, 409);
    assert.equal(created.body.error.code, "PROJECT_WORKSPACE_UNAVAILABLE");
  } finally {
    await fixture.close();
  }
});

test("non-local AI turns reject a workspace that became unavailable", async () => {
  const fixture = await createServerFixture();
  try {
    const workspaceLink = path.join(fixture.directory, "project-workspace");
    await symlink(
      path.resolve(import.meta.dirname, ".."),
      workspaceLink,
      process.platform === "win32" ? "junction" : "dir",
    );
    const project = await request(fixture.baseUrl, "/api/projects", {
      method: "POST",
      body: {
        id: "disconnected-workspace",
        name: "Disconnected workspace",
        workspacePath: workspaceLink,
      },
    });
    assert.equal(project.response.status, 201);

    const created = await request(fixture.baseUrl, "/api/local/ai/threads", {
      method: "POST",
      body: { projectId: "disconnected-workspace" },
    });
    assert.equal(created.response.status, 201);
    const threadId = created.body.thread.id;
    await rm(workspaceLink);

    const turn = await request(fixture.baseUrl, `/api/local/ai/threads/${threadId}/turns`, {
      method: "POST",
      body: { message: "hello" },
    });
    assert.equal(turn.response.status, 409);
    assert.equal(turn.body.error.code, "PROJECT_WORKSPACE_UNAVAILABLE");

    const snapshot = await request(fixture.baseUrl, `/api/local/ai/threads/${threadId}`);
    assert.deepEqual(snapshot.body.runs, []);
  } finally {
    await fixture.close();
  }
});

test("the local AI project falls back to the Taskboard workspace", async () => {
  const fixture = await createServerFixture();
  try {
    await rm(path.join(fixture.claudeHome, "projects"), { recursive: true, force: true });

    const created = await request(fixture.baseUrl, "/api/local/ai/threads", {
      method: "POST",
      body: { projectId: "local" },
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.thread.origin.workspacePath, path.resolve(import.meta.dirname, ".."));
  } finally {
    await fixture.close();
  }
});

test("danger-full-access requires confirmation on every turn and thread settings are validated", async () => {
  const fixture = await createServerFixture();
  try {
    const created = await request(fixture.baseUrl, "/api/local/ai/threads", {
      method: "POST",
      body: {
        projectId: "local",
        model: "claude-real",
        reasoningEffort: "low",
        sandbox: "danger-full-access",
      },
    });
    assert.equal(created.response.status, 201);
    const threadId = created.body.thread.id;
    const denied = await request(fixture.baseUrl, `/api/local/ai/threads/${threadId}/turns`, {
      method: "POST",
      body: { message: "hello" },
    });
    assert.equal(denied.response.status, 400);
    assert.equal(denied.body.error.code, "DANGER_CONFIRMATION_REQUIRED");
    const allowed = await request(fixture.baseUrl, `/api/local/ai/threads/${threadId}/turns`, {
      method: "POST",
      body: { message: "hello", dangerFullAccessConfirmed: true },
    });
    assert.equal(allowed.response.status, 202);

    const invalidModel = await request(fixture.baseUrl, `/api/local/ai/threads/${threadId}`, {
      method: "PATCH",
      body: { model: "invented-model", reasoningEffort: "high" },
    });
    assert.equal(invalidModel.response.status, 400);
    assert.equal(invalidModel.body.error.code, "INVALID_MODEL");
  } finally {
    await fixture.close();
  }
});

test("thread management, interrupt and query contracts stay narrow", async () => {
  const fixture = await createServerFixture();
  try {
    const created = await request(fixture.baseUrl, "/api/local/ai/threads", {
      method: "POST",
      body: { projectId: "local", title: "Original" },
    });
    const threadId = created.body.thread.id;

    const list = await request(fixture.baseUrl, "/api/local/ai/threads");
    assert.equal(list.response.status, 200);
    assert.equal(list.body.threads.some((thread) => thread.id === threadId), true);

    const unknownQuery = await request(fixture.baseUrl, "/api/local/ai/threads?projectId=local");
    assert.equal(unknownQuery.response.status, 400);
    assert.equal(unknownQuery.body.error.code, "UNKNOWN_QUERY_PARAMETER");

    const updated = await request(fixture.baseUrl, `/api/local/ai/threads/${threadId}`, {
      method: "PATCH",
      body: { title: "Renamed", sandbox: "workspace-write" },
    });
    assert.equal(updated.response.status, 200);
    assert.equal(updated.body.thread.title, "Renamed");

    const interruptedMissing = await request(fixture.baseUrl, "/api/local/ai/runs/missing/interrupt", {
      method: "POST",
    });
    assert.equal(interruptedMissing.response.status, 404);

    const removed = await request(fixture.baseUrl, `/api/local/ai/threads/${threadId}`, {
      method: "DELETE",
    });
    assert.equal(removed.response.status, 204);
    const missing = await request(fixture.baseUrl, `/api/local/ai/threads/${threadId}`);
    assert.equal(missing.response.status, 404);
  } finally {
    await fixture.close();
  }
});

test("local AI routes reject private-LAN clients while ordinary API routes remain available", async (context) => {
  const address = privateLanAddress();
  if (!address) {
    context.skip("No private LAN interface is available");
    return;
  }
  const fixture = await createServerFixture("0.0.0.0");
  const port = fixture.app.server.address().port;
  try {
    const projects = await requestFrom(address, port, "/api/projects");
    assert.equal(projects.status, 200);
    const metadata = await requestFrom(address, port, "/api/meta");
    assert.equal(metadata.status, 200);
    assert.equal(metadata.body.capabilities.localAiChat, false);
    const ai = await requestFrom(address, port, "/api/local/ai/threads");
    assert.equal(ai.status, 403);
    assert.equal(ai.body.error.code, "LOCAL_AI_LOOPBACK_REQUIRED");
  } finally {
    await fixture.close();
  }
});

test("AI SSE is live-only and thread snapshots remain the durable source", async () => {
  const fixture = await createServerFixture();
  try {
    const created = await request(fixture.baseUrl, "/api/local/ai/threads", {
      method: "POST",
      body: { projectId: "local" },
    });
    const threadId = created.body.thread.id;
    const controller = new AbortController();
    const response = await fetch(`${fixture.baseUrl}/api/local/ai/threads/${threadId}/events`, {
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    let connected = "";
    while (!connected.includes("event: ai.event")) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      connected += new TextDecoder().decode(chunk.value);
    }
    assert.match(connected, /connected/);
    const turn = await request(fixture.baseUrl, `/api/local/ai/threads/${threadId}/turns`, {
      method: "POST",
      body: { message: "hello" },
    });
    assert.equal(turn.response.status, 202);
    let streamed = "";
    while (!streamed.includes("ai.event")) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      streamed += new TextDecoder().decode(chunk.value);
    }
    assert.match(streamed, /event: ai\.(event|run)/);
    controller.abort();
  } finally {
    await fixture.close();
  }
});

test("server close stops accepting requests before AI shutdown completes", async () => {
  const fixture = await createServerFixture();
  let appClosed = false;
  try {
    let releaseAiClose;
    const aiCloseGate = new Promise((resolve) => {
      releaseAiClose = resolve;
    });
    fixture.app.aiChat.close = () => aiCloseGate;

    const closing = fixture.app.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const acceptedDuringClose = await fetch(`${fixture.baseUrl}/health`)
      .then(() => true, () => false);
    releaseAiClose();
    await closing;
    appClosed = true;

    assert.equal(acceptedDuringClose, false);
  } finally {
    if (appClosed) {
      await rm(fixture.directory, { recursive: true, force: true });
    } else {
      await fixture.close();
    }
  }
});
