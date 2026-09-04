// Registry of Claude Code sessions reported by the SessionStart/SessionEnd/
// Stop hooks installed into project workspaces. Powers the local sessions
// panel and gives MCP tool calls a session to attribute their writes to.
export class SessionRegistry {
  constructor({ limit = 500 } = {}) {
    this.limit = limit;
    this.sessions = new Map();
    this.nextSequence = 0;
  }

  resolveProjectForPath(cwd, projects) {
    if (typeof cwd !== "string" || !cwd) return null;
    const normalized = cwd.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    let best = null;
    let bestLength = -1;
    for (const project of projects) {
      if (typeof project?.workspacePath !== "string" || !project.workspacePath) continue;
      const workspace = project.workspacePath
        .replace(/\\/g, "/")
        .replace(/\/+$/, "")
        .toLowerCase();
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

  record(event, projects) {
    const sessionId = typeof event.session_id === "string" ? event.session_id.trim() : "";
    if (!sessionId || sessionId.length > 256) return null;
    const now = new Date().toISOString();
    const sequence = this.nextSequence;
    this.nextSequence += 1;
    const project = this.resolveProjectForPath(event.cwd, projects);
    const existing = this.sessions.get(sessionId);
    const session = {
      sessionId,
      sequence,
      cwd: typeof event.cwd === "string" && event.cwd ? event.cwd : existing?.cwd ?? null,
      projectId: project ? project.id : existing?.projectId ?? null,
      projectName: project ? project.name : existing?.projectName ?? null,
      workspacePath: project?.workspacePath ?? existing?.workspacePath ?? null,
      startedAt: existing?.startedAt ?? now,
      lastSeenAt: now,
      endedAt: existing?.endedAt ?? null,
      turnsCompleted: existing?.turnsCompleted ?? 0,
      // Set by the Notification hook (permission_prompt): the session is
      // showing a permission dialog and cannot proceed until a human answers.
      // Consumers treat it as stale once the transcript advances past `at`.
      attention: existing?.attention ?? null,
    };
    if (event.hook_event_name === "SessionStart") {
      session.endedAt = null;
    }
    if (event.hook_event_name === "SessionEnd") {
      session.endedAt = now;
      session.attention = null;
    }
    if (event.hook_event_name === "Stop") {
      session.turnsCompleted += 1;
      session.attention = null;
    }
    if (event.hook_event_name === "Notification") {
      const message = typeof event.message === "string" && event.message.trim()
        ? event.message.trim().slice(0, 500)
        : "";
      if (message) session.attention = { message, at: now };
    }
    this.sessions.set(sessionId, session);
    if (this.sessions.size > this.limit) {
      const oldest = [...this.sessions.values()]
        .sort((left, right) => left.lastSeenAt.localeCompare(right.lastSeenAt))[0];
      if (oldest) this.sessions.delete(oldest.sessionId);
    }
    return session;
  }

  get(sessionId) {
    return this.sessions.get(sessionId) ?? null;
  }

  list() {
    return [...this.sessions.values()].sort((left, right) => right.sequence - left.sequence);
  }

  // Most recently seen still-active session for a project; used to attribute
  // MCP writes when the calling Claude session is not otherwise identified.
  activeSessionForProject(projectId) {
    return this.list().find((session) => (
      session.projectId === projectId && !session.endedAt
    )) ?? null;
  }
}
