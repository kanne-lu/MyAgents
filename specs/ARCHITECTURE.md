# MyAgents 技术架构

> 最后更新：v0.1.69 (2026-04-23)

## 概述

MyAgents 是基于 Tauri v2 的桌面应用，提供 Claude Agent SDK 的图形界面。支持多 Tab 对话、IM Bot（Telegram/钉钉/社区插件）、定时任务、MCP 工具集成、多 Agent Runtime（Claude Code CLI / Codex CLI / Gemini CLI）、任务中心（想法速记 + 任务编辑 + 调度 + 状态机审计）。

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React 19 + TypeScript + Vite + TailwindCSS |
| 桌面框架 | Tauri v2 (Rust) |
| 后端 | Node.js v24 + TypeScript (多实例 Sidecar 进程) |
| AI | Anthropic Claude Agent SDK 0.2.111 |
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
│   │ OpenAI     │  ← 三方供应商                              (Node→社区)│
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

**Node.js SSE Server** (`src/server/sse.ts`) — 管理 SSE 客户端连接、heartbeat、事件广播：

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
| Rust CLI 入口 | `cli.rs` | 检测 CLI 模式，不启动 GUI，spawn bundled Node.js 执行 `myagents.js`（esbuild 产物） |
| CLI 脚本 | `src/cli/myagents.ts` | 参数解析 → HTTP 转发到 `/api/admin/*` → 输出格式化 |
| 版本门控同步 | `commands.rs` (`cmd_sync_cli`, `CLI_VERSION`) | 应用启动时拷贝脚本到 `~/.myagents/bin/myagents` |
| Admin API | `admin-api.ts` | 业务逻辑：写 config → 更新内存 → SSE 广播 |
| PATH 注入 | `agent-session.ts` (`buildClaudeSessionEnv`) | `~/.myagents/bin` 加入 SDK 子进程 PATH |

**为什么放在 `~/.myagents/bin/` 而非 app bundle**：SDK 子进程 PATH 不含 app bundle 内部路径；shebang 执行需要可执行权限和去掉 `.ts` 后缀；`~/.myagents/bin/` 是跨平台稳定的工具投放点。

**Rust Management API (v0.1.69)**：CLI / 前端 / Node.js 内部工具三条入口都需要 CRUD 定时任务、任务、想法这类**直接持久化在 Rust 的状态**。为避免每条入口都经前端 IPC 再转 Node 再转 Rust，`src-tauri/src/management_api.rs` 在 app 启动时监听 `127.0.0.1:${随机端口}`（axum）直接暴露 HTTP 路由：

| 前缀 | 职责 | 典型调用方 |
|------|------|-----------|
| `/api/cron/*`（9 条） | CronTask CRUD + 调度控制 | CLI（`myagents cron`）、Node.js `im-cron-tool.ts` |
| `/api/task/*`（13 条） | Task Center 任务 CRUD + run/rerun + doc 读写 | CLI（`myagents task`）、Node.js `admin-api.ts` |
| `/api/thought/*`（2 条） | 想法 create / list | CLI（`myagents thought`）、Node.js `admin-api.ts` |
| `/api/im/*` + `/api/im-bridge/*` | IM Bot 唤醒 + 媒体下发 + Plugin Bridge 回调 | Node.js / 社区插件 Bridge |
| `/api/plugin/*`（3 条） | OpenClaw 插件 CRUD | CLI |
| `/api/agent/runtime-status` | Agent 运行时状态查询 | Node.js / 前端 |

端口号通过 `MYAGENTS_MANAGEMENT_PORT` 环境变量注入到 Node.js Sidecar 进程。这是项目内**唯一**的"Node → Rust"反向 HTTP 通道，规避了"所有前端 HTTP 走 Rust proxy → Node"这条主流向对后端间通信的不适配。所有客户端必须走 `crate::local_http::builder()`（loopback，但仍复用 no_proxy 保护）。

详见 [CLI 架构](./tech_docs/cli_architecture.md)。

### 6. 定时任务系统 (v0.1.42)

**Rust 层**（`src-tauri/src/cron_task.rs`）：
- `CronTaskManager` — 单例，管理任务 CRUD、tokio 调度循环、持久化、崩溃恢复
- 支持三种 `CronSchedule`：`Every { minutes, start_at? }` / `Cron { expr, tz? }` / `At { at }`
- 调度器使用 wall-clock polling（`sleep_until_wallclock`），系统休眠后能正确唤醒
- 持久化：`~/.myagents/cron_tasks.json`（原子写入），执行记录 `~/.myagents/cron_runs/<taskId>.jsonl`

**Node.js 层**（`src/server/tools/im-cron-tool.ts`）：
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
| `BridgeAdapter` | HTTP 双向转发 | OpenClaw 社区插件（飞书/微信/QQ 等），Rust → 独立 Node.js Bridge 进程 |

> 旧版内置飞书适配器（`FeishuAdapter`）已从 UI 隐藏入口，代码保留供向后兼容。新飞书集成通过 OpenClaw 官方插件 `@larksuite/openclaw-lark`。

