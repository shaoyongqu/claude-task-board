# Privacy

Claude Task Board is a local-first application. The board service runs on your
computer and does not send board content or usage telemetry to the project
maintainers.

## Data stored on the computer

The board stores its SQLite database and attachments under the configured data
directory (default: `.data` inside the repository checkout).

The optional `install:skill` script copies the bundled `manage-taskboard`
skill into the current user's `~/.claude/skills/manage-taskboard` directory.

## What runs locally

- The board HTTP service binds to `127.0.0.1` (or `0.0.0.0` on trusted LANs).
- AI conversations spawn the local `claude` CLI with the board's prompt and
  session context; requests go directly to whichever provider your Claude Code
  installation is configured to use.
- `taskctl` talks to the board over the loopback HTTP API.

## What leaves the computer

Only what you explicitly configure:

- Prompts and task content sent to your AI provider when you start a
  conversation from the board.
- Optional cloud collaboration deployments (Cloudflare Worker/D1/R2) that you
  configure and authenticate yourself.

No telemetry, crash reporting, or analytics are built in.
