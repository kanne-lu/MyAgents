# MyAgents - Desktop AI Agent

基于 Claude Agent SDK 的桌面端通用 Agent 产品。开源项目（Apache-2.0），使用 Conventional Commits，不提交敏感信息。

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面框架 | Tauri v2 (Rust) |
| 前端 | React 19 + TypeScript + Vite + TailwindCSS |
| 后端 | Bun + Claude Agent SDK (多实例 Sidecar) |
| 通信 | Rust HTTP/SSE Proxy (reqwest via `local_http` 模块) |
| 运行时 | Bun 内置于应用包（用户无需安装 Bun 或 Node.js） |

## 项目结构

- `src/renderer/` — React 前端（api/、context/、hooks/、components/、pages/）
- `src/server/` — Bun 后端 Sidecar
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

### Tab-scoped 隔离

每个 Chat Tab 拥有独立的 Bun Sidecar 进程（Tab/CronTask/BackgroundCompletion/ImBot 四种 Owner 共享 SidecarManager）。MUST 在 Tab 内使用 `useTabState()` 返回的 `apiGet`/`apiPost`，**禁止**在 Tab 内使用全局 `apiPostJson`/`apiGetJson`（会发到 Global Sidecar）。

### Rust 代理层

所有前端 HTTP/SSE 流量 MUST 通过 Rust 代理层（`invoke` → Rust → reqwest → Bun Sidecar），**禁止**从 WebView 直接发起 HTTP 请求。

### local_http 模块（致命陷阱）

所有连接本地 Sidecar（`127.0.0.1`）的 reqwest 客户端 MUST 通过 `crate::local_http::builder()` / `blocking_builder()` / `json_client()` / `sse_client()` 创建。内置 `.no_proxy()` 防止系统代理拦截 localhost。**禁止**裸 `reqwest::Client::builder()` 或 `reqwest::Client::new()` 连接 localhost，否则系统代理（Clash/V2Ray）会导致 502。

### 零外部依赖

应用内置 Bun 运行时（`getBundledRuntimePath()`），MUST NOT 依赖用户系统的 Node.js/npm/npx。

### 持久 Session 架构

- `messageGenerator()` 使用 `while(true)` 持续 yield，SDK subprocess 全程存活
- 所有中止场景 MUST 使用 `abortPersistentSession()`（设置 abort 标志 + 唤醒 generator Promise 门控 + interrupt subprocess），禁止直接设置 `shouldAbortSession = true`（generator 会永久阻塞）
- 配置变更时 MUST 先设 `resumeSessionId` 再 abort，否则 AI 会"失忆"
- `abortPersistentSession()` 的调用场景：`setMcpServers`、`setAgents`、`resetSession`、`switchToSession`、`enqueueUserMessage` provider change、`rewindSession`

### Pre-warm 机制

- MCP/Agents 同步触发 `schedulePreWarm()`（500ms 防抖），Model 同步不触发
- 持久 Session 中 pre-warm 就是最终 session，用户消息通过 `wakeGenerator()` 注入。任何 `!preWarm` 条件守卫都可能导致逻辑在持久模式下永远不执行
- 新增配置同步端点时，确保 `currentXxx` 变量在 pre-warm 前已设置

### Config 持久化（disk-first）

`AppConfig` 同时存在于磁盘（config.json）和 React 状态中，两者可能不同步。`useConfig` 已重构为 `ConfigDataContext` + `ConfigActionsContext` 双 Context 分离。写入配置时 MUST 以磁盘为准（`await loadAppConfig()` 读最新再合并），禁止直接使用 React `config` 状态写盘。

IM Bot 配置通过 Rust 命令 `cmd_update_im_bot_config` 写盘，写盘后 MUST 调用 `refreshConfig()` 同步 React 状态。

---

## 禁止事项

| 禁止 | 后果 | 正确做法 |
|------|------|----------|
| WebView 直接 fetch | CORS 失败 | `proxyFetch()` 经 Rust 代理 |
| Tab 内用全局 API | 请求发到错误 Sidecar | `useTabState()` |
| 裸 `reqwest::Client` 连 localhost | 系统代理 → 502 | `crate::local_http::builder()` |
| 依赖系统 npm/npx/Node.js | 用户未安装 | 内置 bun |
| 直接设 `shouldAbortSession = true` | generator 永久阻塞 | `abortPersistentSession()` |
| 配置变更不设 `resumeSessionId` | AI 失忆 | 先设 resumeSessionId 再 abort |
| `!preWarm` 条件守卫 | 持久模式下永不执行 | 移除或改用其他条件 |
| Config 写盘用 React state | 覆盖其他字段（如 API Key） | `await loadAppConfig()` 磁盘读 |
| IM config 写盘后不 `refreshConfig()` | UI 显示过期数据 | 写盘后调 `refreshConfig()` |
| 新增 SSE 事件不注册白名单 | 前端静默丢弃该事件 | 在 `SseConnection.ts` 的 `JSON_EVENTS` 注册 |
| Sidecar 用 `__dirname` / `readFileSync` | bun build 硬编码路径，生产环境出错 | 内联常量或 `getScriptDir()` |
| 日志日期用 UTC `toISOString` | 与本地日期文件名不匹配 | 统一用 `localDate()`（`src/shared/logTime.ts`） |

---

## 日志与排查

日志来自三层（React/Bun Sidecar/Rust），汇入统一日志 `~/.myagents/logs/unified-{YYYY-MM-DD}.log`。用户报告问题时 MUST 主动读取日志，不等用户粘贴。

- **IM Bot 问题**：搜 `[feishu]` `[im]` `[telegram]` `[dingtalk]`
- **AI/Agent 异常**：搜 `[agent]` `pre-warm` `timeout`
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