**Plugin Bridge**（`src/server/plugin-bridge/`）：
- 独立 Node.js 进程加载 OpenClaw Channel Plugin
- **入口解析协议**（v0.2.0+）：`resolveOpenClawPluginEntry()` 按 OpenClaw 上游规范（`openclaw/src/plugins/manifest.ts::resolvePackageExtensionEntries`）读取 `package.json["openclaw"].extensions[]`，**不再**信任 `main` / `exports`。原因：社区插件（如 `@sliverp/qqbot` / `@larksuite/openclaw-lark`）的 `main` 常指向未打包的 `dist/`，只有 `openclaw.extensions` 指向实际分发的入口
- **CJS+ESM 混用插件运行时兼容**：通过 `module.registerHooks()`（Node 22.15+ 同步 loader hook）拦截 `openclaw-plugins/*/node_modules/**` 下所有 `.js` 文件；对含 `import.meta.url` + CJS `exports.X = Y` 的插件（TypeScript 编译器 bug 产物）重写：`fileURLToPath(import.meta.url)` → `__filename`、`import.meta.url` → `pathToFileURL(__filename).href`，并强制 `format: 'commonjs'`。必须用 `registerHooks`（同步）而非 `register`（异步）—— `require()` → `loadESMFromCJS` 走主线程同步路径，异步钩子捕获不到
- **始终注入 `--import tsx/esm`**（dev 和 prod 都要）：插件入口常为 `.ts`（qqbot / weixin），Node 拒绝 strip types on node_modules；tsx 对已编译 `.js` 是 no-op，没有副作用
- SDK Shim（`sdk-shim/`）提供 `openclaw/plugin-sdk/*` 兼容层（v2026.4.24+，**全 ESM**），**全量覆盖** OpenClaw 所有 265+ 子路径导出
  - 27 个手写模块（`_handwritten.json` 清单保护）：提供 Bridge 模式下的真实逻辑
  - 238 个自动生成 stub（`scripts/generate-sdk-shims.ts`）：命名导出 + 首次调用警告，防止 `Cannot find module` 崩溃
  - 更新流程：`npm run generate:sdk-shims`（读取 `../openclaw/src/plugin-sdk` 源码，跳过手写模块，重新生成 stub）
  - Shim 版本必须 bump 三处同步（`sdk-shim/package.json` / `compat-runtime.ts` / `bridge.rs::SHIM_COMPAT_VERSION`），否则用户端 shim 不会更新
- 安装流程：`npm install` → `install_sdk_shim`（最后写入，last-write-wins）→ bridge 启动前 shim 完整性检查
- 消息通过 HTTP 双向转发，AI 推理仍走 Rust → Node.js Sidecar 标准管道

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

### 9. Multi-Agent Runtime (v0.1.60 / v0.1.66 / v0.1.69)

除内置 Claude Agent SDK（builtin）外，支持 Claude Code CLI、OpenAI Codex CLI、Google Gemini CLI 作为外部 Runtime。功能门控：`config.multiAgentRuntime`（默认关闭，设置 → 关于 → 实验室）。

**抽象层**（`src/server/runtimes/`）：

| 文件 | 职责 |
|------|------|
| `types.ts` | `AgentRuntime` 接口 + `UnifiedEvent` 联合类型 |
| `factory.ts` | Runtime 工厂，`getCurrentRuntimeType()` 读 `MYAGENTS_RUNTIME` 环境变量 |
| `claude-code.ts` | CC Runtime：NDJSON over stdio，`-p` 模式（每轮退出，`--resume` 续接） |
| `codex.ts` | Codex Runtime：JSON-RPC 2.0 over stdio，`app-server` 持久进程,thread/turn 模型 |
| `gemini.ts` | Gemini Runtime(v0.1.66):Agent Client Protocol(ACP)JSON-RPC 2.0 over stdio,`gemini --acp` 持久进程,`session/new` / `session/prompt` / `session/set_mode`;系统提示通过 `GEMINI_SYSTEM_MD` 环境变量 + 合并后的 tmp 文件注入(MyAgents 三层 + Gemini 官方 prompt 基底) |
| `external-session.ts` | 统一会话管理：内容块持久化、配置变更、并发守卫、看门狗、Token 用量、stale text 防护 |

**门控链路**：Rust `sidecar.rs` 在启动 Sidecar 时读取 `config.multiAgentRuntime` + `agent.runtime` → 注入 `MYAGENTS_RUNTIME` 环境变量 → Node.js `factory.ts` 读取 → `shouldUseExternalRuntime()` 分流请求到 `external-session.ts`。前端 `Chat.tsx` 用同样的门控决定 `currentRuntime`，源头门控确保所有下游派生自动安全。

**跨 Runtime Session 保护**：用户关闭功能后打开外部 Runtime 历史 session → `initializeAgent` 检测 `meta.runtime !== 'builtin'` → 跳过 SDK resume（防止 "No conversation found" 崩溃）→ 前端弹确认框引导新开会话。

详见 [Multi-Agent Runtime 架构](./tech_docs/multi_agent_runtime.md)。

### 10. Session 切换与持久化

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

**分层 Config Snapshot (v0.1.69)**：Session 创建时按 Owner 类型选择 config 快照策略，决定后续 config 变更是否穿透到已开 session：

| Owner 类型 | Snapshot helper | 策略 | 行为 |
|-----------|----------------|------|------|
| Tab / Cron / Background | `snapshotForOwnedSession(agent)` | 冻结 | Session 创建时把 `model / permissionMode / mcpEnabledServers / providerId / providerEnvJson / runtime` 一次性写入 metadata，后续 Agent 配置变更**不影响**已开 session |
| IM / Agent Channel | `snapshotForImSession(agent)` | 跟随 | 只记录 `runtime`（runtime drift 触发 session fork），model/permission/MCP 每次消息都实时从 `agent + channel.overrides` 重新 resolve |

