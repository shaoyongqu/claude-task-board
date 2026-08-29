export function withoutTaskboardLauncherEnvironment(environment = process.env) {
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => !name.startsWith("CLAUDE_TASKBOARD_")),
  );
}
