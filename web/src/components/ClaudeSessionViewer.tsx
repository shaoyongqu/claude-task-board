import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { getClaudeSessionTranscript, type ClaudeSessionTranscript } from "../api";
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
  if (transcript.running) {
    if (transcript.total !== null) {
      return `${transcript.completed ?? 0}/${transcript.total}`;
    }
    return text("正在处理", "Processing");
  }
  return text("已结束", "Finished");
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
  const runningRef = useRef(false);

  const refresh = useCallback(async (explicit: boolean) => {
    if (explicit) setRefreshing(true);
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    try {
      const next = await getClaudeSessionTranscript(threadId, controller.signal);
      if (controller.signal.aborted) return;
      runningRef.current = next.running;
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
    if (runningRef.current) {
      pollTimerRef.current = setTimeout(() => void refresh(false), RUNNING_POLL_INTERVAL_MS);
    }
  }, [threadId]);

  useEffect(() => {
    setTranscript(null);
    setError(null);
    runningRef.current = false;
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
            <span className={`claude-session-status${transcript?.running ? " is-running" : ""}`}>
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
      </div>
    </div>
  );
}
