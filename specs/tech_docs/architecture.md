# MyAgents 技术架构

> 最后更新：v0.1.54 (2026-03-27)

## 概述

MyAgents 是基于 Tauri v2 的桌面应用，提供 Claude Agent SDK 的图形界面。支持多 Tab 对话、IM Bot（Telegram/钉钉/社区插件）、定时任务、MCP 工具集成。

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React 19 + TypeScript + Vite + TailwindCSS |
| 桌面框架 | Tauri v2 (Rust) |
| 后端 | Bun + TypeScript (多实例 Sidecar 进程) |
| AI | Anthropic Claude Agent SDK 0.2.84 |
| 通信 | Rust HTTP/SSE Proxy (reqwest via `local_http` 模块) |
| 拖拽 | @dnd-kit/sortable |

## 架构图

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          Tauri Desktop App                               │
├──────────────────────────────────────────────────────────────────────────┤
│                            React Frontend                                │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌──────────────┐   │
│  │   Tab 1     │  │   Tab 2     │  │  Settings   │  │  IM Settings │   │
│  │ session_123 │  │ session_456 │  │  Launcher   │  │  聊天机器人   │   │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬───────┘   │
│         │                │                │                │            │
├─────────┼────────────────┼────────────────┼────────────────┼────────────┤
│         │                │                │                │   Rust     │
│   ┌─────┴────────────────┴─────┐   ┌─────┴──────┐  ┌──────┴─────────┐ │
│   │     SidecarManager         │   │   Global   │  │ ManagedAgents  │ │
│   │  Session-Centric Model     │   │  Sidecar   │  │  + Legacy      │ │
│   └─────┬────────────────┬─────┘   └────────────┘  │  ManagedImBots │ │
│         │                │                          └──────┬─────────┘ │
│         ▼                ▼                                 │           │
│  ┌─────────────┐  ┌─────────────┐                          ▼           │
│  │ Sidecar A   │  │ Sidecar B   │  ← Session 级别  ┌──────┼─────────┐ │
│  │ session_123 │  │ session_456 │  (1:1 对应)      │      │         │ │
│  │ :31415      │  │ :31416      │                  Telegram  Dingtalk │ │
│  └──────┬──────┘  └─────────────┘                  Bot API   Stream  │ │
│         │                                                    Plugin  │ │
│   ┌─────┴──────┐                                             Bridge │ │
│   │ OpenAI     │  ← 三方供应商                              (Bun→社区) │
│   │ Bridge     │  (DeepSeek/Gemini)                                  │ │
│   └────────────┘                                                     │ │
└──────────────────────────────────────────────────────────────────────────┘
```

### 核心概念：Session-Centric Sidecar 架构 (v0.1.10+)

| 概念 | 说明 |
|------|------|
| **Sidecar = Agent 实例** | 一个 Sidecar 进程 = 一个 Claude Agent SDK 实例 |
| **Session:Sidecar = 1:1** | 每个 Session 最多有一个 Sidecar，严格对应 |
| **后端优先，前端辅助** | Sidecar 可独立运行（定时任务、Agent Channel），无需前端 Tab |
| **Owner 模型** | Tab、CronTask、BackgroundCompletion、Agent 是 Sidecar 的"使用者"，所有 Owner 释放后 Sidecar 才停止 |

### Sidecar 使用边界

| 页面类型 | TabProvider | Sidecar 类型 | API 来源 |
|----------|-------------|--------------|----------|
| Chat | ✅ 包裹 | Session Sidecar | `useTabState()` |
| Settings | ❌ 不包裹 | Global Sidecar | `apiFetch.ts` |
| Launcher | ❌ 不包裹 | Global Sidecar | `apiFetch.ts` |
| IM Bot / Agent Channel | — (Rust 驱动) | Session Sidecar | Rust `ensure_session_sidecar()` |

**设计原则**：
- **Chat 页面**需要 Session Sidecar（有 `sessionId`，项目级 AI 对话）
- **Settings/Launcher**使用 Global Sidecar（全局功能、API 验证等）
- 不在 TabProvider 内的组件调用 `useTabStateOptional()` 返回 `null`，自动 fallback 到 Global API

## 核心模块

### 1. Session-Centric Sidecar Manager (`src-tauri/src/sidecar.rs`)

**核心数据结构**：

```rust
/// Sidecar 使用者类型
pub enum SidecarOwner {
    Tab(String),                 // Tab ID
    CronTask(String),            // CronTask ID
    BackgroundCompletion(String),// Session ID（AI 后台完成时保活）
    Agent(String),               // session_key（Agent Channel 消息处理，v0.1.41+）
}

