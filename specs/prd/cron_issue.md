# 定时任务 Code Review 发现的问题清单

> **来源**：Cross-Review (Claude Code + Codex CLI) on branch `dev/0.1.42`
> **Date**: 2026-03-15
> **状态**: 待修复

---

## Critical Issues (must fix)

### C1. Rust — Scheduler race in `cmd_update_cron_task_fields`
- **文件**: `src-tauri/src/cron_task.rs` ~L2064
- **问题**: `stop_task()` 不清除 `active_schedulers`；`start_task_scheduler()` 在 task ID 仍在 set 中时 short-circuit。编辑后重启可能静默保留旧 schedule 参数。
- **来源**: Codex

### C2. Server — Cross-session task mutation via `im-cron` tool
- **文件**: `src/server/tools/im-cron-tool.ts` ~L261
- **问题**: `update`/`remove`/`run`/`runs` 操作只转发 `taskId`，无 ownership/workspace 检查。`im-cron` 现在注入到所有 session，任何 session 知道外部 `taskId` 就能修改/删除/触发其他工作区或 IM Bot 的任务。
- **来源**: Codex

### C3. Frontend — `CronTaskSettingsModal` loses `executionTarget` on reopen
- **文件**: `src/renderer/components/cron/CronTaskSettingsModal.tsx` ~L98
- **问题**: `executionTarget` 总是初始化为 `'current_session'`，重新打开 modal 会静默将已选的 standalone 任务转回 current-session 模式。
- **来源**: Codex

### C4. Frontend — `CronTaskDetailPanel` shows stale data after save
- **文件**: `src/renderer/components/CronTaskDetailPanel.tsx` ~L119
- **问题**: save 路径忽略 `updateCronTaskFields()` 返回的 `CronTask`。面板继续渲染旧的 `task` prop，用户看到过期数据直到面板被重新打开。
- **来源**: CC + Codex（两个 AI 都指出）

### C5. Frontend — Async state updates without `isMountedRef` guard
- **文件**: `src/renderer/components/CronTaskDetailPanel.tsx` ~L113
- **问题**: Delete/save/resume/stop handlers 在 await 之后调用 `setState` 但没有 unmount guard。delete 路径调用 `onClose()` 后仍在 `finally` 中执行 `setIsDeleting(false)`。违反项目的 React stability conventions。
- **来源**: Codex

### C6. Frontend — `ScheduleTypeTabs` crashes on empty datetime
- **文件**: `src/renderer/components/scheduled-tasks/ScheduleTypeTabs.tsx` ~L78
- **问题**: `new Date(...).toISOString()` 用于一次性定时但不 guard 空/无效的 `datetime-local` 值。清空字段抛出 `RangeError`。
- **来源**: Codex

### C7. Frontend — Invalid cron expressions not blocked at submit
- **文件**: `src/renderer/components/scheduled-tasks/CronExpressionInput.tsx` ~L155, `TaskCreateModal.tsx` ~L144
- **问题**: 无效 cron 文本在每次按键时传播给上层。UI 显示 parse error 但表单仍允许提交畸形 cron。
- **来源**: Codex

### C8. Frontend — Notification navigation hijack on window focus
- **文件**: `src/renderer/hooks/useTrayEvents.ts` ~L79
- **问题**: `consumePendingNavigation()` 在任何窗口获焦时（10 秒内）触发，而不是实际点击通知时。可能意外强制切换用户到其他 tab。
- **来源**: Codex

### C9. Frontend — `CustomSelect` fixed dropdown detaches on scroll
- **文件**: `src/renderer/components/CustomSelect.tsx` ~L47
- **问题**: fixed-position dropdown 只在打开时测量一次位置。在可滚动容器中，滚动时菜单视觉上脱离触发按钮。
- **来源**: CC + Codex

### C10. Rust — 新增 `start_at` 处理使用错误的日志宏
- **文件**: `src-tauri/src/cron_task.rs` L807-815
- **问题**: 使用 `log::info!` / `log::warn!` 而非 `ulog_info!` / `ulog_warn!`。这些日志会写入 Rust 系统日志但不会进入统一日志 `~/.myagents/logs/unified-*.log`，导致 `[CronTask]` 调试不一致。
- **来源**: CC

---

## Warnings (should fix)

### W1. Rust — `CronRunRecord` camelCase rename breaks backward compat
- **文件**: `src-tauri/src/cron_task.rs` ~L339
- **问题**: 添加 `#[serde(rename_all = "camelCase")]` 会破坏已有 snake_case JSONL 历史的反序列化（`duration_ms`）。旧执行历史会静默消失。
- **来源**: Codex

