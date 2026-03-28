# OpenClaw Plugin Bridge 技术架构

> 最后更新：v0.1.54 (2026-03-27)

## 概述

Plugin Bridge 是 MyAgents 加载社区 OpenClaw Channel Plugin 的核心基础设施。它以**独立 Bun 进程**的形式运行，将 OpenClaw 生态的 Channel 插件（飞书、微信、QQ 等）适配到 MyAgents 的 Agent 架构中。

**设计哲学**：MyAgents 是 OpenClaw 的**通用 Plugin 适配层**，不是各家 IM 的硬编码集成。所有功能基于 OpenClaw SDK 协议（`ChannelPlugin` 接口），禁止为单个插件硬编码逻辑。

## 架构图

```
┌────────────────────────────────────────────────────────────────┐
│                     Rust Management Layer                       │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  BridgeAdapter (src-tauri/src/im/bridge.rs)              │  │
│  │  - Plugin 安装 (npm install → SDK shim → integrity check)│  │
│  │  - Bridge 进程管理 (spawn / health check / restart)       │  │
│  │  - HTTP 双向通信 (Rust ↔ Bun, via local_http)            │  │
│  │  - QR 登录流程代理                                         │  │
│  └───────────────┬──────────────────────────────┬───────────┘  │
│                  │ spawn(bun)                    │ HTTP         │
├──────────────────┼──────────────────────────────┼──────────────┤
│                  ▼                              ▼              │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Bun Bridge Process (plugin-bridge/)                     │  │
│  │                                                          │  │
│  │  index.ts          — HTTP Server + Plugin 加载入口        │  │
│  │  compat-api.ts     — OpenClaw API 适配（registerChannel） │  │
│  │  compat-runtime.ts — Channel Runtime Mock + 消息路由      │  │
│  │                                                          │  │
│  │  ┌────────────────────────────────────────────────────┐  │  │
│  │  │  sdk-shim/ (node_modules/openclaw)                 │  │  │
│  │  │  package.json (155 exports)                        │  │  │
│  │  │  plugin-sdk/                                       │  │  │
│  │  │    26 手写模块 — 真实 Bridge 逻辑                    │  │  │
│  │  │    129 自动生成 stub — 防崩溃兜底                    │  │  │
│  │  └────────────────────────────────────────────────────┘  │  │
│  │                                                          │  │
│  │  ┌────────────────────────────────────────────────────┐  │  │
│  │  │  OpenClaw Channel Plugin                           │  │  │
│  │  │  (e.g., @larksuite/openclaw-lark)                  │  │  │
│  │  │                                                    │  │  │
│  │  │  import { ... } from 'openclaw/plugin-sdk/...'     │  │  │
│  │  │  → 解析到 sdk-shim 提供的模块                       │  │  │
│  │  └────────────────────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────┘
```

## 完整生命周期

### Phase 1: 插件安装

```
用户在 UI 选择/输入插件 npm 包名
  ↓
Rust sanitize_npm_spec() 清洗输入（剥离 npx -y 等前缀）
  ↓
npm install --ignore-scripts --omit=peer（使用内置 Node.js，非 Bun）
  ↓
install_sdk_shim()（最后写入，覆盖 npm 可能安装的真 openclaw 包）
  ↓
Lark SDK axios 补丁（Bun fetch 替换 Node.js http adapter）
  ↓
读取插件 manifest → 提取 requiredFields / supportsQrLogin / compatWarning
```

**关键原则**：SDK shim 必须在 npm install **之后**安装（last-write-wins），因为 npm 可能将真实 `openclaw` 包写入 `node_modules/openclaw/`，覆盖我们的 shim。

### Phase 2: Bridge 进程启动

```
Rust spawn_plugin_bridge()
  ↓
1. 定位 bun 可执行文件 + plugin-bridge-dist.js
2. SDK shim 完整性检查（package.json version 含 "-shim"?）
   └─ 不通过 → 自动重新安装 shim
3. spawn(bun, script, --plugin-dir, --port, --rust-port, --bot-id)
   └─ 敏感配置通过 BRIDGE_PLUGIN_CONFIG 环境变量传递（不暴露到 ps）
   └─ 注入 proxy_config 环境变量
4. stdout/stderr → 统一日志（过滤 heartbeat 噪音）
5. Health check: GET /health × 30 次, 500ms 间隔, 最多 15s
  ↓
Bridge HTTP Server 就绪
```

### Phase 3: 插件加载与注册

```
Bridge index.ts
  ↓
1. 读 plugin_dir/package.json，扫描 dependencies
2. 检测 OpenClaw 插件标记（pkg.openclaw 或 keywords 含 'openclaw'）
3. 推断 Channel 品牌（feishu/qqbot/dingtalk/telegram）
4. 全局 axios 超时补丁（10s，防 Bun socket 30s 挂起）
5. import(pluginModule) → 获取插件对象
6. 调用 plugin.register(compatApi)
   └─ compatApi 提供：registerChannel / config / runtime / registerTool
   └─ 插件注册自己的 Channel 对象（gateway、sendText、editMessage 等）
7. 解析账号凭证 → isConfigured() 校验
   ├─ 通过 → 启动 gateway（startAccount）
   └─ 不通过 + supportsQrLogin → 等待 QR 登录
```