两个 helper 是独立的命名函数（**不是**布尔参数分派）——任何新增字段都必须在两处显式处理，无法"忘记"。读侧通过 `resolveSessionConfig(sessionMeta, ownerKind)`（`src/server/utils/resolve-session-config.ts`）统一消费：owned session 走 meta 冻结值，IM session 走 live agent；meta 缺失时 fallback 到 agent config，向后兼容老 session。

Snapshot helper + resolve 层的入口分别在 `agent-session.ts:enqueueUserMessage`（builtin runtime）和 `external-session.ts:registerSessionMetadataIfNew`（外部 runtime），两处都按 `InteractionScenario.type` 分派。

### 11. 内嵌终端 (`src-tauri/src/terminal.rs` + `src/renderer/components/TerminalPanel.tsx`) (v0.1.57)

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

**环境注入**（`inject_terminal_env`）：PATH（内置 Node.js + `~/.myagents/bin`）、`MYAGENTS_PORT`（当前 session sidecar 端口）、`TERM=xterm-256color`、`COLORTERM=truecolor`、`NO_PROXY`（localhost 保护）。Shell 以 login shell（`-l`）启动。

**主题**: 日间/夜间双主题自动切换，MutationObserver 监听 `<html>.dark`（同 Monaco 模式）。

**与 Pit-of-Success 模块关系**：不走 `process_cmd`（`portable-pty` 自管进程创建）、不走 `local_http`（不发 HTTP）、复用 `proxy_config` 常量和函数、使用 `system_binary::find()` 检测 Windows Shell。

### 12. 内嵌浏览器 (`src-tauri/src/browser.rs` + `src/renderer/components/BrowserPanel.tsx`) (v0.1.58)

Chat 分屏右侧面板中的 URL 预览器，与文件预览、终端并列为第三个分屏视图。AI 消息中的外部链接和 AI 生成的 HTML 文件优先在此打开。

**架构**：

```
用户点击 Markdown 链接 → BrowserPanelContext.openUrl(url)
  → invoke('cmd_browser_create', { tabId, url, x, y, w, h })
  → Tauri Window::add_child(WebviewBuilder::new(label, External(url)))
  → 原生 OS Webview 渲染（macOS: WKWebView / Windows: WebView2）

URL 变化 → emit('browser:url-changed:{tabId}') → 前端更新地址栏
页面加载 → emit('browser:loading:{tabId}') → 前端更新 loading 状态
```

- **Rust**: `BrowserManager` 管理 `HashMap<String, BrowserSession>`，per-tab 生命周期
- **前端**: `BrowserPanel.tsx` 导航工具栏（◀ ▶ ↻ ↗）+ 占位容器 + ResizeObserver 坐标同步
- **通信**: Tauri IPC（invoke + event），不走 SSE Proxy
- **入口**: Markdown 链接点击（`BrowserPanelContext`）、HTML 文件预览
- **安全**: URL scheme 限制为 `http://` `https://`，Capability 隔离（`browser.json` 零权限）

**依赖说明**：需要 Tauri `"unstable"` feature flag（`Window::add_child()` 多 Webview API）。该 API 尚未承诺稳定时间表，但 `browser.rs` 模块隔离良好，Tauri 升级时迁移成本可控。

**生命周期**：

| 事件 | 行为 |
|------|------|
| 首次 `openUrl(url)` | 创建子 Webview → `browserAlive=true` → 切换到 browser 视图 |
| 再次 `openUrl(newUrl)` | 复用 Webview → `cmd_browser_navigate(newUrl)` |
| 关闭浏览器 Tab（×） | `cmd_browser_close` → 销毁 Webview（关闭即销毁，不后台保活） |
| 切换到其他分屏视图 | `cmd_browser_hide`（不销毁，保留页面状态） |
| 切换回浏览器视图 | `cmd_browser_show` + 坐标同步 |
| Overlay/Modal 弹出 | `closeLayer` 注册表检测 → 自动 hide |
| 拖拽分屏 divider | hide + 毛玻璃占位 → 松手 resize + show |
| Tab 关闭 / App 退出 | `cmd_browser_close` / `close_all_browsers()` |

**Cookie 持久化**：同 App 内所有 Webview 共享 Cookie Store，默认持久化到磁盘。一处登录 → 处处可用 → 重启保持。

**Overlay 遮挡处理**：原生 Webview 浮在 React DOM 之上（OS 层级），需在 Overlay 出现时 hide。使用 `closeLayer` 注册表的 `hasOverlayLayer()` 检测（零 DOM 遍历），通过 `useBrowserOverlayGuard` hook 驱动 BrowserPanel 的 show/hide 效果。

**与终端面板的差异**：终端在 React DOM 内渲染（xterm.js），不需要坐标同步和 Overlay 协调；浏览器是原生 OS 视图，需要 ResizeObserver 手动同步坐标、Overlay 检测自动 hide/show、拖拽时毛玻璃遮罩。

**与 Pit-of-Success 模块关系**：不走 `process_cmd`（Tauri API 创建 Webview）、不走 `local_http`（Webview 自行发起网络请求）、Webview 自动继承系统代理。

### 13. 层级关闭系统 (`src/renderer/utils/closeLayer.ts`) (v0.1.58)

Cmd+W 层级关闭：Overlay → 分屏面板 → Tab，高 z-index 优先。

