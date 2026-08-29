# Claude Task Board 使用手册

本手册覆盖看板的全部功能。安装与配置参见 [README](../README.zh-CN.md)。

---

## 1. 快速开始

```bash
npm install
npm run build
npm run install:skill   # 安装 Claude Code 技能（首次必做）
npm start               # 启动看板服务
```

| 访问方式 | 地址 | 能力范围 |
| --- | --- | --- |
| 本机访问 | <http://127.0.0.1:47823> | **全部功能**（AI 对话、自动化、Jira） |
| 局域网访问 | `http://<本机局域网IP>:47823` | 看板协作（项目/议题/评论）；本机能力类接口返回 403 属正常 |

> 注意：需要驱动本机 Claude Code 的功能（AI 对话、自动化、Jira 连接）请在运行服务的机器上用 `127.0.0.1` 访问。

**首次运行**：本机打开看板时，顶部会出现「完成 Claude Code 集成配置」横幅（技能未装或当前项目未配集成时）。点击进入集成设置：一键安装技能、查看默认工作目录根、为当前项目配置/移除 MCP+hooks+斜杠命令三件套。可随时从项目右键菜单 →「Claude 集成…」再次打开。

---

## 2. 界面总览

顶栏从左到右：

- **切换项目**：项目下拉菜单（含搜索、最近项目、"所有项目"汇总视图、连接 Jira、创建项目）。
- **看板视图切换**：仪表盘 / 议题看板 / 列表视图 / 甘特图 / 项目文档（后两项仅具体项目中显示）。
- **搜索议题**：点击或按 `/` 聚焦，支持标题、描述、评论全文匹配。
- **筛选议题**：按状态、标签、经办人、优先级组合过滤。
- **显示设置**：卡片展示字段（经办人、日期、标签、会话活动等）的显隐。
- **打开其他任务**：侧栏查看次要状态列（积压事项 / 完成 / 取消 / 已归档）。
- **打开 AI 对话**：进入 AI 会话面板（见第 7 节）。
- **新建议题**：创建议题。

---

## 3. 项目管理

### 创建项目

切换项目 → 创建项目 → 输入项目名称。**工作目录**默认已按项目名预填在全局根目录 `~\Claude Task Board\workspaces` 下，可手动修改或点击"浏览…"在内置目录浏览器中选取（支持盘符、逐级进入）；服务端会在创建时自动创建该目录。

之后随时修改：在切换项目菜单中**右键项目 → 设置工作目录**（必须是本机的绝对路径）。AI 对话和自动化都在该目录下驱动 Claude Code；"临时任务"全局项目默认使用 `workspaces\temp-tasks`。环境变量 `CLAUDE_TASKBOARD_WORKSPACE_ROOT` 可改写默认根目录。

### 项目菜单能力

- **项目文档**：每个项目一个 README（Markdown），存放项目概览、约定；执行任务前 Claude 会先读它。
- **项目标签**：自定义项目级标签集合，供议题使用。
- **删除项目**：仅空项目可删除。
- **自动化**：见第 8 节。

> 全局项目（显示为"临时任务"）是未指定项目的议题的默认去处。

---

## 4. 议题管理

### 议题字段

| 字段 | 说明 |
| --- | --- |
| 状态 | 七态：`积压事项` → `待办` → `处理中` → `等你确认` → `完成`；另有 `遇到阻碍`、`取消` |
| 优先级 | 无 / 紧急 / 高 / 中 / 低 |
| 标签 | 项目标签多选 |
| 起止/截止日期 | 供甘特图展示 |
| 循环 | 配合截止日期，按天/周/月/年周期性重开 |
| 经办人 | 本机用户 或 **Claude Agent**（指派给 Claude 处理） |
| 开发上下文 | 绑定一个 Git 分支或 worktree（从项目仓库自动扫描，不手填） |
| 描述 | GFM Markdown，支持表格、任务列表、mermaid 图表、行内附件、`#` 引用其他议题 |

### 状态语义（重要）

- `积压事项`：未批准执行，Claude 不会认领。
- `待办`：可认领。
- `处理中`：已被某个会话认领并绑定。
- `等你确认`：实现与自验证完成，等待用户验收。
- `完成`：**只有用户明确验收后才进入**（Claude 不会自行标记完成）。
- 议题卡片上的会话图标显示当前绑定的 Claude 会话；点击可复制 `claude --resume <会话ID>` 终端命令，随时人工接管继续。

