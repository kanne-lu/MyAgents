# MyAgents - Desktop AI Agent

基于 Claude Agent SDK 的桌面端通用 Agent 产品。开源项目（Apache-2.0），使用 Conventional Commits，不提交敏感信息。

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面框架 | Tauri v2 (Rust) |
| 前端 | React 19 + TypeScript + Vite + TailwindCSS |
| 后端 | Node.js v24 + Claude Agent SDK (多实例 Sidecar) |
| 通信 | Rust HTTP/SSE Proxy (reqwest via `local_http` 模块) |
| 运行时 | 单一 Node.js v24（Sidecar / Plugin Bridge / MCP Server / CLI），内置于应用包 |

## 项目结构

- `src/renderer/` — React 前端（api/、context/、hooks/、components/、pages/）
- `src/server/` — Node.js 后端 Sidecar（esbuild 打包成 `server-dist.js`，开发态经 `tsx/esm` loader 直跑 TS）
- `src/server/plugin-bridge/` — OpenClaw Plugin Bridge（独立 Node 进程，加载社区 Channel 插件）
- `src/cli/` — 自配置 CLI（`myagents` 命令，同步到 `~/.myagents/bin/`，详见下方说明）
- `src/shared/` — 前后端共享类型
- `src-tauri/` — Tauri Rust 层
- `specs/` — 设计文档（tech_docs/、guides/、prd/、research/）
- `bundled-agents/myagents_helper/` — 内置 MA 小助理（见下方说明）

### 内置 MA 小助理（`bundled-agents/myagents_helper/`）

应用内置了一个 AI 助手（MA 小助理），运行在 `~/.myagents/` 工作区中，职能是产品首席客服 — 帮用户诊断问题、配置工具、管理 Agent。

**核心机制**：小助理通过 `/self-config` Skill 调用内置 `myagents` CLI 工具，**直接执行**用户请求的管理操作（配置 Provider、安装 MCP、管理 Agent Channel、创建定时任务等），而不是输出操作步骤让用户自己做。CLI 通过 Admin API（`/api/admin/*`）与 Rust Management API 通信，能力与 GUI 对等。

**文件结构**：
- `CLAUDE.md` — 小助理的元认知（架构速览、日志格式、错误速查表、诊断工作流）
- `.claude/skills/self-config/SKILL.md` — CLI 操作技能（MCP/Provider/Agent/Cron/Plugin CRUD）
- `.claude/skills/support/SKILL.md` — 用户支持技能（日志分析、Bug Report 生成）

**开发约束**：
- 修改 `bundled-agents/myagents_helper/` 的 CLAUDE.md 或 Skills 后，MUST bump `ADMIN_AGENT_VERSION`（`src-tauri/src/commands.rs`），否则用户端小助理不会更新。
- 修改 `src/cli/myagents.ts` 或 `src/cli/myagents.cmd` 后，MUST bump `CLI_VERSION`（`src-tauri/src/commands.rs`），否则用户端 CLI 不会更新。
- 修改 `bundled-skills/` 中 **system skill**（目前：`task-alignment` / `task-implement`，清单见 `SYSTEM_SKILLS` 常量）后，MUST bump `SYSTEM_SKILLS_VERSION`（`src-tauri/src/commands.rs`），否则用户端 skill 不会强制更新。新增 system skill 时：(1) 放入 `bundled-skills/<name>/`；(2) 把 `<name>` 加到 Rust `SYSTEM_SKILLS` 和 Node `src/server/index.ts::SYSTEM_SKILLS` 两个清单（保持同步）；(3) bump 版本号。三个版本门控独立运作。
- **Utility skill vs system skill 区分**：`bundled-skills/` 里的 skill 分两类 —— **system skill**（清单里的）随版本强制更新，用户自定义会被覆盖；**utility skill**（其它）首次 seed 后就归用户所有，bump 不再动用户副本。新增 skill 默认是 utility；只有和 app 流程强耦合的才升级为 system。

## 开发命令

```bash
npm install                 # 依赖安装（v0.2.0+ 统一 npm，不再使用 Bun）
./start_dev.sh              # 浏览器开发模式 (快速迭代)
npm run tauri:dev           # Tauri 开发模式 (完整桌面体验)
./build_dev.sh              # Debug 构建 (含 DevTools)
./build_macos.sh            # 生产构建
./publish_release.sh        # 发布到 R2
npm run typecheck && npm run lint  # 代码质量检查
```

---

## 核心架构约束

### 第一原则：架构延续性

**每个功能都在已有架构上生长，而不是另起炉灶。** 项目已有成熟的分层设计、通信模式、安全约束和前端规范。新功能 MUST 复用现有模块和模式（如 `local_http`、`process_cmd`、`broadcast()`、`awaitSessionTermination()`），禁止为单点需求发明新的技术方案。

