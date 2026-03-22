# MyAgents - Desktop AI Agent

基于 Claude Agent SDK 的桌面端通用 Agent 产品。开源项目（Apache-2.0），使用 Conventional Commits，不提交敏感信息。

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面框架 | Tauri v2 (Rust) |
| 前端 | React 19 + TypeScript + Vite + TailwindCSS |
| 后端 | Bun + Claude Agent SDK (多实例 Sidecar) |
| 通信 | Rust HTTP/SSE Proxy (reqwest via `local_http` 模块) |
| 运行时 | 双运行时：Bun（Agent Runtime / Sidecar）+ Node.js（MCP Server / 社区工具），均内置于应用包 |

## 项目结构

- `src/renderer/` — React 前端（api/、context/、hooks/、components/、pages/）
- `src/server/` — Bun 后端 Sidecar
- `src/server/plugin-bridge/` — OpenClaw Plugin Bridge（独立 Bun 进程，加载社区 Channel 插件）
- `src/shared/` — 前后端共享类型
- `src-tauri/` — Tauri Rust 层
- `specs/` — 设计文档（tech_docs/、guides/、prd/、research/）

## 开发命令

```bash
bun install                 # 依赖安装
./start_dev.sh              # 浏览器开发模式 (快速迭代)
npm run tauri:dev           # Tauri 开发模式 (完整桌面体验)
./build_dev.sh              # Debug 构建 (含 DevTools)
./build_macos.sh            # 生产构建
./publish_release.sh        # 发布到 R2
npm run typecheck && npm run lint  # 代码质量检查
```

---

## 核心架构约束

### 开发前置要求

进行新功能开发或模块重构时，MUST 先阅读整体架构文档 @specs/tech_docs/architecture.md ，从宏观视角理解系统分层、模块边界和数据流，避免局部修改破坏全局设计。对接外部 SDK/插件时，MUST 先读源码确认接口约定（函数签名、config schema、返回值格式），再写适配层。

开发前端界面时，MUST 先阅读项目设计系统（Token/组件/页面规范）：@specs/guides/design_guide.md ，遵循设计系统，并参考行业最佳交互方式进行设计开发。

### Tab-scoped 隔离

每个 Chat Tab 拥有独立的 Bun Sidecar 进程（Tab/CronTask/BackgroundCompletion/Agent 四种 Owner 共享 SidecarManager）。MUST 在 Tab 内使用 `useTabState()` 返回的 `apiGet`/`apiPost`，**禁止**在 Tab 内使用全局 `apiPostJson`/`apiGetJson`（会发到 Global Sidecar）。

### Rust 代理层

所有前端 HTTP/SSE 流量 MUST 通过 Rust 代理层（`invoke` → Rust → reqwest → Bun Sidecar），**禁止**从 WebView 直接发起 HTTP 请求。

### local_http 模块（致命陷阱）

所有连接本地 Sidecar（`127.0.0.1`）的 reqwest 客户端 MUST 通过 `crate::local_http::builder()` / `blocking_builder()` / `json_client()` / `sse_client()` 创建。内置 `.no_proxy()` 防止系统代理拦截 localhost。**禁止**裸 `reqwest::Client::builder()` 或 `reqwest::Client::new()` 连接 localhost，否则系统代理（Clash/V2Ray）会导致 502。

### process_cmd 模块（Windows 控制台窗口陷阱）

所有 Rust 层子进程 MUST 通过 `crate::process_cmd::new()` 创建，**禁止**裸 `std::process::Command::new()`。内置 Windows `CREATE_NO_WINDOW` 标志，防止 GUI 应用启动子进程（bun.exe Sidecar / Plugin Bridge / bun init 等）时弹出黑色控制台窗口。遵循与 `local_http` 相同的 "pit of success" 模式。例外：`#[cfg(windows)]` 守卫内的系统工具命令（taskkill/powershell/wmic）已内联处理；`commands.rs` 的 OS opener（open/explorer/xdg-open）和 Unix pgrep 是用户可见的系统命令，无需隐藏。

### 零外部依赖与双运行时

应用内置三个运行时依赖，用户无需自行安装任何东西：

| 依赖 | 用途 | 打包位置 |
|------|------|---------|
| **Bun** | Agent Runtime — 运行 Claude Agent SDK（`executable: 'bun'`），Sidecar 主进程、Plugin Bridge | `src-tauri/binaries/bun-*` |
| **Node.js** | 功能层 — MCP Server 执行（`npx`）、社区 npm 包、AI Bash 环境中的 `node`/`npx`/`npm` | `src-tauri/resources/nodejs/`（v0.1.44+，含 node + npm/npx） |
| **Git** | SDK 依赖 — Claude Code 需要 `git`（代码操作）+ `bash`（工具执行），Windows 无自带 → NSIS 静默安装 Git for Windows | `src-tauri/nsis/Git-Installer.exe`（仅 Windows） |

