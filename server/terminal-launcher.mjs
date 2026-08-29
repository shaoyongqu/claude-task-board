// Launches an interactive Claude Code session in a real terminal window on
// the user's desktop. Windows Terminal first, cmd.exe windows as fallback;
// when no terminal can be spawned the caller receives the command to copy.
import { spawn } from "node:child_process";

export function claudeArgs({ sessionId, prompt }) {
  const args = [];
  if (typeof sessionId === "string" && sessionId.trim()) {
    args.push("--resume", sessionId.trim());
  } else if (typeof prompt === "string" && prompt.trim()) {
    args.push(prompt.trim());
  }
  return args;
}

function trySpawn(executable, args, { cwd }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(executable, args, {
        cwd,
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => resolve(false), 2_500);
    timer.unref();
    child.once("spawn", () => {
      clearTimeout(timer);
      child.unref();
      resolve(true);
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

export function displayCommand(workspacePath, claudeCommand, args) {
  const tail = args.length > 0 ? ` ${args.join(" ")}` : "";
  return `${claudeCommand}${tail}   # in ${workspacePath}`;
}

export async function launchTerminalSession({
  workspacePath,
  sessionId,
  prompt,
  claudeCommand = process.env.CLAUDE_TASKBOARD_CLAUDE_COMMAND || "claude",
  platform = process.platform,
  spawnAttempt = trySpawn,
}) {
  const args = claudeArgs({ sessionId, prompt });
  const display = displayCommand(workspacePath, claudeCommand, args);

  const attempts = platform === "win32"
    ? [
      {
        terminal: "wt",
        run: () => spawnAttempt("wt.exe", [
          "-d", workspacePath,
          "cmd", "/k", claudeCommand, ...args,
        ], { cwd: workspacePath }),
      },
      {
        terminal: "cmd",
        run: () => spawnAttempt("cmd.exe", [
          "/c", "start", "Claude Task Board", "/D", workspacePath,
          "cmd", "/k", claudeCommand, ...args,
        ], { cwd: workspacePath }),
      },
    ]
    : [
      { terminal: "gnome-terminal", run: () => spawnAttempt("gnome-terminal", [`--working-directory=${workspacePath}`, "--", claudeCommand, ...args], { cwd: workspacePath }) },
      { terminal: "konsole", run: () => spawnAttempt("konsole", ["--workdir", workspacePath, "-e", claudeCommand, ...args], { cwd: workspacePath }) },
      { terminal: "kitty", run: () => spawnAttempt("kitty", ["--directory", workspacePath, claudeCommand, ...args], { cwd: workspacePath }) },
      { terminal: "wezterm", run: () => spawnAttempt("wezterm", ["start", "--cwd", workspacePath, "--", claudeCommand, ...args], { cwd: workspacePath }) },
      { terminal: "xterm", run: () => spawnAttempt("xterm", ["-e", claudeCommand, ...args], { cwd: workspacePath }) },
    ];

  for (const attempt of attempts) {
    if (await attempt.run()) {
      return { launched: true, terminal: attempt.terminal, command: display };
    }
  }
  return { launched: false, terminal: null, command: display };
}
