import path from "node:path";
import { fileURLToPath } from "node:url";

const taskctlCliPath = fileURLToPath(new URL("../cli/taskctl.mjs", import.meta.url));

const AUTOMATION_OPERATIONS = new Set(["ensure-active", "pause", "list", "apply-policy", "run-task", "terminate-task"]);
const INTERVAL_MINUTES = new Set([5, 10, 15, 30, 60]);
const HOST_REQUEST_FIELDS = new Set([
  "id",
  "action",
  "requestId",
  "operation",
  "issueId",
  "taskboardProjectId",
  "codexProjectId",
  "codexProjectKind",
  "codexHostId",
  "projectName",
  "workspacePath",
  "remoteProjects",
  "skillPath",
  "automationId",
  "enabledByUser",
  "quotaAware",
  "intervalMinutes",
  "model",
  "modelProfileId",
  "reasoningEffort",
]);

export function parseTaskboardAutomationHostRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (Object.keys(value).some((field) => !HOST_REQUEST_FIELDS.has(field))) return null;
  if (value.action !== undefined && value.action !== "automation") return null;
  if (!validProjectId(value.taskboardProjectId)) return null;
  if (!AUTOMATION_OPERATIONS.has(value.operation)) return null;
  const taskRunOperation = value.operation === "run-task" || value.operation === "terminate-task";
  if (taskRunOperation && !validText(value.issueId, 128)) return null;
  if (value.issueId !== undefined && !validText(value.issueId, 128)) return null;
  if (!validText(value.projectName, 200)) return null;
  const codexProjectKind = value.codexProjectKind ?? "local";
  const codexHostId = value.codexHostId ?? "local";
  if (codexProjectKind !== "local") return null;
  if (codexHostId !== "local") return null;
  if (!validAbsolutePath(value.workspacePath)) return null;
  const codexProjectId = value.codexProjectId && validText(value.codexProjectId, 256)
    ? value.codexProjectId
    : value.workspacePath;
  if (!validText(value.skillPath, 2_048)) return null;
  const remoteProjects = value.remoteProjects === undefined ? [] : value.remoteProjects;
  if (!Array.isArray(remoteProjects) || remoteProjects.length > 0) return null;
  if (!INTERVAL_MINUTES.has(value.intervalMinutes)) return null;
  if (!validText(value.model, 256) || !validText(value.reasoningEffort, 100)) return null;
  if (
    value.modelProfileId !== undefined
    && value.modelProfileId !== null
    && !validProfileId(value.modelProfileId)
  ) return null;
  if (value.automationId !== undefined && !validText(value.automationId, 256)) return null;
  if (typeof value.enabledByUser !== "boolean" || typeof value.quotaAware !== "boolean") return null;

  return {
    id: value.id ?? value.requestId ?? "",
    action: "automation",
    requestId: value.requestId ?? "",
    operation: value.operation,
    ...(value.issueId === undefined ? {} : { issueId: value.issueId }),
    taskboardProjectId: value.taskboardProjectId,
    codexProjectId,
    codexProjectKind,
    codexHostId,
    projectName: value.projectName,
    workspacePath: value.workspacePath,
    remoteProjects,
    skillPath: value.skillPath,
    ...(value.automationId === undefined ? {} : { automationId: value.automationId }),
    enabledByUser: value.enabledByUser,
    quotaAware: value.quotaAware,
    intervalMinutes: value.intervalMinutes,
    model: value.model,
    modelProfileId: value.modelProfileId ?? null,
    reasoningEffort: value.reasoningEffort,
  };
}

export function buildTaskboardAutomationName(request) {
  return `Taskboard 自动认领 · ${request.taskboardProjectId}`;
}

