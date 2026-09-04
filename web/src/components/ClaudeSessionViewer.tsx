import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import {
  answerClaudeSessionInput,
  getClaudeSessionTranscript,
  type ClaudeSessionPendingInput,
  type ClaudeSessionTranscript,
} from "../api";
import { useTaskboardI18n } from "../i18n";
import { CodexResumeIcon, ConversationIcon } from "./SemanticIcons";

// AiChat.tsx is a large code-split module; the timeline is only needed once a
// transcript is actually opened, so it loads on demand instead of entering the
// main bundle.
const MessageTimeline = lazy(() => import("./AiChat").then((module) => ({
  default: module.MessageTimeline,
})));

const RUNNING_POLL_INTERVAL_MS = 3_000;

interface ClaudeSessionViewerProps {
  threadId: string;
  title: string | null;
  onClose: () => void;
  onContinueInTerminal: (threadId: string) => void;
  onCopyCommand: (threadId: string) => void;
}

function statusLabel(
  transcript: ClaudeSessionTranscript,
  text: (chinese: string, english: string) => string,
) {
  if (transcript.pendingInput) {
    return text("等待回应", "Awaiting you");
  }
  if (transcript.running) {
    if (transcript.total !== null) {
      return `${transcript.completed ?? 0}/${transcript.total}`;
    }
    return text("正在处理", "Processing");
  }
  return text("已结束", "Finished");
}

type QuestionDraft = { selections: string[]; custom: string };

function draftIsAnswered(draft: QuestionDraft) {
  return draft.selections.length > 0 || draft.custom.trim().length > 0;
}