开发前 MUST 做的三件事（这两份文档是项目的全局核心规范，渐进式按需读取）：
1. **读架构文档** @specs/ARCHITECTURE.md — 理解系统分层、模块边界、数据流；从这里再下钻到 `specs/tech_docs/*` 的专题文档
2. **读设计规范** @specs/DESIGN.md — 前端开发 MUST 遵循 Token/组件/页面规范
3. **搜索现有实现** — 先在代码库中搜索类似功能是否已有模式，复用而非重建

如果需求确实需要架构变更（新的通信模式、新的状态管理方式、新的进程类型），MUST 先与用户讨论方案，不得自行引入。对接外部 SDK/插件时，MUST 先读源码确认接口约定（函数签名、config schema、返回值格式），再写适配层。

### Claude Agent SDK 交互规范

项目的核心 AI 运行时是 Claude Agent SDK（`@anthropic-ai/claude-agent-sdk`），所有 Agent 会话、工具调用、子 Agent 派发都通过它驱动。SDK 持续迭代，API 行为、环境变量、消息类型可能随版本变更。

**禁止凭假设编写 SDK 交互代码。** 涉及 SDK 的任何开发（`query()` 参数、`SDKMessage` 类型处理、环境变量设置、Hook 注册、MCP 集成等），MUST 先查阅官方文档确认实际行为：
- **SDK 文档**：https://platform.claude.com/docs/zh-CN/agent-sdk/overview
- **SDK 类型定义**：`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`（当前版本 0.2.111）
- **SDK 工具类型**：`node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts`

典型错误案例：臆测 `seedReadState` 的调用时机导致"先读后改"语义被绕过、臆测环境变量名导致模型别名不生效。这类问题的根因都是没有查文档就动手写代码。

### Tab-scoped 隔离

每个 Chat Tab 拥有独立的 Node.js Sidecar 进程（Tab/CronTask/BackgroundCompletion/Agent 四种 Owner 共享 SidecarManager）。MUST 在 Tab 内使用 `useTabState()` 返回的 `apiGet`/`apiPost`，**禁止**在 Tab 内使用全局 `apiPostJson`/`apiGetJson`（会发到 Global Sidecar）。

### Rust 代理层

所有前端 HTTP/SSE 流量 MUST 通过 Rust 代理层（`invoke` → Rust → reqwest → Node.js Sidecar），**禁止**从 WebView 直接发起 HTTP 请求。

### local_http 模块（致命陷阱）

所有连接本地 Sidecar（`127.0.0.1`）的 reqwest 客户端 MUST 通过 `crate::local_http::builder()` / `blocking_builder()` / `json_client()` / `sse_client()` 创建。内置 `.no_proxy()` 防止系统代理拦截 localhost。**禁止**裸 `reqwest::Client::builder()` 或 `reqwest::Client::new()` 连接 localhost，否则系统代理（Clash/V2Ray）会导致 502。

### process_cmd 模块（Windows 控制台窗口陷阱）

所有 Rust 层子进程 MUST 通过 `crate::process_cmd::new()` 创建，**禁止**裸 `std::process::Command::new()`。内置 Windows `CREATE_NO_WINDOW` 标志，防止 GUI 应用启动子进程（node.exe Sidecar / Plugin Bridge / npm install 等）时弹出黑色控制台窗口。遵循与 `local_http` 相同的 "pit of success" 模式。例外：`#[cfg(windows)]` 守卫内的系统工具命令（taskkill/powershell/wmic）已内联处理；`commands.rs` 的 OS opener（open/explorer/xdg-open）和 Unix pgrep 是用户可见的系统命令，无需隐藏；`terminal.rs` 的 PTY 进程由 `portable-pty` 的 `CommandBuilder` + `slave.spawn_command()` 管理，不走 `std::process::Command`。`cli.rs` 的 Node CLI spawn 也不走 `process_cmd`（CLI 模式 NEEDS 控制台显示 stdout/stderr）。

### proxy_config 子进程代理策略（node fetch 陷阱）

所有可能发起 HTTP 请求的 Rust 层子进程（Node Sidecar、Plugin Bridge、npm install 等）MUST 在 spawn 前调用 `crate::proxy_config::apply_to_subprocess(&mut cmd)`。该函数确保：用户配置代理时注入 `HTTP_PROXY` + `NO_PROXY`；未配置时继承系统网络行为但**始终注入 `NO_PROXY`** 保护 localhost。**禁止**手动 `cmd.env("HTTP_PROXY", ...)` 或 `cmd.env_remove("HTTP_PROXY")`。Node.js 20+ 的 `fetch()`（undici）会读取 `HTTP_PROXY` 环境变量，没有 `NO_PROXY` 的话，Sidecar 内部的 localhost 通信（admin-api、cron-tool、bridge-tools 等）会被系统代理拦截 → 502。

