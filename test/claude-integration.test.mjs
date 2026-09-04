import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  isBoardManagedWorkspace,
  projectIntegrationStatus,
  removeProjectIntegration,
  setupProjectIntegration,
} from "../server/claude-integration.mjs";

const BOARD_URL = "http://127.0.0.1:47823";

async function createWorkspace() {
  return mkdtemp(path.join(os.tmpdir(), "claude-integration-"));
}

test("setup writes the integration artifacts into a fresh workspace", async () => {
  const workspace = await createWorkspace();
  try {
    const { wrote, status } = await setupProjectIntegration({ workspacePath: workspace, boardUrl: BOARD_URL });
    assert.deepEqual([...wrote].sort(), [".claude/commands/e-taskboard.md", ".claude/commands/taskboard-status.md", ".claude/settings.json", ".mcp.json"]);
    assert.equal(status.configured, true);
    assert.equal(status.mcp, true);
    assert.deepEqual(status.hooks, { sessionStart: true, sessionEnd: true, stop: true, notification: true, preToolUse: true });
    assert.deepEqual(status.commands, { eTaskboard: true, taskboardStatus: true });

    const mcp = JSON.parse(await readFile(path.join(workspace, ".mcp.json"), "utf8"));
    assert.equal(mcp.mcpServers["claude-task-board"].command, process.execPath);
    assert.equal(mcp.mcpServers["claude-task-board"].env.CLAUDE_TASKBOARD_URL, BOARD_URL);

    const settings = JSON.parse(await readFile(path.join(workspace, ".claude", "settings.json"), "utf8"));
    for (const event of ["SessionStart", "SessionEnd", "Stop", "Notification", "PreToolUse"]) {
      const group = settings.hooks[event][0];
      assert.match(group.hooks[0].command, /(hooks-bridge|tool-decision-bridge)\.mjs/);
      assert.match(group.hooks[0].command, new RegExp(BOARD_URL.replaceAll(".", "\\.")));
    }
    assert.equal(settings.hooks.Notification[0].matcher, "permission_prompt");
    assert.match(settings.hooks.Notification[0].hooks[0].command, /hooks-bridge\.mjs/);
    assert.equal(settings.hooks.PreToolUse[0].matcher, "AskUserQuestion");
    assert.match(settings.hooks.PreToolUse[0].hooks[0].command, /tool-decision-bridge\.mjs/);

    const command = await readFile(path.join(workspace, ".claude", "commands", "e-taskboard.md"), "utf8");
    assert.match(command, /\$0/);
    assert.match(command, /manage-taskboard/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("setup is idempotent and preserves unrelated user configuration", async () => {
  const workspace = await createWorkspace();
  try {
    await writeFile(path.join(workspace, ".mcp.json"), JSON.stringify({
      mcpServers: {
        other: { command: "npx", args: ["-y", "other-server"] },
      },
    }, null, 2));
    await mkdir(path.join(workspace, ".claude"), { recursive: true });
    await writeFile(path.join(workspace, ".claude", "settings.json"), JSON.stringify({
      model: "opus",
      hooks: {
        SessionStart: [
          { matcher: "*", hooks: [{ type: "command", command: "echo user-hook" }] },
        ],
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "echo guard" }] },
        ],
      },
    }, null, 2));

    await setupProjectIntegration({ workspacePath: workspace, boardUrl: BOARD_URL });
    const second = await setupProjectIntegration({ workspacePath: workspace, boardUrl: BOARD_URL });
    assert.deepEqual(second.wrote, []);

    const mcp = JSON.parse(await readFile(path.join(workspace, ".mcp.json"), "utf8"));
    assert.equal(mcp.mcpServers.other.command, "npx");
    assert.ok(mcp.mcpServers["claude-task-board"]);

    const settings = JSON.parse(await readFile(path.join(workspace, ".claude", "settings.json"), "utf8"));
    assert.equal(settings.model, "opus");
    assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, "echo guard");
    assert.equal(settings.hooks.SessionStart.length, 2);
    assert.ok(settings.hooks.SessionStart.some((group) => group.hooks[0].command === "echo user-hook"));

    // First modification backed up the user's original files once.
    const mcpBackup = await readFile(path.join(workspace, `.mcp.json.claude-task-board.bak`), "utf8");
    assert.equal(JSON.parse(mcpBackup).mcpServers.other.command, "npx");
    assert.ok(await stat(path.join(workspace, ".claude", `settings.json.claude-task-board.bak`)).then(() => true));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("setup upgrades a legacy three-hook workspace to the new hooks", async () => {
  const workspace = await createWorkspace();
  try {
    await setupProjectIntegration({ workspacePath: workspace, boardUrl: BOARD_URL });
    // Roll the settings back to the legacy SessionStart/SessionEnd/Stop shape.
    const settingsPath = path.join(workspace, ".claude", "settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    const legacy = { model: settings.model, hooks: {} };
    for (const event of ["SessionStart", "SessionEnd", "Stop"]) {
      legacy.hooks[event] = [{ hooks: [{ type: "command", command: settings.hooks[event][0].hooks[0].command }] }];
    }
    await writeFile(settingsPath, JSON.stringify(legacy, null, 2));
    const before = await projectIntegrationStatus(workspace);
    assert.equal(before.configured, false);

    const { wrote } = await setupProjectIntegration({ workspacePath: workspace, boardUrl: BOARD_URL });
    assert.deepEqual(wrote, [".claude/settings.json"]);
    const after = await projectIntegrationStatus(workspace);
    assert.equal(after.configured, true);
    assert.equal(after.hooks.notification, true);
    assert.equal(after.hooks.preToolUse, true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("removing the integration only deletes board-owned entries", async () => {
  const workspace = await createWorkspace();
  try {
    await setupProjectIntegration({ workspacePath: workspace, boardUrl: BOARD_URL });
    const { removed, status } = await removeProjectIntegration({ workspacePath: workspace });
    assert.ok(removed.includes(".mcp.json"));
    assert.ok(removed.includes(".claude/settings.json"));
    assert.equal(status.configured, false);

    const settings = JSON.parse(await readFile(path.join(workspace, ".claude", "settings.json"), "utf8"));
    assert.deepEqual(settings.hooks, {});
    const mcp = JSON.parse(await readFile(path.join(workspace, ".mcp.json"), "utf8"));
    assert.deepEqual(mcp.mcpServers, {});
    assert.equal(await stat(path.join(workspace, ".claude", "commands", "e-taskboard.md")).then(() => true, () => false), false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("isBoardManagedWorkspace only matches the default workspace root", () => {
  const home = path.join("C:", "Users", "someone");
  const root = path.join(home, "Claude Task Board", "workspaces");
  assert.equal(isBoardManagedWorkspace(path.join(root, "my-project"), { home }), true);
  assert.equal(isBoardManagedWorkspace("D:\\repos\\external", { home }), false);
  assert.equal(isBoardManagedWorkspace(null, { home }), false);
  assert.equal(
    isBoardManagedWorkspace("D:\\elsewhere", {
      env: { CLAUDE_TASKBOARD_WORKSPACE_ROOT: "D:\\elsewhere" },
      home,
    }),
    true,
  );
});

test("status reports partial configuration accurately", async () => {
  const workspace = await createWorkspace();
  try {
    const empty = await projectIntegrationStatus(workspace);
    assert.equal(empty.configured, false);
    assert.equal(empty.mcp, false);

    await setupProjectIntegration({ workspacePath: workspace, boardUrl: BOARD_URL });
    await rm(path.join(workspace, ".claude", "commands", "e-taskboard.md"), { force: true });
    const partial = await projectIntegrationStatus(workspace);
    assert.equal(partial.mcp, true);
    assert.equal(partial.commands.eTaskboard, false);
    assert.equal(partial.configured, false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
