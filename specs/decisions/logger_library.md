# ADR: Logger 实现选型 — 不替换为 pino / tracing-appender

> **Date:** 2026-04-25
> **Status:** Decided — 维持手写 logger，作为 v0.2.0 后期 follow-up 议题但不立即迁
> **Context:** v0.2.0 cross-review (review-by-cc) 把"用 pino / tracing-appender 替代手写 logger"标为 follow-up

## 问题

Pattern 6 实现期间，sidecar 端 `UnifiedLogger.ts` + Rust `logger.rs` 用手写约 250 行 + 200 行做了：

- Bounded async queue（Node 1000 entries / Rust mpsc 1024）
- 100ms / 200ms flush tick
- 50MB per-file rotation + 500MB total cap + 30d retention
- Drop counter 60s warning
- Process exit hook（exit/beforeExit/SIGINT/SIGTERM）同步 drain
- BufWriter（Rust）/ openSync+writeSync（Node）

cross-review (review-by-cc) flag："pino (Node) / tracing-appender (Rust) 是业界事实标准，250 行非平凡并发逻辑测试覆盖较薄"。

## 评估

### pino 替代 Node UnifiedLogger

**潜在收益：**
- 业界验证的性能（每秒数十万条 log）
- 成熟的 transport / formatter / level 体系
- 生态广（bindings、rotation 库、destination plugin）

**实际成本：**
- **`LogEntry` schema 耦合：** 当前 LogEntry 含 `source: 'bun'|'rust'|'react'`、`sessionId/tabId/turnId/runtime/requestId/ownerId` correlation 字段。pino 默认序列化是 JSON 但字段名固定（`level`、`time`、`msg`、`pid`、`hostname`），跟我们的 schema 不一致。需要 custom serializer 把 LogEntry 翻译成 pino 形状再翻回来读时使用。round-trip 不平衡。
- **SSE broadcast 耦合：** `createAndBroadcast` 同时写 unified log + SSE 广播 (`chat:log` event) + ring buffer (`getLogHistory` 给后接的 SSE client 重放)。pino 是单 sink 设计，要把 broadcast / ring buffer 接到 pino transport 上，代码量未必少。
- **AsyncLocalStorage 集成：** Pattern 6 让 console.* capture 自动从 ALS 拿 correlation。pino 自己有 child logger 模式但不读 ALS；要么写 custom mixin，要么放弃 ALS 入口（跟 PRD §6.2.0 "保留 console.* 入口"原则冲突）。
- **历史日志兼容：** unified-{date}.log 格式被 `unified_logging.md` 文档化（line 215 给了示例：`2026-03-26 10:30:45.123 [REACT] [INFO ] [TabProvider] SSE connected`），用户排查时会 grep。pino 默认 ndjson 格式不一样，需要 custom destination 维持。
- **退役 'bun' source 兼容：** v0.2.0 把 `'bun'` 字面量保留给历史日志兼容（cross-review 单独 fix #15 决定不动）。pino 切换会逼迫这个决定一并 revisit。
- **Exit hook drain：** pino async transport 在进程退出时的 flush 行为不如手写直观，需要额外 fastify-style `pino.destination({ sync: false }).flushSync()` + 调用约定。

**改造规模估计：** ~300-400 行代码改动 + 2-3 周 stabilization。

### tracing-appender 替代 Rust ulog_*!

**潜在收益：**
- `tracing` 是 Rust 现代生态事实标准，结构化字段 + span 自然支持
- `tracing-appender` 自带 rolling file appender（日级/时级 rotation）
- 跟 OpenTelemetry 生态打通（未来可观测性升级路径）

