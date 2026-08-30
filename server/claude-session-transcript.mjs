// Maps a native Claude Code session transcript (~/.claude/projects/<dir>/<sessionId>.jsonl,
// one stream-json record per line) to board chat events so the web UI can render
// external sessions with the same timeline used for built-in AI threads.
import { normalizeClaudeEvent } from "./ai-chat-process.mjs";

const USER_TEXT_PREFIX_DENYLIST = [
  "<command-name>",
  "<command-message>",
  "<command-args>",
  "<local-command-stdout>",
  "<system-reminder",
  "<task-panel",
];

function isEchoedAutomationText(value) {
  return USER_TEXT_PREFIX_DENYLIST.some((prefix) => value.startsWith(prefix));
}

function userTextBlocks(record) {
  const content = record.message?.content;
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text);
}

export function buildClaudeSessionTranscript(threadId, lines) {
  const events = [];
  const pendingTools = new Map();
  let sequence = 0;
  const nextEventId = () => `${threadId}-${sequence += 1}`;

  lines.forEach((line) => {
    if (!line.trim()) return;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      return;
    }
    if (!record || typeof record !== "object") return;

    for (const normalized of normalizeClaudeEvent(record, pendingTools)) {
      if (normalized.kind !== "event") continue;
      const data = normalized.data && typeof normalized.data === "object"
        ? { ...normalized.data }
        : undefined;
      // The UI collapses an activity item to its latest event per itemId, so a
      // tool_use "started" event is superseded by its tool_result event.
      if (typeof data?.toolUseId === "string" && data.toolUseId) {
        data.itemId = data.toolUseId;
      }
      events.push({
        id: nextEventId(),
        threadId,
        runId: null,
        type: normalized.type,
        role: normalized.role,
        content: normalized.content,
        data: data && Object.keys(data).length > 0 ? data : null,
        createdAt: typeof record.timestamp === "string" ? record.timestamp : undefined,
      });
    }

    if (record.type === "user" && record.isMeta !== true) {
      for (const text of userTextBlocks(record)) {
        if (!text.trim() || isEchoedAutomationText(text.trim())) continue;
        events.push({
          id: nextEventId(),
          threadId,
          runId: null,
          type: "user_message",
          role: "user",
          content: text,
          data: null,
          createdAt: typeof record.timestamp === "string" ? record.timestamp : undefined,
        });
      }
    }
  });

  return events;
}