- **注册表**: 模块级 `layers[]` 数组，每个 Overlay/面板 mount 时 `registerCloseLayer(handler, zIndex)`，unmount 自动 deregister
- **优先级**: 以组件 CSS z-index 为排序依据（z-300 ConfirmDialog > z-200 WorkspaceConfigPanel > z-0 分屏面板）
- **同级 LIFO**: 相同 z-index 按注册顺序后进先出（最新 mount 的先关闭）
- **Hook**: `useCloseLayer(handler, zIndex)` — 一行集成，`handlerRef` 模式防止闭包过期
- **App 集成**: `App.tsx` 的 Cmd+W handler：`if (!dismissTopmost()) closeCurrentTab()`
- **浏览器联动**: `hasOverlayLayer()` 导出给 `useBrowserOverlayGuard`，当有 z-index > 0 的注册层时自动隐藏原生 Webview

### 14. 全文搜索引擎 (`src-tauri/src/search/` + `src/renderer/components/search/`) (v0.1.65)

基于 Tantivy + tantivy-jieba 的 Rust 层搜索子系统。`SearchEngine` 作为 Tauri managed state 单例，与 `SidecarManager` / `CronTaskManager` 同层，为两类查询提供全文检索：Session 历史（跨工作区）与工作区文件内容。

**仅 Tauri 可用**：前端通过 `invoke('cmd_search_*')` 直接调 Rust，不经 Node.js Sidecar。浏览器开发模式不提供 fallback — UI 入口按 Tauri 环境守卫。

**关键设计**：

| 项 | 说明 |
|----|------|
| **Session 索引** | 单一全局索引 `~/.myagents/search_index/sessions/`，启动时全量重建，之后由文件系统 watcher 增量维护 |
| **Session watcher** | `notify-debouncer-full` 5s 滑动去抖观察 `~/.myagents/sessions/`，**任何**写入者（Sidecar/CLI/迁移）的变更都自动流入索引 — pit-of-success 模式 |
| **初始化时序** | `tauri::async_runtime::spawn`（不能用 `tokio::spawn`）→ `index_all_sessions` → watcher 启动。watcher MUST 在全量索引后启动，否则首个 tick 会把所有已索引 session 当新增再 reindex 一遍 |
| **读写并发** | `Arc<SessionIndex>`（无外层 mutex），读路径 lock-free，写路径 `StdMutex<IndexWriter>`。用户搜索永远不被后台索引阻塞 |
| **文件索引** | `FileIndexManager` 按工作区懒加载。冷路径全量扫描，热路径 `(rel_path → mtime_ms/size)` diff 只 re-index 变更文件。进入文件搜索模式时调 `cmd_refresh_workspace_index` |
| **工作区目录命名** | FNV-1a 64-bit 稳定哈希（**禁止** `DefaultHasher`，无稳定性保证会静默孤立历史索引） |
| **中文分词** | `tantivy-jieba`（~37 万词词典），字段 MUST 显式引用 `"chinese"` tokenizer；**禁止**裸 `TEXT`（默认英文分词器会把中文切单字然后丢失） |
| **Schema 版本门控** | `SCHEMA_VERSION` + `.schema_version` 磁盘 marker，不一致时自动删除重建。修改任意 schema 字段/分词器时 MUST bump |
| **高亮传输** | Rust 用 `util::byte_to_utf16` 把 UTF-8 字节 offset 转成 UTF-16 code unit offset，前端 `SearchHighlight.tsx` 用 `String.slice()` 直接消费 `[start, end][]`，零 `dangerouslySetInnerHTML` |
| **Char boundary 安全** | snippet 构建通过 `util::floor/ceil_char_boundary` 夹紧到 codepoint 边界，防止中文/emoji 字节切片 panic |

**与 Pit-of-Success 模块的关系**：搜索子系统不发 HTTP、不启动子进程、无 outbound 网络，与 `local_http` / `process_cmd` / `proxy_config` 均无交集。但 session watcher 自身就是第四个 pit-of-success 典范 — 把"每个 writer 都必须记得通知索引"替换成"观察结果目录"。

详见 [全文搜索架构](./tech_docs/search_architecture.md)。

### 15. Skill URL 安装 (`src/server/skills/`) (v0.1.66)

支持从 GitHub 链接、`npx skills add` 命令或直连 zip 一键把社区 skill 装到 `~/.myagents/skills/`（或当前工作区 `.claude/skills/`）。

**三段流水线**：

```
用户输入（任意形式）
    ▼
url-resolver.ts      — 宽容解析 → { owner, repo, ref?, subPath?, skillName? }
    ▼
tarball-fetcher.ts   — codeload.github.com 下载 zip → 内存解包 + 安全限额
    ▼
installer.ts         — 扫描 SKILL.md / marketplace.json → 生成 InstallAnalysis
    ▼
/api/skill/install-from-url — 复用 /api/skill/upload 的 Zip-Slip 写盘路径
```

**关键设计**：

