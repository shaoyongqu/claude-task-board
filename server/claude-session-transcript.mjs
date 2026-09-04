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

const QUESTION_TEXT_LIMIT = 2_000;

function cappedQuestionText(value) {
  return typeof value === "string" ? value.slice(0, QUESTION_TEXT_LIMIT) : "";
}

// Tool calls in the transcript tail that have not produced a tool_result yet.
// An interactive session sitting on one of these is waiting for a human:
// AskUserQuestion renders its option picker, other tools wait in the
// permission prompt. Sidechain (subagent) records never block the main turn.
export function extractPendingToolUses(records) {
  const pending = new Map();
  for (const record of records) {
    if (!record || typeof record !== "object" || record.isSidechain === true) continue;
    if (record.type === "assistant" && Array.isArray(record.message?.content)) {
      for (const block of record.message.content) {
        if (block?.type === "tool_use" && typeof block.id === "string" && block.id) {
          pending.set(block.id, {
            id: block.id,
            name: typeof block.name === "string" ? block.name : "",
            input: block.input && typeof block.input === "object" ? block.input : null,
          });
        }
      }
    } else if (record.type === "user" && Array.isArray(record.message?.content)) {
      for (const block of record.message.content) {
        if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {
          pending.delete(block.tool_use_id);
        }
      }
    }
  }
  return [...pending.values()];
}

export function normalizePendingQuestions(input) {
  if (!input || typeof input !== "object" || !Array.isArray(input.questions)) return null;
  const questions = [];
  for (const question of input.questions.slice(0, 4)) {
    if (!question || typeof question !== "object") continue;
    const options = Array.isArray(question.options)
      ? question.options
        .filter((option) => option && typeof option === "object" && typeof option.label === "string" && option.label)
        .slice(0, 4)
        .map((option) => ({
          label: cappedQuestionText(option.label),
          description: cappedQuestionText(option.description) || null,
        }))
      : [];
    if (options.length === 0) continue;
    questions.push({
      question: cappedQuestionText(question.question),
      header: cappedQuestionText(question.header) || null,
      multiSelect: question.multiSelect === true,
      options,
    });
  }
  return questions.length > 0 ? questions : null;
}

// The board answers a brokered AskUserQuestion by denying the tool call with a
// reason phrased like Claude Code's own answered-question tool_result, so the
// model treats the text as the user's actual answer instead of a failure.
export function formatAskUserQuestionAnswers(answers) {
  const parts = [];
  for (const answer of answers) {
    if (!answer || typeof answer !== "object") continue;
    const selections = Array.isArray(answer.selections)
      ? answer.selections.filter((value) => typeof value === "string" && value)
      : [];
    const custom = typeof answer.custom === "string" ? answer.custom.trim() : "";
    const choices = [...selections, ...(custom ? [`Other: ${custom}`] : [])];
    if (choices.length === 0) continue;
    parts.push(`"${cappedQuestionText(answer.question)}"="${choices.join(", ")}"`);
  }
  if (parts.length === 0) return null;
  return `User answered via taskboard: ${parts.join(", ")}. Treat these as the user's actual answers and continue; do not call AskUserQuestion again for these questions.`;
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
