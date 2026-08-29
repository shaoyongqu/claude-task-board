[English](README.md) | [简体中文](README.zh-CN.md)

# Claude Task Board

一个本地优先、用 **Claude Code** 驱动的任务看板，在浏览器中运行。每个议题都可以交给真实的 `claude` 会话处理：看板以无头方式派生 Claude Code 回合，把工具活动实时流式显示到对话面板，会话自身则通过内置的 `taskctl` CLI 和 `manage-taskboard` 技能完成议题的认领与状态流转。

本项目 fork 自 [dashi-taskboard](https://github.com/chuspeeism/dashi-taskboard)（Codex 版），将驱动层从 Codex 完整移植到 Claude Code。

## 驱动 Claude Code 的方式

- **AI 对话** —— 看板聊天面板在项目工作目录中按回合派生 `claude -p --output-format stream-json`，沙箱模式映射为 Claude Code 权限模式（`plan` / `acceptEdits` + Bash / `--dangerously-skip-permissions`）。工具调用（Bash、文件编辑、联网搜索、TodoWrite…）实时流式进入界面；从 `init` 事件捕获会话 ID，后续回合用 `--resume` 续接。
- **会话归属** —— 派生的会话注入了 `CLAUDE_THREAD_ID`（其会话 ID）和 `CLAUDE_TASKBOARD_URL`（看板 API 地址），`taskctl` 由此自动为写入归属，会话认领议题时写入完整绑定。之后可随时用 `claude --resume <id>` 续接会话（议题详情面板可复制该命令）。
- **自动认领** —— 按项目开启自动化后，看板用本地调度器按间隔派生一个无头控制会话；它认领一个 `todo`、实现、验证、写评论并把议题移到 `in_review`。
- **目录发现** —— 模型列表来自 `CLAUDE_TASKBOARD_MODELS`（缺省为 Claude 常用别名）；技能、子代理和斜杠命令从 `~/.claude` 与工作区 `.claude` 目录发现。

## 环境要求

- Node.js 22.5 或更新
- 已安装并登录的 Claude Code CLI（`claude`）—— `npm install -g @anthropic-ai/claude-code` 或官方原生安装器

## 本地运行

```bash
npm install
npm run build
npm start
```

打开 <http://127.0.0.1:47823>。SQLite 数据库存储在 `.data/taskboard.sqlite`。

前端热更新开发模式：

```bash
npm run dev
```

## 安装 Claude Code 技能

```bash
npm run install:skill
```

该命令把 `skills/manage-taskboard` 复制到 `~/.claude/skills/manage-taskboard`。技能会教 Claude Code：读取议题 → 用完整会话绑定认领（`todo` → `in_progress`）→ 实现 → 验证 → 移到 `in_review`；只有用户明确验收后才移到 `done`。

完整的功能使用说明（界面、议题、AI 对话、自动化、CLI、协作、常见问题）见 **[使用手册](docs/user-guide.zh-CN.md)**。

## 工作目录

每个项目都有一个工作目录，AI 对话和自动认领在该目录下驱动 Claude Code：

- **默认机制**：未指定的项目自动使用 PC 全局默认根目录 `~\Claude Task Board\workspaces`（"临时任务"全局项目使用其中的 `temp-tasks` 子目录），服务启动时自动补建，无需手工干预。
- **创建时指定**：创建项目对话框会按项目名预填工作目录，可手动输入或点击"浏览…"在内置目录浏览器中选取（支持盘符与逐级进入）。
- **随时修改**：在切换项目菜单中右键项目 → "设置工作目录…"。
- 可用 `CLAUDE_TASKBOARD_WORKSPACE_ROOT` 环境变量改写默认根目录。

## 使用 CLI

```bash
npm run taskctl -- project create \
  --id my-project \
  --name "我的项目" \
  --workspace-path /仓库/绝对路径

npm run taskctl -- issue create \
  --project my-project \
  --title "实现下一个切片" \
  --status todo \
  --priority high \
  --labels product,mvp \
  --thread-id <claude会话id>
```

在看板派生的会话中，`taskctl` 自动读取 `CLAUDE_THREAD_ID`；其他场景请传 `--thread-id`。执行 `npm link` 可把 `taskctl` 加入 PATH。

## 配置

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `CLAUDE_TASKBOARD_HOST` | `0.0.0.0` | HTTP 绑定地址；设为 `127.0.0.1` 关闭局域网访问 |
| `CLAUDE_TASKBOARD_PORT` | `47823` | 本地 HTTP 端口 |
| `CLAUDE_TASKBOARD_DATA_DIR` | `.data` | SQLite 数据目录 |
| `CLAUDE_TASKBOARD_URL` | `http://127.0.0.1:47823` | CLI API 地址 |
| `CLAUDE_TASKBOARD_MODELS` | Claude 默认 | JSON 模型目录，如 `[{"slug":"glm-5.3","supportedReasoningEfforts":["low","high"]}]` |
| `CLAUDE_TASKBOARD_TRUSTED_ORIGINS` | 未设置 | 环回反向隧道允许的精确 HTTPS Origin，逗号分隔 |
| `CLAUDE_EXECUTABLE` | 自动探测 | `claude` CLI 路径 |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | 技能/代理/命令发现使用的 Claude 主目录 |

`npm start` 会打印本地地址；局域网模式下还会打印可用 LAN 地址。可信局域网内的同事可以打开同一块看板，变更通过 SSE 实时广播。局域网模式没有账号鉴权。

## 云协作

两个可信协作者可以把看板部署到 Cloudflare（Worker 静态资源 + D1 + R2），使用共享密码认证。每台设备保留自己的项目路径映射和本地配套服务（Claude Code、Git/worktree、技能能力）。详见 [Cloud collaboration](docs/cloud-collaboration.md)。

## 验证

```bash
npm run check
```

包括 TypeScript 检查、生产前端构建、组件测试和服务端/CLI 测试套件。

## 任务 Markdown

任务描述和评论支持 GFM（表格、任务列表等）。`mermaid` 代码块渲染为只读图表。不启用原生 HTML。

## 与上游项目的关系

本 fork 替换了 Codex 集成层：

| 上游（Codex） | 本项目（Claude Code） |
| --- | --- |
| 每回合 `codex exec --json` 子进程 | 每回合 `claude -p --output-format stream-json` |
| `codex app-server` JSON-RPC（线程/技能/自动化） | 本地调度器 + 文件系统目录（`~/.claude`） |
| CDP 注入 ChatGPT/Codex 桌面端 | 浏览器看板（无注入；桌面端代码已移除） |
| `CODEX_THREAD_ID` 归属 | `CLAUDE_THREAD_ID` 归属（注入派生会话） |
| Tauri 桌面打包 | 已移除 —— `npm start` + 浏览器 |
| `~/.codex` 状态（项目、会话） | `~/.claude/projects` 会话文件 + 看板项目 |

SQLite 表结构保留上游 `thread_*` 列名以便平滑迁移数据；actor 身份会自动从 `codex-agent` 迁移为 `claude-agent`。
