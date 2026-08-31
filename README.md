[English](README.md) | [简体中文](README.zh-CN.md)

# Claude Task Board

A local-first issue board that runs in your browser and is driven by **Claude Code**. Every issue can be worked by a real `claude` session: the board spawns headless Claude Code turns, streams their tool activity into the conversation panel, and the session claims/moves issues itself through the bundled `taskctl` CLI and `manage-taskboard` skill.

Forked from [dashi-taskboard](https://github.com/chuspeeism/dashi-taskboard) (Codex edition), re-targeted from Codex to Claude Code.

## How it drives Claude Code

- **AI conversations** — the board's chat panel spawns `claude -p --output-format stream-json` per turn in the project workspace, with sandbox modes mapped to Claude Code permission modes (`plan` / `acceptEdits` + Bash / `--dangerously-skip-permissions`). Tool calls (Bash, edits, web search, TodoWrite…) stream into the UI; the session id is captured from the `init` event and threads resume with `--resume`.
- **Session attribution** — spawned sessions run with `CLAUDE_THREAD_ID` (their session id) and `CLAUDE_TASKBOARD_URL` injected, so `taskctl` self-attributes writes and the session binds the issue it claims. Sessions stay resumable later via `claude --resume <id>` (the issue detail panel copies this command).
- **Auto-claim automation** — enable per-project automation and the board runs a local scheduler that spawns one headless controller session per tick; it claims a `todo`, implements, verifies, comments, and moves the issue to `in_review`.
- **Catalog discovery** — models come from `CLAUDE_TASKBOARD_MODELS` (sensible Claude defaults otherwise); skills, subagents, and slash commands are discovered from `~/.claude` and the workspace's `.claude` directories.

## Requirements

- Node.js 22.5 or newer
- Claude Code CLI (`claude`) installed and logged in — `npm install -g @anthropic-ai/claude-code` or the native installer

## Run locally

```bash
npm install
npm run build
npm start
```

Open <http://127.0.0.1:47823>. The SQLite database is stored at `.data/taskboard.sqlite`.

For development with live frontend reload:

```bash
npm run dev
```

## Install the skill for Claude Code

```bash
npm run install:skill
```

This copies `skills/manage-taskboard` to `~/.claude/skills/manage-taskboard`. The skill teaches Claude Code to inspect an issue, claim it (`todo` → `in_progress`) with a complete session binding, verify the work, and move it to `in_review`; it moves an issue to `done` only after the user explicitly accepts it.

## Use the CLI

```bash
npm run taskctl -- project create \
  --id my-project \
  --name "My project" \
  --workspace-path /absolute/path/to/repository

npm run taskctl -- issue create \
  --project my-project \
  --title "Implement the next slice" \
  --status todo \
  --priority high \
  --labels product,mvp \
  --thread-id <claude-session-id>
```

Inside a board-driven Claude session, `taskctl` reads `CLAUDE_THREAD_ID` automatically; elsewhere pass `--thread-id`. Use `npm link` to put `taskctl` on your shell path.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `CLAUDE_TASKBOARD_HOST` | `0.0.0.0` | HTTP bind address; use `127.0.0.1` to disable LAN access |
| `CLAUDE_TASKBOARD_PORT` | `47823` | Local HTTP port |
| `CLAUDE_TASKBOARD_DATA_DIR` | `.data` | SQLite data directory |
| `CLAUDE_TASKBOARD_URL` | `http://127.0.0.1:47823` | CLI API origin |
| `CLAUDE_TASKBOARD_MODELS` | Claude defaults | JSON model catalog, e.g. `[{"slug":"glm-5.3","supportedReasoningEfforts":["low","high"]}]` |
| `CLAUDE_TASKBOARD_TRUSTED_ORIGINS` | unset | Comma-separated exact HTTPS origins allowed through a loopback reverse tunnel; a configured origin is also accepted as the request `Host`, so the proxy does not need to rewrite it to a private address |
| `CLAUDE_EXECUTABLE` | auto-detected | Path to the `claude` CLI |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude home used for skill/agent/command discovery |

`npm start` prints the local URL and, in LAN mode, the available LAN URLs. Teammates on a trusted network can open the same board; changes broadcast to every client through server-sent events. LAN mode has no account authentication.

## Cloud collaboration

For two trusted collaborators, the board can run on Cloudflare (Worker Static Assets, D1, R2) with shared-password authentication. Each device keeps its own project checkout mapping and local companion for Claude Code, Git/worktree, and skill capabilities. See [Cloud collaboration](docs/cloud-collaboration.md).

## Verify

```bash
npm run check
```

This runs TypeScript checking, a production frontend build, the component tests, and the server/CLI test suite.

## Task Markdown

Task descriptions and comments support GFM, including tables and task lists. Fenced `mermaid` blocks render as read-only diagrams. Raw HTML is not enabled.

## Relationship to the upstream project

This fork replaces the Codex integration layer:

| Upstream (Codex) | This fork (Claude Code) |
| --- | --- |
| `codex exec --json` subprocess per turn | `claude -p --output-format stream-json` per turn |
| `codex app-server` JSON-RPC (threads, skills, automations) | Local scheduler + filesystem catalog (`~/.claude`) |
| CDP injection into the ChatGPT/Codex desktop app | Browser board (no injection; desktop app code removed) |
| `CODEX_THREAD_ID` attribution | `CLAUDE_THREAD_ID` attribution (injected into spawned sessions) |
| Tauri desktop packaging | Removed — `npm start` + browser |
| `~/.codex` state (projects, sessions) | `~/.claude/projects` session files + board projects |

The SQLite schema keeps the upstream `thread_*` column names for a painless data migration; the actor identity is migrated from `codex-agent` to `claude-agent` automatically.
