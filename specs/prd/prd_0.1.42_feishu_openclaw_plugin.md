# 飞书官方 OpenClaw 插件接入 — CardKit Streaming + 工具桥接 + SDK Shim

> **Version**: 0.1.42
> **Date**: 2026-03-15
> **Status**: Implemented
> **Author**: Ethan + Claude
> **前置研究**: [feishu_integration_research.md](../research/feishu_integration_research.md), [feishu_bot_doc.md](../research/feishu_bot_doc.md), [research_openclaw_channel_plugin.md](../research/research_openclaw_channel_plugin.md), [openclaw_sdk_shim_analysis.md](../research/openclaw_sdk_shim_analysis.md)
> **官方插件仓库**: https://github.com/larksuite/openclaw-lark
> **官方插件 npm**: `@larksuite/openclaw-lark` (v2026.3.15)

---

## 1. 背景

### 1.1 现状

MyAgents 有两套飞书 Bot 方案：

| 方案 | 状态 | 优势 | 劣势 |
|------|------|------|------|
| **原生 Rust 实现** (`feishu.rs` 2296 行) | 生产可用 | 深度集成权限体系、流式 draft、去重持久化 | 仅消息收发，无飞书业务能力，维护成本高 |
| **OpenClaw Plugin Bridge** | QQBot 已跑通 | 生态扩展、插件隔离、社区维护 | 本版本前不支持 CardKit Streaming、不桥接插件工具 |

飞书官方 OpenClaw 插件 `@larksuite/openclaw-lark`（MIT 许可）提供消息收发、CardKit Streaming、35 个 OAPI Tools（文档/表格/日历/任务/Wiki/Drive/IM/搜索/OAuth）。

### 1.2 目标

用官方插件**逐步替代**原生 Rust 实现：

1. **Plugin Bridge 接入** — 官方插件作为 promoted plugin，消息流复用 QQBot 路径
2. **CardKit Streaming** — 扩展 Bridge 协议，支持插件控制流式卡片输出
3. **工具桥接** — 将插件的 35 个飞书工具注入 AI Sidecar，按组可选
4. **双入口过渡** — 新入口标"官方"，旧入口标"即将下线"
5. **权限体系** — 飞书 Bot 使用插件自带的 dmPolicy/groupPolicy
6. **SDK Shim 完善** — 完整补全 OpenClaw plugin-sdk 的 44+ 运行时符号

### 1.3 不做的

- 原生飞书实现的移除（本版本仅标记 deprecated）
- 飞书 OAuth 授权的完整 UI 管理
- 插件 Skills 映射到 MyAgents Skill 体系（仅桥接 Tools）
- 插件 CLI 命令在 MyAgents 中的 UI 封装

---

## 2. 关键技术决策

### 2.1 Bun 兼容性（已验证通过）

`@larksuite/openclaw-lark` 在 Bun 1.3.6 下完全兼容：所有依赖（axios、ws、protobufjs、node:crypto 等）均通过测试，无原生 addon。

### 2.2 SDK Shim 方案（手写 shim，非自动提取）

**核心问题**：OpenClaw 是单体架构，`plugin-sdk/feishu.ts` 的 44 个导出散布在 `channels/`、`auto-reply/`、`agents/` 等互相引用的核心模块中。任何打包/提取方式都会拉进整个框架（500MB+ 依赖或 14MB+ bundle）。

**评估过的方案**：

| 方案 | 结论 | 原因 |
|------|------|------|
| 从 npm tarball 提取 dist/ | ❌ | 不自包含，运行时需 40+ npm 包 |
| `bun build --bundle` 全内联 | ❌ | 14MB JS + 26MB native binary |
| `bun add openclaw` 完整安装 | ❌ | 55 依赖，500MB+，安装超时 |
| **手写完整 shim** | ✅ | 唯一可行方案 |

**实现**：基于 `openclaw/src/plugin-sdk/feishu.ts`（82 行 re-export 文件）逐个读取真实实现，编写匹配签名的 shim。详见 [openclaw_sdk_shim_analysis.md](../research/openclaw_sdk_shim_analysis.md)。

### 2.3 Streaming 实现（独立 adapter，非复用插件类）