/// Session 级别的 Sidecar 实例
pub struct SessionSidecar {
    pub session_id: String,
    pub port: u16,
    pub workspace_path: PathBuf,
    pub owners: HashSet<SidecarOwner>,  // 可以有多个使用者
    pub healthy: bool,
}
```

**IPC 命令**：

| 命令 | 用途 |
|------|------|
| `cmd_ensure_session_sidecar` | 确保 Session 有运行中的 Sidecar |
| `cmd_release_session_sidecar` | 释放 Owner 对 Sidecar 的使用 |
| `cmd_get_session_port` | 获取 Session 的 Sidecar 端口 |
| `cmd_get_session_activation` | 查询 Session 激活状态 |
| `cmd_activate_session` | 激活 Session（记录到 HashMap）|
| `cmd_deactivate_session` | 取消 Session 激活 |
| `cmd_upgrade_session_id` | 升级 Session ID（场景 4 handover）|
| `cmd_start_global_sidecar` | 启动 Global Sidecar |
| `cmd_stop_all_sidecars` | 应用退出时清理全部 |

### 2. Multi-Tab 前端架构 (`src/renderer/context/`)

| 组件 | 职责 |
|------|------|
| `TabContext.tsx` | Context 定义，提供 Tab-scoped API |
| `TabProvider.tsx` | 状态容器，管理 messages/logs/SSE/Session |

**Tab-Scoped API**：
```typescript
const { apiGet, apiPost, stopResponse } = useTabState();
```

### 3. SSE 系统

**Rust SSE Proxy** (`src-tauri/src/sse_proxy.rs`) — 多连接代理，按 Tab 隔离事件：
```
事件格式: sse:${tabId}:${eventName}
示例:     sse:tab-xxx:chat:message-chunk
```

**Bun SSE Server** (`src/server/sse.ts`) — 管理 SSE 客户端连接、heartbeat、事件广播：

- `broadcast(event, data)` — 向所有客户端广播事件
- **Last-Value Cache** (v0.1.53) — 缓存 `chat:status` 事件的最新值。新 SSE 客户端连接时自动 replay，解决 Tab 中途接入 IM session 时短暂显示 idle 的问题
- **日志降噪** — 高频流式事件（`chat:message-chunk`、`chat:thinking-delta`、`chat:tool-input-delta`、`chat:log` 等）跳过 `console.log`，仅关键状态事件（status/complete/error）写入统一日志

### 4. 系统提示词组装 (`src/server/system-prompt.ts`)

统一三层 Prompt 架构：

| 层 | 用途 | 何时包含 |
|----|------|----------|
| **L1** 基础身份 | 告诉 AI 运行在 MyAgents 产品中 | **始终** |
| **L2** 交互方式 | 桌面客户端 / IM Bot / Agent Channel（含平台、聊天类型、Bot 名称） | **互斥选一** |
| **L3** 场景指令 | Cron 定时任务上下文 / IM 心跳机制 / Browser Storage 指令 | **按需叠加** |

**核心类型**：
```typescript
export type InteractionScenario =
  | { type: 'desktop' }
  | { type: 'im'; platform: 'telegram' | 'feishu'; sourceType: 'private' | 'group'; botName?: string }
  | { type: 'agent-channel'; platform: string; sourceType: 'private' | 'group'; botName?: string; agentName?: string }
  | { type: 'cron'; taskId: string; intervalMinutes: number; aiCanExit: boolean };
