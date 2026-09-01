import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { LocalAutomationScheduler } from "../server/automation-scheduler.mjs";

function request(overrides = {}) {
  return {
    requestId: "req-1",
    operation: "apply-policy",
    taskboardProjectId: "local",
    codexProjectId: "C:\\work\\alpha",
    codexProjectKind: "local",
    codexHostId: "local",
    projectName: "Alpha",
    workspacePath: "C:\\work\\alpha",
    remoteProjects: [],
    skillPath: "/skills/manage-taskboard",
    enabledByUser: true,
    quotaAware: false,
    intervalMinutes: 5,
    model: "default",
    reasoningEffort: "medium",
    ...overrides,
  };
}

test("enabled automations persist across scheduler restarts", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "automation-persist-"));
  const persistPath = path.join(directory, "automation-configs.json");
  // Mock database with one todo so apply-policy keeps the automation active.
  const database = {
    listTasks: () => [{ id: "t1", identifier: "LOCAL-1" }],
    listProjects: () => [],
    interruptRunningScheduleRuns: () => 0,
  };

  const first = new LocalAutomationScheduler({
    database,
    claudeExecutable: process.execPath,
    skillPath: "/skills/manage-taskboard",
    processEnv: process.env,
    persistPath,
  });
  const applied = await first.handleRequest(request({ operation: "apply-policy" }));
  assert.equal(applied.item.status, "ACTIVE");
  const saved = JSON.parse(await readFile(persistPath, "utf8"));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].request.enabledByUser, true);
  await first.close();

  // A fresh scheduler (simulated server restart) restores the entry.
  const second = new LocalAutomationScheduler({
    database,
    claudeExecutable: process.execPath,
    skillPath: "/skills/manage-taskboard",
    processEnv: process.env,
    persistPath,
  });
  second.resume();
  const list = await second.handleRequest(request({ operation: "list" }));
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].status, "ACTIVE");
  assert.match(list.items[0].rrule, /INTERVAL=5$/);
  assert.ok(list.items[0].nextRunAt !== null);
  await second.close();
  await rm(directory, { recursive: true, force: true });
});

test("paused automations restore as paused without timers", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "automation-pause-"));
  const persistPath = path.join(directory, "automation-configs.json");
  const database = {
    listTasks: () => [],
    listProjects: () => [],
    interruptRunningScheduleRuns: () => 0,
  };

  const first = new LocalAutomationScheduler({
    database,
    claudeExecutable: process.execPath,
    skillPath: "/skills/manage-taskboard",
    processEnv: process.env,
    persistPath,
  });
  await first.handleRequest(request({ operation: "apply-policy", enabledByUser: false }));
  await first.close();

  const second = new LocalAutomationScheduler({
    database,
    claudeExecutable: process.execPath,
    skillPath: "/skills/manage-taskboard",
    processEnv: process.env,
    persistPath,
  });
  second.resume();
  const list = await second.handleRequest(request({ operation: "list", enabledByUser: false }));
  assert.equal(list.items[0].status, "PAUSED");
  await second.close();
  await rm(directory, { recursive: true, force: true });
});

test("corrupt or missing persistence files are ignored", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "automation-corrupt-"));
  const persistPath = path.join(directory, "automation-configs.json");
  await writeFile(persistPath, "not json", "utf8");
  const scheduler = new LocalAutomationScheduler({
    database: { listTasks: () => [], listProjects: () => [] },
    claudeExecutable: process.execPath,
    skillPath: "/skills/manage-taskboard",
    processEnv: process.env,
    persistPath,
  });
  const list = await scheduler.handleRequest(request({ operation: "list" }));
  assert.deepEqual(list.items, []);
  await scheduler.close();
  await rm(directory, { recursive: true, force: true });
});