| 项 | 说明 |
|----|------|
| **统一归一** | URL / owner/repo / `npx skills add ...` 整条命令 / tree 子路径 / `@skill` 后缀 / `--skill` flag 全部归一为同一个 `ResolvedSkillSource` 结构 |
| **默认分支回退** | 未指定 ref 时先试 `refs/heads/main`，404 回退 `refs/heads/master` |
| **代理透明** | Node.js 原生 `fetch()`（undici）自动继承 `proxy_config` 注入的 `HTTP_PROXY` / `NO_PROXY`；无需本模块感知代理 |
| **marketplace.json 感知** | 检测到 `.claude-plugin/marketplace.json` 时返回 plugin 合集预览，让前端 / CLI 选一个 plugin（UI 文案：**"Claude Plugins 插件"**） |
| **两步交互** | 无歧义（单 skill 无冲突）→ 直接落盘；有 marketplace / 多 skill / 冲突 → 返回 preview 让前端二次确认，由前端携带 `confirmedSelection` 再发一次（服务器再次 fetch — 设计权衡是简单 > 状态缓存） |
| **安全限额** | tarball ≤ 50MB、单文件 ≤ 5MB、文件总数 ≤ 2000、超时 60s、Zip-Slip 防御（复用 `/api/skill/upload` 的 `fullPath.startsWith(skillDir + sep)` 守卫） |
| **落盘后复用** | 成功写入后调 `bumpSkillsGeneration()` + `syncProjectUserConfig()` + `markSkillsSynced()`，Tab Sidecar 下次请求 skills 时自动同步，与 `/api/skill/upload` 一致 |

**不支持**（MVP 明确拒绝，不是遗漏）：GitLab、私有仓库、git SSH URL、搜索集成（`skill find`）、市场订阅持久化、`skill update`、跨 IDE symlink 同步、npm spec 形态的 skill 包。

**CLI 与 Admin API**：`myagents skill list/info/add/remove/enable/disable/sync` 通过 `/api/admin/skill/*` 薄包装转发到本模块。小助理（MA helper）通过 `self-config` skill 调用 CLI，用户说"帮我装个 foo/bar 的 skill"时助理**直接执行**而非输出步骤。

详见 [Skill URL 安装指南](./guides/skill_marketplace.md)。

### 16. 任务中心 (`src-tauri/src/task.rs` + `src-tauri/src/thought.rs` + `src/renderer/components/task-center/`) (v0.1.69)

Task Center 是 v0.1.69 的主线特性 —— 把"想法速记 → 对齐 → 派发 → 执行 → 验收 → 审计"的完整工作流提升为一等公民。数据层全部在 Rust，前端按卡片/列表双视图呈现，AI 和用户共享同一套 CLI 操作闭环。

**两个持久化 Store**（均存于 `~/.myagents/` 用户目录）：

| Store | 文件 | 模块 |
|-------|------|------|
| `ThoughtStore` | `~/.myagents/thoughts/<YYYY-MM>/<id>.md`（按月分目录的 Markdown + 头部 YAML frontmatter） | `thought.rs` |
| `TaskStore` | `~/.myagents/tasks.jsonl`（元数据行）+ `~/.myagents/tasks/<id>/{task.md,verify.md,progress.md,alignment/…}`（AI 工作区） | `task.rs` |

**写盘原子性**：两个 Store 均走 `write_atomic_text` —— tmp 文件写入 + `sync_all` + `rename` + 父目录 fsync。TaskStore 的 `create_direct` / `create_migrated` **先写 task.md 再提交 JSONL**（cross-review C3 修复）：JSONL 失败时 best-effort 清理 docs 目录，orphan 目录无害；反序则会残留"有 JSONL 行无 task.md"的鬼任务。

**路径穿越防御**：`validate_safe_id(value, label)` 在每个 task_id / thought_id / alignmentSessionId 入口拦截 `..`、分隔符、`\0`、Windows 保留名（CON/PRN/COM1-9 等）、非 ASCII 字符，再叠加 `task_docs_dir()` 的 `resolved.starts_with(&base)` 双保险。

**状态机 + 审计链**：
- Task 状态：`Todo → Running → Verifying ↔ Done` + `Blocked / Stopped / Archived / Deleted`
- 每次 `update_status` 都原子写入 `statusHistory: StatusTransition[]`（`{from, to, at, actor, source, message}`）并 append 到 `progress.md`
- 广播 Tauri event `task:status-changed`（非 SSE，前端 `listen()` 直接消费）让所有打开的任务中心 Tab 实时同步
- 崩溃恢复把遗留 `running / verifying` 迁到 `blocked` 并记入 statusHistory
- 软删（`deleted = true`）也写审计 `→ deleted` 伪状态，真删只在 archive 后可选

**Task ↔ CronTask 反向指针（执行闭环）**：Task 不自己跑，而是登记一条 `CronTask { task_id: Some(<taskId>) }`。调度器 tick 时检查 `task_id` → 回调 `task::build_dispatch_prompt()` **动态**构造首条消息（`direct` → "执行任务：<task.md>"；`ai-aligned` → `/task-implement`）。用户中途编辑 task.md，下一次执行立即生效 —— 不需要手动同步 Prompt，也不会跑半新半旧。

**AI 讨论路径（想法 → 正式任务）**：
1. 用户点想法卡「AI 讨论」→ 打开新 Chat Tab + 注入 `task-alignment` Skill
2. AI 完成 alignment → 四份文档（alignment.md / task.md / verify.md / progress.md）存于 `~/.myagents/tasks/<alignmentSessionId>/alignment/`
3. AI 调 `myagents task create-from-alignment <alignmentSessionId> --name <name>` → `TaskStore::create_from_alignment` 事务化迁移：JSONL 先写 → 原 alignment 目录 rename 到 `~/.myagents/tasks/<newTaskId>/` → 失败时 JSONL rollback
4. `dispatchOrigin = 'ai-aligned'`，后续走 `/task-implement` 模板

