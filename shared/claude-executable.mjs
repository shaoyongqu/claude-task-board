import { accessSync, constants } from "node:fs";
import os from "node:os";
import path from "node:path";

function executableFile(candidate) {
  try {
    accessSync(candidate, constants.X_OK);
    return candidate;
  } catch {
    return null;
  }
}

function npmPackageEntries(directory, platform) {
  const packageDirectory = path.join(
    directory,
    "node_modules",
    "@anthropic-ai",
    "claude-code",
  );
  const candidates = platform === "win32"
    ? [
      path.join(packageDirectory, "bin", "claude.exe"),
      path.join(packageDirectory, "cli.js"),
      path.join(packageDirectory, "cli-wrapper.cjs"),
    ]
    : [
      path.join(packageDirectory, "bin", "claude"),
      path.join(packageDirectory, "cli.js"),
    ];
  return candidates;
}

function executableOnPath(env, platform) {
  for (const directory of (env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    if (platform === "win32") {
      const nativeExecutable = executableFile(path.join(directory, "claude.exe"));
      if (nativeExecutable) return nativeExecutable;
    } else {
      const executable = executableFile(path.join(directory, "claude"));
      if (executable) return executable;
    }
    for (const candidate of npmPackageEntries(directory, platform)) {
      const entry = executableFile(candidate);
      if (entry) return entry;
    }
  }
  return null;
}

export function resolveClaudeExecutable({
  explicit = process.env.CLAUDE_EXECUTABLE,
  env = process.env,
  platform = process.platform,
  homeDirectory = os.homedir(),
} = {}) {
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();

  const installedCli = executableOnPath(env, platform);
  if (installedCli) return installedCli;

  if (platform === "win32") {
    for (const candidate of npmPackageEntries(
      path.join(homeDirectory, "AppData", "Roaming", "npm"),
      platform,
    )) {
      const entry = executableFile(candidate);
      if (entry) return entry;
    }

    const nativeInstaller = executableFile(path.join(
      homeDirectory,
      ".local",
      "bin",
      "claude.exe",
    ));
    if (nativeInstaller) return nativeInstaller;
  } else {
    for (const candidate of npmPackageEntries(
      path.join(homeDirectory, ".npm-global"),
      platform,
    )) {
      const entry = executableFile(candidate);
      if (entry) return entry;
    }
    const nativeInstaller = executableFile(path.join(homeDirectory, ".local", "bin", "claude"));
    if (nativeInstaller) return nativeInstaller;
  }

  return "claude";
}
