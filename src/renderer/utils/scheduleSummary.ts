// scheduleSummary — human-readable schedule line for a Task, suitable
// for the preview overlay's SummaryCard.
//
// Why this lives here (not inlined in the overlay):
//   * cronstrue + cron-parser are async-imported (same pattern as
//     `CronExpressionInput`) so the bundle doesn't eagerly load them
//     for screens that never open the overlay.
//   * Every execution mode returns the same shape, so the consumer
//     just renders `title` (big) + optional `next` (small) without
//     branching in JSX.
//   * Tests can target this util directly.
//
// Design goal: answer the question "when will this fire next?" in one
// glance. For recurring/cron tasks that means translating cron →
// Chinese + computing the next trigger time + a rough countdown.

import type { Task, TaskExecutionMode } from '@/../shared/types/task';

export interface ScheduleSummary {
  /** Execution mode (passed through from the Task — consumer picks the icon). */
  mode: TaskExecutionMode;
  /** Primary one-line readout. Chinese, speakable. */
  title: string;
  /** Next-trigger line, when known. Empty for `once` / `loop` /
   *  past-due `scheduled`. */
  next?: string;
  /** IANA tz, surfaced only for cron-mode recurring with an explicit tz. */
  timezone?: string;
}

/**
 * Build a render-ready summary for the given task. Async because
 * cronstrue and cron-parser are dynamically imported (same as
 * CronExpressionInput), keeping them out of the non-overlay bundle.
 *
 * `nextExecutionAtMs` — if the Rust scheduler already knows when the
 * next fire is (via `CronTask.next_execution_at`), the caller can
 * bypass the frontend computation by passing it in. Otherwise we
 * fall back to `cron-parser` / `intervalMinutes + lastExecutedAt`.
 */
export async function summarizeSchedule(
  task: Task,
  nextExecutionAtMs?: number | null,
): Promise<ScheduleSummary> {
  const mode = task.executionMode;

  if (mode === 'once') {
    return { mode, title: '一次性' };
  }

  if (mode === 'loop') {
    return {
      mode,
      title: '心跳循环',
      next: '连续触发(无定时),完成即下一轮',
    };
  }

  if (mode === 'scheduled') {
    const at =
      task.dispatchAt ??
      task.endConditions?.deadline ??
      null;
    if (!at) {
      return { mode, title: '定时一次 · 未设置时间' };
    }
    const when = new Date(at);
    const title = `定时一次 · ${formatAbsolute(when)}`;
    const delta = at - Date.now();
    const next = delta > 0 ? `${formatRelativeFuture(delta)}后触发` : '已过期';
    return { mode, title, next };
  }

  // recurring
  if (task.cronExpression) {
    const expr = task.cronExpression.trim();
    const tz = task.cronTimezone?.trim() || undefined;
    const title = await describeCron(expr);
    const next = await computeNextCronFire(expr, tz, nextExecutionAtMs);
    return {
      mode,
      title: title ?? `周期 · ${expr}`,
      next,
      timezone: tz,
    };
  }

  if (task.intervalMinutes) {
    const mins = task.intervalMinutes;
    const title = formatInterval(mins);
    const next = formatIntervalNext(mins, task.lastExecutedAt ?? null, nextExecutionAtMs);
    return { mode, title, next };
  }

  return { mode, title: '周期 · 未设置' };
}

// ---------- formatters ----------

/** `4月21日 周一 11:00` — locale-aware, single line, no year when in 2026. */
function formatAbsolute(d: Date): string {
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const opts: Intl.DateTimeFormatOptions = {
    ...(sameYear ? {} : { year: 'numeric' }),
    month: 'short',
    day: 'numeric',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  };
  return d.toLocaleString('zh-CN', opts);
}

/** `~13 小时` / `~5 分钟` / `~2 天` — rough, always positive. */
function formatRelativeFuture(deltaMs: number): string {
  const mins = Math.round(deltaMs / 60_000);
  if (mins < 1) return '不到 1 分钟';
  if (mins < 60) return `约 ${mins} 分钟`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `约 ${hours} 小时`;
  const days = Math.round(hours / 24);
  return `约 ${days} 天`;
}

function formatInterval(mins: number): string {
  if (mins % (24 * 60) === 0) return `每 ${mins / (24 * 60)} 天`;
  if (mins % 60 === 0) return `每 ${mins / 60} 小时`;
  return `每 ${mins} 分钟`;
}

async function describeCron(expr: string): Promise<string | null> {
  try {
    const mod = await import('cronstrue/i18n');
    const toStr = mod.toString as (e: string, o?: Record<string, unknown>) => string;
    return toStr(expr, { locale: 'zh_CN' });
  } catch {
    return null;
  }
}

async function computeNextCronFire(
  expr: string,
  tz: string | undefined,
  nextExecutionAtMs?: number | null,
): Promise<string | undefined> {
  // Rust scheduler already told us → prefer that, avoids tz drift
  // between cron-parser and the backend.
  if (typeof nextExecutionAtMs === 'number' && nextExecutionAtMs > 0) {
    return formatNextAbs(nextExecutionAtMs);
  }
  try {
    const mod = await import('cron-parser');
    const interval = mod.CronExpressionParser.parse(expr, tz ? { tz } : undefined);
    const at = interval.next().toDate().getTime();
    return formatNextAbs(at);
  } catch {
    return undefined;
  }
}

function formatIntervalNext(
  mins: number,
  lastExecutedAtMs: number | null,
  nextExecutionAtMs?: number | null,
): string | undefined {
  if (typeof nextExecutionAtMs === 'number' && nextExecutionAtMs > 0) {
    return formatNextAbs(nextExecutionAtMs);
  }
  if (!lastExecutedAtMs) return undefined;
  const at = lastExecutedAtMs + mins * 60_000;
  return formatNextAbs(at);
}

function formatNextAbs(ms: number): string {
  const now = Date.now();
  const delta = ms - now;
  if (delta <= 0) return '下次触发 即将发生';
  return `下次触发 ${formatAbsolute(new Date(ms))} · ${formatRelativeFuture(delta)}后`;
}