`FeishuStreamingSession`（插件源码 375 行）虽然自包含，但唯一硬依赖 `fetchWithSsrFGuard` 来自 OpenClaw core。实现方案：在 Bridge 中编写独立的 `streaming-adapter.ts`，直接调用飞书 CardKit API（create card → update content → close streaming），用普通 `fetch` 替代 SSRF 保护。

---

## 3. 实际实现细节

### 3.1 UI：双入口 + Badge

**BotPlatformRegistry** 展示两个飞书入口：

```
┌─────────────────────────────────────────────────────┐
│ [feishu.jpeg]  飞书 Bot（官方插件）        [官方]    │
│                飞书开放平台官方 OpenClaw 插件         │
│                支持文档/表格/日历等深度集成           │
│                                    [点击安装] / [配置] │
├─────────────────────────────────────────────────────┤
│ [feishu.jpeg]  飞书 Bot（内置）        [即将下线]    │
│                通过飞书自建应用 Bot 远程使用 AI Agent │
│                ⚠️ 推荐迁移到官方插件版本              │
│                                             [配置]   │
└─────────────────────────────────────────────────────┘
```

- `[官方]`：飞书品牌蓝 `#3370FF`（品牌色例外）
- `[即将下线]`：灰色虚线边框 + 迁移提示文字
- `PlatformEntry` 新增 `platformBadge` 和 `deprecationNotice` 字段
- `PromotedPlugin` 新增 `badge?: 'official' | 'community'` 字段

### 3.2 CardKit Streaming 协议

#### Bridge 端点

```
POST /start-stream   { chatId, initialContent?, streamMode, receiveIdType?, replyToMessageId?, header? }
POST /stream-chunk   { streamId, content, sequence?, isThinking? }
POST /finalize-stream { streamId, finalContent? }
POST /abort-stream   { streamId }
```

**关键行为**：
- `isThinking=true` 时**跳过 update**，不写入 CardKit 内容（避免 `"__"` 标记污染最终文本）
- `/stop` 时遍历 `streamingSessions` 并 close 所有活跃 session（防泄漏）

#### Rust ImStreamAdapter trait

新增 6 个方法（均有默认实现，不影响现有 adapter）：

| 方法 | 用途 | 默认行为 |
|------|------|---------|
| `supports_streaming()` | 能力标记 | `false` |
| `start_stream(chat_id, initial_text)` | 开始流式 session | 返回空 string |
| `stream_chunk(chat_id, stream_id, text, seq, is_thinking)` | 推送内容 chunk | no-op |
| `finalize_stream(chat_id, stream_id, final_text)` | 结束流式 | no-op |
| `abort_stream(chat_id, stream_id)` | 中止流式 | no-op |
| `bridge_context()` | 返回 Bridge 端口/插件/工具组信息 | `None` |

#### stream_to_im_streaming()

约 210 行，处理 SSE 事件流：
- `partial` → 首次有意义文本时 `start_stream()`，后续 `stream_chunk()`
- `activity`（thinking/tool_use）→ 发送 thinking indicator chunk
- `block-end` → `finalize_stream()` 或 fallback 到 `send_message()`
- `error` → `abort_stream()`
- `complete` → 返回 session_id
- 异常断连 → 清理活跃 stream

### 3.3 工具桥接

#### 实际工具数量：35 个

插件 `register()` 注册了 **35 个工具**（原 PRD 估计 14 个是基于源码分析，实际 npm 发布版含更多工具）：

```
feishu_get_user, feishu_search_user, feishu_chat, feishu_chat_members,
feishu_im_user_message, feishu_im_user_fetch_resource, feishu_im_user_get_messages,
feishu_im_user_get_thread_messages, feishu_im_user_search_messages,
feishu_calendar_calendar, feishu_calendar_event, feishu_calendar_event_attendee,
feishu_calendar_freebusy, feishu_task_task, feishu_task_tasklist,
feishu_task_comment, feishu_task_subtask, feishu_bitable_app,
feishu_bitable_app_table, feishu_bitable_app_table_record,
feishu_bitable_app_table_field, feishu_bitable_app_table_view,
feishu_search_doc_wiki, feishu_drive_file, feishu_doc_comments,
feishu_doc_media, feishu_wiki_space, feishu_wiki_space_node,
feishu_sheet, feishu_im_bot_image, feishu_fetch_doc, feishu_create_doc,
feishu_update_doc, feishu_oauth, feishu_oauth_batch_auth
```