### 零外部依赖与单一运行时（v0.2.0+）

应用内置所有运行时依赖，用户无需自行安装任何东西：

| 依赖 | 用途 | 打包位置 |
|------|------|---------|
| **Node.js v24** | 统一 JS runtime — Sidecar / Plugin Bridge / MCP Server (`npx`) / 社区 npm 包 / `myagents` CLI / AI Bash `node`/`npx`/`npm` | `src-tauri/resources/nodejs/`（含 node + npm + npx） |
| **Claude Agent SDK native binary** | Claude Code 主循环 — SDK 0.2.113+ 以 `bun build --compile` 产物分发，内嵌 SDK team 自己 pin 的 Bun；独立进程，我们不感知 | `src-tauri/resources/claude-agent-sdk/claude[.exe]`（构建时从 `@anthropic-ai/claude-agent-sdk-<triple>` 拷贝） |
| **Git** | SDK 依赖 — Claude Code 需要 `git`（代码操作）+ `bash`（工具执行），Windows 无自带 → NSIS 静默安装 Git for Windows | `src-tauri/nsis/Git-Installer.exe`（仅 Windows） |
| **cuse** (v0.1.67+) | 预置 Computer-Use MCP 原生二进制（截图/点击/输入/滚动，仅 macOS/Windows） | `src-tauri/binaries/cuse-*-<triple>[.exe]`，构建时 `scripts/download_cuse.sh`/`.ps1` 从 `hAcKlyc/MyAgents-Cuse` GitHub Release 拉取 latest |

**单一 runtime 原则**：所有 MyAgents 自己的代码统一跑在 Node.js 上（Sidecar、Plugin Bridge、CLI）。SDK 子进程内部的 runtime 是 SDK 团队的实现细节（静态链接 Bun），通过 stdio NDJSON 与我们通信，我们不感知、不共享状态。原生二进制 MCP（cuse 等）作为独立类，通过 `PRESET_MCP_SERVERS` 的 `command: '__bundled_xxx__'` 哨兵注册、`platforms?:` 字段做平台门控、`build_macos.sh` 的 `src-tauri/binaries/*-apple-darwin` 通配符自动继承应用签名与 TCC 权限。

**PATH 注入**：`buildClaudeSessionEnv()` 构造 SDK 子进程的 PATH，决定 AI Bash 工具能找到哪些命令。优先级：`systemNodeDirs`（用户安装的 Node.js） → `bundledNodeDir` → `~/.myagents/bin` → 系统路径。Node.js 系统优先（用户维护、npm 更可靠），bundled Node 作为 fallback。

**运行时发现**：`src/server/utils/runtime.ts` 提供 `getBundledNodePath()`（Node.js）。

**SDK native binary resolver**：`src/server/agent-session.ts::resolveClaudeCodeCli()` 按 platform triple 定位 `claude[.exe]`，支持 glibc/musl Linux 检测（via `process.report.getReport().header.glibcVersionRuntime`）。生产优先用 `<resources>/claude-agent-sdk/claude`，开发 fallback 到 `node_modules/@anthropic-ai/claude-agent-sdk-<triple>/claude`。

**历史背景**：v0.1.x 采用 Bun + Node.js 双运行时策略（Bun 跑 Sidecar、Node.js 跑 MCP 生态）。v0.2.0 统一到 Node.js — 动因：SDK 0.2.113+ 放弃 cli.js 改用 native binary 后，"Bun 跑 cli.js" 职能消失，剩下的 Sidecar/Bridge 用 Node 等价替代可消除双 runtime 复杂度 + Plugin Bridge 的 Bun-on-Node-http 兼容性坑。完整迁移设计见 `specs/prd/prd_0.2.0_node_runtime_migration.md`（`specs/prd/` 在 gitignore，PRD 以本地文档形式保留）。

### 持久 Session 架构

