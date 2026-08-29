// Installer for the per-workspace Claude Code integration files:
//   .mcp.json                     -> board MCP server registration
//   .claude/settings.json         -> SessionStart/SessionEnd/Stop hooks
//   .claude/commands/*.md         -> /e-taskboard and /taskboard-status
//
// All writes are idempotent and surgical: existing user configuration is
// preserved, only entries owned by this board (identified by the
// hooks-bridge/mcp file paths) are added or removed, and the first
// modification of a pre-existing file leaves a .claude-task-board.bak copy.
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MCP_SERVER_PATH = path.join(projectRoot, "server", "mcp.mjs");
const HOOKS_BRIDGE_PATH = path.join(projectRoot, "server", "hooks-bridge.mjs");
const SKILL_SOURCE = path.join(projectRoot, "skills", "manage-taskboard");
const MCP_SERVER_KEY = "claude-task-board";
const BACKUP_SUFFIX = ".claude-task-board.bak";
const HOOK_EVENTS = ["SessionStart", "SessionEnd", "Stop"];

const E_TASKBOARD_COMMAND = `---
description: 处理一个看板议题——读取、认领、实现、验证并推进状态 / Work a Task Board issue end to end
argument-hint: <议题编号，如 ABC-1> [补充说明]
allowed-tools: Bash, Read, Grep, Glob
---

使用 manage-taskboard 技能完整处理看板议题 **$0**：

1. 用 issue_get 读取议题与全部评论（可用 MCP 工具或 \`node ${path.join(projectRoot, "cli", "taskctl.mjs")} issue get $0 --json\`）。
2. 按技能规则认领（todo → in_progress，携带完整绑定）；若评论要求等待则停止并报告。
3. 实现描述中的工作并验证；补充说明：$1
4. 用 comment_add 记录改动与验证结果，再把议题移到 in_review。不要自行标记 done。

$ARGUMENTS
`;

const TASKBOARD_STATUS_COMMAND = `---
description: 汇报当前项目的看板状态 / Report the board status of this project
allowed-tools: Bash
---

使用 manage-taskboard 技能查看当前项目的看板状态并简要汇报：

1. 读取各状态的议题列表（可用 MCP 工具 issue_list 或 \`node ${path.join(projectRoot, "cli", "taskctl.mjs")} issue list --json\`）。
2. 按「待办 / 处理中（含会话）/ 等你确认 / 遇到阻碍」分组汇总，每条一行：编号、标题、关键风险。
3. 如有 in_review 议题，提醒用户验收。

$ARGUMENTS
`;

function normalizeForCompare(value) {
  return String(value ?? "").replace(/\\/g, "/").toLowerCase();
}

function ownsHookEntry(hook) {
  return hook?.type === "command"
    && typeof hook.command === "string"
    && normalizeForCompare(hook.command).includes("hooks-bridge.mjs");
}

function ownsHookGroup(group) {
  return Array.isArray(group?.hooks) && group.hooks.some(ownsHookEntry);
}