#### 注入方式：泛型代理

Sidecar 通过 `im-bridge-tools.ts` 注册两个 MCP 工具：

| 工具 | 用途 |
|------|------|
| `feishu_tool` | 泛型代理，接收 `tool_name` + `arguments` (JSON string)，转发到 Bridge `/mcp/call-tool` |
| `list_feishu_tools` | 列出当前可用的飞书工具及描述 |

**Tool Group 校验链路**：
1. 用户在 `OpenClawToolGroupsSelector` 勾选启用的工具组
2. 保存到 `ChannelConfig.openclawEnabledToolGroups`（通过 `agentConfigService.ts` 持久化）
3. Rust `ImConfig.openclaw_enabled_tool_groups` 读取用户配置
4. `BridgeAdapter.set_enabled_tool_groups()` 覆盖插件声明的组
5. `bridge_context()` 将用户配置的组传给 Sidecar
6. `im-bridge-tools.ts` 调用 `/mcp/call-tool` 时附带 `enabledGroups`
7. Bridge `/mcp/call-tool` 校验 tool 是否在启用组内，否则返回 403

#### UI 工具组选择

`OpenClawToolGroupsSelector.tsx`（仅 `openclaw-lark` 插件显示）：

| 组 ID | 组名 | 默认 |
|-------|------|------|
| `doc` | 文档 | ✅ |
| `chat` | 消息 | ✅ |
| `wiki_drive` | 知识库 & 云盘 | ✅ |
| `bitable` | 多维表格 | ✅ |
| `perm` | 权限管理 | ❌（敏感操作） |

### 3.4 SDK Shim 最终状态

#### 覆盖的子路径

| 路径 | 符号数 | 状态 |
|------|--------|------|
| `openclaw/plugin-sdk` (index.js) | ~30 运行时 | ✅ 全部实现 |
| `openclaw/plugin-sdk/feishu` | ~44 运行时 | ✅ 全部实现 |
| `openclaw/plugin-sdk/compat` | ~8 运行时 | ✅ 全部实现 |
| `openclaw/plugin-sdk/account-id` | 3 运行时 | ✅ 全部实现 |

#### compat-api 补充的方法

| 方法 | 用途 |
|------|------|
| `registerTool()` | 捕获工具定义（从 no-op 改为存储） |
| `on()` / `off()` / `emit()` | 事件 emitter（no-op，插件注册 `before_tool_call` 等 hook） |
| `registerCommand()` / `registerChatCommand()` | 聊天命令注册（no-op） |
| `registerMcpServer()` | MCP 服务注册（no-op） |

#### 插件加载验证（已通过）

```
[test] ✅ Import succeeded!
[test] ✅ register() completed!
[test]   Channels: 1
[test]   Tools: 35
[test]   Missing API methods (handled by Proxy): on, registerCli, registerCommand
```

### 3.5 Bridge 上下文传递链路

```
Rust BridgeAdapter
  │ bridge_context() → (bridge_port, plugin_id, enabled_tool_groups)
  │
  ▼ 写入 /api/im/chat POST body
Sidecar index.ts
  │ payload.bridgePort, payload.bridgePluginId, payload.bridgeEnabledToolGroups
  │
  ▼ setImBridgeToolsContext()
im-bridge-tools.ts (module-global context)
  │ bridgePort, pluginId, enabledToolGroups, senderId
  │
  ▼ buildSdkMcpServers() → 注入 im-bridge-tools MCP server
  │
  ▼ session teardown → clearImBridgeToolsContext()
```

---

## 4. 数据模型变更

### TypeScript

```typescript
// src/shared/types/agent.ts — ChannelConfig
openclawEnabledToolGroups?: string[];

// src/renderer/components/ImSettings/promotedPlugins.ts — PromotedPlugin
badge?: 'official' | 'community';

// src/renderer/components/ImSettings/BotPlatformRegistry.tsx — PlatformEntry
platformBadge?: 'builtin' | 'official' | 'deprecated' | 'plugin';
deprecationNotice?: string;
```

### Rust