// Bottom bar for a session blocked on a human. Brokered AskUserQuestion calls
// (requestId present) can be answered right here; permission dialogs live in
// the owning terminal, so those (and questions from workspaces without the
// PreToolUse hook) only mirror the pending prompt and offer the terminal jump.
function PendingInputBar({
  threadId,
  pendingInput,
  onAnswered,
  onContinueInTerminal,
}: {
  threadId: string;
  pendingInput: ClaudeSessionPendingInput;
  onAnswered: () => void;
  onContinueInTerminal: (threadId: string) => void;
}) {
  const { text } = useTaskboardI18n();
  const [drafts, setDrafts] = useState<QuestionDraft[]>(() => (
    (pendingInput.questions ?? []).map(() => ({ selections: [], custom: "" }))
  ));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setDrafts((pendingInput.questions ?? []).map(() => ({ selections: [], custom: "" })));
    setError(null);
  }, [pendingInput.requestId, pendingInput.toolUseId, pendingInput.questions?.length]);

  function toggleSelection(index: number, label: string, multiSelect: boolean) {
    setDrafts((current) => current.map((draft, position) => {
      if (position !== index) return draft;
      if (!multiSelect) {
        return draft.selections[0] === label && !draft.custom
          ? { ...draft, selections: [] }
          : { ...draft, selections: [label] };
      }
      return {
        ...draft,
        selections: draft.selections.includes(label)
          ? draft.selections.filter((value) => value !== label)
          : [...draft.selections, label],
      };
    }));
  }

  async function submit() {
    if (!pendingInput.questions) return;
    setSubmitting(true);
    setError(null);
    try {
      await answerClaudeSessionInput(
        threadId,
        pendingInput.requestId,
        pendingInput.questions.map((question, index) => ({
          question: question.question,
          selections: drafts[index]?.selections ?? [],
          custom: drafts[index]?.custom.trim() || null,
        })),
      );
      onAnswered();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSubmitting(false);
    }
  }

  const answerable = pendingInput.kind === "question" && pendingInput.requestId !== null;
  const allAnswered = answerable
    && (pendingInput.questions ?? []).every((_, index) => draftIsAnswered(drafts[index] ?? { selections: [], custom: "" }));

  return (
    <footer className="claude-session-pending">
      <div className="claude-session-pending-head">
        <span className={`claude-session-pending-kind is-${pendingInput.kind}`}>
          {pendingInput.kind === "question"
            ? text("AI 提问，等待你的回应", "The AI is asking you a question")
            : text("会话在等待授权", "The session is waiting for permission")}
        </span>
        {pendingInput.message && <span className="claude-session-pending-message">{pendingInput.message}</span>}
        {pendingInput.kind === "permission" && pendingInput.toolDetail && (
          <code className="claude-session-pending-detail">{pendingInput.toolDetail}</code>
        )}
      </div>
      {pendingInput.questions?.map((question, index) => {
        const draft = drafts[index] ?? { selections: [], custom: "" };
        return (
          <div className="claude-session-question" key={index}>
            {question.header && <span className="claude-session-question-header">{question.header}</span>}
            <p className="claude-session-question-text">{question.question}</p>
            <div className="claude-session-question-options">
              {question.options.map((option) => (
                <button
                  key={option.label}
                  type="button"
                  disabled={!answerable}
                  className={`claude-session-option${draft.selections.includes(option.label) ? " is-selected" : ""}`}
                  title={option.description ?? undefined}
                  onClick={() => toggleSelection(index, option.label, question.multiSelect)}
                >
                  <span className="claude-session-option-label">{option.label}</span>
                  {option.description && <span className="claude-session-option-description">{option.description}</span>}
                </button>
              ))}
            </div>
            {answerable && (
              <input
                className="claude-session-question-custom"
                type="text"
                value={draft.custom}
                placeholder={text("自定义回答（可选）", "Custom answer (optional)")}
                onChange={(event) => setDrafts((current) => current.map((item, position) => (
                  position === index ? { ...item, custom: event.target.value } : item
                )))}
              />
            )}
          </div>
        );
      })}
      {error && <p className="claude-session-error" role="alert">{error}</p>}
      <div className="claude-session-pending-actions">
        {answerable ? (
          <button
            className="button primary"
            type="button"
            disabled={submitting || !allAnswered}
            onClick={() => void submit()}
          >
            {submitting ? text("发送中…", "Sending…") : text("发送回答", "Send answer")}
          </button>
        ) : (
          <>
            <span className="claude-session-pending-note">{text(
              "该问题由终端会话直接持有（工作区尚未安装问答代理钩子），请在终端中回应。",
              "This question is held by the terminal session itself (the workspace does not have the question-broker hook yet); answer it in the terminal.",
            )}</span>
            <button
              className="button secondary"
              type="button"
              title={text("在系统终端中回应此会话", "Answer this session in a system terminal")}
              onClick={() => onContinueInTerminal(threadId)}
            >
              <CodexResumeIcon />
              <span>{text("在终端中回应", "Answer in terminal")}</span>
            </button>
          </>
        )}
      </div>
    </footer>
  );
}

