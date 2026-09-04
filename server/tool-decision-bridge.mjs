#!/usr/bin/env node
// Claude Code PreToolUse bridge for AskUserQuestion. Registered for the
// "AskUserQuestion" matcher in each configured project workspace's
// .claude/settings.json. Forwards the tool call to the board's
// /api/local/hooks/pre-tool-use endpoint and holds the hook open while a user
// answers in the board UI (long poll). Prints a permissionDecision only when
// the board supplies one; every failure path prints nothing, which falls
// through to Claude Code's normal permission flow so a broken bridge can never
// block the session.
function resolveBoardUrl() {
  const argvIndex = process.argv.indexOf("--url");
  if (argvIndex >= 0 && process.argv[argvIndex + 1]) {
    return process.argv[argvIndex + 1].trim().replace(/\/+$/, "");
  }
  if (typeof process.env.CLAUDE_TASKBOARD_URL === "string" && process.env.CLAUDE_TASKBOARD_URL.trim()) {
    return process.env.CLAUDE_TASKBOARD_URL.trim().replace(/\/+$/, "");
  }
  return "http://127.0.0.1:47823";
}

// Kept under the 600s default PreToolUse command-hook budget so the hook's own
// timeout never discards our answer mid-flight; a timeout there is harmless
// (output discarded, normal permission flow resumes).
const DECISION_TIMEOUT_MS = 540_000;

async function main() {
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }
  if (!payload || typeof payload !== "object") return;

  let body;
  try {
    const response = await fetch(`${resolveBoardUrl()}/api/local/hooks/pre-tool-use`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(DECISION_TIMEOUT_MS),
    });
    body = await response.json();
  } catch {
    return;
  }
  if (body?.decision?.permissionDecision) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: body.decision.permissionDecision,
        ...(typeof body.decision.permissionDecisionReason === "string"
          ? { permissionDecisionReason: body.decision.permissionDecisionReason }
          : {}),
      },
    }));
  }
}

main().finally(() => process.exit(0));