- `messageGenerator()` 使用 `while(true)` 持续 yield，SDK subprocess 全程存活
- 所有中止场景 MUST 使用 `abortPersistentSession()`（设置 abort 标志 + 唤醒 generator Promise 门控 + interrupt subprocess），禁止直接设置 `shouldAbortSession = true`（generator 会永久阻塞）
- 配置变更时 MUST 先设 `resumeSessionId` 再 abort，否则 AI 会"失忆"
- **两种重启机制不要混淆**：
  - **直接 abort**（`abortPersistentSession()`）— 立即中断 + interrupt subprocess。触发点：`resetSession`、`switchToSession`、`rewindSession`、`recoverFromStaleSession`、`enqueueUserMessage` provider change、provider proxy 凭证变化、startup timeout、watchdog、end-of-turn drain、pre-warm drain
  - **延迟重启**（`scheduleDeferredRestart('mcp' | 'agents')`）— 合并防抖 + 下次 pre-warm 时柔性重启。触发点：`setMcpServers`、`setAgents`。**不**等同于直接 abort（不会立即中断 in-flight turn，也不 interrupt subprocess）

### Pre-warm 机制

- MCP/Agents 同步触发 `schedulePreWarm()`（500ms 防抖），Model 同步不触发
- 持久 Session 中 pre-warm 就是最终 session，用户消息通过 `wakeGenerator()` 注入。任何 `!preWarm` 条件守卫都可能导致逻辑在持久模式下永远不执行
- 新增配置同步端点时，确保 `currentXxx` 变量在 pre-warm 前已设置
- **MCP 配置权威来源分离**：Tab 会话的 MCP 由前端 `/api/mcp/set` 配置（`initializeAgent` 中 MUST NOT self-resolve MCP），IM/Cron 会话的 MCP 由 self-resolve 从磁盘读取。混用会导致 fingerprint 差异 → abort → 30s 重启循环

### Builtin MCP 懒加载架构（v0.2.0+）

6 个 in-process 内置 MCP（cron-tools / im-cron / im-media / generative-ui / gemini-image / edge-tts）采用**两层 META/INSTANCE 懒加载**：

- **META 层**（`src/server/tools/builtin-mcp-meta.ts`）：每个 MCP 登记一个 `{ id, load: async () => ... }` 工厂，**模块加载时只存函数引用**，不 eval 任何 tool 代码
- **INSTANCE 层**（`src/server/tools/builtin-mcp-registry.ts::getBuiltinMcpInstance(id)`）：按需触发 factory，`@anthropic-ai/claude-agent-sdk`（~900KB）+ `zod/v4`（~470KB）+ per-tool schema 构造全部在此发生；**首次 call 付 100-400ms，后续缓存命中 0ms**。Promise 失败自动 evict，防止 poisoned cache
- **Settings UI 的 MCP 列表**从**静态** `PRESET_MCP_SERVERS`（`src/renderer/config/types.ts`）读取，**不依赖** INSTANCE 层。关闭某个 builtin = 不传给 SDK ≠ 不创建

**新增一个 builtin MCP 的正确流程**：
1. 新建 `src/server/tools/xxx-tool.ts`，导出 `async function createXxxServer()`（SDK/zod 的 value import **必须**在 factory 内部 `await import(...)`，顶层只能 light 依赖 + `import type`）
2. 在 `src/server/tools/builtin-mcp-meta.ts` 加一个 `registerBuiltinMcpMeta({ id, load: async () => { const m = await import('./xxx-tool'); return { server: await m.createXxxServer() }; } })`
3. 用户可开关的 MCP（Settings 可见）：另导出 `configureXxx` + `validateXxx`（纯 JS，不 import SDK/zod），在 META 的 load() 里一并返回

**结构性防御**：`.eslintrc` 的 `@typescript-eslint/no-restricted-imports` 规则禁止 `src/server/tools/*.ts` 顶层 value-import SDK/zod（`allowTypeImports: true` 保留 type-only 零成本）。破坏这条规则 → lint 立即报错。

### Multi-Agent Runtime (v0.1.60)

除 builtin（Claude Agent SDK）外，支持 Claude Code CLI（NDJSON/stdio）和 Codex CLI（JSON-RPC 2.0/stdio）作为外部 Runtime。功能门控：`config.multiAgentRuntime`（默认关闭）。

- **抽象层**：`src/server/runtimes/` — `AgentRuntime` 接口 + `UnifiedEvent` 统一事件 + `external-session.ts` 会话管理
- **门控链路**：Rust `sidecar.rs` 注入 `MYAGENTS_RUNTIME` 环境变量 → Node `factory.ts` 读取 → `shouldUseExternalRuntime()` 分流。前端 `Chat.tsx` 的 `currentRuntime` 在定义处门控（`multiAgentRuntimeEnabled ? agent.runtime : 'builtin'`），下游派生自动安全
- **Config 变更**：Model/Permission 变更 → `setExternalModel()`/`setExternalPermissionMode()` → 停进程 → 下次消息以新配置 resume
- **跨 Runtime Session 保护**：`initializeAgent` 检测 `meta.runtime !== 'builtin'` → 跳过 SDK resume → 前端弹确认框引导新开会话
- **`schedulePreWarm()` 已内置 external runtime 跳过守卫**（agent-session.ts:1145），外部 runtime 不走 SDK pre-warm
- 新增 config 同步端点时，MUST 检查 `shouldUseExternalRuntime()` 并分流到 `external-session.ts` 对应函数
- 详见 @specs/tech_docs/multi_agent_runtime.md

