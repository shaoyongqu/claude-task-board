import assert from "node:assert/strict";
import { test } from "node:test";

import { SessionRegistry } from "../server/session-registry.mjs";

const projects = [
  { id: "local", name: "全局", workspacePath: null },
  { id: "alpha", name: "Alpha", workspacePath: "C:\\work\\alpha" },
  { id: "beta", name: "Beta", workspacePath: "/home/me/beta" },
];

test("SessionStart registers a session and resolves the owning project", () => {
  const registry = new SessionRegistry();
  const session = registry.record({
    hook_event_name: "SessionStart",
    session_id: "11111111-1111-4111-8111-111111111111",
    cwd: "C:\\work\\alpha\\sub",
  }, projects);
  assert.equal(session.projectId, "alpha");
  assert.equal(session.projectName, "Alpha");
  assert.equal(session.endedAt, null);
  assert.deepEqual(registry.list().map((entry) => entry.sessionId), [
    "11111111-1111-4111-8111-111111111111",
  ]);
});

test("nested workspaces resolve to the longest matching project", () => {
  const registry = new SessionRegistry();
  const nested = [...projects, { id: "deep", name: "Deep", workspacePath: "C:\\work\\alpha\\deep" }];
  const session = registry.record({
    hook_event_name: "SessionStart",
    session_id: "22222222-2222-4222-8222-222222222222",
    cwd: "C:/work/alpha/deep/src",
  }, nested);
  assert.equal(session.projectId, "deep");
});

test("SessionEnd marks the session ended and Stop counts turns", () => {
  const registry = new SessionRegistry();
  const id = "33333333-3333-4333-8333-333333333333";
  registry.record({ hook_event_name: "SessionStart", session_id: id, cwd: "/home/me/beta" }, projects);
  registry.record({ hook_event_name: "Stop", session_id: id, cwd: "/home/me/beta" }, projects);
  registry.record({ hook_event_name: "Stop", session_id: id, cwd: "/home/me/beta" }, projects);
  registry.record({ hook_event_name: "SessionEnd", session_id: id, cwd: "/home/me/beta" }, projects);
  const session = registry.list()[0];
  assert.equal(session.turnsCompleted, 2);
  assert.notEqual(session.endedAt, null);
  assert.equal(registry.activeSessionForProject("beta"), null);
});

test("unmatched directories and invalid payloads are ignored gracefully", () => {
  const registry = new SessionRegistry();
  const unmatched = registry.record({
    hook_event_name: "SessionStart",
    session_id: "44444444-4444-4444-8444-444444444444",
    cwd: "D:\\unrelated",
  }, projects);
  assert.equal(unmatched.projectId, null);
  assert.equal(registry.record({ hook_event_name: "SessionStart", session_id: "" }, projects), null);
  assert.equal(registry.record({ hook_event_name: "SessionStart" }, projects), null);
});

test("activeSessionForProject returns the most recently seen session", () => {
  const registry = new SessionRegistry();
  registry.record({
    hook_event_name: "SessionStart",
    session_id: "55555555-5555-4555-8555-555555555555",
    cwd: "C:\\work\\alpha",
  }, projects);
  const later = registry.record({
    hook_event_name: "SessionStart",
    session_id: "66666666-6666-4666-8666-666666666666",
    cwd: "C:\\work\\alpha",
  }, projects);
  assert.equal(registry.activeSessionForProject("alpha").sessionId, later.sessionId);
  assert.equal(registry.activeSessionForProject("local"), null);
});
