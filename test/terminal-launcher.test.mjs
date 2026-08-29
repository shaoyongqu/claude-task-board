import assert from "node:assert/strict";
import { test } from "node:test";

import {
  claudeArgs,
  displayCommand,
  launchTerminalSession,
} from "../server/terminal-launcher.mjs";

function fakeSpawner(results) {
  const calls = [];
  let index = 0;
  const attempt = async (executable, args, options) => {
    calls.push({ executable, args, options });
    const result = results[Math.min(index, results.length - 1)];
    index += 1;
    return result;
  };
  return { attempt, calls };
}

test("claudeArgs builds resume or prompt invocations", () => {
  assert.deepEqual(claudeArgs({ sessionId: "abcd" }), ["--resume", "abcd"]);
  assert.deepEqual(claudeArgs({ prompt: "fix the bug" }), ["fix the bug"]);
  assert.deepEqual(claudeArgs({}), []);
});

test("launchTerminalSession tries Windows Terminal then cmd on win32", async () => {
  const { attempt, calls } = fakeSpawner([false, true]);
  const result = await launchTerminalSession({
    workspacePath: "C:\\work\\demo",
    sessionId: "session-1",
    claudeCommand: "claude",
    platform: "win32",
    spawnAttempt: attempt,
  });
  assert.equal(result.launched, true);
  assert.equal(result.terminal, "cmd");
  assert.equal(calls[0].executable, "wt.exe");
  assert.deepEqual(calls[0].args, ["-d", "C:\\work\\demo", "cmd", "/k", "claude", "--resume", "session-1"]);
  assert.deepEqual(calls[1].args, [
    "/c", "start", "Claude Task Board", "/D", "C:\\work\\demo",
    "cmd", "/k", "claude", "--resume", "session-1",
  ]);
  assert.match(result.command, /claude --resume session-1/);
});

test("launchTerminalSession reports a copyable command when no terminal exists", async () => {
  const { attempt } = fakeSpawner([false, false]);
  const result = await launchTerminalSession({
    workspacePath: "C:\\work\\demo",
    prompt: "process ISSUE-1",
    claudeCommand: "claude",
    platform: "win32",
    spawnAttempt: attempt,
  });
  assert.equal(result.launched, false);
  assert.equal(result.terminal, null);
  assert.match(result.command, /claude process ISSUE-1/);
  assert.match(result.command, /C:\\work\\demo/);
});

test("displayCommand is stable and readable", () => {
  assert.equal(
    displayCommand("/w", "claude", ["--resume", "x"]),
    "claude --resume x   # in /w",
  );
});
