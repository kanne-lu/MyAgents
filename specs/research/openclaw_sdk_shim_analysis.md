# OpenClaw SDK Shim 深度分析：为什么不能自动提取，只能手写

> **Date**: 2026-03-15
> **Context**: 飞书官方 OpenClaw 插件 (`@larksuite/openclaw-lark`) 接入 MyAgents Plugin Bridge
> **结论**: 手写完整 shim 是唯一可行方案

---

## 问题

OpenClaw 插件通过 `import { xxx } from "openclaw/plugin-sdk/feishu"` 引用 SDK 工具函数。
MyAgents Plugin Bridge 需要提供这些符号的实现，否则插件加载时直接崩溃。

飞书插件需要 **~44 个运行时符号**（QQBot 只需 4 个）。

## 尝试过的方案及失败原因

### 方案 1: 从 npm tarball 提取预构建 dist/

**失败原因**：dist/plugin-sdk/ 的 JS 文件**不是自包含的**。
Rollup 构建产物中，`thread-bindings-SYAnWHuW.js`（5.7MB mega-chunk）仍有 40+ 个外部 npm import：

```
discord-api-types, grammy, @slack/bolt, @whiskeysockets/baileys,
playwright-core, @buape/carbon, @line/bot-sdk, @mariozechner/pi-ai,
@modelcontextprotocol/sdk, @aws-sdk/client-bedrock, sharp, ...
```

这些包合计 500MB+，和完整安装 openclaw 没有区别。

### 方案 2: `bun build --bundle --packages external` 从源码构建

**结果**：7.45MB 单文件，但仍然 import 40+ 个外部包（只是没有内联它们）。

```bash
cd openclaw && bun build src/plugin-sdk/feishu.ts --outdir /tmp/sdk-bundle --bundle --target bun --packages external
# → 7.45 MB, 仍需 discord-api-types, grammy, @slack/bolt 等
```

### 方案 3: `bun build --bundle` 全部内联

**结果**：14.1MB JS + 26.5MB native binary（skia.node），不可接受。

```bash
bun build src/plugin-sdk/feishu.ts --outdir /tmp/sdk-bundle-v2 --bundle --target bun \
  --external playwright-core --external sharp --external electron ...
# → 14.1 MB JS + 26.13 MB native binary
```

### 方案 4: `bun add openclaw`（完整安装 SDK）

**结果**：55 个依赖，94.8MB 包体 + ~500MB node_modules，安装超时。

## 根因分析

OpenClaw 是**单体架构**。plugin-sdk/feishu.ts 的 44 个导出来自以下内部模块：

```
src/plugin-sdk/feishu.ts
  ├── ../auto-reply/reply/history.ts      → 历史管理
  ├── ../channels/plugins/onboarding/     → 引导流程
  ├── ../channels/plugins/pairing/        → 配对机制
  ├── ../channels/logging.ts              → 日志
  ├── ../channels/plugins/channel.ts      → 频道状态
  ├── ../infra/net/fetch-guard.ts         → SSRF 防护
  └── ../infra/rate-limit.ts              → 限流
```

这些内部模块**互相引用**了所有渠道实现（Telegram, Discord, Slack, WhatsApp, LINE 等），
导致任何提取/打包方式都会拉进整个框架。

```
feishu.ts → history.ts → pi-tools.ts → channels/telegram/... → import grammy
                                      → channels/discord/...  → import discord.js
                                      → channels/slack/...    → import @slack/bolt
```

这是 OpenClaw 的架构选择：所有渠道共享一个 mega-chunk。对它们的部署模式（单进程 Node.js）没问题，
但对我们的隔离式 Plugin Bridge 来说是个障碍。

## 最终方案：手写完整 shim

### 符号分类

| 类别 | 数量 | 做法 | 示例 |
|------|------|------|------|
| 常量 | 5 | 直接定义值 | `DEFAULT_GROUP_HISTORY_LIMIT = 50` |
| 简单工具函数 | 10 | 1-3 行实现 | `normalizeAgentId(id) → id.trim().toLowerCase()` |
| 工厂函数（返回对象） | 8 | 返回正确 shape | `createDedupeCache() → { check, peek, delete }` |
| 有状态函数 | 6 | Map/计数器实现 | `createFixedWindowRateLimiter() → 计数器+定时重置` |
| Bridge 不执行的 | 15 | no-op | `promptSingleChannelSecretInput() → async noop` |
| 已有 shim | 3 | 保持 | `fetchWithSsrFGuard`, `evaluateSenderGroupAccessForPolicy`, `withTempDownloadPath` |

### 枚举来源

**权威来源文件**：`openclaw/src/plugin-sdk/feishu.ts`（82 行纯 re-export）

```typescript
// 每一行 export 就是一个需要 shim 的符号
export { buildPendingHistoryContextFromMap, ... } from "../auto-reply/reply/history.js";
export { createDedupeCache, ... } from "../channels/dedup.js";
// ...
```

### 维护策略

当 openclaw 发布新版本时：
1. `diff openclaw/src/plugin-sdk/feishu.ts` 查看新增/删除的导出
2. 对新增符号补充 shim
3. 频率预计很低（该文件注释说 "Keep this list additive and scoped"）

### 为什么手写 shim 可以工作

关键认知：在 Bridge 模式下，很多 SDK 函数被调用但其结果被忽略或被 Rust 层覆盖：

- **去重**：Rust 层有独立的 72h TTL 去重机制，SDK 的 dedup 只是冗余
- **限流**：Rust 层控制消息发送频率，SDK 的 rate limiter 是冗余保护
- **历史管理**：Sidecar 有自己的 session 历史，SDK 的 history 辅助函数只影响上下文拼接
- **引导/配对**：Bridge 不触发 onboarding 流程，这些函数只被引用不被调用
- **打字状态**：Bridge 不使用 OpenClaw 的 typing indicator

因此大部分 shim 只需要 "不崩溃 + 返回合理默认值" 即可。
少数真正影响行为的（如 dedup、history context），实现简单的内存版本足够。