### 定时任务系统

Rust `CronTaskManager` 统一管理所有定时任务（Chat 定时、独立创建、AI 工具调用、IM Cron、Heartbeat），支持三种调度：固定间隔 / Cron 表达式 / 一次性。Cron Tool（`im-cron` MCP server）已泛化为**所有 Session 可用**（不仅 IM Bot），始终信任。新增 `CronTask` 字段 MUST 带 `#[serde(default)]`。详见 @specs/ARCHITECTURE.md 的「定时任务系统」节。

### Config 持久化（disk-first）

`AppConfig` 同时存在于磁盘（config.json）和 React 状态中，两者可能不同步。`useConfig` 已重构为 `ConfigDataContext` + `ConfigActionsContext` 双 Context 分离。写入配置时 MUST 以磁盘为准（`await loadAppConfig()` 读最新再合并），禁止直接使用 React `config` 状态写盘。

Agent 配置通过 Rust 命令 `cmd_update_agent_config` 写盘，写盘后 MUST 调用 `refreshConfig()` 同步 React 状态。

### 内嵌终端（Embedded Terminal）

Chat 分屏右侧面板的交互式 PTY 终端。Rust `terminal.rs`（`portable-pty`）+ 前端 `TerminalPanel.tsx`（xterm.js），通过 Tauri IPC 通信（不走 SSE/Sidecar）。终端绑定 Tab 生命周期，面板关闭不杀进程。PTY 进程由 `portable-pty` 管理，**不走** `process_cmd`；Proxy 手动复用 `proxy_config` 常量。详见 @specs/ARCHITECTURE.md 的「内嵌终端」节。

### 内嵌浏览器（Embedded Browser）

Chat 分屏右侧面板的 URL 预览器（Tauri Multi-Webview）。Rust `browser.rs` + 前端 `BrowserPanel.tsx`，通过 Tauri IPC 通信。AI Markdown 链接和 HTML 文件优先在此打开。

- **依赖 Tauri `"unstable"` feature**（`Window::add_child()` 多 Webview API），Cargo.toml 已开启
- **安全隔离**：`browser.json` Capability 零权限，Webview 无法访问 Tauri IPC；`on_navigation` 限制 http/https scheme
- **Overlay 协调**：原生 Webview 浮于 React DOM 之上，Overlay 出现时通过 `closeLayer.hasOverlayLayer()` 自动 hide
- **Cookie 持久化**：同 App 所有 Webview 共享，默认持久化磁盘，关闭即销毁（不后台保活）

详见 @specs/ARCHITECTURE.md 的「内嵌浏览器」节。

### 层级关闭系统（Close Layer）

Cmd+W 层级关闭：Overlay → 分屏面板 → Tab。`closeLayer.ts` 模块级注册表，`useCloseLayer(handler, zIndex)` 一行集成。新增 Overlay 组件 MUST 调用 `useCloseLayer`，z-index 与 CSS 保持一致。详见 @specs/ARCHITECTURE.md 的「层级关闭系统」节。

### 全文搜索引擎

Rust `SearchEngine` 单例（Tantivy + jieba），提供 Session 历史与工作区文件全文检索，仅 Tauri 可用。修改搜索相关代码前 MUST 读 @specs/tech_docs/search_architecture.md。

### Plugin Bridge（OpenClaw 插件）

- Bridge 是独立 Node.js 进程，MUST 与 Sidecar 保持同等待遇：环境变量注入（`proxy_config`、`NO_PROXY`）、日志宏（`ulog_*` 不是 `log::*`）、config 查询范围（`imBotConfigs` + `agents[].channels[]`）
- v0.2.0+ 统一 Node.js 后，之前 Bun http 兼容性坑已清（axios 等不再静默挂起）。社区 OpenClaw 插件天然是 Node.js 标准
- 兼容层验证 MUST 跑完整消息收发链路（不能只验证 `register()` 成功）
- **SDK Shim 全量覆盖**：shim 覆盖 OpenClaw 全部 `plugin-sdk/*` 导出（手写 + 自动生成 stub）。手写模块受 `_handwritten.json` 清单保护
- **Shim 修改 MUST bump 版本**：源码 shim 经 build → app bundle → Bridge 启动时 `install_sdk_shim()` 拷贝到插件 `node_modules/openclaw/`。**版本不变则跳过拷贝**。三处同步 bump：`sdk-shim/package.json` version、`compat-runtime.ts` SHIM_COMPAT_VERSION、`bridge.rs` SHIM_COMPAT_VERSION
- 详细架构：@specs/tech_docs/plugin_bridge_architecture.md