// Read-only browser view of a native Claude Code session transcript. The data
// comes from the session JSONL on disk, so the view can lag behind a session
// that is still running; it polls while running and offers the terminal
// takeover for interactive use.
export function ClaudeSessionViewer({
  threadId,
  title,
  onClose,
  onContinueInTerminal,
  onCopyCommand,
}: ClaudeSessionViewerProps) {
  const { text } = useTaskboardI18n();
  const [transcript, setTranscript] = useState<ClaudeSessionTranscript | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const pinnedToBottomRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRef = useRef(false);

  const refresh = useCallback(async (explicit: boolean) => {
    if (explicit) setRefreshing(true);
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    try {
      const next = await getClaudeSessionTranscript(threadId, controller.signal);
      if (controller.signal.aborted) return;
      activeRef.current = next.running || next.pendingInput !== null;
      setTranscript(next);
      setError(null);
    } catch (caught) {
      if (controller.signal.aborted) return;
      if (explicit) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      if (explicit && !controller.signal.aborted) setRefreshing(false);
    }
    if (controller.signal.aborted) return;
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    // Keep polling while the session runs OR is waiting on a human, so the
    // bar clears as soon as the answer lands in the transcript.
    if (activeRef.current) {
      pollTimerRef.current = setTimeout(() => void refresh(false), RUNNING_POLL_INTERVAL_MS);
    }
  }, [threadId]);

  useEffect(() => {
    setTranscript(null);
    setError(null);
    activeRef.current = false;
    pinnedToBottomRef.current = true;
    void refresh(false);
    return () => {
      abortRef.current?.abort();
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, [refresh]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body || !transcript) return;
    if (pinnedToBottomRef.current) {
      body.scrollTop = body.scrollHeight;
    }
  }, [transcript]);

  function handleBodyScroll() {
    const body = bodyRef.current;
    if (!body) return;
    pinnedToBottomRef.current = body.scrollTop + body.clientHeight >= body.scrollHeight - 48;
  }

  const shortId = threadId.slice(0, 8);
  return (
    <div
      className="claude-session-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="claude-session-viewer"
        role="dialog"
        aria-modal="true"
        aria-label={title ?? text(`Claude Code 会话 ${shortId}`, `Claude Code session ${shortId}`)}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
      >
        <header className="claude-session-header">
          <span className="claude-session-title">
            <ConversationIcon color="currentColor" size={16} />
            <strong>{title ?? text("任务对话", "Task conversation")}</strong>
            <span className={`claude-session-status${transcript?.running || transcript?.pendingInput ? " is-running" : ""}${transcript?.pendingInput ? " is-awaiting" : ""}`}>
              {transcript ? statusLabel(transcript, text) : "…"}
            </span>
          </span>
          <span className="claude-session-header-actions">
            <button
              className="button secondary"
              type="button"
              disabled={refreshing}
              onClick={() => void refresh(true)}
            >
              {refreshing ? text("刷新中…", "Refreshing…") : text("刷新", "Refresh")}
            </button>
            <button
              className="button secondary"
              type="button"
              title={text("在系统终端中续接此 Claude Code 会话", "Resume this Claude Code session in a system terminal")}
              onClick={() => onContinueInTerminal(threadId)}
            >
              <CodexResumeIcon />
              <span>{text("在终端继续", "Continue in terminal")}</span>
            </button>
            <button
              className="button secondary"
              type="button"
              title={text("复制终端命令", "Copy terminal command")}
              onClick={() => onCopyCommand(threadId)}
            >
              <span>{text("复制终端命令", "Copy terminal command")}</span>
            </button>
            <button
              className="claude-session-close"
              type="button"
              aria-label={text("关闭", "Close")}
              onClick={onClose}
            >
              ✕
            </button>
          </span>
        </header>
        {transcript?.workspacePath && (
          <div className="claude-session-meta">
            <code>{transcript.workspacePath}</code>
            <span>{shortId}</span>
          </div>
        )}
        <div
          ref={bodyRef}
          className="claude-session-body"
          onScroll={handleBodyScroll}
        >
          {error && <p className="claude-session-error" role="alert">{error}</p>}
          {!error && !transcript && (
            <p className="claude-session-hint">{text("正在读取会话记录…", "Loading session transcript…")}</p>
          )}
          {transcript && transcript.events.length === 0 && !error && (
            <p className="claude-session-hint">{text("该会话没有可显示的消息。", "This session has no visible messages.")}</p>
          )}
          {transcript && transcript.events.length > 0 && (
            <Suspense fallback={null}>
              <MessageTimeline activeRunId={null} events={transcript.events} skills={[]} />
            </Suspense>
          )}
        </div>
        {transcript?.pendingInput && (
          <PendingInputBar
            threadId={threadId}
            pendingInput={transcript.pendingInput}
            onAnswered={() => void refresh(false)}
            onContinueInTerminal={onContinueInTerminal}
          />
        )}
      </div>
    </div>
  );
}
