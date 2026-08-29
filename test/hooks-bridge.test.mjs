import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { test } from "node:test";

const BRIDGE_PATH = path.resolve("server", "hooks-bridge.mjs");

function startCaptureServer() {
  const events = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      events.push({
        url: request.url,
        body: chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, events, port: server.address().port }));
  });
}

function runBridge(url, stdin) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BRIDGE_PATH, "--url", url], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.on("exit", (code) => resolve(code));
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

test("the hooks bridge forwards the hook payload to the board", async () => {
  const capture = await startCaptureServer();
  try {
    const payload = JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "abcd1234-1111-4111-8111-000000000000",
      cwd: "C:\\work\\demo",
      transcript_path: "C:\\Users\\me\\.claude\\projects\\demo\\abcd.jsonl",
    });
    const code = await runBridge(`http://127.0.0.1:${capture.port}`, payload);
    assert.equal(code, 0);
    assert.equal(capture.events.length, 1);
    assert.equal(capture.events[0].url, "/api/local/hooks/event");
    assert.equal(capture.events[0].body.session_id, "abcd1234-1111-4111-8111-000000000000");
    assert.equal(capture.events[0].body.hook_event_name, "SessionStart");
  } finally {
    await new Promise((resolve) => capture.server.close(resolve));
  }
});

test("the bridge exits quietly on malformed input or an unreachable board", async () => {
  const capture = await startCaptureServer();
  try {
    assert.equal(await runBridge(`http://127.0.0.1:${capture.port}`, "not json at all"), 0);
    assert.equal(await runBridge(`http://127.0.0.1:${capture.port}`, JSON.stringify({ session_id: "x" })), 0);
    // Port 1 is reserved and nothing listens there.
    assert.equal(await runBridge("http://127.0.0.1:1", JSON.stringify({ hook_event_name: "Stop", session_id: "s" })), 0);
    assert.equal(capture.events.length, 1);
  } finally {
    await new Promise((resolve) => capture.server.close(resolve));
  }
});
