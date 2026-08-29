# Project Development Rules

For feature work in this repository, use this order:

1. Before implementation, prove the real operation path: entry point → user or agent action → data change → observable result. Cite the actual component, API, and file involved.
2. Implement the requested main path with the smallest direct change that makes it work.
3. After implementation, verify that direct operation path and report the result.
4. Do not proactively add guardrails, speculative fallbacks, legacy compatibility, or broad regression tests before the user confirms the feature works. Add targeted protection only when explicitly requested or after a concrete failure.
5. Keep validation that is necessary at real external boundaries (user input, external APIs), but do not expand it into hypothetical protection beyond the requested path.

# Architecture orientation

- `server/` — local HTTP service: `app.mjs` (API routes), `database.mjs` (SQLite), `ai-chat.mjs` + `ai-chat-process.mjs` (Claude Code session execution over `claude -p --output-format stream-json`), `ai-chat-catalog.mjs` (models/skills/agents discovery from `~/.claude` + default workspace root), `automation-scheduler.mjs` (local auto-claim scheduler).
- `server/mcp.mjs` — MCP server (stdio JSON-RPC) exposing board tools to any claude session in a configured workspace.
- `server/hooks-bridge.mjs` — forwards Claude Code hook events to `/api/local/hooks/event`; `session-registry.mjs` maps sessions to projects (powers the local sessions panel and MCP write attribution).
- `server/claude-integration.mjs` — idempotent installer/remover for the per-workspace trio (`.mcp.json`, hooks in `.claude/settings.json`, `.claude/commands/*.md`); board-managed workspaces under the default root are auto-configured.
- `server/terminal-launcher.mjs` — opens an interactive `claude` in a real terminal (wt → cmd fallback, copy-command last resort).
- `cli/taskctl.mjs` — board CLI used by agents; conversation attribution comes from `CLAUDE_THREAD_ID`.
- `skills/manage-taskboard/` — the Claude Code skill installed to `~/.claude/skills` via `npm run install:skill`.
- `web/` — React board UI (Vite); `cloud/` — optional Cloudflare Worker/D1/R2 deployment. The old embedded-host bridge (postMessage/challenge/drag-region) has been fully removed — the UI is browser-only.
- Environment variables use the `CLAUDE_TASKBOARD_` prefix (see README).

Claude sessions spawned by the board receive `CLAUDE_THREAD_ID` (their session id) and `CLAUDE_TASKBOARD_URL` (the board API) in their environment, so `taskctl` self-attributes inside those sessions. User-launched sessions in integrated workspaces attribute via the hooks registry instead.

# Taskboard Delivery Workflow

Use this workflow when processing board work:

1. Read and claim: read the full issue, its attachments, and all comments before acting. Claim `todo` items only; never assign `backlog` items. Claim (move to `in_progress` with a complete thread binding) before reading code or implementing. Continue `in_progress` items only when bound to the current session.
2. Use optimistic versions: every status write passes `--if-version` with the latest read version; on 409, re-read and reconcile before one retry.
3. Execute with E3: Estimate (context, steps, overlap, risk) → Execute (smallest viable real path) → Expand (only when direct verification fails).
4. Implement in the issue's bound branch/worktree when one exists; never implement directly on `main` of a target repository.
5. Verify the direct user path; for UI-surface changes verify on the real board surface.
6. Record one initial comment (claim + plan) and one final comment (changes, verification, outcome, limitations). Add intermediate comments only for material blockers or scope changes.
7. Move the issue to `in_review` after implementation and verification. Never move an issue to `done` unless the user explicitly accepts it or asks for completion. Use `blocked` when work cannot continue.
8. Do not merge, release, or archive conversations without explicit authorization. Preserve task conversations for traceability.