### OpenClaw 插件通用性原则

MyAgents 是 OpenClaw 的**通用 Plugin 适配层**，不是各家 IM 的硬编码集成。开发准则：

- **协议优先**：所有功能 MUST 基于 OpenClaw SDK 协议（`ChannelPlugin` 接口），禁止为单个插件硬编码逻辑。能力检测用 duck-typing（`plugin.gateway?.loginWithQrStart` 存在 → 支持 QR 登录），不用 if/else 分平台。
- **SDK shim 对齐源码**：新增 shim 函数 MUST 先读 OpenClaw 源码确认签名和行为（`/Users/zhihu/Documents/project/openclaw/`），禁止臆造实现。
- **预设 = 最小定制**：`promotedPlugins.ts` 只声明元数据（npmSpec、icon、authType），功能逻辑走通用路径。预设插件与自定义插件的代码路径 MUST 相同。
- **安装输入清洗**：用户可能粘贴 `npx -y @scope/pkg install` 等完整命令，`sanitize_npm_spec()` 统一剥离，安装/查找/manifest 全链路 MUST 用清洗后的值。
- **鉴权方式自适应**：config 填写 vs QR 扫码由插件能力决定（`supportsQrLogin`），向导流程自动切换，不绑死某种鉴权方式。

---

### v0.2.0 pit-of-success 模块（新增）

v0.2.0 结构性重构落地了 7 个新的 helper 层模块，把"正确路径"做成默认。完整设计见 @specs/ARCHITECTURE.md 的「v0.2.0 Pit-of-Success Modules」章节。

- `withConfigLock` / `with_config_lock` — `~/.myagents/config.json` 跨进程串行写入（Node + Rust + renderer 三端共享同一个 lockdir）。
- `withFileLock` / `with_file_lock` — 通用 atomic-mkdir-based file lock，stale-recovery 通过 `<runtime>:<pid>:<startMs>` owner sentinel + pid liveness 探测。Async 实现，无 sync busy-wait。
- `killWithEscalation` — 子进程 stop 的 SIGTERM → SIGKILL → orphan-log 升级链，bounded-time（worst case `gracefulMs + hardMs`）。
- `withAbortSignal` / `cancellableFetch` / `withBoundedTimeout` / `anySignal` — 所有下游 fetch / 子进程 / 流的统一 cancel 协议（`CancelReason` 枚举）。
- `maybeSpill` + `/refs/:id` + SSE 优先级队列 — 大 payload（>256KB Node、>1MiB Rust）流到 `~/.myagents/refs/<id>`，SSE 只送 ref；SSE 三档优先级（critical/coalescible/droppable）+ per-client 软硬上限。
- `withLogContext` + AsyncLocalStorage logger pipeline — `console.*` capture 自动注入 sessionId/tabId/turnId/runtime/requestId，932 个调用零 call-site migration。`UnifiedLogger` 改 in-memory bounded queue + 100ms async flusher。
- `DeferredInitState` + `/health/{live,ready,functional}` 三分 — sidecar deferred init 状态机，Renderer loading 挂 ready，不再"假就绪"。

---

## 补充禁止事项

> 核心架构约束（Rust 代理层、local_http、process_cmd、Tab 隔离、持久 Session、Config disk-first 等）已在上方各节以 MUST/禁止 形式给出，此处不重复。以下为上方未覆盖的补充规则。

