#!/usr/bin/env node
// Claude Task Board MCP server (stdio). Exposes the board's HTTP API as
// native tools for any Claude Code session running inside a configured
// project workspace. Launched by Claude Code via the project's .mcp.json.
//
// Write attribution: the board's write APIs require a conversation id. The
// server resolves the most recently active hook-reported session for the
// resolved project (GET /api/local/sessions) and falls back to a stable
// "claude-mcp" identity when no session is known.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MCP_SERVER_NAME = "claude-task-board";
const MCP_SERVER_VERSION = "1.0.0";
const PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_BOARD_URL = "http://127.0.0.1:47823";
const ATTRIBUTION_FALLBACK = "claude-mcp";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function boardBaseUrl() {
  const fromEnv = process.env.CLAUDE_TASKBOARD_URL;
  if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv.trim().replace(/\/+$/, "");
  const argvIndex = process.argv.indexOf("--url");
  if (argvIndex >= 0 && process.argv[argvIndex + 1]) {
    return process.argv[argvIndex + 1].trim().replace(/\/+$/, "");
  }
  return DEFAULT_BOARD_URL;
}

class BoardApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function boardRequest(pathname, { method = "GET", body } = {}) {
  const response = await fetch(`${boardBaseUrl()}${pathname}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-taskboard-client": "taskctl",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!response.ok) {
    throw new BoardApiError(
      response.status,
      data?.error?.code ?? "BOARD_REQUEST_FAILED",
      data?.error?.message ?? `Board request ${pathname} failed with ${response.status}`,
    );
  }
  return data;
}

function normalizePath(value) {
  return String(value ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

async function resolveProjects() {
  return (await boardRequest("/api/projects")).projects ?? [];
}

async function resolveProjectByIdOrCwd({ projectId, cwd }) {
  const projects = await resolveProjects();
  if (projectId) {
    const byId = projects.find((project) => project.id === projectId);
    if (byId) return byId;
    const byName = projects.find((project) => project.name === projectId);
    if (byName) return byName;
    throw new BoardApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
  }
  const reference = cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const normalized = normalizePath(reference);
  let best = null;
  let bestLength = -1;
  for (const project of projects) {
    const workspace = normalizePath(project.workspacePath ?? "");
    if (!workspace) continue;
    if (
      (normalized === workspace || normalized.startsWith(`${workspace}/`))
      && workspace.length > bestLength
    ) {
      best = project;
      bestLength = workspace.length;
    }
  }
  return best;
}

async function resolveTaskIdentifier(identifier, { projectId, cwd } = {}) {
  const query = new URLSearchParams({ archived: "false" });
  const project = await resolveProjectByIdOrCwd({ projectId, cwd });
  if (project) query.set("projectId", project.id);
  const tasks = (await boardRequest(`/api/tasks?${query}`)).tasks ?? [];
  const wanted = String(identifier).trim().toUpperCase();
  const task = tasks.find((candidate) => candidate.identifier.toUpperCase() === wanted);
  if (!task) {
    throw new BoardApiError(
      404,
      "ISSUE_NOT_FOUND",
      `Issue '${identifier}' was not found${project ? ` in project '${project.id}'` : ""}`,
    );
  }
  return { task, project };
}

async function attributionThreadId({ projectId, cwd }) {
  try {
    const project = await resolveProjectByIdOrCwd({ projectId, cwd });
    if (!project) return ATTRIBUTION_FALLBACK;
    const sessions = (await boardRequest("/api/local/sessions")).sessions ?? [];
    const active = sessions.find((session) => (
      session.projectId === project.id && !session.endedAt
    ));
    return active?.sessionId ?? ATTRIBUTION_FALLBACK;
  } catch {
    return ATTRIBUTION_FALLBACK;
  }
}

const STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "canceled"];
const PRIORITIES = ["none", "urgent", "high", "medium", "low"];

const TOOLS = [
  {
    name: "context_current",
    description: "Resolve the Claude Task Board project for the current working directory and list its recent issues. Start here when working on board tasks.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Working directory; defaults to CLAUDE_PROJECT_DIR" },
      },
    },
  },
  {
    name: "project_list",
    description: "List Task Board projects with ids, names, workspace paths, and issue counts.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "issue_list",
    description: "List issues of a project (or all projects), optionally filtered by status.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project id or name; defaults to the current directory's project" },
        status: { type: "string", enum: STATUSES },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Max issues to return (default 30)" },
      },
    },
  },
  {
    name: "issue_get",
    description: "Read one issue by identifier (e.g. 'ABC-1') with description, comments, relations, and thread binding.",
    inputSchema: {
      type: "object",
      properties: {
        identifier: { type: "string", description: "Issue identifier like 'ABC-1'" },
        projectId: { type: "string" },
        cwd: { type: "string" },
      },
      required: ["identifier"],
    },
  },
  {
    name: "issue_create",
    description: "Create a board issue. Provide title; optionally description, status, priority, labels.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", maxLength: 240 },
        description: { type: "string", description: "GFM markdown body" },
        projectId: { type: "string" },
        cwd: { type: "string" },
        status: { type: "string", enum: STATUSES },
        priority: { type: "string", enum: PRIORITIES },
        labels: { type: "array", items: { type: "string" }, maxItems: 20 },
      },
      required: ["title"],
    },
  },
  {
    name: "issue_move",
    description: "Move an issue to another status. Claim todo work with in_progress; move to in_review after verification; use done only after explicit user acceptance.",
    inputSchema: {
      type: "object",
      properties: {
        identifier: { type: "string" },
        status: { type: "string", enum: STATUSES },
        projectId: { type: "string" },
        cwd: { type: "string" },
        version: { type: "integer", description: "Optimistic version; fetched automatically when omitted" },
      },
      required: ["identifier", "status"],
    },
  },
  {
    name: "comment_add",
    description: "Add a markdown comment to an issue (progress notes, verification results, blockers).",
    inputSchema: {
      type: "object",
      properties: {
        identifier: { type: "string" },
        body: { type: "string", maxLength: 100_000 },
        projectId: { type: "string" },
        cwd: { type: "string" },
      },
      required: ["identifier", "body"],
    },
  },
  {
    name: "project_readme_get",
    description: "Read a project's README (architecture, conventions) before planning complex work.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        cwd: { type: "string" },
      },
    },
  },
];

const TOOL_HANDLERS = {
  async context_current(args) {
    const project = await resolveProjectByIdOrCwd(args);
    if (!project) {
      return {
        project: null,
        note: "No board project matches this directory. Use project_list, or create one on the board.",
      };
    }
    const issues = (await boardRequest(`/api/tasks?projectId=${encodeURIComponent(project.id)}&archived=false`)).tasks ?? [];
    return {
      project: {
        id: project.id,
        name: project.name,
        workspacePath: project.workspacePath,
        issueCount: project.issueCount,
      },
      recentIssues: issues.slice(0, 10).map((task) => ({
        identifier: task.identifier,
        title: task.title,
        status: task.status,
        priority: task.priority,
      })),
    };
  },

  async project_list() {
    const projects = await resolveProjects();
    return {
      projects: projects.map((project) => ({
        id: project.id,
        name: project.name,
        workspacePath: project.workspacePath,
        issueCount: project.issueCount,
      })),
    };
  },

  async issue_list(args) {
    const project = await resolveProjectByIdOrCwd(args);
    const query = new URLSearchParams({ archived: "false" });
    if (project) query.set("projectId", project.id);
    if (args.status) query.set("status", args.status);
    let tasks = (await boardRequest(`/api/tasks?${query}`)).tasks ?? [];
    const limit = Number.isInteger(args.limit) ? args.limit : 30;
    tasks = tasks.slice(0, limit);
    return {
      project: project ? { id: project.id, name: project.name } : null,
      issues: tasks.map((task) => ({
        identifier: task.identifier,
        title: task.title,
        status: task.status,
        priority: task.priority,
        labels: task.labels,
        threadId: task.threadId,
        version: task.version,
      })),
    };
  },

  async issue_get(args) {
    const { task } = await resolveTaskIdentifier(args.identifier, args);
    const comments = (await boardRequest(
      `/api/tasks/${encodeURIComponent(task.id)}/comments`,
    )).comments ?? [];
    return {
      issue: {
        identifier: task.identifier,
        title: task.title,
        description: task.description,
        status: task.status,
        priority: task.priority,
        labels: task.labels,
        assignee: task.assignee,
        startDate: task.startDate,
        dueDate: task.dueDate,
        developmentContext: task.developmentContext,
        threadId: task.threadId,
        threadBinding: task.threadBinding,
        version: task.version,
      },
      comments: comments.map((comment) => ({
        author: comment.authorName,
        body: comment.body,
        createdAt: comment.createdAt,
      })),
    };
  },

  async issue_create(args) {
    const project = await resolveProjectByIdOrCwd(args)
      ?? (await resolveProjects()).find((candidate) => candidate.id === "local");
    if (!project) throw new BoardApiError(404, "PROJECT_NOT_FOUND", "No board project to create the issue in");
    const threadId = await attributionThreadId({ projectId: project.id });
    const task = (await boardRequest("/api/tasks", {
      method: "POST",
      body: {
        projectId: project.id,
        title: args.title,
        description: args.description ?? "",
        status: args.status ?? "todo",
        priority: args.priority ?? "none",
        labels: Array.isArray(args.labels) ? args.labels : [],
        threadId,
      },
    })).task;
    return { issue: { identifier: task.identifier, title: task.title, status: task.status, version: task.version } };
  },

  async issue_move(args) {
    const { task } = await resolveTaskIdentifier(args.identifier, args);
    const version = Number.isInteger(args.version) ? args.version : task.version;
    const threadId = task.threadId ?? await attributionThreadId(args);
    const moved = (await boardRequest(`/api/tasks/${encodeURIComponent(task.id)}/move`, {
      method: "POST",
      body: { version, status: args.status, threadId },
    })).task;
    return { issue: { identifier: moved.identifier, status: moved.status, version: moved.version } };
  },

  async comment_add(args) {
    const { task } = await resolveTaskIdentifier(args.identifier, args);
    const threadId = task.threadId ?? await attributionThreadId(args);
    const comment = (await boardRequest(`/api/tasks/${encodeURIComponent(task.id)}/comments`, {
      method: "POST",
      body: { body: args.body, threadId },
    })).comment;
    return { comment: { id: comment.id, createdAt: comment.createdAt } };
  },

  async project_readme_get(args) {
    const project = await resolveProjectByIdOrCwd(args);
    if (!project) throw new BoardApiError(404, "PROJECT_NOT_FOUND", "No board project matches this directory");
    const readme = (await boardRequest(
      `/api/projects/${encodeURIComponent(project.id)}/readme`,
    )).readme;
    return { projectId: project.id, readme: readme?.content ?? "" };
  },
};

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message, data) {
  send({ jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } });
}

async function handleRequest(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    sendResult(id, {
      protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    });
    return;
  }
  if (method === "ping") {
    sendResult(id, {});
    return;
  }
  if (method === "tools/list") {
    sendResult(id, { tools: TOOLS });
    return;
  }
  if (method === "prompts/list") {
    sendResult(id, { prompts: [] });
    return;
  }
  if (method === "resources/list") {
    sendResult(id, { resources: [] });
    return;
  }
  if (method === "tools/call") {
    const toolName = params?.name;
    const tool = TOOLS.find((candidate) => candidate.name === toolName);
    if (!tool) {
      sendError(id, -32602, `Unknown tool '${toolName}'`);
      return;
    }
    try {
      const result = await TOOL_HANDLERS[toolName](params?.arguments ?? {});
      sendResult(id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 1) }],
      });
    } catch (error) {
      sendResult(id, {
        isError: true,
        content: [{
          type: "text",
          text: `${error.code ? `[${error.code}] ` : ""}${error.message ?? String(error)}`,
        }],
      });
    }
    return;
  }
  if (id !== undefined) {
    sendError(id, -32601, `Method '${method}' is not supported`);
  }
}

function main() {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) {
        try {
          void handleRequest(JSON.parse(line));
        } catch {}
      }
      newlineIndex = buffer.indexOf("\n");
    }
  });
  process.stdin.on("end", () => process.exit(0));
  // Keep the event loop alive even when spawned detached from a parent that
  // holds stdin open without data.
  process.stdin.resume();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