### 编辑与归档

- 列表/看板中点击议题进入详情；右上更多菜单可归档、恢复、永久删除（需先归档）。
- 所有多用户/多会话写入使用乐观版本号，冲突时界面会提示并自动重新同步。

---

## 5. 议题详情

- **评论**：Markdown，支持附件与行内图片；评论是当前需求的最高优先级来源（Claude 每轮先读最新评论）。
- **附件**：拖拽或选择上传，25MB 上限；正文里可插入行内图片。
- **关联关系**：父议题 / 子议题 / 阻塞 / 被阻塞 / 相关；自动化调度只会处理"依赖均已完成"的待办议题。
- **活动流**：状态变更、字段修改、会话认领的完整时间线，含操作者身份（本机用户 / Claude Agent）。

---

## 6. 四种视图

| 视图 | 用途 |
| --- | --- |
| 议题看板 | 四列主状态流（待办/处理中/遇到阻碍/等你确认），拖拽改状态 |
| 列表视图 | 紧凑表格，适合批量浏览；URL 可直达单个议题 |
| 甘特图 | 按起止日期排期，需要先给议题设置日期 |
| 仪表盘 | 项目概览 + **AI 项目总结**（Claude 定期生成的进展/风险/下一步摘要） |

---

## 7. AI 对话（Claude Code 驱动）

右上角"打开 AI 对话"。每个会话绑定一个项目（自动使用该项目的 workspace 作为 Claude Code 工作目录）。

### 会话设置

- **模型 / 推理力度**：默认提供 Claude 常用别名；可用环境变量 `CLAUDE_TASKBOARD_MODELS` 自定义（适配 GLM 等代理），如：
  `CLAUDE_TASKBOARD_MODELS='[{"slug":"glm-5.3","supportedReasoningEfforts":["low","high"]}]'`
- **沙箱**（权限从紧到松）：
  - `只读` → Claude Code `plan` 模式，只读分析；
  - `工作区可写`（默认）→ `acceptEdits + Bash`，可改文件、跑命令；
  - `完全访问` → 跳过全部权限确认，**每次发送都需二次确认**。

### 对话能力

- 输入 `@` 引用本机 `~/.claude/skills` 或项目 `.claude` 下的**技能/子代理**；`/` 引用斜杠命令。
- 附件随消息发送（图片 Claude 可直接查看）。
- 实时流式展示 Claude 的工具活动：运行命令及输出、文件修改、联网搜索、任务清单进度、报错。
- 可随时**中断**当前回合；会话按 Claude Code 会话 ID 续接（`--resume`）。
- 从议题详情/菜单"在对话中打开"，会话自动携带该议题上下文，Claude 通过 taskctl 认领、推进状态。

### 会话归属机制

看板派生的会话被注入 `CLAUDE_THREAD_ID`（其会话 ID）与 `CLAUDE_TASKBOARD_URL`，会话内 `taskctl` 写入自动归属到该会话，并写入五字段完整绑定（会话 ID、项目、类型、主机、工作目录）。

### 在终端继续（交互式接管）

- 议题详情会话区 / AI 对话面板头部 / 会话卡片的「在终端继续」会在**系统终端**打开交互式 `claude` 并自动 `--resume` 对应会话（Windows Terminal 优先，cmd 兜底；都失败时复制启动命令）。
- 「在新对话打开」走看板内无头对话；两者互补。

---

## 7.5 Claude Code 深度集成（MCP / hooks / 斜杠命令）

配置了集成的项目工作区里，**你自己开的任何 claude 会话**都能原生操作看板：

| 能力 | 说明 |
| --- | --- |
| **MCP 工具** | 会话内自动可用 `issue_list / issue_get / issue_create / issue_move / comment_add / project_list / context_current / project_readme_get`，直接说"把 ABC-1 移到处理中"即可 |
| **会话上报** | SessionStart/End/Stop hooks 自动把会话报给看板；顶栏「本机会话」面板实时列出，可**绑定到当前打开的议题**或终端打开 |
| **斜杠命令** | `/e-taskboard ABC-1` 完整处理一个议题；`/taskboard-status` 汇报项目状态 |

