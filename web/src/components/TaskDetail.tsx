import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { taskboardStorage } from "../storage";
import {
  ApiError,
  attachmentDownloadUrl,
  createComment,
  deleteComment,
  getTask,
  listAttachments,
  listComments,
  listScheduleRuns,
  listTaskActivities,
  resolveTaskboardUrl,
  uploadAttachment,
  uploadCommentAttachment,
  updateComment,
} from "../api";
import {
  taskPriorityLabel,
  taskStatusLabel,
  useTaskboardI18n,
  type TaskboardLanguage,
} from "../i18n";
import { MACHINE_MODEL_PROFILE_ID, TASK_PRIORITIES, TASK_STATUSES } from "../types";
import type {
  ActorIdentity,
  Attachment,
  Comment,
  CodexThreadBinding,
  DevelopmentContext,
  DevelopmentScan,
  IssueRelationOrigin,
  IssueRelationType,
  ModelProfile,
  Recurrence,
  Schedule,
  ScheduleRun,
  Task,
  TaskChangeActivity,
  TaskDraft,
  TaskPriority,
  TaskRelationSummary,
  TaskStatus,
} from "../types";
import {
  CLAUDE_AGENT_ACTOR,
  actorKey,
  assigneeTargetForActor,
} from "../actors";
import { ActorAvatar } from "./ActorAvatar";
import { STATUS_DETAILS } from "./BoardColumn";
import { LabelPicker } from "./LabelPicker";
import { LinearIcon } from "./LinearIcon";
import { ScheduleEditor } from "./ScheduleEditor";
import { describeSchedule, scheduleIsPeriodic } from "../schedule";
import {
  AttachmentIcon,
  BlockingRelationIcon,
  BranchIcon,
  CodexResumeIcon,
  ConversationIcon,
  DeleteIcon,
  DueDateIcon,
  EditIcon,
  LabelIcon,
  MoreIcon,
  NewConversationIcon,
  PriorityIcon,
  ProjectIcon,
  RecurrenceIcon,
  RelationIcon,
  StatusIcon,
} from "./SemanticIcons";
import {
  createInlineMediaSegments,
  InlineMediaComposer,
  inlineMediaFiles,
  inlineMediaImages,
  inlineMediaText,
  resolveInlineAttachmentMarkdown,
  resolveInlineMediaMarkdown,
  serializeInlineMedia,
  type InlineMediaComposerHandle,
  type InlineMediaSegment,
} from "./InlineMediaComposer";
import {
  IssueParentLink,
  IssueRelationSidebar,
  IssueSubIssues,
  type RelationMutationResult,
} from "./IssueRelations";
import { TaskPropertyPicker } from "./TaskPropertyPicker";
import { TaskboardIcon } from "./TaskboardIcon";
import { buildIssueUrl } from "../issueRoute";
import copyIdIcon from "../assets/figma-taskboard/copy-id.svg";
import copyLinkIcon from "../assets/figma-taskboard/copy-link.svg";
import { DescriptionDocument } from "./DescriptionDocument";

type TaskDetailError = string | readonly [string, string];

// Mirrors the model catalog's supported effort ladder and the CLI's --effort.
const TASK_REASONING_EFFORTS = ["low", "medium", "high", "max"] as const;

const TASK_EFFORT_LABELS: Record<string, readonly [string, string]> = {
  low: ["轻度", "Low"],
  medium: ["中", "Medium"],
  high: ["高", "High"],
  max: ["最高", "Maximum"],
};

interface TaskDetailProps {
  task: Task;
  tasks: Task[];
  referenceTasks: Task[];
  currentUser: ActorIdentity;
  availableLabels: string[];
  developmentScan: DevelopmentScan;
  developmentScanLoading: boolean;
  modelProfiles?: ModelProfile[];
  commentsRevision: number;
  attachmentsRevision: number;
  onCreateLabel: (label: string) => Promise<void>;
  onDeleteLabel: (label: string) => Promise<void>;
  onUpdate: (task: Task, changes: Partial<TaskDraft>) => Promise<Task>;
  onOpenTask: (task: TaskRelationSummary) => void;
  onAddRelation: (
    task: Task,
    type: IssueRelationType,
    relatedTaskId: string,
    origin?: IssueRelationOrigin,
  ) => Promise<RelationMutationResult>;
  onRemoveRelation: (
    task: Task,
    type: IssueRelationType,
    relatedTaskId: string,
    origin?: IssueRelationOrigin,
  ) => Promise<RelationMutationResult>;
  onOpenThread: (binding: CodexThreadBinding) => void;
  onOpenInTerminal: (threadId: string) => void;
  onOpenLegacyLocalThread: (threadId: string) => void;
  onOpenInThread: (task: Task) => void;
  executionLocked?: boolean;
  onTerminateExecution?: (task: Task) => void;
  onCopy: (text: string, announcement: string) => void;
  openingThread: boolean;
  onError: (message: TaskDetailError | null) => void;
}

function messageFor(error: unknown): TaskDetailError {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return ["操作未完成，请重试。", "The action could not be completed. Try again."];
}

function issueMessageFor(error: unknown): TaskDetailError {
  if (error instanceof ApiError && error.code === "VERSION_CONFLICT") {
    return [
      "该议题已在其他位置更新，请刷新后重试。",
      "This issue changed elsewhere. Refresh and try again.",
    ];
  }
  return messageFor(error);
}