| 禁止 | 后果 | 正确做法 |
|------|------|----------|
| 依赖用户系统安装的运行时 | 用户未安装 → 功能不可用 | 使用内置 Node.js（`runtime.ts::getBundledNodePath()`） |
| 新增 SSE 事件不注册白名单 | 前端静默丢弃该事件 | 在 `SseConnection.ts` 的 `JSON_EVENTS` 注册 |
| Sidecar 用 `__dirname` / `readFileSync` | esbuild 硬编码路径，生产环境出错 | 内联常量或 `fileURLToPath(import.meta.url)` / `getScriptDir()` |
| 日志日期用 UTC `toISOString` | 与本地日期文件名不匹配 | 统一用 `localDate()`（`src/shared/logTime.ts`） |
| Rust 日志用 `log::info!` | 不进统一日志 | MUST 用 `ulog_info!` / `ulog_error!` |
| 裸 `which::which()` 查找系统工具 | Finder 启动时 PATH 缺少 homebrew 等路径 | `crate::system_binary::find()` |
| 前端 `@tauri-apps/plugin-fs` 读写工作区文件 | Tauri fs scope 仅覆盖 `~/.myagents/**` | `invoke('cmd_read_workspace_file')` / `invoke('cmd_write_workspace_file')` |
| UI 硬编码颜色（`#fff`、`bg-blue-500`） | 破坏设计系统一致性 | 使用 CSS Token `var(--xxx)`，参考 specs/DESIGN.md |
| 表单用原生 `<select>` | 系统下拉框样式各平台不一致 | 使用 `<CustomSelect>` 组件（`@/components/CustomSelect`） |
| 函数参数用 `undefined`/`null` 表示特定业务动作 | 内部调用方无意触发该动作 | 业务动作用自解释字面量（如 `'subscription'`），`undefined` 只表示"未提供 / 保持现状" |
| 新增手写 shim 不加入 `_handwritten.json` | `generate:sdk-shims` 下次运行覆盖手写文件 | 手写 shim MUST 同步加入 `sdk-shim/plugin-sdk/_handwritten.json` |
| 新增 overlay/可关闭面板不调用 `useCloseLayer` | Cmd+W 跳过该面板直接关 Tab | 在组件内调用 `useCloseLayer(() => { onClose(); return true; }, zIndex)`，zIndex 取组件 CSS z-index 值 |
| Overlay 遮罩层用裸 `<div>` + 手写 `onClick`/`onMouseDown` | 选中文字拖拽到面板外松手会误关闭 | 使用 `<OverlayBackdrop>` 组件（`@/components/OverlayBackdrop`），内置 `onMouseDown` + target guard |
| 在 onClick 里用 `requestAnimationFrame(() => otherEl.focus())` 抢夺焦点 | macOS WebKit 触摸板 tap 事件合成在 <16ms 内完成，rAF 夺焦会插入 click 合成窗口 → WebKit 判定交互被打断 → 吞掉 click（物理按下正常、轻按首次无效，极隐蔽） | 按钮如果不该抢焦点，改用 `onMouseDown={retainFocusOnMouseDown}`（`@/utils/focusRetention`），原焦点元素天然保持聚焦，不需要再 rAF 夺回 |
| 在 `src/server/tools/*.ts` 顶部写 `import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'` 或 `import { z } from 'zod/v4'` | 破坏 builtin MCP lazy-load —— Sidecar 冷启动每次付 ~500-1000ms zod schema 构造税，即使用户压根没启用这个 MCP | SDK/zod imports MUST 放在 `createXxxServer()` 内部通过 `await import(...)` 获取；tool 文件顶层只保留 light 依赖（sse/fs/crypto 等）。META 注册在 `src/server/tools/builtin-mcp-meta.ts`；参考 `cron-tools.ts` / `gemini-image-tool.ts` 的形状 |
| `~/.myagents/config.json` 写入用裸 `tmp + rename`（绕过锁） | 多写者 race，用户密钥 / 设置静默丢失（last writer wins） | Node MUST 用 `withConfigLock` (`src/server/utils/admin-config.ts`)；Rust MUST 用 `with_config_lock` (`src-tauri/src/config_io.rs`)；renderer MUST 走 `withConfigLock` (`src/renderer/config/services/configStore.ts`)。三端共享同一个 `config.json.lock` lockdir |
| 单写者文件（`cron_tasks.json` / `sessions/*.jsonl` / `mcp-oauth state` 等）裸 append 或 read-modify-write | 应用内多 owner 并发触发 race / 数据损坏 | Node 用 `withFileLock` (`src/server/utils/file-lock.ts`)；Rust 用 `with_file_lock` / `with_file_lock_blocking` (`src-tauri/src/utils/file_lock.rs`)。owner sentinel `<runtime>:<pid>:<startMs>`，stale recovery 自动检 pid liveness |
| Runtime 子进程 stop 用裸 `setTimeout + child.kill('SIGTERM')` 等 `waitForExit` | 进程拒收 SIGTERM 时 sidecar 永久卡死（user 停止 / 模型切换 / 权限切换 / runtime 切换全中招） | MUST 用 `killWithEscalation` (`src/server/runtimes/utils/kill-with-escalation.ts`)。三个 runtime adapter + `external-session.ts` 的 catch-fallback 已全部走它，新增 stop 路径同样 |
| 工具 / bridge 用裸 `fetch()` 无 AbortSignal | 卡住的下游 → tool turn 永久 hang，token 持续烧 | MUST 用 `cancellableFetch` 或 `withAbortSignal` (`src/server/utils/cancellation.ts`)。所有工具 fetch（im-bridge / im-cron / im-media / edge-tts / plugin-bridge compat）已迁完，新增 fetch 同样 |
| 大 payload（>256KB）直接进 SSE / IPC JSON | OOM、UI 线程被 base64 阻塞、慢 client 拖死 sidecar | MUST 用 `maybeSpill` (`src/server/utils/large-value-store.ts`)；renderer 大响应通过 `/refs/:id` 取。SSE `controller.enqueue` MUST 经 priority gate（`dispatchWithBackpressure`） |
| 同步 busy-wait（`Atomics.wait` / CPU spin / `while (Date.now() < end)`） | 阻塞 Node event loop / pegs CPU / starve TCP accept | 异步 polling（`setTimeout` async loop）；锁等待用现成 helper（`withFileLock` / `withConfigLock`）。`grep "Atomics.wait"` / `grep "while (Date.now"` 在 src/ 应只剩 doc comment |
| 健康探针把 readiness 等同于 liveness（renderer loading 挂 `/health`） | "假就绪"——sidecar 看着 OK 但首次发消息卡在 deferred init | MUST 区分 `/health/live` / `/health/ready` / `/health/functional` 三个语义；renderer / Rust `wait_for_readiness` / IM watchdog 都挂 `/health/ready`。新加 route 不要 `await __myagentsDeferredInit`（已下线），用 `DeferredInitState` 查询 |
| 跨进程 trace 需要 correlation 时去改 `console.*` 加前缀 / 引并行的 `sendLog` 通道 | 932 个 call site 漏改一处就断链；并行通道破坏 unified logging | `console.*` 在合适的 boundary 内调用即可（HTTP middleware / SDK turn / runtime spawn 已经在外层 `withLogContext` 包好），自动注入 sessionId/tabId/turnId/runtime/requestId。新边界用 `withLogContext({ ... }, fn)` 包一层；ambient store 按 sessionId\|ownerId 隔离，**不**用 process singleton |