### Phase 4: 消息流转

```
用户发消息到 IM 平台 → 插件 gateway 收到
  ↓
插件调用 runtime.channel.reply.dispatchReplyFromConfig(params)
  ↓
compat-runtime.ts 拦截：
  - 提取 chatId、text、attachments、metadata
  - 媒体文件 → base64 编码（最大 20MB）
  ↓
POST /api/im-bridge/message → Rust
  ↓
Rust 路由到 AI Sidecar → Claude 处理 → 生成回复
  ↓
回复通过 streaming 返回：
  /stream-chunk  → 插件 onPartialReply 回调
  /finalize-stream → 插件 sendFinalReply 回调
  ↓
插件将回复发送到 IM 平台（CardKit / 原生消息）
```

### Phase 5: 错误恢复

| 场景 | 检测方式 | 恢复策略 |
|------|---------|---------|
| Bridge 进程崩溃 | Health check 连续 3 次失败 | Rust 自动重启 Bridge |
| 插件注册失败 | `register()` 抛异常 | 存入 `gatewayError`，`/status` 返回错误 |
| Gateway 启动失败 | `startAccount()` 抛异常 | Bridge 保持存活，用户可从 UI 重试 |
| SDK shim 被覆盖 | 启动时 version 检查 | 自动重新安装 shim |

## SDK Shim 系统

### 问题与方案

**问题**：OpenClaw SDK 声明 154 个 `plugin-sdk/*` 子路径导出。插件通过 `require('openclaw/plugin-sdk/xxx')` 导入。如果 shim 缺少某个模块，Bridge 直接崩溃（`Cannot find module`）。

**方案**：Generator + Override Manifest（全量覆盖 + 手写保护）

```
sdk-shim/
├── package.json                    ← 155 条 exports（154 OpenClaw + 1 自定义 compat）
└── plugin-sdk/
    ├── _handwritten.json           ← 手写清单（26 个），生成器绝不覆盖
    ├── index.js                    ← 手写：根模块
    ├── core.js                     ← 手写：defineChannelPluginEntry 等
    ├── agent-runtime.js            ← 手写：jsonResult / textResult / ToolInputError
    ├── routing.js                  ← 手写：session key 解析
    ├── feishu.js                   ← 手写：飞书专用适配
    ├── ... (共 26 个手写文件)
    ├── discord.js                  ← 自动生成 stub
    ├── telegram.js                 ← 自动生成 stub
    └── ... (共 129 个自动生成 stub)
```

### 手写模块 vs 自动生成 stub

| 维度 | 手写模块 | 自动生成 stub |
|------|---------|-------------|
| 数量 | 26 | 129 |
| 保护机制 | `_handwritten.json` 清单 | `AUTO-GENERATED STUB` header |
| 函数行为 | 真实逻辑（简化版） | 首次调用打印警告，返回安全默认值 |
| 维护方式 | 手动编写和更新 | `bun run generate:sdk-shims` 自动生成 |
| 用途 | 插件实际调用的核心 API | 防止 `Cannot find module` 崩溃 |

### 生成器工作原理

`scripts/generate-sdk-shims.ts`：

1. 读取 `openclaw/package.json` → 提取全部 `./plugin-sdk/*` 导出路径
2. 读取 `_handwritten.json` → 跳过手写模块
3. 对每个非手写模块：
   - 读取 `openclaw/src/plugin-sdk/{name}.ts`
   - 正则提取运行时导出符号（函数、常量、类、枚举）
   - 递归跟踪 `export * from "..."`（深度限制 5 层，`.js` → `.ts` 路径转换）
   - 匹配 `export { foo, bar }` 和 `export { foo } from "..."`（跳过 `type` 前缀）
4. 渲染 stub 文件（命名导出 + 返回值启发式 + 首次调用警告）
5. 更新 `package.json` exports map

**返回值启发式**：

| 函数名模式 | 默认返回值 | 原因 |
|-----------|-----------|------|
| `is*`, `has*`, `should*`, `can*` | `false` | 布尔判断，false 不启用功能 |
| `list*`, `collect*` | `[]` | 空数组避免 `.map()` 崩溃 |
| `format*`, `normalize*`, `strip*` | `""` | 空串安全 |
| `*Schema`, `*Config`, `*Defaults` | `undefined`（const） | 识别为配置对象常量 |
| 其他 | `undefined` | |

### 版本同步（三处一致）

