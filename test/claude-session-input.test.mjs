import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  extractPendingToolUses,
  formatAskUserQuestionAnswers,
  normalizePendingQuestions,
} from "../server/claude-session-transcript.mjs";
import { SessionRegistry } from "../server/session-registry.mjs";
import { createTaskboardServer } from "../server/app.mjs";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const BRIDGE_PATH = path.resolve("server", "tool-decision-bridge.mjs");

function assistantRecord(blocks) {
  return { type: "assistant", message: { role: "assistant", content: blocks } };
}

function toolResultRecord(toolUseId, content = "ok") {
  return { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content }] } };
}

test("extractPendingToolUses reports tool calls without a result", () => {
  const records = [
    assistantRecord([{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }]),
    toolResultRecord("t1"),
    assistantRecord([{ type: "tool_use", id: "t2", name: "AskUserQuestion", input: { questions: [] } }]),
  ];
  const pending = extractPendingToolUses(records);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, "t2");
  assert.equal(pending[0].name, "AskUserQuestion");
});

test("extractPendingToolUses ignores sidechain records", () => {
  const records = [
    { ...assistantRecord([{ type: "tool_use", id: "s1", name: "Bash", input: {} }]), isSidechain: true },
  ];
  assert.deepEqual(extractPendingToolUses(records), []);
});

test("normalizePendingQuestions mirrors AskUserQuestion options and multiSelect", () => {
  const questions = normalizePendingQuestions({
    questions: [{
      question: "Tea or coffee?",
      header: "Drink",
      multiSelect: true,
      options: [
        { label: "Tea", description: "hot leaf" },
        { label: "Coffee" },
      ],
    }],
  });
  assert.equal(questions.length, 1);
  assert.equal(questions[0].multiSelect, true);
  assert.deepEqual(questions[0].options, [
    { label: "Tea", description: "hot leaf" },
    { label: "Coffee", description: null },
  ]);
  assert.equal(normalizePendingQuestions({ questions: [{ question: "?", options: [] }] }), null);
  assert.equal(normalizePendingQuestions(null), null);
});

test("formatAskUserQuestionAnswers phrases answers like Claude Code's own results", () => {
  const reason = formatAskUserQuestionAnswers([
    { question: "Tea or coffee?", selections: ["Coffee"], custom: null },
    { question: "Snacks?", selections: ["Cake"], custom: "also biscuits" },
  ]);
  assert.equal(
    reason,
    'User answered via taskboard: "Tea or coffee?"="Coffee", "Snacks?"="Cake, Other: also biscuits". '
      + "Treat these as the user's actual answers and continue; do not call AskUserQuestion again for these questions.",
  );
  assert.equal(formatAskUserQuestionAnswers([]), null);
  assert.equal(formatAskUserQuestionAnswers([{ question: "?", selections: [], custom: "" }]), null);
});

test("Notification attention is set and cleared by Stop/SessionEnd", () => {
  const registry = new SessionRegistry();
  const id = "44444444-4444-4444-8444-444444444444";
  registry.record({ hook_event_name: "SessionStart", session_id: id, cwd: "/w" }, []);
  registry.record({
    hook_event_name: "Notification",
    session_id: id,
    cwd: "/w",
    message: "Claude needs your permission to use Bash",
  }, []);
  assert.equal(registry.get(id).attention.message, "Claude needs your permission to use Bash");
  registry.record({ hook_event_name: "Stop", session_id: id, cwd: "/w" }, []);
  assert.equal(registry.get(id).attention, null);
  registry.record({
    hook_event_name: "Notification",
    session_id: id,
    cwd: "/w",
    message: "Claude needs your permission to use WebFetch",
  }, []);
  registry.record({ hook_event_name: "SessionEnd", session_id: id, cwd: "/w" }, []);
  assert.equal(registry.get(id).attention, null);
});

test("pre-tool-use broker holds AskUserQuestion and resolves it with the user's answer", async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "claude-session-input-"));
  const app = createTaskboardServer({
    dataDirectory,
    claudeHome: path.join(dataDirectory, "claude-home"),
    processEnv: { ...process.env, CLAUDE_TASKBOARD_DATA_DIR: dataDirectory },
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${address.port}`;
  const sessionId = "55555555-5555-4555-8555-555555555555";
  try {
    // Non-AskUserQuestion calls pass straight through.
    const passthrough = await fetch(`${base}/api/local/hooks/pre-tool-use`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, tool_name: "Bash", tool_input: { command: "ls" } }),
    });
    assert.deepEqual(await passthrough.json(), { decision: null });

    // The brokered question holds the hook open until the board answers.
    const held = fetch(`${base}/api/local/hooks/pre-tool-use`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        tool_name: "AskUserQuestion",
        tool_input: { questions: [{ question: "Tea or coffee?", options: [{ label: "Tea" }, { label: "Coffee" }] }] },
      }),
    });

    // Answers can be addressed by thread, which is what the preview window knows.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const answered = await fetch(`${base}/api/local/claude-session-answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        threadId: sessionId,
        answers: [{ question: "Tea or coffee?", selections: ["Coffee"], custom: null }],
      }),
    });
    assert.equal(answered.status, 200);
    const decision = await (await held).json();
    assert.equal(decision.decision.permissionDecision, "deny");
    assert.match(decision.decision.permissionDecisionReason, /"Tea or coffee\?"="Coffee"/);
    assert.match(decision.decision.permissionDecisionReason, /Treat these as the user's actual answers/);

    // The answered question is gone: a second answer request 404s.
    const stale = await fetch(`${base}/api/local/claude-session-answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        threadId: sessionId,
        answers: [{ question: "Tea or coffee?", selections: ["Tea"], custom: null }],
      }),
    });
    assert.equal(stale.status, 404);
  } finally {
    await app.close();
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("tool-decision-bridge prints the board decision for a brokered call", async () => {
  // Minimal stand-in for the board endpoint: echoes a fixed decision.
  const { createServer } = await import("node:http");
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => raw += chunk);
    request.on("end", () => {
      const payload = JSON.parse(raw);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        decision: {
          permissionDecision: "deny",
          permissionDecisionReason: `echo:${payload.tool_name}`,
        },
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const stdout = await new Promise((resolve, reject) => {
      execFile(
        process.execPath,
        [BRIDGE_PATH, "--url", `http://127.0.0.1:${port}`],
        { env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(os.tmpdir(), "claude-session-input-home") } },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      ).stdin.end(JSON.stringify({ session_id: "66666666-6666-4666-8666-666666666666", tool_name: "AskUserQuestion", tool_input: {} }));
    });
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
    assert.equal(parsed.hookSpecificOutput.permissionDecisionReason, "echo:AskUserQuestion");
  } finally {
    server.close();
  }
});

test("tool-decision-bridge stays silent when the board is unreachable", async () => {
  const bridgeUrl = fileURLToPath(new URL("../server/tool-decision-bridge.mjs", import.meta.url));
  const stdout = await new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [bridgeUrl, "--url", "http://127.0.0.1:1"],
      { env: { ...process.env } },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    ).stdin.end(JSON.stringify({ session_id: "77777777-7777-4777-8777-777777777777", tool_name: "AskUserQuestion", tool_input: {} }));
  });
  assert.equal(stdout, "");
});
