#!/usr/bin/env node
// Claude Code hooks bridge. Registered for SessionStart/SessionEnd/Stop in
// each configured project workspace's .claude/settings.json. Reads the hook
// payload from stdin and forwards it to the board's /api/local/hooks/event.
// Never fails loudly: a broken bridge must not block the Claude session.
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_500);
  timer.unref();
  try {
    await fetch(`${resolveBoardUrl()}/api/local/hooks/event`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch {}
}

main().finally(() => process.exit(0));
