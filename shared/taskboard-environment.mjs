// Board-spawned claude processes get a filtered environment so launcher-only
// runtime variables do not leak in. Server configuration that spawned
// sessions legitimately need (the quota command) is preserved.
const PRESERVED_ENV_VARS = new Set(["CLAUDE_TASKBOARD_QUOTA_COMMAND"]);

export function withoutTaskboardLauncherEnvironment(environment = process.env) {
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => (
      !name.startsWith("CLAUDE_TASKBOARD_") || PRESERVED_ENV_VARS.has(name)
    )),
  );
}