export function buildTaskboardAutomationPrompt(request) {
  const taskctlCommand = buildTaskctlCommand(request);
  const executionInstructions = [
    "从返回的 todo 中只选择依赖已完成的议题：relations.blockedBy 为空，或其中每个依赖的 status 都严格等于 done。无依赖的 todo 仍可并行处理。若有 todo 但全部被未完成依赖阻塞，本轮直接结束，不暂停自动化。",
    "每次仅处理一个符合依赖条件的 todo：选定后先用 issue get 读取最新议题内容，并用 comment list 读取全部评论。根据描述和最新评论判断是否允许开始；若其中写明等待、暂不执行或当前不应开始，立即跳过并报告，不改状态。评论也包含已完成后被打回的返工要求。",
    "完成 issue get 和 comment list 后、移动状态前，必须再次运行 issue get，并复核 relations.blockedBy 仍为空或其中每个依赖的 status 都严格等于 done。若依赖条件不再满足，立即跳过并结束本轮，不改状态，也不暂停自动化。",
    `确认允许开始后，只有 threadId 和 threadBinding 都为空且仍为未归档 todo 的议题才可在读取代码、下载附件、分析或实施前认领。issue list 返回中 schedule 字段非空（配置了定时/周期执行）的 todo 不得认领——它们由看板在约定时间自动触发，提前认领会破坏其时间计划；若本轮候选全部带 schedule，直接结束本轮。认领必须使用刚读取的 version 移到 in_progress，并显式传 --binding-thread-id "$CLAUDE_THREAD_ID"、--binding-codex-project-id ${JSON.stringify(request.codexProjectId)}、--binding-codex-project-kind "local"、--binding-codex-host-id "local"、--binding-workspace-path ${JSON.stringify(request.workspacePath)}，把当前会话一次写成完整 binding；记录响应 task.version 为 ownedVersion。写入成功前不得继续。已有完整 binding 或 legacy local binding 的议题不得由本轮认领；不得认领已被其他会话绑定或其他 Agent 领取的议题。认领后的每一次 issue move 都必须显式传 ownedVersion 和这五个完整 binding 字段，成功后更新 ownedVersion。`,
    "若因 version 陈旧发生版本冲突，重新运行 issue get 和 comment list；仅当仍为可认领 todo、未绑定其他会话、未归档且描述和最新评论未变化时，用最新 version 重试一次。若已被认领、状态或要求已变、已归档、服务或永久 API 错误，或重试仍失败，立即跳过该议题、退出并报告；不得抢占或循环重试。",
    `项目文档（架构、约束与约定）可在需要时用 ${taskctlCommand} project readme get ${request.taskboardProjectId} --json 读取。`,
    "若议题已绑定 branch 或 worktree，必须在该议题绑定的开发上下文执行，避免并行会话修改同一工作目录。",
    "在本会话内完成实现和验证，不要派发给其他会话。执行完成并验证后，先用 comment add 记录关键改动、验证结果、执行结果和剩余风险，再使用 ownedVersion、显式 --if-version 和认领时保存的完整 binding 将议题移动到 in_review；成功后更新 ownedVersion。不要省略 binding，避免把完整绑定降级为 legacy local；不要直接标记为 done。",
  ];
  return [
    `使用 manage-taskboard 技能（目录 ${request.skillPath}）处理任务面板工作。e-taskboard 每 ${request.intervalMinutes} 分钟检查任务面板中的「${request.projectName}」项目（项目 ID：${request.taskboardProjectId}，项目目录：${request.workspacePath}）。`,
    `本轮所有 taskctl 操作都使用完整命令前缀 ${taskctlCommand}，不要使用 PATH 中的 taskctl。当前会话 ID 已通过环境变量 CLAUDE_THREAD_ID 注入。`,
    `开始时先运行 ${taskctlCommand} issue list --project ${request.taskboardProjectId} --status todo --json。若没有 todo，直接结束本轮并说明没有可认领的任务；不要创建新的会话。`,
    ...executionInstructions,
    `本次处理结束后，再次运行 ${taskctlCommand} issue list --project ${request.taskboardProjectId} --status todo --json，并报告剩余 todo 数量。`,
  ].join("\n");
}