| 位置 | 变量 | 当前值 | 用途 |
|------|------|--------|------|
| `sdk-shim/package.json` | `version` | `2026.3.27-shim` | Bridge 启动完整性检查 |
| `compat-runtime.ts` | `SHIM_COMPAT_VERSION` | `2026.3.27` | 插件 `assertHostCompatibility()` |
| `bridge.rs` | `SHIM_COMPAT_VERSION` | `2026.3.27` | Rust 层 peerDependencies 比对 |

### 维护工作流

**OpenClaw 更新时**：
```bash
cd ../openclaw && git pull
cd ../MyAgents && bun run generate:sdk-shims
git diff src/server/plugin-bridge/sdk-shim/  # 审查变更
```

**Stub 需要真实逻辑时**：
1. 在 `_handwritten.json` 添加模块名
2. 编辑 `.js` 文件实现真实逻辑
3. 重跑生成器（它会跳过该文件）

**故障模式降级**：
```
之前：插件更新 → 新 import → Cannot find module → Bridge 崩溃
现在：插件更新 → 新 import → stub 兜底 → 功能可能不工作但不崩溃
                                         → 控制台警告 "[sdk-shim] xxx.foo() not implemented"
                                         → 按需升级为手写实现
```

## Bun 兼容性陷阱

### axios 30s 挂起

**问题**：Bun 的 `http` 模块与 Node.js 不完全兼容。使用 axios 的 npm 包（如 `@larksuiteoapi/node-sdk`）在 Bun 下 HTTP 请求静默挂起 30s。

**解决**：`install_sdk_shim()` 中为 Lark SDK 注入 fetch-based axios adapter，将 30s 降至 252ms。

**规则**：新接入插件 MUST 验证其 HTTP 调用在 Bun 下正常（不能只验证 import 成功）。

### 全局 axios 超时

Bridge 在 import 插件前全局 patch `axios.create`，为所有新建 axios 实例设置 10s 默认超时，防止 Bun socket bug 级联传播。

## HTTP 端点一览

| 端点 | 方法 | 用途 |
|------|------|------|
| `/health` | GET | Rust 健康检查 |
| `/status` | GET | 就绪状态 + 错误信息 |
| `/capabilities` | GET | 插件能力标记 |
| `/send-text` | POST | 发送消息 |
| `/edit-message` | POST | 编辑已发消息 |
| `/delete-message` | POST | 删除消息 |
| `/send-media` | POST | 发送图片/文件 |
| `/validate-credentials` | POST | 凭证验证（dry-run） |
| `/start-stream` | POST | 开始流式回复 |
| `/stream-chunk` | POST | 流式内容块 |
| `/finalize-stream` | POST | 完成流式回复 |
| `/abort-stream` | POST | 中止流式回复 |
| `/mcp/tools` | GET | 列出插件工具 |
| `/mcp/call-tool` | POST | 执行插件工具 |
| `/execute-command` | POST | 执行斜杠命令 |
| `/qr-login-start` | POST | 发起 QR 登录 |
| `/qr-login-wait` | POST | 轮询 QR 扫码结果 |
| `/restart-gateway` | POST | QR 登录后重启 gateway |
| `/stop` | POST | 优雅关闭 |

## QR 登录流程

```
1. isConfigured() → false + supportsQrLogin → 等待 QR 登录
2. 前端 POST /qr-login-start → 插件生成 QR 数据
3. 前端轮询 /qr-login-wait（最长 35s）
4. 用户扫码 → 插件保存凭证到磁盘
5. 前端 POST /restart-gateway (accountId)
6. Bridge 重新解析账号 → isConfigured() 通过 → 启动 gateway
```

## 资源打包

| 资源 | 开发模式 | 生产模式 |
|------|---------|---------|
| Bridge 脚本 | `src-tauri/resources/plugin-bridge-dist.js` | `Contents/Resources/plugin-bridge-dist.js` |
| SDK shim | `src/server/plugin-bridge/sdk-shim/`（源码目录） | `Contents/Resources/plugin-bridge-sdk-shim/` |
| Bun 运行时 | `src-tauri/binaries/bun-*` | `Contents/MacOS/bun` |
| Node.js（npm install 用） | `src-tauri/resources/nodejs/` | `Contents/Resources/nodejs/` |

## 关键文件索引

| 文件 | 职责 |
|------|------|
| `src-tauri/src/im/bridge.rs` | Rust 层：安装、启动、健康检查、消息路由 |
| `src/server/plugin-bridge/index.ts` | Bridge HTTP Server + 插件加载入口 |
| `src/server/plugin-bridge/compat-api.ts` | OpenClaw API 适配（registerChannel/Tool） |
| `src/server/plugin-bridge/compat-runtime.ts` | Channel Runtime Mock + 消息拦截路由 |
| `src/server/plugin-bridge/sdk-shim/` | SDK shim 包（155 个模块） |
| `src/server/plugin-bridge/sdk-shim/plugin-sdk/_handwritten.json` | 手写模块保护清单 |
| `scripts/generate-sdk-shims.ts` | Stub 自动生成器 |
| `tauri.conf.json` (resources) | shim 打包配置 |