**实际成本：**
- **调用面广：** 当前 ulog_*! 在 Rust 代码里有 ~932 处调用（Pattern 6 子 Agent 报告）。即使 macros 兼容旧调用，全量替换 / 验证不便宜。
- **kv-pair 形式不同：** ulog_*! 现在用 `ulog_info!("msg", session_id = "x", turn_id = "y")` 形式（Pattern 6 加的）。tracing 的等价是 `tracing::info!(session_id = %"x", turn_id = %"y", "msg")` —— 字段顺序、字面量前缀都不一样。文本 search/replace 会漏边界 case。
- **格式跟 Node 端一致性：** Node 写 unified-{date}.log 行格式 `[BUN ] [INFO ] [TabProvider] msg`；Rust 当前 mirror 同格式。tracing 默认 layered formatter 不出此格式，需要 custom formatter。这又把"用业界标准"的优势抹平。
- **task_local 兼容：** Pattern 6 用 `tokio::task_local!` 做 LogContext 传递。tracing 自己有 span 机制；要么跟现有 task_local 共存（双轨），要么迁移所有 span boundary 到 `tracing::Span::enter`（再来一次大改）。
- **LogEntry → tauri Event 桥接：** Rust logger.rs 把 LogEntry emit 给 renderer (`log:rust` Tauri event)。tracing 不内置这种 sink；要写 custom Layer。
- **Performance 不是瓶颈：** Pattern 6 已经把"每条 log open/close 文件"换成 BufWriter + mpsc。当前实现的 throughput 已经够桌面应用使用（log 量级 < 1k entries/s 量级）。

**改造规模估计：** ~500+ 行代码改动 + 大量调用点替换 + 几周 stabilization。

## 决策

**不替换。** 维持手写 UnifiedLogger（Node）+ ulog_*!（Rust）。

理由：

1. **当前实现已通过质量门：** Pattern 6 + cross-review 两轮（review-by-cc / review-by-codex / review-architecture）+ codex review --base 共 4 次独立审查。除了 Pattern 6 commit message 自己标的 follow-up，无残留 critical 问题。
2. **替换的边际收益小：** Logger 是基础设施层，已经满足 PRD §6 全部不变量（bounded、correlation、rotation、缓冲）。pino / tracing 的收益主要在性能 + 生态，桌面端 sidecar 都不强需。
3. **替换的成本大：** 跟 SSE broadcast、AsyncLocalStorage、`'bun'` 兼容、`unified-{date}.log` 文本格式、Tauri event emit 多重耦合。一次性切换风险高。
4. **review-by-cc 自己也限定了"Acceptable as MVP"：** 这条 finding 不是 must-fix，是"Flag for follow-up"。
5. **触发条件未到：** 如果未来 throughput 翻 100 倍 / 多了 OTel 集成需求 / unified-log 文件格式可以 break，再 revisit。

## 触发再评估的信号

下次出现以下情况之一，重新打开本 ADR：

- 单进程 logger throughput 成为可观测瓶颈（profiling 数据 → log path > 10% CPU）
- OpenTelemetry / 统一观测平台接入需求
- `unified-{date}.log` 文件格式可以 break（破坏性版本升级机会）
- 手写 logger 出现非平凡并发 bug（单点 ≥ 2 次同类 fix）

## 不替换 ≠ 不改进

仍然要做的小幅迭代（未来某次 maintenance）：

- `unified-logger-bounded.test.ts` 测试覆盖目前 3 个 case（burst / flush / ring）；可加：rotation 触发、exit hook drain、drop counter 60s warning emit
- `process.on('exit', drain)` 跟 `SIGINT`/`SIGTERM` 之间的 listener 顺序细节（cross-review #15 提到的 SIGINT override）值得一次专项验证
- Rust mpsc bounded channel 的 backpressure 策略（满时直接 drop，不阻塞调用方）和 Node side bounded queue 的 drop 策略对齐（一致性）

这些都是 logger 本体内部的小修，不属于"换 lib"范畴。

---

*作者：Mino / 2026-04-25*
*相关：`prd_0.2.0_structural_refactors.md` §Pattern 6；`unified_logging.md`；commit `276b478`*