**部署**：默认根目录下的工作区创建时自动配置；外部仓库在项目右键菜单 →「Claude 集成…」（或首次运行横幅）一键配置/移除。写入 `.mcp.json`、`.claude/settings.json`、`.claude/commands/`，均先备份、只增删看板自有条目。

**注意**：首次在配置了 `.mcp.json` 的工作区启动 claude 会请求批准该 MCP 服务器；`claude mcp reset-project-choices` 可重置。局域网地址下集成配置入口不可用（本机能力）。

---

## 8. 自动化（自动认领）

项目菜单 → **自动化**：

- 开启后，看板每 5/10/15/30/60 分钟派生一个无头 Claude Code 控制会话；
- 它会：挑一个依赖已完成的待办议题 → 用 taskctl 认领 → 在项目工作目录实现并验证 → 写完成评论 → 移到"等你确认"；
- 每轮最多处理一个议题；没有可认领议题时自动暂停；
- 支持选择模型与推理力度。

---

## 9. taskctl CLI

命令行操作看板（脚本、CI、手动批量都可用）：

```bash
npm run taskctl -- project list
npm run taskctl -- context current

npm run taskctl -- issue create --project <id> --title "标题" --status todo \
  --priority high --labels 产品,MVP --description-file spec.md --thread-id <会话ID>
npm run taskctl -- issue list --project <id> --status todo --json
npm run taskctl -- issue get <编号> --json
npm run taskctl -- issue move <编号> --status in_progress --if-version <版本> \
  --binding-thread-id ... --binding-codex-project-id ... --binding-codex-project-kind local \
  --binding-codex-host-id local --binding-workspace-path ...

npm run taskctl -- comment list <编号>
npm run taskctl -- comment add <编号> --body "内容"
npm run taskctl -- relation add <编号> --type blocks --related <编号2>
npm run taskctl -- attachment list --task <编号>
npm run taskctl -- project readme get <id>
```

完整命令参考见 [skills/manage-taskboard/references/cli.md](../skills/manage-taskboard/references/cli.md)。环境变量 `CLAUDE_TASKBOARD_URL` 指定目标服务；看板派生的会话内自动读取 `CLAUDE_THREAD_ID` 归属。

---

## 10. Claude Code 集成清单

| 事项 | 命令/位置 |
| --- | --- |
| 安装技能 | `npm run install:skill` → `~/.claude/skills/manage-taskboard` |
| 技能内容 | `skills/manage-taskboard/SKILL.md`（认领/推进/验收规则） |
| 恢复某个会话 | 议题卡片会话图标 → 复制 `claude --resume <id>` → 终端执行 |
| 自己开终端让 Claude 处理议题 | 提示词里带上议题编号，Claude 会用 taskctl 认领 |
| 模型自定义 | `CLAUDE_TASKBOARD_MODELS` |
| Claude CLI 路径 | 自动探测，或 `CLAUDE_EXECUTABLE` 指定 |

---

## 11. 多人协作

- **局域网**：服务默认绑定 `0.0.0.0`，同事用 `http://<你的IP>:47823` 打开同一块看板，变更通过 SSE 实时广播。无鉴权，仅限可信网络（收紧为 `127.0.0.1` 可关闭）。
- **云端**：Cloudflare Worker + D1 + R2 部署，共享密码认证，适合两人异地协作；每台设备保留本地配套服务。详见 [Cloud collaboration](cloud-collaboration.md)。

## 12. Jira 集成

项目菜单 → 连接 Jira：配置实例后，Jira 项目可作为看板项目映射，手动/定时同步议题。凭据仅存本机（所以局域网访问时该入口 403）。

---

## 13. 常见问题

**控制台出现 `GET /api/local/jira-connection 403`？**
局域网访问时的正常现象——本机能力接口仅限 `127.0.0.1`，不影响看板协作功能。

**局域网打开后部分按钮/功能不可用？**
AI 对话、自动化、Jira 属本机能力，请在本机用 `http://127.0.0.1:47823` 操作。

**改了代码页面行为没变？**
浏览器已加载的页面不会自动更新，按 F5 刷新。

**AI 回合失败提示 Claude Code 退出？**
检查 `claude` CLI 已安装并登录（`claude --version`）；自定义模型需与你的供应商匹配（`CLAUDE_TASKBOARD_MODELS`）。

**数据存在哪里？**
`<项目>/.data/taskboard.sqlite`（附件在 `.data/attachments`）。备份这两个位置即可。