```rust
// src-tauri/src/im/types.rs — ImConfig + AgentChannelConfig + BotConfigPatch
pub openclaw_enabled_tool_groups: Option<Vec<String>>,  // #[serde(default)]

// src-tauri/src/im/bridge.rs — BridgeAdapter
supports_streaming: bool,
supports_cardkit: bool,
enabled_tool_groups: Vec<String>,

// src-tauri/src/im/adapter.rs — ImStreamAdapter trait
fn bridge_context(&self) -> Option<(u16, String, Vec<String>)> { None }
fn supports_streaming(&self) -> bool { false }
// + start_stream, stream_chunk, finalize_stream, abort_stream
```

---

## 5. 详细改动范围

### 前端（5 文件）

| 文件 | 变更 |
|------|------|
| `promotedPlugins.ts` | 新增飞书官方插件条目 + `badge` 字段 |
| `BotPlatformRegistry.tsx` | 双入口 + Badge 组件 + deprecated 标记 |
| `ChannelDetailView.tsx` | 集成 OpenClawToolGroupsSelector |
| `OpenClawToolGroupsSelector.tsx` | **新建**：工具组选择器 |
| `agentConfigService.ts` | 持久化 `openclawEnabledToolGroups` |

### Plugin Bridge（12 文件）

| 文件 | 变更 |
|------|------|
| `compat-api.ts` | registerTool 捕获 + on/off/emit/registerCommand 等方法 |
| `compat-runtime.ts` | 传递 attachments/replyTo 上下文 |
| `index.ts` | +4 streaming 端点 + 2 MCP 端点 + capabilities 扩展 + session 清理 |
| `streaming-adapter.ts` | **新建**：FeishuStreamingSession CardKit 控制器 |
| `mcp-handler.ts` | **新建**：MCP 工具代理 |
| `sdk-shim/package.json` | 新增 3 个子路径 export |
| `sdk-shim/plugin-sdk/index.js` | 从 4 个符号扩展到 ~30 个 |
| `sdk-shim/plugin-sdk/feishu.js` | **新建**：44 个运行时符号完整 shim |
| `sdk-shim/plugin-sdk/compat.js` | **新建**：8 个运行时符号 |
| `sdk-shim/plugin-sdk/account-id.js` | **新建**：3 个运行时符号 |
| `sdk-shim/plugin-sdk/*.d.ts` | **新建**：3 个类型声明文件 |

### Rust（4 文件）

| 文件 | 变更 |
|------|------|
| `adapter.rs` | ImStreamAdapter 新增 6 个方法（含默认实现） |
| `bridge.rs` | BridgeAdapter streaming 实现 + capabilities 解析 + set_enabled_tool_groups + bridge_context |
| `mod.rs` | AnyAdapter dispatch + stream_to_im_streaming() 210 行 + bridge context 注入 payload |
| `types.rs` | ImConfig/AgentChannelConfig/BotConfigPatch 新增 `openclaw_enabled_tool_groups` |

### Sidecar（3 文件）

| 文件 | 变更 |
|------|------|
| `agent-session.ts` | buildSdkMcpServers() 注入 im-bridge-tools + clearImBridgeToolsContext 清理 |
| `index.ts` | setImBridgeToolsContext + payload 类型扩展 |
| `im-bridge-tools.ts` | **新建**：MCP 代理工具（feishu_tool + list_feishu_tools） |

### Types（1 文件）

| 文件 | 变更 |
|------|------|
| `agent.ts` | ChannelConfig 新增 openclawEnabledToolGroups |

### 文档（3 文件）

| 文件 | 变更 |
|------|------|
| `prd_0.1.42_feishu_openclaw_plugin.md` | 本文档 |
| `openclaw_sdk_shim_analysis.md` | SDK shim 方案深度分析 |
| `cron_issue.md` | Cross-review 发现的定时任务问题清单 |

---

## 6. Review 发现与修复

Cross-review（Claude Code + Codex CLI × 2，三份独立报告）发现以下飞书插件相关问题，全部已修复：