function buildTaskctlCommand(request) {
  const command = `${shellQuote(process.execPath)} ${shellQuote(taskctlCliPath)}`;
  const runtimeFilePath = process.env.CLAUDE_TASKBOARD_RUNTIME_FILE;
  return runtimeFilePath
    ? `${command} --runtime-file ${shellQuote(runtimeFilePath)}`
    : command;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// Prompt for a board-triggered execution of one specific issue: the user
// dragged the issue to in_progress and the board already bound it to this
// session, so the controller reads, executes, verifies, comments, and moves it
// to in_review — the same lifecycle an auto-claimed todo goes through.
export function buildTaskboardTaskRunPrompt(request) {
  return buildTaskRunPrompt(request, `议题 ${request.issueId} 已由用户在看板移入「处理中」，需要你立即认领并完成。`);
}

// Same lifecycle, triggered by the issue's schedule instead of the user: the
// scheduler already moved the issue to in_progress and bound this session.
// Each round is an independent execution of the same issue definition; earlier
// rounds only survive as comments and run history.
export function buildTaskboardScheduledRunPrompt(request, sequence) {
  const roundNote = sequence !== undefined
    ? `本次为第 ${sequence} 轮定时执行，历史轮次的记录保留在评论中；判断当前状态时以最近一轮的评论为准。`
    : "";
  return buildTaskRunPrompt(
    request,
    `议题 ${request.issueId} 的定时执行计划已到期，看板已将其移入「处理中」并绑定到当前会话，需要你立即执行并完成。${roundNote}`,
  );
}

function buildTaskRunPrompt(request, triggerIntro) {
  const intro = `使用 manage-taskboard 技能（目录 ${request.skillPath}）处理任务面板工作。${triggerIntro}`;
  const taskctlCommand = buildTaskctlCommand(request);
  const bindingOptions = `--binding-thread-id "$CLAUDE_THREAD_ID" --binding-codex-project-id ${JSON.stringify(request.codexProjectId)} --binding-codex-project-kind "local" --binding-codex-host-id "local" --binding-workspace-path ${JSON.stringify(request.workspacePath)}`;
  const executionInstructions = [
    `先运行 ${taskctlCommand} issue get ${request.issueId} --json 读取最新议题内容，再运行 comment list 读取全部评论。根据描述和最新评论判断是否允许开始；若其中写明等待、暂不执行或当前不应开始，报告并结束本轮，不改状态。`,
    `该议题已绑定到当前会话（threadId 为 $CLAUDE_THREAD_ID）。若 issue get 显示绑定不是当前会话，立即报告并结束，不要改写他人的绑定。`,
    `确认允许开始后，在本会话内完成实现和验证，不要派发给其他会话。若议题绑定了 branch 或 worktree，必须在该议题绑定的开发上下文执行。`,
    `项目文档（架构、约束与约定）可在需要时用 ${taskctlCommand} project readme get ${request.taskboardProjectId} --json 读取。`,
    `执行完成并验证后，先用 comment add 记录关键改动、验证结果、执行结果和剩余风险，再运行 issue get 读取最新 version，并使用显式 --if-version 和完整 binding（${bindingOptions}）将议题移动到 in_review；成功后更新 ownedVersion。不要省略 binding，不要直接标记为 done。`,
    "若因 version 陈旧发生版本冲突，重新运行 issue get 和 comment list；仅当描述和最新评论未变化且仍绑定当前会话时，用最新 version 重试一次；仍失败则报告并结束。",
  ];
  return [
    intro,
    `本轮所有 taskctl 操作都使用完整命令前缀 ${taskctlCommand}，不要使用 PATH 中的 taskctl。当前会话 ID 已通过环境变量 CLAUDE_THREAD_ID 注入。`,
    ...executionInstructions,
  ].join("\n");
}

export function buildTaskboardAutomationSpec(request) {
  return {
    name: buildTaskboardAutomationName(request),
    model: request.model,
    reasoningEffort: request.reasoningEffort,
    rrule: `RRULE:FREQ=MINUTELY;INTERVAL=${request.intervalMinutes}`,
  };
}

export function taskboardAutomationPolicyOperation(request, {
  explicit,
  hasTodo,
  previousQuotaState = "available",
  quotaState = "available",
  currentStatus,
} = {}) {
  if (!request.enabledByUser) return "pause";
  if (hasTodo === false) return "pause";
  if (
    !explicit
    && currentStatus === "PAUSED"
    && (!request.quotaAware || previousQuotaState === "available")
  ) return "list";
  if (request.quotaAware && quotaState !== "available") return "pause";
  return "ensure-active";
}

function validText(value, maxLength) {
  return typeof value === "string"
    && value.trim() === value
    && value.length > 0
    && value.length <= maxLength
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function validProjectId(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 128
    && /^[a-z0-9._-]+$/i.test(value);
}

function validProfileId(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 128
    && /^[a-z0-9._-]+$/i.test(value);
}

function validAbsolutePath(value) {
  return validText(value, 2_048)
    && (path.posix.isAbsolute(value) || path.win32.isAbsolute(value));
}
