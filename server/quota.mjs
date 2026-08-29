// Quota provider for the automation scheduler. Claude Code has no built-in
// quota API, so the board shells out to a user-configured command (e.g. a
// ccswitch-style CLI) that prints JSON on stdout:
//   { "state": "available" | "blocked" | "unknown", "resetsAt": "ISO-8601" }
// Configure it with CLAUDE_TASKBOARD_QUOTA_COMMAND. Results are cached for
// one minute; failures degrade to "unknown" and never crash the caller.
import { exec } from "node:child_process";

const CACHE_TTL_MS = 60_000;
const COMMAND_TIMEOUT_MS = 15_000;

let cache = null;

export function resetQuotaCacheForTests() {
  cache = null;
}

function normalizeState(value) {
  return value === "available" || value === "blocked" || value === "unknown"
    ? value
    : null;
}

export function parseQuotaOutput(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const state = normalizeState(parsed.state);
    if (!state) return null;
    return {
      state,
      ...(typeof parsed.resetsAt === "string" && parsed.resetsAt
        ? { resetsAt: parsed.resetsAt }
        : {}),
    };
  } catch {
    return null;
  }
}

export async function getQuotaStatus(env = process.env) {
  const command = typeof env.CLAUDE_TASKBOARD_QUOTA_COMMAND === "string"
    ? env.CLAUDE_TASKBOARD_QUOTA_COMMAND.trim()
    : "";
  if (!command) {
    return { state: "unavailable", checkedAt: Date.now(), reason: "not-configured" };
  }
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.status;

  const status = await new Promise((resolve) => {
    const child = exec(command, { timeout: COMMAND_TIMEOUT_MS }, (error, stdout) => {
      if (error) {
        resolve({ state: "unknown", checkedAt: Date.now(), reason: "command-failed" });
        return;
      }
      const parsed = parseQuotaOutput(stdout);
      resolve(parsed
        ? { ...parsed, checkedAt: Date.now() }
        : { state: "unknown", checkedAt: Date.now(), reason: "invalid-output" });
    });
    child.on("error", () => {
      resolve({ state: "unknown", checkedAt: Date.now(), reason: "command-failed" });
    });
  });
  cache = { at: Date.now(), status };
  return status;
}