**分层原则**：Bun 跑我们自己的代码（启动快、行为可控），Node.js 跑社区生态代码（MCP Server / npm 包，设计目标是 Node.js，Bun 兼容性存在系统性缺陷）。

**PATH 注入**：`buildClaudeSessionEnv()` 构造 SDK 子进程的 PATH，决定 AI Bash 工具能找到哪些命令。优先级：`bundledBunDir` → `systemNodeDirs`（用户安装的 Node.js） → `bundledNodeDir` → `~/.myagents/bin` → 系统路径。Node.js 系统优先（用户维护、npm 更可靠），Bun 内置优先（跑我们自己的代码）。

**运行时发现**：`src/server/utils/runtime.ts` 提供 `getBundledRuntimePath()`（Bun）、`getBundledNodePath()`（Node.js）。

详见：@specs/prd/prd_0.1.44_dual_runtime.md

### 持久 Session 架构

- `messageGenerator()` 使用 `while(true)` 持续 yield，SDK subprocess 全程存活
- 所有中止场景 MUST 使用 `abortPersistentSession()`（设置 abort 标志 + 唤醒 generator Promise 门控 + interrupt subprocess），禁止直接设置 `shouldAbortSession = true`（generator 会永久阻塞）
- 配置变更时 MUST 先设 `resumeSessionId` 再 abort，否则 AI 会"失忆"
- `abortPersistentSession()` 的调用场景：`setMcpServers`、`setAgents`、`resetSession`、`switchToSession`、`enqueueUserMessage` provider change、`rewindSession`

### Pre-warm 机制

- MCP/Agents 同步触发 `schedulePreWarm()`（500ms 防抖），Model 同步不触发
- 持久 Session 中 pre-warm 就是最终 session，用户消息通过 `wakeGenerator()` 注入。任何 `!preWarm` 条件守卫都可能导致逻辑在持久模式下永远不执行
- 新增配置同步端点时，确保 `currentXxx` 变量在 pre-warm 前已设置

### 定时任务系统

Rust `CronTaskManager` 统一管理所有定时任务（Chat 定时、独立创建、AI 工具调用、IM Cron、Heartbeat），支持三种调度：固定间隔 / Cron 表达式 / 一次性。Cron Tool（`im-cron` MCP server）已泛化为**所有 Session 可用**（不仅 IM Bot），始终信任。新增 `CronTask` 字段 MUST 带 `#[serde(default)]`。详见 @specs/tech_docs/architecture.md 的「定时任务系统」节。

### Config 持久化（disk-first）

`AppConfig` 同时存在于磁盘（config.json）和 React 状态中，两者可能不同步。`useConfig` 已重构为 `ConfigDataContext` + `ConfigActionsContext` 双 Context 分离。写入配置时 MUST 以磁盘为准（`await loadAppConfig()` 读最新再合并），禁止直接使用 React `config` 状态写盘。

Agent 配置通过 Rust 命令 `cmd_update_agent_config` 写盘，写盘后 MUST 调用 `refreshConfig()` 同步 React 状态。

### Plugin Bridge（OpenClaw 插件）

- Bridge 是独立 Bun 进程，MUST 与 Sidecar 保持同等待遇：环境变量注入（`proxy_config`、`NO_PROXY`）、日志宏（`ulog_*` 不是 `log::*`）、config 查询范围（`imBotConfigs` + `agents[].channels[]`）
- Bun 对 Node.js `http` 模块兼容性不完整，使用 axios 的 npm 包可能静默挂起。新接入插件 MUST 验证其 HTTP 调用在 Bun 下正常（不能只验证 import 成功）
- 兼容层验证 MUST 跑完整消息收发链路（不能只验证 `register()` 成功）
- 详细架构：@specs/research/openclaw_sdk_shim_analysis.md

### OpenClaw 插件通用性原则

MyAgents 是 OpenClaw 的**通用 Plugin 适配层**，不是各家 IM 的硬编码集成。开发准则：