**Legacy Cron 升级 (`legacy_upgrade.rs`)**：v0.1.69 之前的独立 CronTask 在首次加载时被检测为 "legacy"，自动升级成带 Task 的结构：
- 幂等：`set_task_id(cron_id, new_task_id, require_null=true)` CAS，已升级过的 cron 会被 short-circuit 跳过
- Rollback：Task 创建成功但 CAS 失败 → 回滚 Task；CAS 成功后 Rename 失败 → CAS 回滚 + Task 删除
- 状态保留：running cron → Running task、已自然结束 → Done、用户手动停的 → Stopped，audit 记 `actor=System, source=Migration`

**前端布局**：`src/renderer/components/task-center/` 32 个组件。左栏 `ThoughtPanel`（速记流），右栏 `TaskListPanel`（进行中 / 规划中 / 已完成三段 + 卡片 / 列表 ViewToggle）。详情 Overlay (`TaskDetailOverlay` / `TaskEditPanel`) 包含名称、描述、Prompt、执行模式、per-task Runtime/Model/PermissionMode 覆盖、结束条件、通知订阅、运行统计、status history、关联 session 列表。

**全文搜索**：`search/mod.rs` 新增 `search_thoughts` / `search_tasks` 方法。v1 规模用内存线性扫描（<10k 条），Thought 遍历 ThoughtStore，Task 遍历 TaskStore 并按需读 `~/.myagents/tasks/<id>/task.md` 全文。超过规模再切 Tantivy，schema 接口已留好。

**CLI**：`myagents task list/get/run/rerun/update-status/update-progress/append-session/archive/delete/create-direct/create-from-alignment` + `myagents thought list/create`。`actor/source` 由运行环境自动识别：`MYAGENTS_PORT` 存在 → AI 子进程（`agent/cli`），否则用户终端（`user/cli`）；UI 路径由 Tauri 层强制 `user/ui`。三条入口互不伪造，审计链可溯。

详见 [Task Center PRD](./prd/prd_0.1.69_task_center.md) 与 [Session Config Snapshot PRD](./prd/prd_0.1.69_session_config_snapshot.md)。

### 17. Sidecar 冷启动性能架构 (v0.2.0+)

多轮性能优化后的 Sidecar 冷启动路径，Tab 打开端到端从 5-7s 降到 ~2-3s。核心思路：**listen 尽快 → 重活延后 → MCP 按需**。

**Rust 侧启动时序**（`src-tauri/src/sidecar.rs`）：
- TCP health check 指数退避 50→500ms（前 5 次累计 1.25s 覆盖常见冷启动窗口），代替固定 500ms 轮询
- 删除了 `spawn` 后的 50ms guard sleep — `try_wait()` 本就非阻塞，crash 检测已由 health loop 的 alive_check（每 20 次）承担

**Node Sidecar `main()` 重排序**（`src/server/index.ts`）：
- listen 前只做极轻量操作：`ensureAgentDir` / `initLogger` / `setSidecarPort` / `createBridgeHandler`
- `honoServe` 立即绑定 127.0.0.1:port → Rust health check 几十 ms 就通过
- listen 后由 IIFE 跑重活：migration / skill seed / agent-browser wrapper / socks bridge / `initializeAgent` / external runtime restore / boot banner
- `globalThis.__myagentsDeferredInit` 作为路由级 readiness gate：除 `/health` 外所有 route 在处理前 `await` 它；稳定态下是亚微秒 no-op
- **`warmupShellPath()`**：interactive `zsh -i -l` 的 PATH 检测从同步 `execSync` 改成异步 `execFile`，防止阻塞事件循环 → starve TCP accept

**Tab fast-path**：`initializeAgent` 对 Tab session 传 `resolveWorkspaceConfig(..., { includeMcp: false })` 跳过 MCP 磁盘扫描（Tab 的 MCP 由前端 `/api/mcp/set` 下发，self-resolve 白做且会触发 fingerprint 差异 → 30s 重启循环）。`getSessionMetadata` 从 3 次合并成 1 次 memo。

**Tier 2 懒加载**：
- `admin-api`（~2900 行，40+ handler）、`openai-bridge`（2664 行）、`adm-zip` 改为 `await import()` 懒加载，只在用户真正点 Settings / 用 OpenAI 兼容 provider / 上传 zip skill 时才 parse
- **Builtin MCP 懒加载架构**（见 CLAUDE.md 对应节）：6 个 in-process MCP（cron-tools / im-cron / im-media / generative-ui / gemini-image / edge-tts）通过 `src/server/tools/builtin-mcp-meta.ts` 集中登记 META，运行时按需 `getBuiltinMcpInstance(id)` 加载。首次加载付 100-400ms（SDK + zod），后续 0ms 缓存；失败自动 evict 防 poisoned cache。ESLint `@typescript-eslint/no-restricted-imports` 规则（作用域 `src/server/tools/*.ts`）结构性禁止顶层 value-import SDK/zod
- Settings UI 的 MCP 列表从**静态** `PRESET_MCP_SERVERS`（`src/renderer/config/types.ts`）读取 —— 与运行时 META 解耦，禁用某个 builtin 后连 META 本身都不加载