function quote(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function hookCommand(boardUrl) {
  return [
    quote(process.execPath),
    quote(HOOKS_BRIDGE_PATH),
    "--url",
    boardUrl,
  ].join(" ");
}

function mcpServerEntry(boardUrl) {
  return {
    command: process.execPath,
    args: [MCP_SERVER_PATH],
    env: { CLAUDE_TASKBOARD_URL: boardUrl },
  };
}

async function readJsonFile(filePath) {
  try {
    const source = await readFile(filePath, "utf8");
    const parsed = JSON.parse(source);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {}
  return null;
}

async function writeJsonFile(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function backupOnce(filePath) {
  try {
    await stat(filePath);
  } catch {
    return;
  }
  const backupPath = `${filePath}${BACKUP_SUFFIX}`;
  try {
    await stat(backupPath);
  } catch {
    await writeFile(backupPath, await readFile(filePath, "utf8"), "utf8");
  }
}

export async function projectIntegrationStatus(workspacePath) {
  const mcpConfig = await readJsonFile(path.join(workspacePath, ".mcp.json"));
  const settings = await readJsonFile(path.join(workspacePath, ".claude", "settings.json"));
  const hooks = settings?.hooks ?? {};
  const commandPaths = {
    eTaskboard: path.join(workspacePath, ".claude", "commands", "e-taskboard.md"),
    taskboardStatus: path.join(workspacePath, ".claude", "commands", "taskboard-status.md"),
  };
  const hooksStatus = {};
  for (const event of HOOK_EVENTS) {
    const groups = hooks[event];
    hooksStatus[event] = Array.isArray(groups) && groups.some(ownsHookGroup);
  }
  const commands = {};
  for (const [key, filePath] of Object.entries(commandPaths)) {
    commands[key] = await stat(filePath).then(() => true, () => false);
  }
  const mcp = Boolean(mcpConfig?.mcpServers?.[MCP_SERVER_KEY]);
  return {
    workspacePath,
    mcp,
    hooks: {
      sessionStart: hooksStatus.SessionStart,
      sessionEnd: hooksStatus.SessionEnd,
      stop: hooksStatus.Stop,
    },
    commands,
    configured: mcp
      && hooksStatus.SessionStart
      && hooksStatus.SessionEnd
      && hooksStatus.Stop
      && commands.eTaskboard
      && commands.taskboardStatus,
  };
}

export async function setupProjectIntegration({ workspacePath, boardUrl }) {
  const normalizedUrl = String(boardUrl).replace(/\/+$/, "");
  const wrote = [];

  // .mcp.json
  const mcpPath = path.join(workspacePath, ".mcp.json");
  const existingMcp = await readJsonFile(mcpPath);
  const nextMcp = {
    ...(existingMcp ?? {}),
    mcpServers: {
      ...(existingMcp?.mcpServers ?? {}),
      [MCP_SERVER_KEY]: mcpServerEntry(normalizedUrl),
    },
  };
  if (JSON.stringify(nextMcp) !== JSON.stringify(existingMcp)) {
    if (existingMcp) await backupOnce(mcpPath);
    await writeJsonFile(mcpPath, nextMcp);
    wrote.push(".mcp.json");
  }

  // .claude/settings.json hooks
  const settingsPath = path.join(workspacePath, ".claude", "settings.json");
  const existingSettings = await readJsonFile(settingsPath);
  const existingHooks = existingSettings?.hooks ?? {};
  const nextHooks = {};
  let hooksChanged = false;
  for (const [event, groups] of Object.entries(existingHooks)) {
    if (!Array.isArray(groups)) {
      nextHooks[event] = groups;
      continue;
    }
    const kept = groups.filter((group) => !ownsHookGroup(group));
    const ours = { hooks: [{ type: "command", command: hookCommand(normalizedUrl) }] };
    const oursCommand = ours.hooks[0].command;
    const ownedGroups = groups.filter(ownsHookGroup);
    // Unchanged only when exactly one owned group exists and it already uses
    // the current command (kept already excludes every owned group, so a
    // length equality check can never succeed here).
    const installedCleanly = ownedGroups.length === 1
      && Array.isArray(ownedGroups[0].hooks)
      && ownedGroups[0].hooks.some((hook) => hook?.command === oursCommand);
    if (installedCleanly) {
      nextHooks[event] = groups;
    } else {
      nextHooks[event] = [...kept, ours];
      hooksChanged = true;
    }
  }
  for (const event of HOOK_EVENTS) {
    if (nextHooks[event]) continue;
    nextHooks[event] = [{ hooks: [{ type: "command", command: hookCommand(normalizedUrl) }] }];
    hooksChanged = true;
  }
  if (hooksChanged || !existingSettings) {
    if (existingSettings) await backupOnce(settingsPath);
    await writeJsonFile(settingsPath, { ...(existingSettings ?? {}), hooks: nextHooks });
    wrote.push(".claude/settings.json");
  }

  // slash commands
  const commands = {
    "e-taskboard.md": E_TASKBOARD_COMMAND,
    "taskboard-status.md": TASKBOARD_STATUS_COMMAND,
  };
  for (const [name, content] of Object.entries(commands)) {
    const filePath = path.join(workspacePath, ".claude", "commands", name);
    let current = null;
    try {
      current = await readFile(filePath, "utf8");
    } catch {}
    if (current !== content) {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, content, "utf8");
      wrote.push(`.claude/commands/${name}`);
    }
  }

  return { wrote, status: await projectIntegrationStatus(workspacePath) };
}

export async function removeProjectIntegration({ workspacePath }) {
  const removed = [];

  const mcpPath = path.join(workspacePath, ".mcp.json");
  const existingMcp = await readJsonFile(mcpPath);
  if (existingMcp?.mcpServers?.[MCP_SERVER_KEY]) {
    const servers = { ...existingMcp.mcpServers };
    delete servers[MCP_SERVER_KEY];
    await backupOnce(mcpPath);
    await writeJsonFile(mcpPath, { ...existingMcp, mcpServers: servers });
    removed.push(".mcp.json");
  }

  const settingsPath = path.join(workspacePath, ".claude", "settings.json");
  const existingSettings = await readJsonFile(settingsPath);
  if (existingSettings?.hooks) {
    const nextHooks = {};
    let changed = false;
    for (const [event, groups] of Object.entries(existingSettings.hooks)) {
      if (!Array.isArray(groups)) {
        nextHooks[event] = groups;
        continue;
      }
      const kept = groups.filter((group) => !ownsHookGroup(group));
      if (kept.length !== groups.length) changed = true;
      if (kept.length > 0) nextHooks[event] = kept;
    }
    if (changed) {
      await backupOnce(settingsPath);
      await writeJsonFile(settingsPath, { ...existingSettings, hooks: nextHooks });
      removed.push(".claude/settings.json");
    }
  }

  for (const name of ["e-taskboard.md", "taskboard-status.md"]) {
    const filePath = path.join(workspacePath, ".claude", "commands", name);
    if (await stat(filePath).then(() => true, () => false)) {
      await rm(filePath, { force: true });
      removed.push(`.claude/commands/${name}`);
    }
  }

  return { removed, status: await projectIntegrationStatus(workspacePath) };
}

export function claudeHomeDirectory(env = process.env) {
  if (typeof env.CLAUDE_CONFIG_DIR === "string" && env.CLAUDE_CONFIG_DIR.trim()) {
    return env.CLAUDE_CONFIG_DIR.trim();
  }
  return path.join(os.homedir(), ".claude");
}

export async function installManageTaskboardSkill(env = process.env) {
  const target = path.join(claudeHomeDirectory(env), "skills", "manage-taskboard");
  await rm(target, { recursive: true, force: true });
  await mkdir(path.dirname(target), { recursive: true });
  await cp(SKILL_SOURCE, target, { recursive: true });
  return { installed: true, path: target };
}

export async function manageTaskboardSkillInstalled(env = process.env) {
  return stat(path.join(claudeHomeDirectory(env), "skills", "manage-taskboard", "SKILL.md"))
    .then(() => true, () => false);
}

// Auto-setup policy: board-managed workspaces live under the PC-wide default
// root and get the integration files without asking; external repositories
// are only configured on explicit request.
export function isBoardManagedWorkspace(workspacePath, { env = process.env, home = os.homedir() } = {}) {
  if (typeof workspacePath !== "string" || !workspacePath) return false;
  const configured = env.CLAUDE_TASKBOARD_WORKSPACE_ROOT;
  const root = configured && configured.trim()
    ? path.resolve(configured.trim())
    : path.join(home, "Claude Task Board", "workspaces");
  return normalizeForCompare(workspacePath).startsWith(normalizeForCompare(root));
}