---

## 日志与排查

日志来自三层（React/Node.js Sidecar/Rust），汇入统一日志 `~/.myagents/logs/unified-{YYYY-MM-DD}.log`。用户报告问题时 MUST 主动读取日志，不等用户粘贴。

- **IM Bot 问题**：搜 `[feishu]` `[im]` `[telegram]` `[dingtalk]` `[bridge]` `[openclaw]`
- **AI/Agent 异常**：搜 `[agent]` `pre-warm` `timeout`
- **定时任务问题**：搜 `[CronTask]`（初始化/恢复/执行日志已切换到统一日志 `ulog_*`）
- **终端问题**：搜 `[terminal]`（PTY 创建/关闭/Shell 退出/自清理）
- **Rust 层问题**：额外查系统日志 `/Users/{user}/Library/Logs/com.myagents.app/MyAgents.log`

详细日志架构：@specs/tech_docs/unified_logging.md

---

## Git 与工作流

- **提交前 MUST**：`npm run typecheck`，检查当前分支（`git branch --show-current`）
- **分支策略**：`dev/x.x.x` 开发 → 合并到 `main`。MUST NOT 在 main 直接提交
- **合并到 main**：需 typecheck + lint 通过 + 用户明确确认
- **Commit 格式**：Conventional Commits（`feat:` / `fix:` / `refactor:`）
- **发布流程**：先更新 CHANGELOG.md → `npm version` → `./build_macos.sh` → `./publish_release.sh` → push tag

---

## 深度文档

修改相关模块前建议先阅读：

- 整体架构（全局核心规范，必读）：@specs/ARCHITECTURE.md
- 设计系统（全局核心规范，前端必读）：@specs/DESIGN.md
- Node.js 打包架构（v0.2.0+ 单一 runtime、PATH 注入、SDK native binary、native addon ABI）：@specs/tech_docs/bundled_node.md
- 自配置 CLI（myagents 命令、Admin API、版本门控）：@specs/tech_docs/cli_architecture.md
- React 稳定性规范（Context/useEffect/memo 等 5 条规则）：@specs/tech_docs/react_stability_rules.md
- IM Bot 集成：@specs/tech_docs/im_integration_architecture.md
- Plugin Bridge（OpenClaw 入口协议、CJS+ESM 混用插件 runtime 补丁、SDK shim ESM、消息流转）：@specs/tech_docs/plugin_bridge_architecture.md
- Session ID 架构：@specs/tech_docs/session_id_architecture.md
- 代理配置：@specs/tech_docs/proxy_config.md
- Windows 平台适配：@specs/tech_docs/windows_platform_guide.md
- Linux 平台适配（v0.2.0+ AppImage/deb）：@specs/tech_docs/linux_platform_guide.md
- Multi-Agent Runtime（CC/Codex/Gemini 协议、会话管理、门控链路）：@specs/tech_docs/multi_agent_runtime.md