**实测数据**（不含 Node 本身冷启动 ~1.5s）：
- META 注册总耗时: ~0ms（只存函数引用）
- 首次 cron-tools factory: ~124ms（SDK+zod+schema 一次性）
- 再次同 MCP: 0ms（命中缓存）
- 其他 MCP（SDK 已缓存）: ~10ms（纯 zod schema 构造）

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

这五个模块构成"正确路径默认化"体系，消除 AI/新手反复踩的隐蔽陷阱：

| 模块 | 层 | 用途 | 防止的问题 |
|------|----|----|-----------|
| `local_http` (`src-tauri/src/local_http.rs`) | Rust | 所有连接 localhost 的 reqwest 客户端 | 系统代理拦截 localhost → 502 |
| `process_cmd` (`src-tauri/src/process_cmd.rs`) | Rust | 所有 Rust 层子进程创建 | Windows GUI 弹黑色控制台窗口 |
| `proxy_config` (`src-tauri/src/proxy_config.rs`) | Rust | 子进程代理环境变量注入 | Node.js `fetch()` 读取继承的 HTTP_PROXY → localhost 通信被代理拦截 |
| `system_binary` (`src-tauri/src/system_binary.rs`) | Rust | 系统工具查找（pgrep/taskkill 等） | Tauri GUI 从 Finder 启动不继承 shell PATH |
| `fs-utils` (`src/server/utils/fs-utils.ts`, v0.1.69+) | Node.js | 目录创建 + 目录判定 helper（`ensureDirSync` / `ensureDir` / `isDirEntry`）。v0.1.69 引入时处理的 ① Bun-on-Windows `mkdirSync` EEXIST bug 在 v0.2.0 切 Node 后已消除；② `Dirent.isDirectory()` 在 Windows junction / POSIX symlink-to-dir 上返回 false 的坑仍在 Node 下存在，helper 继续兜底 | — |
| `subprocess` (`src/server/utils/subprocess.ts`, v0.2.0+) | Node.js | `Bun.spawn` 兼容 adapter：`exited` Promise 在 `'close'` 而非 `'exit'`（stdio 已 drain）、stdin.write 用 Node callback 驱动避免背压 hang、保留 spawn error、cached Readable.toWeb stream；配套 `fireAndForget()` helper（open/explorer/xdg-open 等一次性 spawn） | callers 从 Bun API 平移到 Node 时不用每处重写 stream-shape 差异 |
| `file-response` (`src/server/utils/file-response.ts`, v0.2.0+) | Node.js | `new Response(Bun.file(p))` 替代：`fileResponse(p, {contentType})` 用 `createReadStream + Readable.toWeb` 生成流式 Web Response；`sniffMime(path)` ext→MIME 映射 | HTTP 路由返回文件内容时不用各自内联 `fs.readFile + new Response` |

第六个典范是 v0.1.65 的 **Session watcher**（`search/session_watcher.rs`）—— 把"每个 writer 都必须通知索引"替换成"文件系统观察结果目录"。其它 pit-of-success 应用：`session-snapshot.ts` 的两个命名 helper（`snapshotForImSession` / `snapshotForOwnedSession`）用类型分裂代替布尔参数（v0.1.69）、`legacy_upgrade.rs` 用 CAS `set_task_id(require_null=true)` 避免并发升级竞态（v0.1.69）、`fs-utils::isDirEntry` 把"每个扫目录的 Dirent 检查都要手写 junction fallback"合并到一个 helper（v0.1.70+）。

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
| 浏览器打开 | `cmd_browser_create(tabId, url, x, y, width, height)` |
| 浏览器关闭 / Tab 关闭 | `cmd_browser_close(tabId)` |
| 任务立即执行 / 重新派发 | `task::run` → 登记 `CronTask { task_id }` + 触发调度；执行完成后 CronTask 自然结束 |
| Task 软删除 | `TaskStore::delete` → 写 `→ deleted` 伪状态 + 联动清理 `thought.convertedTaskIds` |
| 应用退出 | `stopAllSidecars()` + `close_all_terminals()` + `close_all_browsers()`，清理全部进程 |

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
| node-out 去重 | Node logger 初始化后停止 stdout 捕获 | `sidecar.rs` |

### 统一日志格式

三个来源汇入 `~/.myagents/logs/unified-{YYYY-MM-DD}.log`（本地时间）：
- **[REACT]** — 前端日志
- **[NODE]** — Node.js Sidecar 日志（logger interceptor 直写）
- **[RUST]** — Rust 层日志（含启动阶段的 `[bun-out]` 和始终捕获的 `[bun-err]`）

## 安全设计

- **FS 权限**: 仅允许 `~/.myagents` 配置目录
- **Agent 目录验证**: 阻止访问系统敏感目录
- **Tauri Capabilities**: 最小权限原则
- **本地绑定**: Sidecar 仅监听 `127.0.0.1`
- **CSP**: `img-src` 允许 `https:`（支持 AI Markdown 图片预览），`connect-src` 和 `fetch-src` 严格锁定
- **代理安全**: `local_http` 模块内置 `.no_proxy()` 防止系统代理拦截 localhost
- **浏览器沙箱**: 内嵌浏览器 Webview 通过 Capability 隔离（`browser.json` 零权限），无法访问 Tauri IPC；URL scheme 限制为 http/https

## 跨平台工具模块 (`src/server/utils/platform.ts`)

统一的跨平台环境变量处理：