function exactTime(value: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function relativeTime(value: string, locale: string): string {
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return formatter.format(days, "day");
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(new Date(value));
}

type ActivityGrouping = "day" | "week" | "none";

// Beyond this many visible entries the timeline auto-collapses every group
// except the most recent one so long histories stay scannable.
const ACTIVITY_AUTO_COLLAPSE_ENTRIES = 15;

type ActivityText = (zh: string, en: string) => string;

function dateKeyOf(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function localDateKey(value: string): string {
  return dateKeyOf(new Date(value));
}

// Week groups start on Monday.
function activityGroupKeyOf(value: string, grouping: ActivityGrouping): string {
  if (grouping === "day") return localDateKey(value);
  if (grouping === "week") {
    const date = new Date(value);
    date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
    return dateKeyOf(date);
  }
  return "all";
}

function activityGroupLabel(
  key: string,
  grouping: ActivityGrouping,
  locale: string,
  text: ActivityText,
): string {
  if (grouping === "none") return "";
  const date = new Date(`${key}T00:00:00`);
  if (grouping === "week") {
    const end = new Date(date);
    end.setDate(end.getDate() + 6);
    const range = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" });
    return `${range.format(date)} – ${range.format(end)}`;
  }
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const prefix = key === dateKeyOf(today)
    ? text("今天 · ", "Today · ")
    : key === dateKeyOf(yesterday)
      ? text("昨天 · ", "Yesterday · ")
      : "";
  const options: Intl.DateTimeFormatOptions = date.getFullYear() === today.getFullYear()
    ? { month: "long", day: "numeric", weekday: "short" }
    : { year: "numeric", month: "long", day: "numeric", weekday: "short" };
  return prefix + new Intl.DateTimeFormat(locale, options).format(date);
}

function scheduleRunStatusLabel(status: ScheduleRun["status"], text: ActivityText): string {
  if (status === "running") return text("执行中", "Running");
  if (status === "completed") return text("已完成", "Completed");
  if (status === "failed") return text("失败", "Failed");
  return text("已中断", "Interrupted");
}

function formatRunDuration(run: ScheduleRun, text: ActivityText): string {
  const end = run.finishedAt ? new Date(run.finishedAt).getTime() : Date.now();
  const totalSeconds = Math.max(0, Math.round((end - new Date(run.startedAt).getTime()) / 1000));
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const duration = hours > 0
    ? text(`${hours} 小时 ${minutes} 分`, `${hours}h ${minutes}m`)
    : minutes > 0
      ? text(`${minutes} 分 ${seconds} 秒`, `${minutes}m ${seconds}s`)
      : text(`${seconds} 秒`, `${seconds}s`);
  return run.finishedAt ? text(`耗时 ${duration}`, duration) : text(`已进行 ${duration}`, `${duration} elapsed`);
}

function resizeTextarea(element: HTMLTextAreaElement | null) {
  if (!element) return;
  element.style.height = "0px";
  element.style.height = `${element.scrollHeight}px`;
}

async function downloadAttachmentFile(attachment: Attachment) {
  const response = await fetch(resolveTaskboardUrl(attachmentDownloadUrl(attachment)));
  if (!response.ok) {
    throw new ApiError(response.status, await response.json().catch(() => ({})));
  }
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = attachment.filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function contextValue(context: DevelopmentContext | null): string {
  return context ? JSON.stringify(context) : "";
}

function contextLabel(
  context: DevelopmentContext,
  text: (chinese: string, english: string) => string,
): string {
  if (context.type === "branch") return context.branch;
  const folder = context.path.split(/[\\/]/).filter(Boolean).at(-1) ?? context.path;
  return `${context.branch ?? text("分离 HEAD", "detached")} · ${folder}`;
}

const ACTIVITY_FIELD_LABELS: Record<string, readonly [string, string]> = {
  projectId: ["项目", "project"],
  title: ["标题", "title"],
  description: ["描述", "description"],
  status: ["状态", "status"],
  priority: ["优先级", "priority"],
  labels: ["标签", "labels"],
  assignee: ["负责人", "assignee"],
  developmentContext: ["开发上下文", "development context"],
  startDate: ["开始日期", "start date"],
  dueDate: ["截止日期", "due date"],
  recurrence: ["重复", "recurrence"],
  schedule: ["定时执行", "schedule"],
  archivedAt: ["归档状态", "archive status"],
  relation: ["关系", "relation"],
};

const RELATION_LABELS: Record<IssueRelationType, readonly [string, string]> = {
  parent: ["父议题", "Parent issue"],
  blocks: ["阻塞", "Blocks"],
  blocked_by: ["阻塞于", "Blocked by"],
  related: ["相关议题", "Related issue"],
};

function activityValue(
  field: string,
  value: unknown,
  language: TaskboardLanguage,
  locale: string,
  text: (chinese: string, english: string) => string,
): string {
  if (field === "archivedAt") {
    return typeof value === "string"
      ? text(`已归档（${exactTime(value, locale)}）`, `Archived (${exactTime(value, locale)})`)
      : text("未归档", "Not archived");
  }
  if (value === null || value === "") return text("未设置", "Not set");
  if (field === "status" && typeof value === "string" && value in STATUS_DETAILS) {
    return taskStatusLabel(language, value as TaskStatus);
  }
  if (field === "priority" && typeof value === "string" && TASK_PRIORITIES.includes(value as TaskPriority)) {
    return taskPriorityLabel(language, value as TaskPriority);
  }
  if (field === "labels" && Array.isArray(value)) {
    return value.length > 0
      ? value.join(language === "zh" ? "、" : ", ")
      : text("无标签", "No labels");
  }
  if (field === "assignee" && typeof value === "object") {
    const actor = value as ActorIdentity;
    return `${actor.name} @${actor.id}`;
  }
  if (field === "developmentContext" && typeof value === "object") {
    const context = value as { type: string; branch?: string | null; path?: string | null };
    if (context.type === "branch") return context.branch ?? text("未设置", "Not set");
    const folder = context.path?.split(/[\\/]/).filter(Boolean).at(-1);
    return `${context.branch ?? text("分离 HEAD", "detached")}${folder ? ` · ${folder}` : ""}`;
  }
  if (field === "recurrence" && typeof value === "object") {
    const recurrence = value as Recurrence;
    const units: Record<Recurrence["unit"], readonly [string, string]> = {
      day: ["天", "day"],
      week: ["周", "week"],
      month: ["月", "month"],
      year: ["年", "year"],
    };
    const [chineseUnit, englishUnit] = units[recurrence.unit];
    return text(
      recurrence.interval === 1 ? `每${chineseUnit}` : `每 ${recurrence.interval} ${chineseUnit}`,
      `Every ${recurrence.interval === 1 ? "" : `${recurrence.interval} `}${englishUnit}${recurrence.interval === 1 ? "" : "s"}`,
    );
  }
  if (field === "schedule" && typeof value === "object") {
    return describeSchedule(value as Schedule, text);
  }
  if (field === "relation" && typeof value === "object") {
    const relation = value as {
      type: IssueRelationType;
      identifier: string;
      externalKey?: string | null;
      title: string;
    };
    const [chineseLabel, englishLabel] = RELATION_LABELS[relation.type];
    return `${text(chineseLabel, englishLabel)} ${relation.externalKey ?? relation.identifier} · ${relation.title}`;
  }
  if (Array.isArray(value)) return value.join(language === "zh" ? "、" : ", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function ActivityChangeIcon({ field, before, after }: {
  field: string;
  before: unknown;
  after: unknown;
}) {
  const value = after ?? before;
  if (field === "status" && typeof value === "string" && value in STATUS_DETAILS) {
    return <StatusIcon status={value as TaskStatus} color="currentColor" size={14} />;
  }
  if (field === "priority" && typeof value === "string" && TASK_PRIORITIES.includes(value as TaskPriority)) {
    return <PriorityIcon priority={value as TaskPriority} color="currentColor" size={14} />;
  }
  if (field === "relation" && typeof value === "object") {
    const relation = value as { type?: IssueRelationType };
    if (relation.type === "blocked_by" || relation.type === "blocks") {
      return <BlockingRelationIcon type={relation.type} color="currentColor" size={14} />;
    }
    return <RelationIcon color="currentColor" size={14} />;
  }
  if (field === "projectId") return <ProjectIcon color="currentColor" size={14} />;
  if (field === "labels") return <LabelIcon color="currentColor" size={14} />;
  if (field === "assignee") return <LinearIcon name="myIssues" />;
  if (field === "developmentContext") return <BranchIcon color="currentColor" size={14} />;
  if (field === "startDate") return <DueDateIcon color="currentColor" size={14} />;
  if (field === "dueDate") return <DueDateIcon color="currentColor" size={14} />;
  if (field === "recurrence") return <RecurrenceIcon color="currentColor" size={14} />;
  if (field === "schedule") return <RecurrenceIcon color="currentColor" size={14} />;
  if (field === "archivedAt") return <DeleteIcon color="currentColor" size={14} />;
  return <EditIcon color="currentColor" size={14} />;
}

function ConversationLink({
  threadId,
  onOpen,
  onTerminal,
  onCopy,
}: {
  threadId: string;
  onOpen: () => void;
  onTerminal: () => void;
  onCopy: (text: string, announcement: string) => void;
}) {
  const { text } = useTaskboardI18n();
  return (
    <div className="issue-conversation-actions">
      <button
        className="issue-conversation-link"
        type="button"
        title={text("查看对话", "View conversation")}
        onClick={onOpen}
      >
        <ConversationIcon color="currentColor" size={16} />
        <strong>{text("查看对话", "View conversation")}</strong>
      </button>
      <button
        className="issue-conversation-terminal"
        type="button"
        title={text("在终端中继续此 Claude Code 会话", "Continue this Claude Code session in a terminal")}
        onClick={onTerminal}
      >
        <CodexResumeIcon />
        <span>{text("在终端继续", "Continue in terminal")}</span>
      </button>
      <button
        className="issue-conversation-copy"
        type="button"
        title={text("复制终端命令", "Copy terminal command")}
        onClick={() => onCopy(
          `claude --resume ${threadId}`,
          text("Claude Code 恢复命令已复制。", "Claude Code resume command copied."),
        )}
      >
        <CodexResumeIcon />
        <span>{text("复制终端命令", "Copy terminal command")}</span>
      </button>
    </div>
  );
}

export function TaskDetail({
  task,
  tasks,
  referenceTasks,
  currentUser,
  availableLabels,
  developmentScan,
  developmentScanLoading,
  modelProfiles,
  commentsRevision,
  attachmentsRevision,
  onCreateLabel,
  onDeleteLabel,
  onUpdate,
  onOpenTask,
  onAddRelation,
  onRemoveRelation,
  onOpenThread,
  onOpenLegacyLocalThread,
  onOpenInTerminal,
  onOpenInThread,
  executionLocked = false,
  onTerminateExecution,
  onCopy,
  openingThread,
  onError,
}: TaskDetailProps) {
  const { language, locale, text } = useTaskboardI18n();
  const [currentTask, setCurrentTask] = useState(task);
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [descriptionSegments, setDescriptionSegments] = useState<InlineMediaSegment[]>(
    () => createInlineMediaSegments(task.description, referenceTasks),
  );
  const [editingDescription, setEditingDescription] = useState(false);
  const [propertyMenu, setPropertyMenu] = useState<
    "status" | "priority" | "assignee" | "labels" | "modelProfile" | "reasoningEffort" | "development" | "schedule" | null
  >(null);
  const schedulePopoverRef = useRef<HTMLDivElement | null>(null);
  const [savingProperty, setSavingProperty] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachmentsError, setAttachmentsError] = useState<TaskDetailError | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [taskActivities, setTaskActivities] = useState<TaskChangeActivity[]>([]);
  const [scheduleRunList, setScheduleRunList] = useState<ScheduleRun[]>([]);
  const [runsDialogOpen, setRunsDialogOpen] = useState(false);
  const [activityGrouping, setActivityGrouping] = useState<ActivityGrouping>("day");
  const [activityDateFilter, setActivityDateFilter] = useState<string | null>(null);
  const [activityRoundFilter, setActivityRoundFilter] = useState<number | null>(null);
  // Per-group expansion decisions the user made explicitly; groups without an
  // entry follow the auto-collapse default (every group but the newest one
  // collapses once the timeline grows past ACTIVITY_AUTO_COLLAPSE_ENTRIES).
  const [activityExpanded, setActivityExpanded] = useState<Map<string, boolean>>(new Map());
  const [commentsLoading, setCommentsLoading] = useState(true);
  const [commentsError, setCommentsError] = useState<TaskDetailError | null>(null);
  const [commentSegments, setCommentSegments] = useState<InlineMediaSegment[]>(
    () => createInlineMediaSegments(
      taskboardStorage.getItem(`taskboard.comment-draft.${task.id}`) ?? "",
      referenceTasks,
    ),
  );
  const [changeStatusToTodo, setChangeStatusToTodo] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingSegments, setEditingSegments] = useState<InlineMediaSegment[]>(
    () => createInlineMediaSegments(),
  );
  const [savingCommentId, setSavingCommentId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Comment | null>(null);
  const [deleting, setDeleting] = useState(false);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const descriptionComposerRef = useRef<InlineMediaComposerHandle>(null);
  const descriptionScrollPositionRef = useRef<{ element: HTMLElement; top: number } | null>(null);
  const descriptionCaretRef = useRef<{ text: string; offset: number; occurrence: number } | null>(null);
  const composerRef = useRef<InlineMediaComposerHandle>(null);
  const editingComposerRef = useRef<InlineMediaComposerHandle>(null);
  const editingCommentScrollPositionRef = useRef<{ element: HTMLElement; top: number } | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const commentAttachmentInputRef = useRef<HTMLInputElement>(null);
  const editCommentAttachmentInputRef = useRef<HTMLInputElement>(null);
  const editingUploadedAttachmentsRef = useRef<Map<string, Attachment>>(new Map());
  const draft = serializeInlineMedia(commentSegments);
  const commentInlineImages = inlineMediaImages(commentSegments);
  const commentInlineFiles = inlineMediaFiles(commentSegments);
  const editingDraft = serializeInlineMedia(editingSegments);
  const displayIdentifier = currentTask.externalKey ?? currentTask.identifier;
  const editingInlineImages = inlineMediaImages(editingSegments);
  const editingInlineFiles = inlineMediaFiles(editingSegments);

  useEffect(() => {
    const taskChanged = currentTask.id !== task.id;
    setCurrentTask(task);
    if (document.activeElement !== titleRef.current) setTitle(task.title);
    if (taskChanged || !editingDescription) {
      setDescription(task.description);
      setDescriptionSegments(createInlineMediaSegments(task.description, referenceTasks));
    }
    if (taskChanged) {
      setEditingDescription(false);
      setChangeStatusToTodo(false);
    }
  }, [task]);

  useEffect(() => {
    resizeTextarea(titleRef.current);
  }, [title]);

  useLayoutEffect(() => {
    if (!editingDescription) return;
    const position = descriptionScrollPositionRef.current;
    descriptionScrollPositionRef.current = null;
    const caret = descriptionCaretRef.current;
    descriptionCaretRef.current = null;
    if (caret) {
      descriptionComposerRef.current?.focusAtText(caret.text, caret.offset, caret.occurrence);
    } else {
      descriptionComposerRef.current?.focus();
    }
    if (position) {
      position.element.scrollTop = position.top;
      requestAnimationFrame(() => {
        position.element.scrollTop = position.top;
      });
    }
  }, [editingDescription]);

  useLayoutEffect(() => {
    if (!editingId) return;
    const position = editingCommentScrollPositionRef.current;
    editingCommentScrollPositionRef.current = null;
    editingComposerRef.current?.focus();
    if (position) {
      position.element.scrollTop = position.top;
      requestAnimationFrame(() => {
        position.element.scrollTop = position.top;
      });
    }
  }, [editingId]);

  useEffect(() => {
    const controller = new AbortController();
    setCommentsError(null);
    void Promise.all([
      listComments(task.id, controller.signal),
      listTaskActivities(task.id, controller.signal),
    ]).then(
      ([nextComments, nextActivities]) => {
        setComments(nextComments);
        setTaskActivities(nextActivities);
        setCommentsLoading(false);
      },
      (error) => {
        if ((error as Error).name === "AbortError") return;
        setCommentsError(messageFor(error));
        setCommentsLoading(false);
      },
    );
    return () => controller.abort();
  }, [commentsRevision, task.activityKey, task.id]);

  useEffect(() => {
    const controller = new AbortController();
    setAttachmentsError(null);
    void listAttachments(task.id, controller.signal).then(
      (nextAttachments) => {
        setAttachments(nextAttachments.filter((attachment) => !attachment.commentId));
      },
      (error) => {
        if ((error as Error).name === "AbortError") return;
        setAttachmentsError(messageFor(error));
      },
    );
    return () => controller.abort();
  }, [attachmentsRevision, task.id]);

  useEffect(() => {
    function receiveAttachmentOpenError(event: MessageEvent) {
      if (event.source !== window.parent || !event.data || typeof event.data !== "object") return;
      if (event.data.type !== "taskboard:attachment-open-error") return;
      setAttachmentsError(typeof event.data.payload?.error === "string"
        ? event.data.payload.error
        : ["无法打开附件，请重试。", "Could not open the attachment. Try again."]);
    }
    window.addEventListener("message", receiveAttachmentOpenError);
    return () => window.removeEventListener("message", receiveAttachmentOpenError);
  }, []);

  useEffect(() => {
    const key = `taskboard.comment-draft.${task.id}`;
    const text = inlineMediaText(commentSegments);
    if (text) taskboardStorage.setItem(key, text);
    else taskboardStorage.removeItem(key);
  }, [commentSegments, task.id]);

  useEffect(() => {
    function handleShortcut(event: globalThis.KeyboardEvent) {
      if (event.key.toLowerCase() !== "r" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable='true']")) return;
      event.preventDefault();
      composerRef.current?.focus();
    }
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  useEffect(() => {
    if (propertyMenu !== "schedule") return;
    function closeSchedulePopover(event: PointerEvent) {
      if (!schedulePopoverRef.current?.contains(event.target as Node)) setPropertyMenu(null);
    }
    document.addEventListener("pointerdown", closeSchedulePopover);
    return () => document.removeEventListener("pointerdown", closeSchedulePopover);
  }, [propertyMenu]);

  // Execution rounds reload whenever the summary on the task payload changes
  // (a round started, finished, or the issue moved).
  const runTotal = currentTask.scheduleRuns?.total ?? 0;
  const runningRunId = currentTask.scheduleRuns?.current?.id ?? null;
  const latestRunFinishedAt = currentTask.scheduleRuns?.latest?.finishedAt ?? null;
  // scheduleRunList comes back ordered newest → oldest by sequence.
  const latestScheduleRun = scheduleRunList[0] ?? null;
  const scheduleRunCounts = useMemo(() => {
    const counts = { running: 0, completed: 0, failed: 0, interrupted: 0 };
    for (const run of scheduleRunList) counts[run.status] += 1;
    return counts;
  }, [scheduleRunList]);
  useEffect(() => {
    if (runTotal === 0 && runningRunId === null) {
      setScheduleRunList([]);
      return;
    }
    const controller = new AbortController();
    listScheduleRuns(currentTask.id, controller.signal)
      .then((runs) => setScheduleRunList(runs))
      .catch(() => {});
    return () => controller.abort();
  }, [currentTask.id, runTotal, runningRunId, latestRunFinishedAt]);

  const runByThreadId = useMemo(() => {
    const map = new Map<string, ScheduleRun>();
    for (const run of scheduleRunList) {
      if (run.threadId) map.set(run.threadId, run);
    }
    return map;
  }, [scheduleRunList]);

  useEffect(() => {
    if (!runsDialogOpen) return;
    // Trap Escape while the rounds dialog is open so the app-level shortcut
    // (Escape returns to the board) does not also close the issue detail.
    function closeRunsDialog(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopImmediatePropagation();
        setRunsDialogOpen(false);
      }
    }
    // Capture phase beats the app-level listener registered earlier on window.
    window.addEventListener("keydown", closeRunsDialog, true);
    return () => window.removeEventListener("keydown", closeRunsDialog, true);
  }, [runsDialogOpen]);

  useEffect(() => {
    if (!activeMenuId) return;
    function closeMenu(event: PointerEvent) {
      const target = event.target as HTMLElement;
      if (!target.closest(`[data-comment-menu-root="${activeMenuId}"]`)) setActiveMenuId(null);
    }
    function closeWithEscape(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") setActiveMenuId(null);
    }
    document.addEventListener("pointerdown", closeMenu);
    window.addEventListener("keydown", closeWithEscape);
    return () => {
      document.removeEventListener("pointerdown", closeMenu);
      window.removeEventListener("keydown", closeWithEscape);
    };
  }, [activeMenuId]);

  async function saveTask(changes: Partial<TaskDraft>, property: string) {
    setSavingProperty(property);
    onError(null);
    try {
      const saved = await onUpdate(currentTask, changes);
      setCurrentTask(saved);
      setTitle(saved.title);
      setDescription(saved.description);
      return saved;
    } catch (error) {
      onError(issueMessageFor(error));
      setTitle(currentTask.title);
      setDescription(currentTask.description);
      return null;
    } finally {
      setSavingProperty(null);
    }
  }

  function openDatePicker(
    field: "startDate" | "dueDate",
    event: MouseEvent<HTMLLabelElement>,
  ) {
    const input = event.currentTarget.querySelector("input");
    if (!input || input.disabled) return;
    event.preventDefault();
    input.showPicker();
  }

  async function applyRelationMutation(
    mutation: () => Promise<RelationMutationResult>,
  ): Promise<RelationMutationResult> {
    onError(null);
    try {
      const result = await mutation();
      const nextCurrent = result.task.id === currentTask.id
        ? result.task
        : result.relatedTask.id === currentTask.id
          ? result.relatedTask
          : null;
      if (nextCurrent) setCurrentTask(nextCurrent);
      return result;
    } catch (error) {
      onError(issueMessageFor(error));
      throw error;
    }
  }

  async function addMentionRelations(
    anchor: Task,
    segments: InlineMediaSegment[],
  ): Promise<Task> {
    let current = anchor;
    const relatedIds = new Set(current.relations.related.map((relation) => relation.id));
    for (const segment of segments) {
      if (segment.type !== "issue-reference" || !segment.taskId) continue;
      const relatedTaskId = segment.taskId;
      if (
        relatedTaskId === current.id
        || segment.projectId !== current.projectId
        || relatedIds.has(relatedTaskId)
      ) continue;
      const result = await applyRelationMutation(
        () => onAddRelation(current, "related", relatedTaskId, "mention"),
      );
      current = result.task;
      relatedIds.add(relatedTaskId);
    }
    return current;
  }

  function mentionTaskIds(segments: InlineMediaSegment[]): Set<string> {
    return new Set(segments.flatMap((segment) => (
      segment.type === "issue-reference" && segment.taskId ? [segment.taskId] : []
    )));
  }

  function removedMentionTaskIds(
    previous: InlineMediaSegment[],
    next: InlineMediaSegment[],
  ): Set<string> {
    const nextIds = mentionTaskIds(next);
    return new Set([...mentionTaskIds(previous)].filter((taskId) => !nextIds.has(taskId)));
  }

  async function removeUnreferencedMentionRelations(
    anchor: Task,
    candidates: Set<string>,
  ): Promise<Task> {
    if (candidates.size === 0) return anchor;
    const savedComments = await listComments(anchor.id);
    const referencedIds = mentionTaskIds(createInlineMediaSegments(anchor.description, referenceTasks));
    for (const comment of savedComments) {
      for (const taskId of mentionTaskIds(createInlineMediaSegments(comment.body, referenceTasks))) {
        referencedIds.add(taskId);
      }
    }

    let current = anchor;
    for (const relatedTaskId of candidates) {
      if (
        referencedIds.has(relatedTaskId)
        || !current.relations.related.some((relation) => relation.id === relatedTaskId)
      ) continue;
      const relatedTask = await getTask(relatedTaskId);
      if (
        mentionTaskIds(createInlineMediaSegments(relatedTask.description, referenceTasks))
          .has(anchor.id)
      ) continue;
      const relatedComments = await listComments(relatedTaskId);
      if (relatedComments.some((comment) => (
        mentionTaskIds(createInlineMediaSegments(comment.body, referenceTasks)).has(anchor.id)
      ))) continue;
      const result = await applyRelationMutation(
        () => onRemoveRelation(current, "related", relatedTaskId, "mention"),
      );
      current = result.task;
    }
    return current;
  }

  function handleTitleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.blur();
    }
    if (event.key === "Escape") {
      setTitle(currentTask.title);
      event.currentTarget.blur();
    }
  }

  async function saveTitle() {
    const normalized = title.trim();
    if (!normalized) {
      setTitle(currentTask.title);
      onError(["议题标题不能为空。", "Issue title cannot be empty."]);
      return;
    }
    if (normalized === currentTask.title) {
      setTitle(normalized);
      return;
    }
    await saveTask({ title: normalized }, "title");
  }

  async function saveDescription() {
    if (savingProperty === "description") return;
    const draftDescription = serializeInlineMedia(descriptionSegments).trim();
    const inlineImages = inlineMediaImages(descriptionSegments);
    const inlineFiles = inlineMediaFiles(descriptionSegments);
    if (
      draftDescription === currentTask.description
      && inlineImages.length === 0
      && inlineFiles.length === 0
    ) {
      setEditingDescription(false);
      return;
    }
    const removedMentionIds = removedMentionTaskIds(
      createInlineMediaSegments(currentTask.description, referenceTasks),
      descriptionSegments,
    );

    setSavingProperty("description");
    onError(null);
    try {
      const uploadedImages = await Promise.all(
        inlineImages.map((image) => uploadAttachment(currentTask.id, image.file, "inline")),
      );
      const uploadedFiles = await Promise.all(
        inlineFiles.map((file) => uploadAttachment(currentTask.id, file.file, "attachment")),
      );
      const resolvedDescription = resolveInlineAttachmentMarkdown(
        resolveInlineMediaMarkdown(
          draftDescription,
          inlineImages,
          uploadedImages,
        ),
        inlineFiles,
        uploadedFiles,
      ).trim();
      const saved = await onUpdate(currentTask, { description: resolvedDescription }).catch((error) => {
        onError(issueMessageFor(error));
        return null;
      });
      if (!saved) return;
      const savedWithAddedRelations = await addMentionRelations(saved, descriptionSegments);
      const savedWithRelations = await removeUnreferencedMentionRelations(
        savedWithAddedRelations,
        removedMentionIds,
      );
      setCurrentTask(savedWithRelations);
      setDescription(savedWithRelations.description);
      const nextAttachments = [
        ...attachments,
        ...[...uploadedImages, ...uploadedFiles].filter((attachment) => (
          !attachments.some((item) => item.id === attachment.id)
        )),
      ];
      setDescriptionSegments(createInlineMediaSegments(
        savedWithRelations.description,
        referenceTasks,
        nextAttachments,
      ));
      setAttachments(nextAttachments);
      setEditingDescription(false);
    } catch (error) {
      onError(messageFor(error));
    } finally {
      setSavingProperty(null);
    }
  }

  async function submitComment() {
    const body = draft.trim();
    if ((!body && commentInlineImages.length === 0 && commentInlineFiles.length === 0) || submitting) return;
    setSubmitting(true);
    setCommentsError(null);
    try {
      const comment = await createComment(task.id, body);
      const [inlineAttachments, fileAttachments] = await Promise.all([
        Promise.all(
          commentInlineImages.map((image) => uploadCommentAttachment(comment.id, image.file, "inline")),
        ),
        Promise.all(
          commentInlineFiles.map((file) => uploadCommentAttachment(comment.id, file.file, "attachment")),
        ),
      ]);
      const nextComment = commentInlineImages.length > 0 || commentInlineFiles.length > 0
        ? await updateComment(
            comment,
            resolveInlineAttachmentMarkdown(
              resolveInlineMediaMarkdown(body, commentInlineImages, inlineAttachments),
              commentInlineFiles,
              fileAttachments,
            ),
          )
        : comment;
      setComments((current) => [...current, nextComment]);
      setCommentSegments(createInlineMediaSegments());
      if (commentAttachmentInputRef.current) commentAttachmentInputRef.current.value = "";
      let relationAnchor = await getTask(currentTask.id);
      if (changeStatusToTodo) {
        const saved = await onUpdate(relationAnchor, { status: "todo" });
        setCurrentTask(saved);
        relationAnchor = saved;
        setChangeStatusToTodo(false);
      }
      const savedWithRelations = await addMentionRelations(relationAnchor, commentSegments);
      setCurrentTask(savedWithRelations);
      requestAnimationFrame(() => composerRef.current?.focus());
    } catch (error) {
      setCommentsError(messageFor(error));
    } finally {
      setSubmitting(false);
    }
  }

  function handleSubmitShortcut(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submitComment();
    }
  }

  function beginEdit(comment: Comment, source: HTMLElement) {
    if (savingCommentId !== null) return;
    const scrollContainer = source.closest<HTMLElement>(".issue-detail-scroll");
    editingCommentScrollPositionRef.current = scrollContainer
      ? { element: scrollContainer, top: scrollContainer.scrollTop }
      : null;
    editingUploadedAttachmentsRef.current.clear();
    setEditingId(comment.id);
    setEditingSegments(createInlineMediaSegments(comment.body, referenceTasks, comment.attachments));
    setActiveMenuId(null);
  }

  function endCommentEdit() {
    setEditingId(null);
    editingUploadedAttachmentsRef.current.clear();
  }

  async function saveComment(comment: Comment) {
    const body = editingDraft.trim();
    if (!body || (
      body === comment.body
      && editingInlineImages.length === 0
      && editingInlineFiles.length === 0
    )) {
      if (body === comment.body) endCommentEdit();
      return;
    }
    const removedMentionIds = removedMentionTaskIds(
      createInlineMediaSegments(comment.body, referenceTasks),
      editingSegments,
    );
    setSavingCommentId(comment.id);
    setCommentsError(null);
    try {
      const uploadedImages: Attachment[] = [];
      for (const image of editingInlineImages) {
        let attachment = editingUploadedAttachmentsRef.current.get(image.id);
        if (!attachment) {
          attachment = await uploadCommentAttachment(comment.id, image.file, "inline");
          editingUploadedAttachmentsRef.current.set(image.id, attachment);
        }
        uploadedImages.push(attachment);
      }
      const uploadedFiles: Attachment[] = [];
      for (const file of editingInlineFiles) {
        let attachment = editingUploadedAttachmentsRef.current.get(file.id);
        if (!attachment) {
          attachment = await uploadCommentAttachment(comment.id, file.file, "attachment");
          editingUploadedAttachmentsRef.current.set(file.id, attachment);
        }
        uploadedFiles.push(attachment);
      }
      const updated = await updateComment(
        comment,
        resolveInlineAttachmentMarkdown(
          resolveInlineMediaMarkdown(body, editingInlineImages, uploadedImages),
          editingInlineFiles,
          uploadedFiles,
        ).trim(),
      );
      setComments((current) => current.map((item) => item.id === updated.id ? updated : item));
      const relationAnchor = await getTask(currentTask.id);
      const savedWithAddedRelations = await addMentionRelations(relationAnchor, editingSegments);
      const savedWithRelations = await removeUnreferencedMentionRelations(
        savedWithAddedRelations,
        removedMentionIds,
      );
      setCurrentTask(savedWithRelations);
      endCommentEdit();
    } catch (error) {
      setCommentsError(messageFor(error));
    } finally {
      setSavingCommentId(null);
    }
  }

  async function confirmDelete() {
    if (!pendingDelete || deleting) return;
    const removedMentionIds = mentionTaskIds(
      createInlineMediaSegments(pendingDelete.body, referenceTasks),
    );
    setDeleting(true);
    setCommentsError(null);
    try {
      await deleteComment(pendingDelete);
      setComments((current) => current.filter((comment) => comment.id !== pendingDelete.id));
      setPendingDelete(null);
      const savedWithRelations = await removeUnreferencedMentionRelations(
        currentTask,
        removedMentionIds,
      );
      setCurrentTask(savedWithRelations);
    } catch (error) {
      setCommentsError(messageFor(error));
    } finally {
      setDeleting(false);
    }
  }

  function handleAttachmentDownload(event: MouseEvent<HTMLAnchorElement>, attachment: Attachment) {
    event.preventDefault();
    event.stopPropagation();
    setAttachmentsError(null);
    void downloadAttachmentFile(attachment).catch((error) => {
      setAttachmentsError(messageFor(error));
    });
  }

  const developmentOptions = [...developmentScan.contexts];
  if (
    currentTask.developmentContext
    && !developmentOptions.some((context) => contextValue(context) === contextValue(currentTask.developmentContext))
  ) {
    developmentOptions.unshift(currentTask.developmentContext);
  }
  const displayAssignee = currentTask.assignee.type === currentUser.type
    && currentTask.assignee.id === currentUser.id
    ? currentUser
    : currentTask.assignee;
  const assigneeOptions = [displayAssignee, currentUser, CLAUDE_AGENT_ACTOR]
    .filter((actor, index, actors) => (
      actors.findIndex((candidate) => actorKey(candidate) === actorKey(actor)) === index
    ));
  const activityTimeline = [
    {
      kind: "created" as const,
      id: "activity-created",
      createdAt: currentTask.createdAt,
    },
    ...taskActivities.flatMap((activity) => activity.changes.map((change, index) => ({
      kind: "change" as const,
      id: `${activity.id}-${index}`,
      createdAt: activity.createdAt,
      activity,
      change,
    }))),
    ...comments.map((comment) => ({
      kind: "comment" as const,
      id: comment.id,
      createdAt: comment.createdAt,
      comment,
    })),
  ].sort((left, right) => (
    left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
  ));

  const activityRoundOptions = [...new Set(comments.flatMap((comment) => {
    const run = comment.threadId ? runByThreadId.get(comment.threadId) : undefined;
    return run ? [run.sequence] : [];
  }))].sort((left, right) => right - left);

  const activityDateOptions = [...new Set(activityTimeline.map((item) => localDateKey(item.createdAt)))]
    .sort()
    .reverse();

  const activityFilterActive = activityDateFilter !== null || activityRoundFilter !== null;
  const filteredTimeline = activityTimeline.filter((item) => {
    if (activityDateFilter !== null && localDateKey(item.createdAt) !== activityDateFilter) return false;
    if (activityRoundFilter !== null) {
      if (item.kind !== "comment") return false;
      const run = item.comment.threadId ? runByThreadId.get(item.comment.threadId) : undefined;
      if (!run || run.sequence !== activityRoundFilter) return false;
    }
    return true;
  });

  // Entries are sorted chronologically, so groups come out oldest → newest.
  const activityGroups = (() => {
    if (activityGrouping === "none") return [{ key: "all", entries: filteredTimeline }];
    const grouped = new Map<string, typeof filteredTimeline>();
    for (const item of filteredTimeline) {
      const key = activityGroupKeyOf(item.createdAt, activityGrouping);
      const bucket = grouped.get(key);
      if (bucket) bucket.push(item);
      else grouped.set(key, [item]);
    }
    return [...grouped.entries()].map(([key, entries]) => ({ key, entries }));
  })();

  const activityAutoCollapsed = !activityFilterActive
    && filteredTimeline.length > ACTIVITY_AUTO_COLLAPSE_ENTRIES
    && activityGroups.length > 1;
  const latestActivityGroupKey = activityGroups.length > 0
    ? activityGroups[activityGroups.length - 1].key
    : null;

  function activityGroupCollapsed(key: string): boolean {
    const override = activityExpanded.get(key);
    if (override !== undefined) return !override;
    return activityAutoCollapsed && key !== latestActivityGroupKey;
  }

  function toggleActivityGroup(key: string) {
    // The override stores "expanded": flip it to whatever the group is not showing now.
    setActivityExpanded((current) => new Map(current).set(key, activityGroupCollapsed(key)));
  }

  const activityAllCollapsed = activityGroups.length > 0
    && activityGroups.every((group) => activityGroupCollapsed(group.key));

  function toggleAllActivityGroups() {
    setActivityExpanded(() => {
      const next = new Map<string, boolean>();
      for (const group of activityGroups) next.set(group.key, activityAllCollapsed);
      return next;
    });
  }

  function focusRoundActivity(run: ScheduleRun) {
    setActivityRoundFilter(run.sequence);
    setActivityDateFilter(null);
    setActivityExpanded(new Map());
    setRunsDialogOpen(false);
  }

  return (
    <section
      className="issue-detail"
      aria-label={text(`${displayIdentifier} 议题详情`, `${displayIdentifier} issue details`)}
    >
      <div className="issue-detail-scroll">
        <div className="issue-detail-layout">
          <div className="issue-detail-main">
            <article className="issue-editor" aria-label={text("议题内容", "Issue content")}>
              <div className="issue-editor-content">
                <textarea
                  ref={titleRef}
                  className="issue-title-input"
                  rows={1}
                  value={title}
                  aria-label={text("议题标题", "Issue title")}
                  disabled={savingProperty === "title"}
                  onChange={(event) => {
                    setTitle(event.target.value.replace(/\n/g, ""));
                    resizeTextarea(event.currentTarget);
                  }}
                  onKeyDown={handleTitleKeyDown}
                  onBlur={() => void saveTitle()}
                />
                <IssueParentLink
                  task={currentTask}
                  tasks={tasks}
                  onOpenTask={onOpenTask}
                  onAddRelation={(anchor, type, relatedTaskId) => applyRelationMutation(
                    () => onAddRelation(anchor, type, relatedTaskId),
                  )}
                  onRemoveRelation={(anchor, type, relatedTaskId) => applyRelationMutation(
                    () => onRemoveRelation(anchor, type, relatedTaskId),
                  )}
                />
                {editingDescription ? (
                  <div
                    className="issue-description-composer"
                    onBlur={(event) => {
                      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                      void saveDescription();
                    }}
                  >
                    <InlineMediaComposer
                      ref={descriptionComposerRef}
                      segments={descriptionSegments}
                      mentionTasks={tasks}
                      referenceTasks={referenceTasks}
                      completionContext={{
                        projectId: currentTask.projectId,
                        surface: "issue-description",
                      }}
                      placeholder={text("添加描述…", "Add description…")}
                      ariaLabel={text("议题描述", "Issue description")}
                      disabled={savingProperty === "description"}
                      allowAttachments
                      onChange={setDescriptionSegments}
                      onError={onError}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          event.preventDefault();
                          event.stopPropagation();
                          setDescriptionSegments(createInlineMediaSegments(
                            currentTask.description,
                            referenceTasks,
                            attachments,
                          ));
                          setEditingDescription(false);
                        }
                      }}
                    />
                    <button
                      className="comment-attach-button issue-description-attach-button"
                      type="button"
                      disabled={savingProperty === "description"}
                      aria-label={text("添加描述附件", "Add description attachments")}
                      title={text("添加附件", "Add attachments")}
                      onClick={() => attachmentInputRef.current?.click()}
                    >
                      <AttachmentIcon color="currentColor" />
                    </button>
                    <input
                      ref={attachmentInputRef}
                      type="file"
                      multiple
                      hidden
                      onChange={(event) => {
                        if (event.currentTarget.files) {
                          descriptionComposerRef.current?.addFiles(event.currentTarget.files);
                        }
                        event.currentTarget.value = "";
                      }}
                    />
                  </div>
                ) : (
                  <div
                    className={`issue-description-read${description ? "" : " empty"}`}
                    role="button"
                    tabIndex={0}
                    aria-label={text("编辑议题描述", "Edit issue description")}
                    onClick={(event) => {
                      if (window.getSelection()?.isCollapsed === false) return;
                      descriptionCaretRef.current = null;
                      const range = event.currentTarget.ownerDocument.caretRangeFromPoint(
                        event.clientX,
                        event.clientY,
                      );
                      const node = range?.startContainer;
                      if (range && node?.nodeType === Node.TEXT_NODE && event.currentTarget.contains(node)) {
                        const value = node.textContent ?? "";
                        const walker = event.currentTarget.ownerDocument.createTreeWalker(
                          event.currentTarget,
                          NodeFilter.SHOW_TEXT,
                        );
                        let occurrence = 0;
                        while (walker.nextNode() && walker.currentNode !== node) {
                          if (walker.currentNode.textContent === value) occurrence += 1;
                        }
                        descriptionCaretRef.current = {
                          text: value,
                          offset: range.startOffset,
                          occurrence,
                        };
                      }
                      const scrollContainer = event.currentTarget.closest<HTMLElement>(".issue-detail-scroll");
                      descriptionScrollPositionRef.current = scrollContainer
                        ? { element: scrollContainer, top: scrollContainer.scrollTop }
                        : null;
                      setDescriptionSegments(createInlineMediaSegments(
                        description,
                        referenceTasks,
                        attachments,
                      ));
                      setEditingDescription(true);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        descriptionCaretRef.current = null;
                        const scrollContainer = event.currentTarget.closest<HTMLElement>(".issue-detail-scroll");
                        descriptionScrollPositionRef.current = scrollContainer
                          ? { element: scrollContainer, top: scrollContainer.scrollTop }
                          : null;
                        setDescriptionSegments(createInlineMediaSegments(
                          description,
                          referenceTasks,
                          attachments,
                        ));
                        setEditingDescription(true);
                      }
                    }}
                  >
                    {description
                      ? <DescriptionDocument
                          value={description}
                          referenceTasks={referenceTasks}
                          onOpenTask={onOpenTask}
                          attachments={attachments}
                          enableImagePreview
                          onOpenAttachment={handleAttachmentDownload}
                        />
                      : text("添加描述…", "Add description…")}
                  </div>
                )}
                {(currentTask.threadBinding || currentTask.legacyLocalThreadId) && (
                  <div
                    className="issue-conversation-list"
                    aria-label={text("处理此议题的对话", "Conversations for this issue")}
                  >
                    <ConversationLink
                      threadId={currentTask.threadBinding?.threadId ?? currentTask.legacyLocalThreadId!}
                      onOpen={() => currentTask.threadBinding
                        ? onOpenThread(currentTask.threadBinding)
                        : onOpenLegacyLocalThread(currentTask.legacyLocalThreadId!)}
                      onTerminal={() => onOpenInTerminal(
                        currentTask.threadBinding?.threadId ?? currentTask.legacyLocalThreadId!,
                      )}
                      onCopy={onCopy}
                    />
                  </div>
                )}
              </div>
              {attachmentsError && (
                <div className="attachments-error" role="alert">
                  {typeof attachmentsError === "string"
                    ? attachmentsError
                    : text(attachmentsError[0], attachmentsError[1])}
                </div>
              )}
            </article>

            <IssueSubIssues
              task={currentTask}
              tasks={tasks}
              onOpenTask={onOpenTask}
              onAddRelation={(anchor, type, relatedTaskId) => applyRelationMutation(
                () => onAddRelation(anchor, type, relatedTaskId),
              )}
              onRemoveRelation={(anchor, type, relatedTaskId) => applyRelationMutation(
                () => onRemoveRelation(anchor, type, relatedTaskId),
              )}
            />

            <section className="activity-section" aria-labelledby="activity-heading">
              <header className="activity-heading">
                <h2 id="activity-heading">{text("活动", "Activity")}</h2>
                <span>{activityFilterActive
                  ? `${filteredTimeline.length}/${activityTimeline.length}`
                  : activityTimeline.length}</span>
              </header>

              {activityTimeline.length > 0 && (
                <div className="activity-toolbar">
                  <div className="activity-segmented" role="group" aria-label={text("活动分组方式", "Activity grouping")}>
                    {([
                      ["day", text("按天", "Day")],
                      ["week", text("按周", "Week")],
                      ["none", text("不分组", "Flat")],
                    ] as const).map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        className={activityGrouping === value ? "is-active" : undefined}
                        aria-pressed={activityGrouping === value}
                        onClick={() => setActivityGrouping(value)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <select
                    className="activity-filter-select"
                    aria-label={text("按日期筛选活动", "Filter activity by date")}
                    value={activityDateFilter ?? ""}
                    onChange={(event) => setActivityDateFilter(event.target.value || null)}
                  >
                    <option value="">{text("全部日期", "All dates")}</option>
                    {activityDateOptions.map((key) => (
                      <option key={key} value={key}>
                        {activityGroupLabel(key, "day", locale, text)}
                      </option>
                    ))}
                  </select>
                  {activityRoundOptions.length > 0 && (
                    <select
                      className="activity-filter-select"
                      aria-label={text("按轮次筛选活动", "Filter activity by round")}
                      value={activityRoundFilter ?? ""}
                      onChange={(event) => setActivityRoundFilter(
                        event.target.value === "" ? null : Number(event.target.value),
                      )}
                    >
                      <option value="">{text("全部轮次", "All rounds")}</option>
                      {activityRoundOptions.map((sequence) => (
                        <option key={sequence} value={sequence}>
                          {text(`第 ${sequence} 轮`, `Round ${sequence}`)}
                        </option>
                      ))}
                    </select>
                  )}
                  {activityGrouping !== "none" && activityGroups.length > 1 && (
                    <button
                      type="button"
                      className="activity-collapse-toggle"
                      onClick={toggleAllActivityGroups}
                    >
                      {activityAllCollapsed
                        ? text("全部展开", "Expand all")
                        : text("全部折叠", "Collapse all")}
                    </button>
                  )}
                </div>
              )}

              <div className="activity-stream">
                {commentsLoading ? (
                  <div className="comments-loading" aria-label={text("正在加载活动", "Loading activity")} aria-busy="true"><i /><i /></div>
                ) : filteredTimeline.length === 0 ? (
                  <div className="activity-empty">{text("没有匹配的动态", "No matching activity")}</div>
                ) : activityGroups.map((group) => {
                  const collapsed = activityGroupCollapsed(group.key);
                  return (
                    <section className="activity-group" key={group.key}>
                      {activityGrouping !== "none" && (
                        <button
                          type="button"
                          className="activity-group-header"
                          aria-expanded={!collapsed}
                          onClick={() => toggleActivityGroup(group.key)}
                        >
                          <span
                            className={`activity-group-chevron${collapsed ? " is-collapsed" : ""}`}
                            aria-hidden="true"
                          >
                            <LinearIcon name="chevronDown" />
                          </span>
                          <span className="activity-group-label">
                            {activityGroupLabel(group.key, activityGrouping, locale, text)}
                          </span>
                          <span className="activity-group-line" aria-hidden="true" />
                          <span className="activity-group-count">
                            {text(`${group.entries.length} 条`, `${group.entries.length}`)}
                          </span>
                        </button>
                      )}
                      {!collapsed && group.entries.map((item) => {
                        if (item.kind === "created") {
                          return (
                            <div className={`activity-entry activity-created is-${currentTask.creatorType}`} key={item.id}>
                              <span className="activity-rail-icon activity-creator-icon" aria-hidden="true">
                                <ActorAvatar
                                  className="comment-avatar"
                                  actor={{
                                    type: currentTask.creatorType,
                                    id: currentTask.creatorId,
                                    name: currentTask.creatorName,
                                    avatarUrl: currentTask.creatorAvatarUrl,
                                  }}
                                />
                              </span>
                              <p>
                                <strong>{currentTask.creatorName}</strong>
                                {text(" 创建了此议题", " created this issue")}
                                <time title={exactTime(currentTask.createdAt, locale)}>{relativeTime(currentTask.createdAt, locale)}</time>
                              </p>
                            </div>
                          );
                        }
                        if (item.kind === "change") {
                          const { activity, change } = item;
                          const fieldLabels = ACTIVITY_FIELD_LABELS[change.field];
                          const fieldLabel = fieldLabels
                            ? text(fieldLabels[0], fieldLabels[1])
                            : change.field;
                          const beforeValue = activityValue(
                            change.field,
                            change.before,
                            language,
                            locale,
                            text,
                          );
                          const afterValue = activityValue(
                            change.field,
                            change.after,
                            language,
                            locale,
                            text,
                          );
                          return (
                            <article
                              className={`activity-entry activity-change is-${activity.actorType}`}
                              key={item.id}
                            >
                              <span className="activity-rail-icon" aria-hidden="true">
                                <ActivityChangeIcon
                                  field={change.field}
                                  before={change.before}
                                  after={change.after}
                                />
                              </span>
                              <p>
                                <strong>{activity.actorName}</strong>
                                {" "}
                                {change.field === "description" ? (
                                  <>{text("更新了描述", "updated the description")}</>
                                ) : change.field === "relation" && change.before === null ? (
                                  <>{text("添加了 ", "added ")}<span className="activity-change-value">{afterValue}</span></>
                                ) : change.field === "relation" && change.after === null ? (
                                  <>{text("移除了 ", "removed ")}<span className="activity-change-value">{beforeValue}</span></>
                                ) : language === "zh" ? (
                                  <>
                                    将{fieldLabel}从
                                    <span className="activity-change-value">{beforeValue}</span>
                                    改为
                                    <span className="activity-change-value">{afterValue}</span>
                                  </>
                                ) : (
                                  <>
                                    {`changed ${fieldLabel} from `}
                                    <span className="activity-change-value">{beforeValue}</span>
                                    {" to "}
                                    <span className="activity-change-value">{afterValue}</span>
                                  </>
                                )}
                                <time title={exactTime(activity.createdAt, locale)}>{relativeTime(activity.createdAt, locale)}</time>
                              </p>
                            </article>
                          );
                        }
                        const comment = item.comment;
                        return (
                        <article
                          className={`comment-entry is-${comment.authorType}`}
                          key={comment.id}
                          id={`comment-${comment.id}`}
                        >
                          <div className="comment-card">
                            <header className="comment-header">
                              <ActorAvatar
                                className="comment-avatar"
                                actor={{
                                  type: comment.authorType,
                                  id: comment.authorId,
                                  name: comment.authorName,
                                  avatarUrl: comment.authorAvatarUrl,
                                }}
                              />
                              <strong>{comment.authorName}</strong>
                              {comment.threadId && runByThreadId.has(comment.threadId) && (
                                <span className="comment-run-badge">
                                  {text(
                                    `第 ${runByThreadId.get(comment.threadId)!.sequence} 轮`,
                                    `Round ${runByThreadId.get(comment.threadId)!.sequence}`,
                                  )}
                                </span>
                              )}
                              <time title={exactTime(comment.createdAt, locale)}>{relativeTime(comment.createdAt, locale)}</time>
                              {comment.version > 1 && (
                                <span
                                  className="comment-edited"
                                  title={text(
                                    `编辑于 ${exactTime(comment.updatedAt, locale)}`,
                                    `Edited ${exactTime(comment.updatedAt, locale)}`,
                                  )}
                                >
                                  {text("已编辑", "Edited")}
                                </span>
                              )}
                              {editingId !== comment.id && (
                                <div className="comment-actions" data-comment-menu-root={comment.id}>
                                  <button
                                    type="button"
                                    className="comment-menu-trigger"
                                    aria-label={text("评论操作", "Comment actions")}
                                    aria-haspopup="menu"
                                    aria-expanded={activeMenuId === comment.id}
                                    onClick={() => setActiveMenuId((current) => current === comment.id ? null : comment.id)}
                                  >
                                    <MoreIcon color="currentColor" />
                                  </button>
                                  {activeMenuId === comment.id && (
                                    <div className="comment-action-menu" role="menu">
                                      <button
                                        type="button"
                                        role="menuitem"
                                        disabled={savingCommentId !== null}
                                        onClick={(event) => beginEdit(comment, event.currentTarget)}
                                      >
                                        <EditIcon color="currentColor" />
                                        {text("编辑评论", "Edit comment")}
                                      </button>
                                      <button
                                        type="button"
                                        role="menuitem"
                                        className="danger"
                                        onClick={() => { setPendingDelete(comment); setActiveMenuId(null); }}
                                      >
                                        <DeleteIcon color="currentColor" />
                                        {text("删除评论", "Delete comment")}
                                      </button>
                                    </div>
                                  )}
                                </div>
                              )}
                            </header>
      
                            {editingId === comment.id ? (
                              <div className="comment-edit-form">
                                <InlineMediaComposer
                                  ref={editingComposerRef}
                                  className="comment-inline-media"
                                  segments={editingSegments}
                                  mentionTasks={tasks}
                                  referenceTasks={referenceTasks}
                                  completionContext={{
                                    projectId: currentTask.projectId,
                                    surface: "comment",
                                  }}
                                  placeholder={text("编辑评论", "Edit comment")}
                                  ariaLabel={text("编辑评论", "Edit comment")}
                                  disabled={savingCommentId === comment.id}
                                  allowAttachments
                                  onChange={setEditingSegments}
                                  onError={setCommentsError}
                                  onKeyDown={(event) => {
                                    if (event.key === "Escape") {
                                      event.preventDefault();
                                      event.stopPropagation();
                                      endCommentEdit();
                                      return;
                                    }
                                    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                                      event.preventDefault();
                                      void saveComment(comment);
                                    }
                                  }}
                                />
                                <div className="comment-edit-actions">
                                  <div className="composer-footer-leading">
                                    <button
                                      className="comment-attach-button"
                                      type="button"
                                      disabled={savingCommentId === comment.id}
                                      aria-label={text("添加评论附件", "Add comment attachments")}
                                      title={text("添加附件", "Add attachments")}
                                      onClick={() => editCommentAttachmentInputRef.current?.click()}
                                    >
                                      <AttachmentIcon color="currentColor" />
                                    </button>
                                    <input
                                      ref={editCommentAttachmentInputRef}
                                      type="file"
                                      multiple
                                      hidden
                                      onChange={(event) => {
                                        if (event.currentTarget.files) {
                                          editingComposerRef.current?.addFiles(event.currentTarget.files);
                                        }
                                        event.currentTarget.value = "";
                                      }}
                                    />
                                  </div>
                                  <div>
                                    <button
                                      className="button secondary"
                                      type="button"
                                      disabled={savingCommentId === comment.id}
                                      onClick={endCommentEdit}
                                    >
                                      {text("取消", "Cancel")}
                                    </button>
                                    <button
                                      className="button primary"
                                      type="button"
                                      disabled={!editingDraft.trim() || savingCommentId === comment.id}
                                      onClick={() => void saveComment(comment)}
                                    >
                                      {savingCommentId === comment.id
                                        ? text("保存中…", "Saving…")
                                        : text("保存", "Save")}
                                    </button>
                                  </div>
                                </div>
                              </div>
                            ) : (
                              comment.body && (
                                <div className="comment-body">
                                  <DescriptionDocument
                                    value={comment.body}
                                    referenceTasks={referenceTasks}
                                    onOpenTask={onOpenTask}
                                    attachments={comment.attachments}
                                    enableImagePreview
                                    onOpenAttachment={handleAttachmentDownload}
                                  />
                                </div>
                              )
                            )}
                            {(comment.threadBinding || comment.legacyLocalThreadId) && (
                              <div className="comment-conversation-link">
                                <ConversationLink
                                  threadId={comment.threadBinding?.threadId ?? comment.legacyLocalThreadId!}
                                  onOpen={() => comment.threadBinding
                                    ? onOpenThread(comment.threadBinding)
                                    : onOpenLegacyLocalThread(comment.legacyLocalThreadId!)}
                                  onTerminal={() => onOpenInTerminal(
                                    comment.threadBinding?.threadId ?? comment.legacyLocalThreadId!,
                                  )}
                                  onCopy={onCopy}
                                />
                              </div>
                            )}
                          </div>
                        </article>
                        );
                      })}
                    </section>
                  );
                })}
              </div>

              {commentsError && (
                <div className="comments-error" role="alert">
                  {typeof commentsError === "string"
                    ? commentsError
                    : text(commentsError[0], commentsError[1])}
                </div>
              )}

              <form className="comment-composer" onSubmit={(event) => { event.preventDefault(); void submitComment(); }}>
                <div className="composer-author">
                  <ActorAvatar
                    className="comment-avatar"
                    actor={currentUser}
                  />
                  <strong>{currentUser.name}</strong>
                </div>
                <InlineMediaComposer
                  ref={composerRef}
                  className="comment-inline-media"
                  segments={commentSegments}
                  mentionTasks={tasks}
                  referenceTasks={referenceTasks}
                  completionContext={{
                    projectId: currentTask.projectId,
                    surface: "comment",
                  }}
                  placeholder={text("留下评论…", "Leave a comment…")}
                  ariaLabel={text("留下评论", "Leave a comment")}
                  allowAttachments
                  onChange={setCommentSegments}
                  onError={setCommentsError}
                  onKeyDown={handleSubmitShortcut}
                />
                <footer className="composer-footer">
                  <div className="composer-footer-leading">
                    <button
                      className="comment-attach-button"
                      type="button"
                      disabled={submitting}
                      aria-label={text("添加评论附件", "Add comment attachments")}
                      title={text("添加附件", "Add attachments")}
                      onClick={() => commentAttachmentInputRef.current?.click()}
                    >
                      <AttachmentIcon color="currentColor" />
                    </button>
                    <input
                      ref={commentAttachmentInputRef}
                      type="file"
                      multiple
                      hidden
                      onChange={(event) => {
                        if (event.currentTarget.files) {
                          composerRef.current?.addFiles(event.currentTarget.files);
                        }
                        event.currentTarget.value = "";
                      }}
                    />
                  </div>
                  <div>
                    {currentTask.status !== "todo" && !executionLocked && (
                      <div className="comment-status-action">
                        <span>{text("改变状态为-等待认领", "Change status to Todo")}</span>
                        <button
                          type="button"
                          className={`board-setting-switch${changeStatusToTodo ? " is-on" : ""}`}
                          role="switch"
                          aria-checked={changeStatusToTodo}
                          disabled={submitting}
                          onClick={() => setChangeStatusToTodo((current) => !current)}
                        >
                          <span aria-hidden="true" />
                        </button>
                      </div>
                    )}
                    <button
                      className="button primary"
                      type="submit"
                      disabled={(
                        !draft.trim()
                        && commentInlineImages.length === 0
                        && commentInlineFiles.length === 0
                      ) || submitting}
                    >
                      {submitting ? text("发布中…", "Posting…") : text("评论", "Comment")}
                    </button>
                  </div>
                </footer>
              </form>
            </section>
          </div>

          <aside className="issue-properties" aria-label={text("议题属性", "Issue properties")}>
            <div className="detail-primary-actions">
              <button
                className="detail-open-thread-action"
                type="button"
                disabled={openingThread}
                onClick={() => onOpenInThread(currentTask)}
              >
                <NewConversationIcon color="currentColor" />
                <span>{openingThread
                  ? text("正在打开…", "Opening…")
                  : text("在新对话打开", "Open in new conversation")}</span>
              </button>
              {currentTask.externalUrl && (
                <a
                  className="detail-copy-action detail-external-action"
                  href={currentTask.externalUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  <span className="detail-copy-action-icon" aria-hidden="true">
                    <LinearIcon name="openExternal" />
                  </span>
                  <span className="detail-copy-action-label">{text("打开 Jira", "Open Jira")}</span>
                </a>
              )}
              <button
                className="detail-copy-action"
                type="button"
                title={text(
                  `复制议题 ID ${displayIdentifier}`,
                  `Copy issue ID ${displayIdentifier}`,
                )}
                onClick={() => onCopy(
                  displayIdentifier,
                  text(`${displayIdentifier} 已复制。`, `${displayIdentifier} copied.`),
                )}
              >
                <span className="detail-copy-action-icon" aria-hidden="true"><img src={copyIdIcon} alt="" /></span>
                <span className="detail-copy-action-label">{text("复制 ID", "Copy ID")}</span>
                <span className="detail-copy-identifier">{displayIdentifier}</span>
              </button>
              <button
                className="detail-copy-action"
                type="button"
                onClick={() => onCopy(
                  buildIssueUrl(
                    document.baseURI,
                    currentTask.projectId,
                    currentTask.identifier,
                  ).href,
                  text("议题链接已复制。", "Issue link copied."),
                )}
              >
                <span className="detail-copy-action-icon" aria-hidden="true"><img src={copyLinkIcon} alt="" /></span>
                <span className="detail-copy-action-label">{text("复制链接", "Copy link")}</span>
              </button>
            </div>
            <h2>{text("属性", "Properties")}</h2>
            <div className="detail-property-row">
              <span className="detail-property-label">{text("状态", "Status")}</span>
              <TaskPropertyPicker
                value={currentTask.status}
                options={TASK_STATUSES.map((status) => ({
                  value: status,
                  label: taskStatusLabel(language, status),
                  icon: <StatusIcon status={status} color="currentColor" size={14} />,
                }))}
                open={propertyMenu === "status"}
                disabled={savingProperty === "status" || executionLocked}
                className="detail-property-picker"
                triggerClassName="detail-property-trigger"
                title={executionLocked
                  ? text("执行终止前无法更改状态", "Status is locked until the execution terminates")
                  : undefined}
                triggerContent={(
                  <>
                    <span className="task-property-trigger-icon">
                      <StatusIcon status={currentTask.status} color="currentColor" size={14} />
                    </span>
                    <span className="task-property-trigger-label">
                      {taskStatusLabel(language, currentTask.status)}
                    </span>
                  </>
                )}
                ariaLabel={text("状态", "Status")}
                onOpenChange={(open) => setPropertyMenu(open ? "status" : null)}
                onChange={(status) => void saveTask({ status }, "status")}
              />
              {executionLocked && onTerminateExecution && (
                <button
                  className="detail-terminate-button"
                  type="button"
                  onClick={() => onTerminateExecution(currentTask)}
                >
                  <span className="detail-terminate-glyph" aria-hidden="true" />
                  {text("终止执行", "Terminate execution")}
                </button>
              )}
            </div>
            <div className="detail-property-row">
              <span className="detail-property-label">{text("优先级", "Priority")}</span>
              <TaskPropertyPicker
                value={currentTask.priority}
                options={TASK_PRIORITIES.map((priority) => ({
                  value: priority,
                  label: taskPriorityLabel(language, priority),
                  icon: <PriorityIcon priority={priority} size={14} />,
                  className: `priority-${priority}`,
                }))}
                open={propertyMenu === "priority"}
                disabled={savingProperty === "priority"}
                className="detail-property-picker"
                triggerClassName="detail-property-trigger"
                ariaLabel={text("优先级", "Priority")}
                onOpenChange={(open) => setPropertyMenu(open ? "priority" : null)}
                onChange={(priority) => void saveTask({ priority }, "priority")}
              />
            </div>
            <div className="detail-property-row assignee-property">
              <span className="detail-property-label">{text("负责人", "Assignee")}</span>
              <TaskPropertyPicker
                value={actorKey(displayAssignee)}
                options={assigneeOptions.map((actor) => ({
                  value: actorKey(actor),
                  label: actorKey(actor) === actorKey(currentUser)
                    ? `${actor.name}${text("（我）", " (me)")}`
                    : actor.name,
                  icon: <ActorAvatar actor={actor} className="task-property-assignee-avatar" />,
                }))}
                open={propertyMenu === "assignee"}
                disabled={currentTask.source === "jira" || savingProperty === "assignee"}
                className="detail-property-picker"
                triggerClassName="detail-property-trigger"
                ariaLabel={text("负责人", "Assignee")}
                onOpenChange={(open) => setPropertyMenu(open ? "assignee" : null)}
                onChange={(value) => {
                  const selected = assigneeOptions.find((actor) => actorKey(actor) === value);
                  const assigneeTarget = selected
                    ? assigneeTargetForActor(selected, currentUser)
                    : undefined;
                  if (assigneeTarget) void saveTask({ assigneeTarget }, "assignee");
                }}
              />
            </div>
            <div className="detail-property-row labels-property">
              <span className="detail-property-icon" aria-hidden="true">
                <LabelIcon color="currentColor" size={14} />
              </span>
              <span className="detail-property-label">{text("标签", "Labels")}</span>
              <LabelPicker
                availableLabels={availableLabels}
                selectedLabels={currentTask.labels}
                open={propertyMenu === "labels"}
                disabled={savingProperty === "labels"}
                className="detail-label-picker"
                triggerClassName="detail-label-trigger"
                showSelectedAsChips
                placeholder={text("添加标签…", "Add labels…")}
                onOpenChange={(open) => setPropertyMenu(open ? "labels" : null)}
                onChange={(nextLabels) => void saveTask({ labels: nextLabels }, "labels")}
                onCreateLabel={onCreateLabel}
                onDeleteLabel={currentTask.source === "jira" ? undefined : onDeleteLabel}
              />
            </div>
            {(modelProfiles?.length ?? 0) > 0 && (
              <div className="detail-property-row">
                <span className="detail-property-label">{text("模型配置", "Model profile")}</span>
                <TaskPropertyPicker
                  value={currentTask.modelProfileId ?? ""}
                  options={[
                    {
                      value: "",
                      label: text("看板默认", "Board default"),
                      icon: <TaskboardIcon name="projectFolder" />,
                    },
                    {
                      value: MACHINE_MODEL_PROFILE_ID,
                      label: text("Claude Code 全局", "Claude Code global"),
                      icon: <TaskboardIcon name="projectFolder" />,
                    },
                    ...modelProfiles!.map((profile) => ({
                      value: profile.id,
                      label: profile.model ? `${profile.name} · ${profile.model}` : profile.name,
                      icon: <TaskboardIcon name="projectFolder" />,
                    })),
                  ]}
                  open={propertyMenu === "modelProfile"}
                  disabled={executionLocked || savingProperty === "modelProfile"}
                  className="detail-property-picker"
                  triggerClassName="detail-property-trigger"
                  ariaLabel={text("模型配置", "Model profile")}
                  title={executionLocked
                    ? text("执行中不能切换模型，等待处理结束或先终止执行", "Model is locked while this issue is executing")
                    : undefined}
                  onOpenChange={(open) => setPropertyMenu(open ? "modelProfile" : null)}
                  onChange={(value) => void saveTask({ modelProfileId: value || null }, "modelProfile")}
                />
              </div>
            )}
            <div className="detail-property-row">
              <span className="detail-property-label">{text("推理强度", "Reasoning effort")}</span>
              <TaskPropertyPicker
                value={currentTask.reasoningEffort ?? ""}
                options={[
                  {
                    value: "",
                    label: text("默认", "Default"),
                    icon: null,
                  },
                  ...TASK_REASONING_EFFORTS.map((effort) => ({
                    value: effort,
                    label: TASK_EFFORT_LABELS[effort] ? text(...TASK_EFFORT_LABELS[effort]) : effort,
                    icon: null,
                  })),
                ]}
                open={propertyMenu === "reasoningEffort"}
                disabled={savingProperty === "reasoningEffort"}
                className="detail-property-picker"
                triggerClassName="detail-property-trigger"
                ariaLabel={text("推理强度", "Reasoning effort")}
                onOpenChange={(open) => setPropertyMenu(open ? "reasoningEffort" : null)}
                onChange={(value) => void saveTask({ reasoningEffort: value || null }, "reasoningEffort")}
              />
            </div>
            <div className="detail-property-row development-property">
              <span className="detail-property-label">{text("开发上下文", "Development context")}</span>
              <TaskPropertyPicker
                value={contextValue(currentTask.developmentContext)}
                options={[
                  {
                    value: "",
                    label: developmentScanLoading
                      ? text("正在扫描 Git…", "Scanning Git…")
                      : text("未绑定", "Not linked"),
                    icon: <BranchIcon color="currentColor" size={14} />,
                  },
                  ...developmentOptions.map((context) => ({
                    value: contextValue(context),
                    label: contextLabel(context, text),
                    icon: context.type === "branch"
                      ? <BranchIcon color="currentColor" size={14} />
                      : <LinearIcon name="folder" />,
                  })),
                ]}
                open={propertyMenu === "development"}
                disabled={developmentScanLoading || savingProperty === "developmentContext"}
                className="detail-property-picker"
                popoverClassName="development-context-popover"
                triggerClassName="detail-property-trigger"
                ariaLabel={text("开发上下文", "Development context")}
                title={currentTask.developmentContext?.type === "worktree" ? currentTask.developmentContext.path : undefined}
                onOpenChange={(open) => setPropertyMenu(open ? "development" : null)}
                onChange={(value) => void saveTask({
                  developmentContext: value ? JSON.parse(value) as DevelopmentContext : null,
                }, "developmentContext")}
              />
            </div>
            <label
              className="detail-property-row detail-date-property-row"
              onClick={(event) => openDatePicker("startDate", event)}
            >
              <span className="detail-property-icon" aria-hidden="true"><DueDateIcon color="currentColor" size={14} /></span>
              <span className="detail-property-label">{text("开始日期", "Start date")}</span>
              <input
                type="date"
                value={currentTask.startDate ?? ""}
                disabled={savingProperty === "startDate"}
                onChange={(event) => void saveTask({
                  startDate: event.target.value || null,
                }, "startDate")}
              />
            </label>
            <label
              className="detail-property-row detail-date-property-row"
              onClick={(event) => openDatePicker("dueDate", event)}
            >
              <span className="detail-property-icon" aria-hidden="true"><DueDateIcon color="currentColor" size={14} /></span>
              <span className="detail-property-label">{text("截止日期", "Due date")}</span>
              <input
                type="date"
                value={currentTask.dueDate ?? ""}
                disabled={savingProperty === "dueDate"}
                onChange={(event) => void saveTask({
                  dueDate: event.target.value || null,
                  ...(event.target.value
                    ? {}
                    : { ...(scheduleIsPeriodic(currentTask.schedule) ? { schedule: null } : {}) }),
                }, "dueDate")}
              />
            </label>
            <div className="detail-property-row schedule-property" ref={schedulePopoverRef}>
              <span className="detail-property-icon" aria-hidden="true"><RecurrenceIcon color="currentColor" size={14} /></span>
              <span className="detail-property-label">{text("定时执行", "Schedule")}</span>
              <button
                type="button"
                className="detail-property-trigger detail-schedule-trigger"
                disabled={currentTask.source === "jira" || savingProperty === "schedule"}
                title={currentTask.scheduleNextAt
                  ? text(
                    `下次执行 ${new Date(currentTask.scheduleNextAt).toLocaleString(locale)}`,
                    `Next run ${new Date(currentTask.scheduleNextAt).toLocaleString(locale)}`,
                  )
                  : undefined}
                onClick={() => setPropertyMenu(propertyMenu === "schedule" ? null : "schedule")}
              >
                {currentTask.schedule
                  ? describeSchedule(currentTask.schedule, text)
                  : text("未设置", "Not set")}
              </button>
              {currentTask.scheduleNextAt && (
                <span className="detail-schedule-next">
                  {text(
                    `下次 ${new Date(currentTask.scheduleNextAt).toLocaleString(locale)}`,
                    `Next ${new Date(currentTask.scheduleNextAt).toLocaleString(locale)}`,
                  )}
                </span>
              )}
              {propertyMenu === "schedule" && (
                <div className="detail-property-popover-anchor">
                  <ScheduleEditor
                    schedule={currentTask.schedule}
                    dueDate={currentTask.dueDate}
                    onApply={({ schedule, dueDate: nextDueDate }) => {
                      setPropertyMenu(null);
                      void saveTask({
                        schedule,
                        ...(nextDueDate ? { dueDate: nextDueDate } : {}),
                      }, "schedule");
                    }}
                    onClose={() => setPropertyMenu(null)}
                  />
                </div>
              )}
            </div>
            {scheduleRunList.length > 0 && (
              <div className="detail-property-row detail-schedule-runs">
                <span className="detail-property-icon" aria-hidden="true"><RecurrenceIcon color="currentColor" size={14} /></span>
                <span className="detail-property-label">{text("执行轮次", "Rounds")}</span>
                <button
                  type="button"
                  className="detail-property-trigger detail-runs-trigger"
                  title={latestScheduleRun ? exactTime(latestScheduleRun.startedAt, locale) : undefined}
                  onClick={() => setRunsDialogOpen(true)}
                >
                  <span className="detail-runs-summary">
                    {currentTask.scheduleRuns?.current
                      ? text(
                        `第 ${currentTask.scheduleRuns.current.sequence} 轮执行中 · 共 ${runTotal} 轮`,
                        `Round ${currentTask.scheduleRuns.current.sequence} running · ${runTotal} total`,
                      )
                      : latestScheduleRun
                        ? text(
                          `共 ${runTotal} 轮 · 最新${scheduleRunStatusLabel(latestScheduleRun.status, text)}`,
                          `${runTotal} rounds · latest ${scheduleRunStatusLabel(latestScheduleRun.status, text)}`,
                        )
                        : text(`共 ${runTotal} 轮`, `${runTotal} rounds`)}
                  </span>
                  <LinearIcon name="chevronRight" />
                </button>
              </div>
            )}
            <IssueRelationSidebar
              task={currentTask}
              tasks={tasks}
              onOpenTask={onOpenTask}
              onAddRelation={(anchor, type, relatedTaskId) => applyRelationMutation(
                () => onAddRelation(anchor, type, relatedTaskId),
              )}
              onRemoveRelation={(anchor, type, relatedTaskId) => applyRelationMutation(
                () => onRemoveRelation(anchor, type, relatedTaskId),
              )}
            />
            <div className="detail-timestamps">
              <span>{text(
                `创建于 ${exactTime(currentTask.createdAt, locale)}`,
                `Created ${exactTime(currentTask.createdAt, locale)}`,
              )}</span>
              {currentTask.updatedAt !== currentTask.createdAt && <span>{text(
                `更新于 ${exactTime(currentTask.updatedAt, locale)}`,
                `Updated ${exactTime(currentTask.updatedAt, locale)}`,
              )}</span>}
            </div>
          </aside>
        </div>
      </div>

      {runsDialogOpen && scheduleRunList.length > 0 && (
        <div
          className="delete-backdrop"
          role="presentation"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) setRunsDialogOpen(false);
          }}
        >
          <div
            className="delete-dialog schedule-runs-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="schedule-runs-title"
          >
            <header className="schedule-runs-header">
              <div>
                <h2 id="schedule-runs-title">{text("执行轮次", "Execution rounds")}</h2>
                <p>{text(
                  `${currentTask.scheduleRuns?.current
                    ? `第 ${currentTask.scheduleRuns.current.sequence} 轮执行中`
                    : `共 ${runTotal} 轮`}`,
                  `${currentTask.scheduleRuns?.current
                    ? `Round ${currentTask.scheduleRuns.current.sequence} running`
                    : `${runTotal} rounds total`}`,
                )}</p>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label={text("关闭", "Close")}
                onClick={() => setRunsDialogOpen(false)}
              >
                <LinearIcon name="close" />
              </button>
            </header>
            <div className="schedule-runs-summary">
              {scheduleRunCounts.running > 0 && (
                <span className="schedule-runs-chip is-running">
                  {text(`执行中 ${scheduleRunCounts.running}`, `${scheduleRunCounts.running} running`)}
                </span>
              )}
              {scheduleRunCounts.completed > 0 && (
                <span className="schedule-runs-chip is-completed">
                  {text(`已完成 ${scheduleRunCounts.completed}`, `${scheduleRunCounts.completed} completed`)}
                </span>
              )}
              {scheduleRunCounts.failed > 0 && (
                <span className="schedule-runs-chip is-failed">
                  {text(`失败 ${scheduleRunCounts.failed}`, `${scheduleRunCounts.failed} failed`)}
                </span>
              )}
              {scheduleRunCounts.interrupted > 0 && (
                <span className="schedule-runs-chip is-interrupted">
                  {text(`已中断 ${scheduleRunCounts.interrupted}`, `${scheduleRunCounts.interrupted} interrupted`)}
                </span>
              )}
            </div>
            <div className="schedule-runs-scroll">
              {scheduleRunList.map((run) => (
                <article key={run.id} className={`schedule-run is-${run.status}`}>
                  <div className="schedule-run-main">
                    <b>{text(`第 ${run.sequence} 轮`, `Round ${run.sequence}`)}</b>
                    <span className="schedule-run-trigger">
                      {run.trigger === "schedule" ? text("定时", "Scheduled") : text("手动", "Manual")}
                    </span>
                    <span className="schedule-run-status">{scheduleRunStatusLabel(run.status, text)}</span>
                    {run.threadId && (
                      <button
                        type="button"
                        className="schedule-run-view"
                        onClick={() => focusRoundActivity(run)}
                      >
                        {text("查看动态", "View activity")}
                      </button>
                    )}
                  </div>
                  <div className="schedule-run-meta">
                    <time title={exactTime(run.startedAt, locale)}>
                      {text("开始于 ", "Started ")}{exactTime(run.startedAt, locale)}
                    </time>
                    <span>{formatRunDuration(run, text)}</span>
                  </div>
                  {run.error && <p className="schedule-run-error">{run.error}</p>}
                </article>
              ))}
            </div>
          </div>
        </div>
      )}

      {pendingDelete && (
        <div className="delete-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !deleting) setPendingDelete(null);
        }}>
          <div className="delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-comment-title">
            <h2 id="delete-comment-title">{text("删除这条评论？", "Delete this comment?")}</h2>
            <p>{text("此操作无法撤销。", "This action cannot be undone.")}</p>
            <div>
              <button className="button secondary" type="button" disabled={deleting} onClick={() => setPendingDelete(null)}>{text("取消", "Cancel")}</button>
              <button className="button danger" type="button" disabled={deleting} onClick={() => void confirmDelete()}>{deleting ? text("删除中…", "Deleting…") : text("删除评论", "Delete comment")}</button>
            </div>
          </div>
        </div>
      )}

    </section>
  );
}
