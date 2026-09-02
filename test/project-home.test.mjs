import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const appSource = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
const apiSource = await readFile(new URL("../web/src/api.ts", import.meta.url), "utf8");
const styles = await readFile(new URL("../web/src/styles.css", import.meta.url), "utf8");
const editorSource = await readFile(new URL("../web/src/components/TaskEditor.tsx", import.meta.url), "utf8");
const detailSource = await readFile(new URL("../web/src/components/TaskDetail.tsx", import.meta.url), "utf8");
const labelPickerSource = await readFile(new URL("../web/src/components/LabelPicker.tsx", import.meta.url), "utf8");
const pendingAttachmentsSource = await readFile(new URL("../web/src/components/PendingAttachments.tsx", import.meta.url), "utf8");
const labelsSource = await readFile(new URL("../web/src/labels.ts", import.meta.url), "utf8");

test("the project switcher lists persisted Taskboard projects", () => {
  assert.match(appSource, /persistedById/);
  assert.match(appSource, /name: project\.id === GLOBAL_PROJECT_ID\s*\? text\("临时任务", "Temporary tasks"\)\s*: project\.name/);
  assert.match(appSource, /for \(const project of projects\) \{[\s\S]*?inCodex: false,[\s\S]*?persisted: true/);
  assert.match(appSource, /projectMenuChoices\.map\(\(project\) => \(/);
  assert.match(appSource, /createProjectRequest/);
  assert.match(apiSource, /export async function createProject/);
});

test("each device stores an independent workspace path for every project", () => {
  assert.match(appSource, /const DEVICE_WORKSPACE_PATHS_KEY = "taskboard\.deviceWorkspacePaths\.v1"/);
  assert.match(appSource, /function readDeviceWorkspacePaths\(\)/);
  assert.match(appSource, /rememberDeviceWorkspacePath/);
  assert.match(appSource, /const \[nextProjects, metadata, workspaces\] = await Promise\.all\(\[/);
  assert.match(appSource, /listDeviceWorkspaces\(signal\)/);
  assert.match(appSource, /const selectedDeviceWorkspacePath = selectedProjectId === GLOBAL_PROJECT_ID[\s\S]*?: deviceWorkspacePaths\[selectedProjectId\]/);
  assert.match(appSource, /listDevelopmentContexts\([\s\S]*?selectedDeviceWorkspacePath,[\s\S]*?\)/);
  assert.match(apiSource, /query\.set\("workspacePath", workspacePath\)/);
  assert.match(apiSource, /\/api\/device-workspaces/);
});

test("persisted projects keep their stored identity fields", () => {
  assert.match(appSource, /codexIdentity: projectCodexIdentities\[project\.id\] \?\? null/);
});


test("the selected project exposes the current board surfaces", () => {
  assert.match(appSource, /<header className="workspace-header">/);
  assert.match(appSource, /<div className="board-toolbar">/);
  assert.match(appSource, /<DashboardView/);
  assert.match(appSource, /<IssueListView/);
  assert.match(appSource, /<GanttView/);
  assert.match(appSource, /<BoardColumn/);
  assert.match(styles, /\.workspace-header \{[\s\S]*?border-bottom: var\(--border-hairline\) solid var\(--border\)/);
});

test("new issues stage attachments in the composer and upload them after creation", () => {
  assert.match(editorSource, /type="file"[\s\S]*?multiple/);
  assert.match(editorSource, /<PendingAttachments[\s\S]*?uploadLabel=\{text\("保存后上传", "Upload after saving"\)\}/);
  assert.match(pendingAttachmentsSource, /className="composer-attachment-list"/);
  assert.match(appSource, /Promise\.allSettled/);
  assert.match(appSource, /uploadAttachment\(saved\.id, file, "attachment"\)/);
  assert.match(appSource, /uploadAttachment\(saved\.id, image\.file, "inline"\)/);
  assert.match(appSource, /zh: `\$\{failedAttachments\} 个附件`[\s\S]*?以下内容写入失败/);
});

test("the issue composer includes Linear-style labels and scheduling", () => {
  for (const label of ["缺陷", "特性", "for-claude", "hold", "改进", "phase-1", "phase-6"]) {
    assert.match(labelsSource, new RegExp(label));
  }
  assert.match(editorSource, /<LabelPicker/);
  assert.match(labelPickerSource, /text\(`创建 “\$\{normalizedSearch\}”`, `Create “\$\{normalizedSearch\}”`\)/);
  assert.match(editorSource, /设置截止日期/);
  assert.match(editorSource, /定时执行…/);
  assert.doesNotMatch(editorSource, /设置重复|最早截止日期/);
  assert.match(editorSource, /developmentScan\.contexts/);
});

test("issue creation selects a project only from all projects and keeps the current project otherwise", () => {
  assert.match(editorSource, /\{!task && projectOptions && \([\s\S]*?ariaLabel=\{text\("项目", "Project"\)\}/);
  assert.doesNotMatch(detailSource, /detail-property-label">项目|project-property-icon|project\.name/);
  assert.match(appSource, /projectOptions=\{!editor\.task && isAllProjects \? createTargetProjects : undefined\}/);
  assert.match(appSource, /const targetProjectId = editorProjectId \?\? selectedProjectId;[\s\S]*?createTaskRequest\(targetProjectId, draft\)/);
  assert.match(appSource, /className="header-project-switcher"/);
});

test("the project header exposes project, automation, and create controls", () => {
  assert.match(appSource, /className="header-project-button"[\s\S]*?aria-haspopup="menu"/);
  assert.match(appSource, /className="header-project-menu" role="menu" aria-label=\{text\("项目", "Projects"\)\}/);
  assert.match(appSource, /<ProjectAutomationMenu/);
  assert.match(appSource, /className="icon-button header-create-button"/);
  assert.match(styles, /\.header-project-menu \{[\s\S]*?-webkit-app-region: no-drag/);
});

test("the project header keeps detail navigation separate from the project switcher", () => {
  assert.match(appSource, /const headerProjectName = isAllProjects\s*\? text\("所有项目", "All projects"\)\s*: selectedProject\?\.id === GLOBAL_PROJECT_ID\s*\? text\("临时任务", "Temporary tasks"\)\s*: selectedProject\?\.name \?\? text\("任务面板", "Taskboard"\)/);
  assert.match(appSource, /detailTask && \([\s\S]*?aria-label=\{text\("返回议题看板", "Back to issue board"\)\}[\s\S]*?<\/button>/);
  assert.match(appSource, /className="header-project-switcher"[\s\S]*?<span className="project-name">\{headerProjectName\}<\/span>/);
  assert.doesNotMatch(appSource, /className="issue-root-button"/);
  assert.doesNotMatch(appSource, /detailTask\?\.identifier \?\? "议题"/);
});

test("the app keeps the workspace header and drops embedded-host leftovers", () => {
  assert.doesNotMatch(appSource, /<aside className="app-nav"/);
  assert.match(appSource, /<header className="workspace-header">/);
  assert.doesNotMatch(appSource, /workspace-drag-region/);
  assert.doesNotMatch(appSource, /codex-sidebar-expand-button/);
  assert.doesNotMatch(appSource, /app-shell.embedded/);
});

test("realtime updates remain active on the project home and reconcile after reconnecting", () => {
  assert.match(appSource, /useEffect\(\(\) => \{\s*const source = new EventSource\(resolveTaskboardUrl\("\/api\/events"\)\)/);
  assert.match(appSource, /event\.type\.startsWith\("task\."\)[\s\S]*?scheduleRefresh\(\{ projects: true, tasks: affectsSelectedProject \}\)/);
  assert.match(appSource, /source\.onopen = \(\) => \{[\s\S]*?scheduleRefresh\(\{ projects: true, tasks: Boolean\(selectedProjectId\) \}\)/);
});