- **协议优先**：所有功能 MUST 基于 OpenClaw SDK 协议（`ChannelPlugin` 接口），禁止为单个插件硬编码逻辑。能力检测用 duck-typing（`plugin.gateway?.loginWithQrStart` 存在 → 支持 QR 登录），不用 if/else 分平台。
- **SDK shim 对齐源码**：新增 shim 函数 MUST 先读 OpenClaw 源码确认签名和行为（`/Users/zhihu/Documents/project/openclaw/`），禁止臆造实现。
- **预设 = 最小定制**：`promotedPlugins.ts` 只声明元数据（npmSpec、icon、authType），功能逻辑走通用路径。预设插件与自定义插件的代码路径 MUST 相同。
- **安装输入清洗**：用户可能粘贴 `npx -y @scope/pkg install` 等完整命令，`sanitize_npm_spec()` 统一剥离，安装/查找/manifest 全链路 MUST 用清洗后的值。
- **鉴权方式自适应**：config 填写 vs QR 扫码由插件能力决定（`supportsQrLogin`），向导流程自动切换，不绑死某种鉴权方式。

---

## 禁止事项

| 禁止 | 后果 | 正确做法 |
|------|------|----------|
| WebView 直接 fetch | CORS 失败 | `proxyFetch()` 经 Rust 代理 |
| Tab 内用全局 API | 请求发到错误 Sidecar | `useTabState()` |
| 裸 `reqwest::Client` 连 localhost | 系统代理 → 502 | `crate::local_http::builder()` |
| 依赖用户系统安装的运行时 | 用户未安装 | 使用内置 Bun 或内置 Node.js（`runtime.ts`） |
| 直接设 `shouldAbortSession = true` | generator 永久阻塞 | `abortPersistentSession()` |
| 配置变更不设 `resumeSessionId` | AI 失忆 | 先设 resumeSessionId 再 abort |
| `!preWarm` 条件守卫 | 持久模式下永不执行 | 移除或改用其他条件 |
| Config 写盘用 React state | 覆盖其他字段（如 API Key） | `await loadAppConfig()` 磁盘读 |
| IM config 写盘后不 `refreshConfig()` | UI 显示过期数据 | 写盘后调 `refreshConfig()` |
| 新增 SSE 事件不注册白名单 | 前端静默丢弃该事件 | 在 `SseConnection.ts` 的 `JSON_EVENTS` 注册 |
| Sidecar 用 `__dirname` / `readFileSync` | bun build 硬编码路径，生产环境出错 | 内联常量或 `getScriptDir()` |
| 日志日期用 UTC `toISOString` | 与本地日期文件名不匹配 | 统一用 `localDate()`（`src/shared/logTime.ts`） |
| UI 硬编码颜色（`#fff`、`bg-blue-500`） | 破坏设计系统一致性 | 使用 CSS Token `var(--xxx)`，参考 design_guide.md |
| Plugin Bridge 用裸 `reqwest::Client` | 系统代理 → 502 | `local_http::json_client()` — Bridge 进程也在 localhost |
| CronTask 新增字段不加 `#[serde(default)]` | 旧版 JSON 反序列化失败 | 非核心字段 MUST 加 `#[serde(default)]` |
| Rust 子进程日志用 `log::info!` | 不进统一日志 | MUST 用 `ulog_info!` / `ulog_error!` |
| 裸 `std::process::Command::new()` | Windows 弹出黑色控制台窗口 | `crate::process_cmd::new()` |
| 前端 `@tauri-apps/plugin-fs` 读写工作区文件 | Tauri fs scope 仅覆盖 `~/.myagents/**`，工作区路径写入必失败 | `invoke('cmd_read_workspace_file')` / `invoke('cmd_write_workspace_file')` 走 Rust 原生 I/O |
| 对接外部 SDK/插件时凭假设写适配代码 | 函数签名、config 格式、返回值结构全部猜错 | MUST 先读源码确认接口约定（函数签名、config schema、返回值格式），再写适配层 |

---

## 日志与排查

日志来自三层（React/Bun Sidecar/Rust），汇入统一日志 `~/.myagents/logs/unified-{YYYY-MM-DD}.log`。用户报告问题时 MUST 主动读取日志，不等用户粘贴。

- **IM Bot 问题**：搜 `[feishu]` `[im]` `[telegram]` `[dingtalk]` `[bridge]` `[openclaw]`
- **AI/Agent 异常**：搜 `[agent]` `pre-warm` `timeout`
- **定时任务问题**：搜 `[CronTask]`（初始化/恢复/执行日志已切换到统一日志 `ulog_*`）
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

- 整体架构：@specs/tech_docs/architecture.md
- React 稳定性规范（Context/useEffect/memo 等 5 条规则）：@specs/tech_docs/react_stability_rules.md
- IM Bot 集成：@specs/tech_docs/im_integration_architecture.md
- Session ID 架构：@specs/tech_docs/session_id_architecture.md
- 代理配置：@specs/tech_docs/proxy_config.md
- Windows 平台适配：@specs/tech_docs/windows_platform_guide.md
- 设计系统（Token/组件/页面规范）：@specs/guides/design_guide.md