```

**组装矩阵**：

| 场景 | L1 | L2 | L3 |
|------|----|----|-----|
| 桌面聊天 | base-identity | channel-desktop | — |
| 内置 IM Bot | base-identity | channel-im | heartbeat |
| Agent Channel（OpenClaw 插件） | base-identity | channel-agent | heartbeat |
| Cron 任务 | base-identity | channel-desktop | cron-task |

### 5. 自配置 CLI (`src/cli/` + `src-tauri/src/cli.rs`) (v0.1.54)

内置命令行工具 `myagents`，让 AI 和用户都能通过 Bash 管理应用配置（MCP/Provider/Agent/Cron/Plugin 等），能力与 GUI 对等。

**两个使用场景**：

| 场景 | 调用方式 | 端口来源 |
|------|---------|---------|
| AI 内部调用（主要） | SDK Bash 工具 → `myagents mcp add ...` | `MYAGENTS_PORT` 环境变量（`buildClaudeSessionEnv` 注入） |
| 用户终端调用 | `MyAgents mcp list`（Rust 二进制直接调） | `~/.myagents/sidecar.port` 文件（`cli.rs` 读取） |

**组件分层**：

| 层 | 文件 | 职责 |
|----|------|------|
| Rust CLI 入口 | `cli.rs` | 检测 CLI 模式，不启动 GUI，spawn Bun 执行脚本 |
| CLI 脚本 | `src/cli/myagents.ts` | 参数解析 → HTTP 转发到 `/api/admin/*` → 输出格式化 |
| 版本门控同步 | `commands.rs` (`cmd_sync_cli`, `CLI_VERSION`) | 应用启动时拷贝脚本到 `~/.myagents/bin/myagents` |
| Admin API | `admin-api.ts` | 业务逻辑：写 config → 更新内存 → SSE 广播 |
| PATH 注入 | `agent-session.ts` (`buildClaudeSessionEnv`) | `~/.myagents/bin` 加入 SDK 子进程 PATH |

**为什么放在 `~/.myagents/bin/` 而非 app bundle**：SDK 子进程 PATH 不含 app bundle 内部路径；shebang 执行需要可执行权限和去掉 `.ts` 后缀；`~/.myagents/bin/` 是跨平台稳定的工具投放点。

详见 [CLI 架构](./cli_architecture.md)。

### 6. 定时任务系统 (v0.1.42)

**Rust 层**（`src-tauri/src/cron_task.rs`）：
- `CronTaskManager` — 单例，管理任务 CRUD、tokio 调度循环、持久化、崩溃恢复
- 支持三种 `CronSchedule`：`Every { minutes, start_at? }` / `Cron { expr, tz? }` / `At { at }`
- 调度器使用 wall-clock polling（`sleep_until_wallclock`），系统休眠后能正确唤醒
- 持久化：`~/.myagents/cron_tasks.json`（原子写入），执行记录 `~/.myagents/cron_runs/<taskId>.jsonl`

**Bun 层**（`src/server/tools/im-cron-tool.ts`）：
- `im-cron` MCP server — **所有 Session 可用**（不仅 IM Bot）
- 始终信任（`canUseTool` auto-allow），`list`/`status` 按工作区过滤

### 7. Agent 架构 (`src-tauri/src/im/`) (v0.1.41+)

v0.1.41 将 IM Bot 升级为 **Agent** 实体，Channel 为可插拔连接：

```
Project (工作区)
  = Basic Agent（被动型，用户在客户端主动交互）
  + 可选的「主动 Agent」模式 → AgentConfig（24h 感知与行动）
    └── Channels: Telegram / Dingtalk / OpenClaw Plugin（飞书/微信/QQ 等）
```

**适配器**：

| 适配器 | 协议 | 说明 |
|--------|------|------|
| `TelegramAdapter` | Bot API 长轮询 | 内置，消息收发/白名单/碎片合并 |
| `DingtalkAdapter` | Stream 长连接 | 内置，消息收发 |
| `BridgeAdapter` | HTTP 双向转发 | OpenClaw 社区插件（飞书/微信/QQ 等），Rust → 独立 Bun Bridge 进程 |

> 旧版内置飞书适配器（`FeishuAdapter`）已从 UI 隐藏入口，代码保留供向后兼容。新飞书集成通过 OpenClaw 官方插件 `@larksuite/openclaw-lark`。

**Plugin Bridge**（`src/server/plugin-bridge/`）：
- 独立 Bun 进程加载 OpenClaw Channel Plugin
- SDK Shim（`sdk-shim/`）提供 `openclaw/plugin-sdk/*` 兼容层，**全量覆盖** OpenClaw 所有 154 个子路径导出
  - 25 个手写模块（`_handwritten.json` 清单保护）：提供 Bridge 模式下的真实逻辑
  - 129 个自动生成 stub（`scripts/generate-sdk-shims.ts`）：命名导出 + 首次调用警告，防止 `Cannot find module` 崩溃
  - 更新流程：`bun run generate:sdk-shims`（读取 OpenClaw 源码，跳过手写模块，重新生成 stub）
- 安装流程：`npm install` → `install_sdk_shim`（最后写入，last-write-wins）→ bridge 启动前 shim 完整性检查
- 消息通过 HTTP 双向转发，AI 推理仍走 Rust → Bun Sidecar 标准管道

### 8. 三方供应商支持

**OpenAI Bridge**（`src/server/openai-bridge/`）：
当供应商使用 OpenAI 协议（DeepSeek/Gemini/Moonshot 等），SDK 的 Anthropic 请求被 loopback 到 Sidecar 的 Bridge handler，翻译为 OpenAI 格式后转发：

```
SDK subprocess → ANTHROPIC_BASE_URL=127.0.0.1:${sidecarPort}
  → /v1/messages → Bridge handler → translateRequest → upstream OpenAI API
  → translateResponse → Anthropic 格式 → SDK
```

**模型别名映射** (v0.1.53)：
子 Agent 指定 `model: "sonnet"` 时，SDK 通过 `ANTHROPIC_DEFAULT_SONNET_MODEL` 环境变量解析为供应商模型（如 `deepseek-chat`）。三个别名环境变量：

| 环境变量 | 用途 |
|----------|------|
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | "sonnet" → 供应商 model ID |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | "opus" → 供应商 model ID |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | "haiku" → 供应商 model ID |

别名来源优先级：Provider preset → 用户自定义 → primaryModel fallback。
Bridge 同时注入 `modelMapping` 函数，确保 OpenAI 协议路径也能区分子 Agent 模型。

**Provider Self-Resolve** (`src/server/utils/admin-config.ts:resolveWorkspaceConfig`)：
IM/Cron Session 的 Provider 和 Model 从磁盘自 resolve，不依赖前端 `/api/provider/set`。解析链：`agent.providerId → config.defaultProviderId → persisted snapshot`。

### 9. Session 切换与持久化

| 场景 | 描述 | 行为 |
|------|------|------|
| **场景 1** | 新 Tab + 新 Session | 创建新 Sidecar |
| **场景 2** | 新 Tab + 其他 Tab 正在用的 Session | 跳转到已有 Tab |
| **场景 3** | 同 Tab 切换到定时任务 Session | 跳转/连接到 CronTask Sidecar |
| **场景 4** | 同 Tab 切换到无人使用的 Session | **Handover**：Sidecar 资源复用 |

**持久 Session 架构**：
- `messageGenerator()` 使用 `while(true)` 持续 yield，SDK subprocess 全程存活
- 所有中止场景 MUST 使用 `abortPersistentSession()`
- 所有 `await sessionTerminationPromise` 通过 `awaitSessionTermination(10_000, label)` 带 10 秒超时防护，防止死锁

### 10. 内嵌终端 (`src-tauri/src/terminal.rs` + `src/renderer/components/TerminalPanel.tsx`) (v0.1.57)

Chat 分屏右侧面板中的交互式终端（PTY），工作目录为当前工作区。

**架构**：

```
用户按键 → xterm.onData → invoke('cmd_terminal_write') → PTY master write
PTY master read → emit('terminal:data:{id}') → xterm.write → 屏幕渲染
```

- **Rust**: `TerminalManager` 管理 `HashMap<String, TerminalSession>`，每个 session 持有 PTY pair（`portable-pty`）、reader task（`spawn_blocking`）、writer
- **前端**: `TerminalPanel.tsx` 封装 xterm.js + FitAddon + WebLinksAddon，通过 Tauri IPC 通信
- **通信**: Tauri event（`terminal:data:{id}` / `terminal:exit:{id}`），不走 SSE Proxy

**生命周期**：

| 事件 | 行为 |
|------|------|
| 点击终端图标 | `terminalPinned=true` → PTY 创建（listeners-first 模式） |
| 切换到文件视图 | 终端用 `hidden` CSS 隐藏，xterm.js 保持挂载 |
| 关闭终端面板（×） | `terminalPinned=false`，PTY 后台存活 |
| 再次点击终端图标 | `terminalPinned=true`，恢复显示，内容完好 |
| Shell exit / Ctrl+D | reader loop 自行从 HashMap 清理 + 前端 `cmd_terminal_close` 双保险 |
| Tab 关闭 | unmount cleanup → `cmd_terminal_close` |
| App 退出 | `close_all_terminals()`（三个退出路径均注册） |

**环境注入**（`inject_terminal_env`）：PATH（内置 Bun/Node.js + `~/.myagents/bin`）、`MYAGENTS_PORT`（当前 session sidecar 端口）、`TERM=xterm-256color`、`COLORTERM=truecolor`、`NO_PROXY`（localhost 保护）。Shell 以 login shell（`-l`）启动。

**主题**: 日间/夜间双主题自动切换，MutationObserver 监听 `<html>.dark`（同 Monaco 模式）。

**与 Pit-of-Success 模块关系**：不走 `process_cmd`（`portable-pty` 自管进程创建）、不走 `local_http`（不发 HTTP）、复用 `proxy_config` 常量和函数、使用 `system_binary::find()` 检测 Windows Shell。

## 通信流程

### SSE 流式事件
```
Tab1 listen('sse:tab1:*') ◄── Rust emit(sse:tab1:event) ◄── reqwest stream ◄── Sidecar:31415
Tab2 listen('sse:tab2:*') ◄── Rust emit(sse:tab2:event) ◄── reqwest stream ◄── Sidecar:31416
```

### HTTP API 调用
```
Tab1 apiPost() ──► getSessionPort(session_123) ──► Rust proxy ──► Sidecar:31415
Tab2 apiPost() ──► getSessionPort(session_456) ──► Rust proxy ──► Sidecar:31416
```

## Pit-of-Success 模块

这四个 Rust 模块构成"正确路径默认化"四驾马车，消除常见陷阱：

| 模块 | 用途 | 防止的问题 |
|------|------|-----------|
| `local_http` (`src-tauri/src/local_http.rs`) | 所有连接 localhost 的 reqwest 客户端 | 系统代理拦截 localhost → 502 |
| `process_cmd` (`src-tauri/src/process_cmd.rs`) | 所有 Rust 层子进程创建 | Windows GUI 弹黑色控制台窗口 |
| `proxy_config` (`src-tauri/src/proxy_config.rs`) | 子进程代理环境变量注入 | Bun `fetch()` 读取继承的 HTTP_PROXY → localhost 通信被代理拦截 |
| `system_binary` (`src-tauri/src/system_binary.rs`) | 系统工具查找（pgrep/taskkill 等） | Tauri GUI 从 Finder 启动不继承 shell PATH |

## 资源管理

| 事件 | 操作 |
|------|------|
| 打开/切换 Session | `ensureSessionSidecar(sessionId, workspace, ownerType, ownerId)` |
| 关闭 Tab | `releaseSessionSidecar(sessionId, 'tab', tabId)` |
| 定时任务启动 | `ensureSessionSidecar(sessionId, workspace, 'cron', taskId)` |
| 定时任务结束 | `releaseSessionSidecar(sessionId, 'cron', taskId)` |
| IM 消息到达 | `ensureSessionSidecar(sessionId, workspace, 'agent', sessionKey)` |
| IM Session 空闲超时 | `releaseSessionSidecar(sessionId, 'agent', sessionKey)` |
| 终端打开 | `cmd_terminal_create(workspace, rows, cols, port, id)` |
| 终端关闭 / Tab 关闭 | `cmd_terminal_close(terminalId)` |
| Shell 退出 | reader loop 自行从 `TerminalManager` 移除 |
| 应用退出 | `stopAllSidecars()` + `close_all_terminals()`，清理全部进程 |

**Owner 释放规则**：当一个 Session 的所有 Owner 都释放后，Sidecar 才停止。

## 日志与排查

### Boot Banner (v0.1.53)

应用启动和每个 Sidecar 创建时输出 `[boot]` 单行自检信息：
```
[boot] v=0.1.53 build=release os=macos-aarch64 provider=deepseek mcp=2 agents=3 channels=5 cron=12 proxy=false dir=/Users/xxx/.myagents
[boot] pid=12345 port=31415 bun=1.3.6 workspace=/path session=abc-123 resume=true model=deepseek-chat bridge=yes mcp=playwright,im-cron
```

**排查第一步**：`grep '[boot]' ./logs/unified-*.log` 获取完整环境。

### 日志降噪 (v0.1.53)

五层过滤将信噪比从 36% 提升到 ~85%：

| 层 | 过滤内容 | 位置 |
|----|---------|------|
| SSE broadcast | chunk/delta/thinking/log 等流式事件 | `sse.ts` SILENT_EVENTS |
| HTTP 路由 | /health、/api/commands、/api/agents/enabled 等高频路径 | `index.ts` SILENT_PATHS |
| SDK message | 摘要替代完整 JSON（`type=assistant model=opus`） | `agent-session.ts` |
| IM Heartbeat | bridge-out 过滤 Heartbeat sent/ACK/op=11 | `bridge.rs` |
| bun-out 去重 | Bun logger 初始化后停止 stdout 捕获 | `sidecar.rs` |

### 统一日志格式

三个来源汇入 `~/.myagents/logs/unified-{YYYY-MM-DD}.log`（本地时间）：
- **[REACT]** — 前端日志
- **[BUN]** — Bun Sidecar 日志（logger interceptor 直写）
- **[RUST]** — Rust 层日志（含启动阶段的 `[bun-out]` 和始终捕获的 `[bun-err]`）

## 安全设计

- **FS 权限**: 仅允许 `~/.myagents` 配置目录
- **Agent 目录验证**: 阻止访问系统敏感目录
- **Tauri Capabilities**: 最小权限原则
- **本地绑定**: Sidecar 仅监听 `127.0.0.1`
- **CSP**: `img-src` 允许 `https:`（支持 AI Markdown 图片预览），`connect-src` 和 `fetch-src` 严格锁定
- **代理安全**: `local_http` 模块内置 `.no_proxy()` 防止系统代理拦截 localhost

## 跨平台工具模块 (`src/server/utils/platform.ts`)

统一的跨平台环境变量处理：

| 用途 | macOS/Linux | Windows |
|------|-------------|---------|
| Home 目录 | `HOME` | `USERPROFILE` |
| 用户名 | `USER` | `USERNAME` |
| 临时目录 | `TMPDIR` | `TEMP`/`TMP` |

`buildCrossPlatformEnv()` 自动设置双平台变量，确保子进程兼容。

## 双运行时策略 (v0.1.44+)

| 运行时 | 用途 | 打包位置 |
|--------|------|---------|
| **Bun** | Agent Runtime（Sidecar、Plugin Bridge） | `src-tauri/binaries/bun-*` |
| **Node.js** | MCP Server（npx）、社区 npm 包、AI Bash 中的 node/npm | `src-tauri/resources/nodejs/` |

**分层原则**：Bun 跑我们自己的代码（启动快、行为可控），Node.js 跑社区生态代码（MCP Server / npm 包）。

## 开发脚本

### macOS

| 脚本 | 用途 |
|------|------|
| `setup.sh` | 首次环境初始化 |
| `start_dev.sh` | 浏览器开发模式 |
| `build_dev.sh` | Debug 构建 (含 DevTools) |
| `build_macos.sh` | 生产 DMG 构建 |
| `publish_release.sh` | 发布到 R2 |

### Windows

| 脚本 | 用途 |
|------|------|
| `setup_windows.ps1` | 首次环境初始化 |
| `build_windows.ps1` | 生产构建 (NSIS + 便携版) |
| `publish_windows.ps1` | 发布到 R2 |

详见 [Windows 构建指南](../guides/windows_build_guide.md)。

## 深度文档索引

| 文档 | 内容 |
|------|------|
| [CLI 架构](./cli_architecture.md) | 自配置 CLI 设计、版本门控、Admin API、PATH 注入 |
| [IM 集成技术架构](./im_integration_architecture.md) | Agent/Channel 详细设计、适配器模型 |
| [Plugin Bridge 架构](./plugin_bridge_architecture.md) | OpenClaw 插件加载、SDK shim、消息流转、QR 登录 |
| [Session ID 架构](./session_id_architecture.md) | Session 生命周期、ID 格式 |
| [React 稳定性规范](./react_stability_rules.md) | Context/useEffect/memo 等 5 条规则 |
| [代理配置](./proxy_config.md) | 系统代理 + SOCKS5 桥接 |
| [统一日志](./unified_logging.md) | 日志格式、来源、排查指南 |
| [三方供应商](./third_party_providers.md) | 环境变量、认证模式、Bridge 原理 |
| [Windows 平台适配](./windows_platform_guide.md) | PATH 问题、控制台窗口、npm 兼容 |
| [设计系统](../guides/design_guide.md) | Token/组件/页面规范 |
