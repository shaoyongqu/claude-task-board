import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";

const MCP_PATH = path.resolve("server", "mcp.mjs");

function startMockBoard() {
  const state = { tasks: [], projects: [], sessions: [] };
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
      const respond = (status, value) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      const url = new URL(request.url, "http://127.0.0.1");
      if (url.pathname === "/api/projects" && request.method === "GET") {
        return respond(200, { projects: state.projects });
      }
      if (url.pathname === "/api/tasks" && request.method === "GET") {
        const projectId = url.searchParams.get("projectId");
        const status = url.searchParams.get("status");
        const tasks = state.tasks
          .filter((task) => !projectId || task.projectId === projectId)
          .filter((task) => !status || task.status === status);
        return respond(200, { tasks });
      }
      if (url.pathname === "/api/tasks" && request.method === "POST") {
        if (typeof body.threadId !== "string" || !body.threadId) {
          return respond(400, { error: { code: "ATTRIBUTION_REQUIRED", message: "threadId required" } });
        }
        const task = {
          id: `task-${state.tasks.length + 1}`,
          identifier: `TST-${state.tasks.length + 1}`,
          ...body,
          version: 1,
        };
        state.tasks.push(task);
        return respond(201, { task });
      }
      const moveMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/move$/);
      if (moveMatch && request.method === "POST") {
        const task = state.tasks.find((candidate) => candidate.id === moveMatch[1]);
        if (!task) return respond(404, { error: { code: "ISSUE_NOT_FOUND", message: "no such task" } });
        if (body.version !== task.version) {
          return respond(409, { error: { code: "VERSION_CONFLICT", message: "stale version" } });
        }
        task.status = body.status;
        task.version += 1;
        return respond(200, { task });
      }
      const commentsMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/comments$/);
      if (commentsMatch) {
        const task = state.tasks.find((candidate) => candidate.id === commentsMatch[1]);
        if (!task) return respond(404, { error: { code: "ISSUE_NOT_FOUND", message: "no such task" } });
        if (request.method === "POST") {
          return respond(201, { comment: { id: "comment-1", body: body.body, createdAt: "now" } });
        }
        return respond(200, { comments: [] });
      }
      if (url.pathname === "/api/local/sessions") {
        return respond(200, { sessions: state.sessions });
      }
      respond(404, { error: { code: "NOT_FOUND", message: request.url } });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, state, port: server.address().port }));
  });
}

class McpClient {
  constructor(port) {
    this.child = spawn(process.execPath, [MCP_PATH, "--url", `http://127.0.0.1:${port}`], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      this.buffer += chunk;
      let index;
      while ((index = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (Object.hasOwn(message, "id") && this.pending.has(message.id)) {
          this.pending.get(message.id)(message);
          this.pending.delete(message.id);
        }
      }
    });
  }

  request(method, params) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  call(name, args) {
    return this.request("tools/call", { name, arguments: args });
  }

  close() {
    this.child.stdin.end();
  }
}

function parseToolContent(response) {
  assert.equal(response.error, undefined, JSON.stringify(response.error));
  assert.equal(response.result.isError, undefined, JSON.stringify(response.result));
  return JSON.parse(response.result.content[0].text);
}

test("the MCP server completes the handshake and lists its tools", async () => {
  const board = await startMockBoard();
  const client = new McpClient(board.port);
  try {
    const initialized = await client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    assert.equal(initialized.result.serverInfo.name, "claude-task-board");
    assert.ok(initialized.result.capabilities.tools);

    const tools = await client.request("tools/list", {});
    const names = tools.result.tools.map((tool) => tool.name);
    for (const expected of [
      "context_current", "project_list", "issue_list", "issue_get",
      "issue_create", "issue_move", "comment_add", "project_readme_get",
    ]) {
      assert.ok(names.includes(expected), `missing tool ${expected}`);
    }
    for (const tool of tools.result.tools) {
      assert.equal(tool.inputSchema.type, "object");
    }

    const ping = await client.request("ping", {});
    assert.deepEqual(ping.result, {});
  } finally {
    client.close();
    await new Promise((resolve) => board.server.close(resolve));
  }
});

test("MCP tools read and write the board with session attribution", async () => {
  const board = await startMockBoard();
  board.state.projects.push({
    id: "alpha",
    name: "Alpha",
    workspacePath: "C:\\work\\alpha",
    issueCount: 0,
  });
  board.state.sessions.push({
    sessionId: "aaaa1111-1111-4111-8111-111111111111",
    projectId: "alpha",
    endedAt: null,
  });
  const client = new McpClient(board.port);
  try {
    await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {} });

    const created = parseToolContent(await client.call("issue_create", {
      title: "First issue",
      projectId: "alpha",
    }));
    assert.equal(created.issue.identifier, "TST-1");
    // Attribution fell back to the active hook-reported session.
    assert.equal(board.state.tasks[0].threadId, "aaaa1111-1111-4111-8111-111111111111");

    const moved = parseToolContent(await client.call("issue_move", {
      identifier: "TST-1",
      status: "in_progress",
      projectId: "alpha",
    }));
    assert.equal(moved.issue.status, "in_progress");

    const comment = parseToolContent(await client.call("comment_add", {
      identifier: "TST-1",
      body: "working on it",
      projectId: "alpha",
    }));
    assert.ok(comment.comment.id);

    const listed = parseToolContent(await client.call("issue_list", { projectId: "alpha" }));
    assert.equal(listed.issues.length, 1);

    const context = parseToolContent(await client.call("context_current", { cwd: "C:\\work\\alpha\\sub" }));
    assert.equal(context.project.id, "alpha");
  } finally {
    client.close();
    await new Promise((resolve) => board.server.close(resolve));
  }
});

test("MCP tool errors surface as isError results without crashing the server", async () => {
  const board = await startMockBoard();
  board.state.projects.push({ id: "alpha", name: "Alpha", workspacePath: null, issueCount: 0 });
  const client = new McpClient(board.port);
  try {
    await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
    const failure = (await client.call("issue_get", { identifier: "NOPE-9" })).result;
    assert.equal(failure.isError, true);
    assert.match(failure.content[0].text, /ISSUE_NOT_FOUND/);

    const unknown = await client.call("does_not_exist", {});
    assert.equal(unknown.error?.code, -32602);

    // Server still answers afterwards.
    const projects = parseToolContent(await client.call("project_list", {}));
    assert.equal(projects.projects[0].id, "alpha");
  } finally {
    client.close();
    await new Promise((resolve) => board.server.close(resolve));
  }
});
