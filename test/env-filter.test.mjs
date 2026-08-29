import assert from "node:assert/strict";
import { test } from "node:test";

import { spawnClaudeTurn } from "../server/ai-chat-process.mjs";
import { resolveClaudeExecutable } from "../shared/claude-executable.mjs";

test("spawned claude turns keep the quota command env var", async () => {
  // The launcher-env filter used to strip every CLAUDE_TASKBOARD_* variable,
  // including CLAUDE_TASKBOARD_QUOTA_COMMAND, so the quota route inside a
  // spawned-session context always reported not-configured. It must survive.
  const executable = resolveClaudeExecutable();
  let captured = null;
  const { child, completion } = spawnClaudeTurn({
    executable,
    args: ["--version"],
    prompt: "",
    env: { ...process.env, CLAUDE_TASKBOARD_QUOTA_COMMAND: "should-survive" },
    cwd: process.cwd(),
    extraEnv: {},
    onRawEvent: () => {},
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  await completion.catch(() => {});
  // Indirect check: withoutTaskboardLauncherEnvironment is applied inside
  // spawnClaudeTurn; verify the filter itself preserves the quota var.
  const { withoutTaskboardLauncherEnvironment } = await import("../shared/taskboard-environment.mjs");
  captured = withoutTaskboardLauncherEnvironment({
    CLAUDE_TASKBOARD_QUOTA_COMMAND: "should-survive",
    CLAUDE_TASKBOARD_PORT: "1234",
    PATH: process.env.PATH,
  });
  assert.equal(captured.CLAUDE_TASKBOARD_QUOTA_COMMAND, "should-survive");
  assert.equal(captured.CLAUDE_TASKBOARD_PORT, undefined);
});
