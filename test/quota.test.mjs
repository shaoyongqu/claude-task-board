import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { getQuotaStatus, parseQuotaOutput, resetQuotaCacheForTests } from "../server/quota.mjs";

test("parseQuotaOutput validates the external command contract", () => {
  assert.deepEqual(parseQuotaOutput('{"state":"available"}'), { state: "available" });
  assert.deepEqual(
    parseQuotaOutput('{"state":"blocked","resetsAt":"2026-08-30T00:00:00Z"}'),
    { state: "blocked", resetsAt: "2026-08-30T00:00:00Z" },
  );
  assert.deepEqual(parseQuotaOutput('{"state":"unknown"}'), { state: "unknown" });
  assert.equal(parseQuotaOutput('{"state":"weird"}'), null);
  assert.equal(parseQuotaOutput("not json"), null);
  assert.equal(parseQuotaOutput("[]"), null);
  assert.equal(parseQuotaOutput(""), null);
});

test("without a configured command the quota is unavailable with a reason", async () => {
  resetQuotaCacheForTests();
  const status = await getQuotaStatus({});
  assert.equal(status.state, "unavailable");
  assert.equal(status.reason, "not-configured");
});

test("a configured command's JSON output becomes the quota status", async () => {
  resetQuotaCacheForTests();
  const directory = await mkdtemp(path.join(os.tmpdir(), "quota-cmd-"));
  const emitter = path.join(directory, "emit.mjs");
  await writeFile(emitter, 'process.stdout.write(JSON.stringify({state:"blocked",resetsAt:"2026-08-30T00:00:00Z"}));\n');
  try {
    const status = await getQuotaStatus({
      CLAUDE_TASKBOARD_QUOTA_COMMAND: `${process.execPath} "${emitter}"`,
    });
    assert.equal(status.state, "blocked");
    assert.equal(status.resetsAt, "2026-08-30T00:00:00Z");

    // cached within the TTL
    const second = await getQuotaStatus({
      CLAUDE_TASKBOARD_QUOTA_COMMAND: process.execPath + " -e 'process.exit(1)'",
    });
    assert.equal(second.state, "blocked");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failing or invalid command degrades to unknown", async () => {
  resetQuotaCacheForTests();
  const directory = await mkdtemp(path.join(os.tmpdir(), "quota-cmd-"));
  const failingEmitter = path.join(directory, "fail.mjs");
  const invalidEmitter = path.join(directory, "garbage.mjs");
  await writeFile(failingEmitter, "process.exit(1);\n");
  await writeFile(invalidEmitter, 'process.stdout.write("garbage");\n');
  try {
    const failing = await getQuotaStatus({
      CLAUDE_TASKBOARD_QUOTA_COMMAND: `${process.execPath} "${failingEmitter}"`,
    });
    assert.equal(failing.state, "unknown");
    assert.equal(failing.reason, "command-failed");

    resetQuotaCacheForTests();
    const invalid = await getQuotaStatus({
      CLAUDE_TASKBOARD_QUOTA_COMMAND: `${process.execPath} "${invalidEmitter}"`,
    });
    assert.equal(invalid.state, "unknown");
    assert.equal(invalid.reason, "invalid-output");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