| # | 问题 | 发现者 | 修复 |
|---|------|--------|------|
| C1 | Tool-group 校验缺失，`feishu_perm` 等敏感工具可被绕过调用 | Codex ×2 + CC | `/mcp/call-tool` 加 enabledGroups 校验 + im-bridge-tools 传组 + agentConfigService 持久化 |
| C2 | Bridge tools context 是 module-global，session teardown 不清理导致跨 session 泄漏 | Codex ×2 + CC | session teardown 加 `clearImBridgeToolsContext()` |
| C3 | Thinking chunk 被 bridge 重写为 `"__"` 并合并进 CardKit 最终文本 | Codex + CC | `isThinking=true` 时跳过 update |
| C4 | `readFileSync` 在 SDK shim feishu.js 中使用，违反 CLAUDE.md 约束 | Codex | 改用 `await readFile()` (fs/promises) |
| C5 | 用户配置的 `openclawEnabledToolGroups` 未从 Rust 传到 Sidecar | CC | ImConfig/AgentChannelConfig/BotConfigPatch 新增字段 + BridgeAdapter.set_enabled_tool_groups() |
| W1 | Streaming session 泄漏（shutdown/stop 不清理活跃 session） | Codex ×2 + CC | `/stop` 时遍历并 close 所有 session |
| W2 | compat.d.ts 声明的函数在 compat.js 中不存在 | CC | 补 registerChannelPlugin/createChannelPluginFromModule |
| W3 | account-id.d.ts 缺 normalizeOptionalAccountId 声明 | CC | 补全 |

---

## 7. 验收标准

| 场景 | 预期结果 | 验证状态 |
|------|---------|---------|
| 安装插件 | 点击"点击安装"后安装成功，卡片变为"已安装" | — |
| 配置凭证 | 输入 appId/appSecret 后验证通过 | — |
| 启动 Bot | Bot 状态变为 Online，飞书端可发消息 | — |
| 私聊文本 | AI 回复显示为 CardKit 流式卡片 | — |
| 群聊 @机器人 | 群内 @bot → AI 回复到群 | — |
| CardKit Streaming | 实时流式文字更新，结束后卡片变完成状态 | — |
| 工具调用 | "帮我创建一个飞书文档" → AI 调用 feishu_tool → 返回结果 | — |
| 工具组开关 | 关闭"权限管理"组后 feishu_perm 不可调用 | — |
| 双入口展示 | 同时显示"官方"和"即将下线"两个飞书入口 | — |
| 内置飞书仍可用 | 已配置的用户不受影响 | — |
| 插件加载测试 | register() 完成，35 工具 + 1 channel 注册 | ✅ 已通过 |
| typecheck + lint | 零错误 | ✅ 已通过 |
| cargo check | 零错误 | ✅ 已通过 |
| Cross-review | 3 Critical + 5 Warning 全部修复 | ✅ 已完成 |

---

## 8. 风险与缓解

| 风险 | 级别 | 缓解 |
|------|------|------|
| 插件快速迭代导致 breaking change | 中 | pin 版本；SDK shim 枚举来源明确（feishu.ts 82 行） |
| SDK shim 不够完整（未来插件新增 import） | 中 | 维护策略：diff `openclaw/src/plugin-sdk/feishu.ts` 即知新增 |
| 从源码提取自包含 SDK 不可行 | — | 已验证并记录（详见 openclaw_sdk_shim_analysis.md） |
| 工具组选择器 UI 中的工具数量/分组是硬编码的 | 低 | 未来可从 Bridge `/capabilities` 动态获取 |
| Bridge tools context 是进程全局单例 | 低 | 已加 session teardown 清理；与 im-cron/im-media 使用相同模式 |
| 品牌色 `#3370FF` 硬编码 | 低 | 品牌色是合理例外；如需统一可抽为 CSS variable |

---

## 附录 A：飞书应用权限批量导入 JSON

完整 JSON 见 `specs/research/feishu_bot_doc.md` 第 168-269 行。

## 附录 B：参考实现文件

| 参考 | 路径 |
|------|------|
| 官方插件 Streaming 源码 | `openclaw/extensions/feishu/src/streaming-card.ts` |
| 官方插件 Reply Dispatcher | `openclaw/extensions/feishu/src/reply-dispatcher.ts` |
| 官方插件工具注册 | `openclaw/extensions/feishu/src/tools/` |
| OpenClaw 工具策略 | `openclaw/src/agents/tool-policy-pipeline.ts` |
| OpenClaw SDK 入口（权威符号枚举） | `openclaw/src/plugin-sdk/feishu.ts` (82 行) |
| SDK Shim 深度分析 | `specs/research/openclaw_sdk_shim_analysis.md` |
| QQBot Bridge 参考 | `src/server/plugin-bridge/` (现有实现) |