### W2. Rust — `interval_minutes` vs `schedule.minutes` inconsistency
- **文件**: `src-tauri/src/cron_task.rs` ~L2097
- **问题**: 只更新 `interval_minutes` 不更新 `schedule.minutes`，但 scheduler 优先使用 `schedule.minutes`。也跳过了 `create_task()` 使用的 `>= 5 minute` 限制。
- **来源**: Codex

### W3. Rust — Provider-env clear not propagated to active sidecars
- **文件**: `src-tauri/src/im/router.rs` ~L561
- **问题**: `sync_ai_config()` 只在 `provider_env` 为 `Some(_)` 时 POST。清除 provider config 会让运行中的 sidecar 保持旧凭证。
- **来源**: Codex

### W4. Server — `list`/`status` fallback leaks all tasks system-wide
- **文件**: `src/server/tools/im-cron-tool.ts` ~L203
- **问题**: cron context 缺失时，查询返回所有 session/workspace 的任务。
- **来源**: Codex

### W5. Server — `/api/provider/set` trusts arbitrary JSON
- **文件**: `src/server/index.ts` ~L5931
- **问题**: provider env 输入无 schema 校验。畸形字段可被持久化并转发。
- **来源**: Codex

### W6. Server — `sessionCronContext` captured once, never refreshed
- **文件**: `src/server/agent-session.ts` ~L3993
- **问题**: 持久 session 期间 config 变更不更新 cron context，后续创建的任务可能继承过期的 `permissionMode`/`providerEnv`。
- **来源**: Codex

### W7. Frontend — Chat.tsx async handlers use `toast.success()` directly
- **文件**: `src/renderer/pages/Chat.tsx` ~L1682
- **问题**: 应使用 `toastRef` 模式，符合 React stability conventions。
- **来源**: Codex

### W8. Frontend — `formatCronExpression()` side effect during render
- **文件**: `src/renderer/types/cronTask.ts` ~L240
- **问题**: 在 render 期间启动 `loadCronstrue()` 异步加载。resolved value 不触发 rerender，cron label 可能卡在 fallback 文本。
- **来源**: CC + Codex

### W9. Frontend — Hardcoded colors in new components
- **文件**: `TaskCreateModal.tsx`, `ScheduleTypeTabs.tsx`, `CronExpressionInput.tsx`, `CronTaskDetailPanel.tsx`, `CronTaskButton.tsx`
- **问题**: `bg-black/30`, `bg-white`, `text-white` 等硬编码颜色，违反 CSS token 设计系统约束。
- **来源**: Codex

### W10. Frontend — `TaskCreateModal` stale session after project change
- **文件**: `src/renderer/components/scheduled-tasks/TaskCreateModal.tsx` ~L115
- **问题**: 旧的 session-load 请求可能覆盖新工作区的 session。项目路径变更时 `selectedSessionId` 未清除。
- **来源**: Codex

### W11. Frontend — Edit-mode validation weaker than create modal
- **文件**: `src/renderer/components/CronTaskDetailPanel.tsx` ~L141
- **问题**: 不阻止空结束条件、无效 datetime 或 NaN 执行次数。
- **来源**: Codex

### W12. Frontend — `notification:show` listener cleanup missing
- **文件**: `src/renderer/App.tsx` ~L1523
- **问题**: 未使用取消模式（heartbeat effect 已使用）。Listener 可能在 unmount 时泄漏。
- **来源**: Codex

---

## Suggestions (nice to have)

### S1. 提取共享组件
- `TaskCreateModal`, `CronTaskDetailPanel`, `CronTaskSettingsModal` 独立定义了 `ToggleSwitch`、`Checkbox`、`SectionHeader`、`PillButton` 等相似组件，应提取为共享模块。
- **来源**: CC

### S2. `CronTaskManager.tasks` 应保持 private
- 改为提供 `update_task_fields_typed()` 方法，而非暴露 `pub(crate)` 内部数据结构。
- **来源**: CC + Codex

### S3. 统一 `ProviderEnv` 类型
- 在 `agent-session.ts`、`index.ts`、`im-cron-tool.ts` 之间统一 schema。
- **来源**: Codex

### S4. Debounce cron expression preview parsing
- `CronExpressionInput.tsx` 中 cron 表达式预览解析应做防抖。
- **来源**: Codex

### S5. `CronExpressionInput` useMemo 替代方案
- 使用 `useState(() => parseCronToVisual(expr))` 替代 `useMemo` + eslint-disable。
- **来源**: CC