| 用途 | macOS/Linux | Windows |
|------|-------------|---------|
| Home 目录 | `HOME` | `USERPROFILE` |
| 用户名 | `USER` | `USERNAME` |
| 临时目录 | `TMPDIR` | `TEMP`/`TMP` |

`buildCrossPlatformEnv()` 自动设置双平台变量，确保子进程兼容。

## 单一运行时策略 (v0.2.0+)

| 运行时 | 用途 | 打包位置 |
|--------|------|---------|
| **Node.js v24**（唯一） | Sidecar + Plugin Bridge + MCP Server + AI Bash `node`/`npx`/`npm` + `myagents` CLI + agent-browser wrapper | `src-tauri/resources/nodejs/` |

**单一 runtime 原则**：所有 MyAgents 自己的代码和所有社区生态代码都跑在 bundled Node.js v24 上。SDK native binary 子进程内部的 Bun runtime（`resources/claude-agent-sdk/claude[.exe]`，SDK team 静态链接）是 SDK 实现细节，我们**不感知、不共享状态**，只通过 stdio NDJSON 通信。v0.1.x 的 Bun + Node.js 双运行时已在 v0.2.0 合并（设计文档：`specs/prd/prd_0.2.0_node_runtime_migration.md` — PRD 目录 gitignore，本地文件；`specs/tech_docs/bundled_node.md` 覆盖实现细节）。

### 预置原生二进制 MCP (v0.1.67+)

除 bundled Node.js 外，少量性能或 OS API 敏感的预置 MCP 以原生二进制形式随 App 分发，通过 Tauri `externalBin` 打包、SDK stdio transport 启动，不依赖 Node.js：

| 二进制 | 用途 | 来源 | 打包位置 |
|--------|------|------|---------|
| **cuse** | 预置 Computer-Use MCP（截图/点击/输入/滚动，仅 macOS/Windows） | `hAcKlyc/MyAgents-Cuse` GitHub Release，构建时 `scripts/download_cuse.sh`（macOS）/`.ps1`（Windows）按 `gh release` 拉取 latest | `src-tauri/binaries/cuse-*-<triple>[.exe]` |

**新增同类二进制时的约定**：
- 注册到 `PRESET_MCP_SERVERS` 时用 `command: '__bundled_xxx__'` 哨兵字符串，解析器放在 `src/server/utils/runtime.ts`，在 `agent-session.ts` / `admin-api.ts` / `index.ts` 三处 MCP 启动/验证分支各加短路分支
- 平台差异（如 cuse 只支持 macOS/Windows）通过 `McpServerDefinition.platforms` + `mcpService.ts` / `admin-config.ts` 的平台过滤器承担，不散布在上游
- `build_macos.sh` 的 `codesign` 循环通配 `src-tauri/binaries/*-apple-darwin`——新二进制只要落在这个目录就自动继承应用签名，TCC 权限（Screen Recording / Accessibility / AppleEvents）通过同 Team ID 的 code signature 自动传递

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

详见 [Windows 构建指南](./guides/windows_build_guide.md)。

## 深度文档索引

| 文档 | 内容 |
|------|------|
| [Node.js 打包架构](./tech_docs/bundled_node.md) | 内置 Node.js v24 + SDK native binary 分发、PATH 注入、native addon ABI rebuild（v0.2.0+，替代原 bundled_bun.md） |
| [CLI 架构](./tech_docs/cli_architecture.md) | 自配置 CLI 设计、版本门控、Admin API、PATH 注入 |
| [IM 集成技术架构](./tech_docs/im_integration_architecture.md) | Agent/Channel 详细设计、适配器模型 |
| [Plugin Bridge 架构](./tech_docs/plugin_bridge_architecture.md) | OpenClaw 插件加载、SDK shim (2026.4.24+ ESM)、入口解析协议 + CJS/ESM 混用插件 runtime 补丁、消息流转、QR 登录 |
| [Session ID 架构](./tech_docs/session_id_architecture.md) | Session 生命周期、ID 格式 |
| [React 稳定性规范](./tech_docs/react_stability_rules.md) | Context/useEffect/memo 等 5 条规则 |
| [代理配置](./tech_docs/proxy_config.md) | 系统代理 + SOCKS5 桥接 |
| [统一日志](./tech_docs/unified_logging.md) | 日志格式、来源、排查指南 |
| [三方供应商](./tech_docs/third_party_providers.md) | 环境变量、认证模式、Bridge 原理 |
| [Windows 平台适配](./tech_docs/windows_platform_guide.md) | PATH 问题、控制台窗口、npm 兼容、bundled Node.js 路径（v0.2.0+） |
| [Linux 平台适配](./tech_docs/linux_platform_guide.md) | AppImage / deb 构建（v0.2.0+） |
| [Multi-Agent Runtime](./tech_docs/multi_agent_runtime.md) | 外部 Runtime 抽象层、CC/Codex/Gemini 协议、会话管理、门控链路 |
| [全文搜索架构](./tech_docs/search_architecture.md) | Tantivy + jieba、session watcher、懒加载文件索引、UTF-16 高亮 |
| [Task Center PRD](./prd/prd_0.1.69_task_center.md) | 任务中心完整设计：数据模型、AI 讨论路径、CronTask 反向指针、状态机、CLI |
| [Session Config Snapshot PRD](./prd/prd_0.1.69_session_config_snapshot.md) | D1-D9 快照策略、owned vs live-follow、resolve 层 |
| [设计系统](./DESIGN.md) | Token/组件/页面规范 |
