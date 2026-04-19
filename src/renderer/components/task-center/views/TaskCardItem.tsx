// TaskCardItem — richer card rendered in the 2-column card view.
//
// v0.1.69 visual rebuild (driven by the mock in
// prd_0.1.69_task_center_visual_feedback.md v2):
//
//   Row 1  — [Category chip left]                       [Status chip + hover actions right]
//   Row 2  — [Title, 16px semibold, clamp-2]
//   Row 3  — [📁 workspace · mode-aware meta · time/rounds]
//   Row 4  — (optional) ActivityBar — latest statusHistory message,
//            rendered when the task is in running or blocked state so
//            users can see "what's happening right now" or "why it's
//            stuck" without opening the detail overlay.
//
// Left vertical stripe was removed — the status chip on the right + the
// category chip on the left already carry the "state" and "kind" axes;
// a third indicator in the form of a color stripe would triple-count
// the same signal. Legacy-cron identity collapses into the category
// chip as "心跳循环 · 遗留" / "周期 · 遗留" etc., so the grid no longer
// needs a separate "遗留" pill — see <TaskCategoryBadge legacy />.

import { useEffect, useState } from 'react';
import { Folder } from 'lucide-react';

import { taskGetRunStats } from '@/api/taskCenter';
import type { Task, TaskExecutionMode, TaskRunStats } from '@/../shared/types/task';
import { TaskCategoryBadge } from '../TaskCategoryBadge';
import { TaskStatusBadge } from '../TaskStatusBadge';
import { TaskItemActions, deriveTaskRowStatus } from './TaskItemActions';
import type { LegacyCronRow } from './types';

export interface TaskCardItemProps {
  task?: Task;
  legacy?: LegacyCronRow;
  highlighted?: boolean;
  busy?: boolean;
  onOpen: () => void;
  onRun?: () => void;
  onStop?: () => void;
  onRerun?: () => void;
  onDelete?: () => void;
}

export function TaskCardItem(props: TaskCardItemProps) {
  const { task, legacy, highlighted, busy, onOpen, onRun, onStop, onRerun, onDelete } = props;
  const isLegacy = !!legacy && !task;
  const status = deriveTaskRowStatus(task ?? null, legacy?.status === 'running');
  const name = task?.name ?? legacy?.name ?? '—';
  const updatedAt = task?.updatedAt ?? legacy?.updatedAt ?? 0;
  const category = task ? task.executionMode : inferLegacyCategory(legacy);

  // Loop + recurring tasks surface "第 N 轮" / "已执行 N 次" — both pull
  // from CronTask.execution_count. RunStats is a per-card fetch because
  // the count lives on the linked CronTask, not on the Task row itself.
  // One Tauri round-trip per card; negligible for dashboards < 50 cards
  // and localises the read (no panel-level Map to keep in sync).
  const [runStats, setRunStats] = useState<TaskRunStats | null>(null);
  const shouldFetchStats =
    !!task && (task.executionMode === 'loop' || task.executionMode === 'recurring');
  useEffect(() => {
    if (!shouldFetchStats || !task?.id) return;
    let cancelled = false;
    void taskGetRunStats(task.id)
      .then((s) => {
        if (!cancelled) setRunStats(s);
      })
      .catch(() => {
        /* silent — "第 N 轮" just doesn't render, card still works */
      });
    return () => {
      cancelled = true;
    };
  }, [shouldFetchStats, task?.id]);

  // Activity bar content — quote the latest statusHistory message IFF
  // it's user-meaningful. Whitelist:
  //   - `cli`   — agent-submitted via `myagents task update-status` (real
  //               progress / blocker reason)
  //   - `ui`    — user wrote it via the detail overlay (own note)
  //   - `crash` — boot recovery ("上次被重启中断"); worth surfacing so
  //               the user knows why the task landed in blocked without
  //               their doing
  // Creation entries (`from == null`) are skipped even when source is
  // `ui` — the auto-generated "created (direct)" row isn't something a
  // user needs to see on every new card. `system`/`scheduler`/`rerun`/
  // `migration`/`watchdog`/`endCondition` are all audit-only: useful
  // in the detail overlay's timeline, but noise on the card.
  const latestHistory = task?.statusHistory?.at(-1);
  const activityMessage: string | null = (() => {
    if (!latestHistory) return null;
    if (latestHistory.from === null) return null;
    const src = latestHistory.source;
    if (src !== 'cli' && src !== 'ui' && src !== 'crash') return null;
    const msg = latestHistory.message?.trim();
    return msg && msg.length > 0 ? msg : null;
  })();

  return (
    <button
      type="button"
      onClick={onOpen}
      className={`group relative flex w-full flex-col gap-2.5 rounded-[var(--radius-lg)] border bg-[var(--paper-elevated)] p-4 pr-10 text-left transition-all hover:border-[var(--line-strong)] hover:shadow-sm hover:-translate-y-[1px] ${
        highlighted ? 'border-[var(--accent-warm)] shadow-sm' : 'border-[var(--line)]'
      }`}
    >
      {/* "…" menu — absolutely pinned to the card's top-right corner so
          its position is stable no matter how wide the chip row gets.
          Chip row gets `pr-10` reserved above so its rightmost chip
          can't overlap the menu button. */}
      <div className="absolute right-2 top-2 z-10">
        <TaskItemActions
          variant={isLegacy ? 'legacy' : 'task'}
          status={status}
          busy={busy}
          onRun={onRun}
          onStop={onStop}
          onRerun={onRerun}
          onOpenDetail={onOpen}
          onDelete={onDelete}
        />
      </div>

      {/* Row 1 — chip row, tags in explicit order: status first, category
          second. Both chips are always pill-shaped; no hover-only
          affordances in this row. */}
      <div className="flex flex-wrap items-center gap-1.5">
        <TaskStatusBadge status={status} compact />
        <TaskCategoryBadge mode={category} legacy={isLegacy} />
      </div>

      {/* Row 2 — title. 14px / weight 500 per the reference mock — the
          earlier text-base/semibold read too heavy next to the card's
          tiny meta row. Slight negative letter-spacing tightens the
          CJK rhythm so the title doesn't feel "plumped" at weight 500. */}
      <div
        className="line-clamp-2 text-sm font-medium leading-snug text-[var(--ink)]"
        style={{ letterSpacing: '-0.005em' }}
      >
        {name}
      </div>

      {/* Row 3 — meta: folder + workspace + · + mode-aware schedule/round + · + time */}
      <MetaRow
        task={task}
        legacy={legacy}
        category={category}
        executionCount={runStats?.executionCount ?? 0}
        updatedAt={updatedAt}
      />

      {/* Row 4 — optional activity bar. Rendered only when there's a
          user-meaningful message (see `activityMessage` derivation up
          top). One visual treatment for all variants — this is a
          "quote" of the last human/agent note, not a status colour. */}
      {activityMessage && <ActivityBar message={activityMessage} />}
    </button>
  );
}

/**
 * Meta row — one `·`-separated line describing *how this task runs*.
 * Content varies per category:
 *
 *   once       workspace · 一次性 · <updatedAt-relative>
 *   loop       workspace · 心跳循环 · 第 N 轮
 *   scheduled  workspace · <formatted dispatch time>
 *   recurring  workspace · <interval or cron> [· 已执行 N 次]
 *
 * Legacy cron rows fall into whichever category their schedule kind maps
 * to; we don't have full schedule-detail access here, so we degrade to a
 * plain relative-time tail.
 */
function MetaRow({
  task,
  legacy,
  category,
  executionCount,
  updatedAt,
}: {
  task?: Task;
  legacy?: LegacyCronRow;
  category: TaskExecutionMode;
  executionCount: number;
  updatedAt: number;
}) {
  const workspace = workspaceName(task, legacy);
  const parts: string[] = [];
  // User-executor tasks render as "自己做" since they're the user's own
  // todo items rather than AI-dispatched work. Agent is the default and
  // stays implicit.
  if (task?.executor === 'user') parts.push('自己做');

  switch (category) {
    case 'once':
      parts.push('一次性');
      if (updatedAt) parts.push(relativeTime(updatedAt));
      break;
    case 'loop':
      parts.push('心跳循环');
      if (executionCount > 0) parts.push(`第 ${executionCount} 轮`);
      else if (updatedAt) parts.push(relativeTime(updatedAt));
      break;
    case 'scheduled': {
      const when = task?.dispatchAt ?? task?.endConditions?.deadline;
      if (when) parts.push(formatAbsolute(when));
      else if (updatedAt) parts.push(relativeTime(updatedAt));
      break;
    }
    case 'recurring': {
      const sched = formatRecurring(task);
      if (sched) parts.push(sched);
      if (executionCount > 0) parts.push(`已执行 ${executionCount} 次`);
      break;
    }
  }

  return (
    <div className="flex items-center gap-1.5 text-[11px] text-[var(--ink-muted)]">
      <Folder className="h-3 w-3 shrink-0" strokeWidth={1.5} />
      <span className="truncate">{workspace}</span>
      {parts.map((p, i) => (
        <span key={i} className="contents">
          <MetaSep />
          <span className={i === parts.length - 1 ? 'truncate' : undefined}>{p}</span>
        </span>
      ))}
    </div>
  );
}

/**
 * Inline activity bar — one uniform "quote" treatment for every kind
 * of message we surface (agent progress, agent blocker reason, user
 * note, crash-recovery). Left hairline + paper tint is the same
 * vocabulary the detail overlay uses for the "来自想法" source quote,
 * so the two surfaces read as related. Status colour is carried by the
 * status badge above; this bar doesn't re-encode it.
 */
function ActivityBar({ message }: { message: string }) {
  // Softer wash than solid `--paper-inset`. Tailwind's `/60` alpha
  // modifier doesn't resolve against arbitrary CSS vars, so we go
  // through color-mix instead.
  return (
    <div
      className="flex items-start gap-2 rounded-r-[var(--radius-sm)] border-l-2 border-[var(--line-strong)] px-2.5 py-1.5 text-[12px] leading-snug text-[var(--ink-muted)]"
      style={{
        backgroundColor:
          'color-mix(in srgb, var(--paper-inset) 55%, var(--paper-elevated))',
      }}
    >
      <span className="line-clamp-2">{message}</span>
    </div>
  );
}

function MetaSep() {
  return (
    <span className="text-[var(--ink-muted)]/50" aria-hidden>
      ·
    </span>
  );
}

/** Best guess at the "kind" of a legacy cron from its schedule shape. */
function inferLegacyCategory(legacy?: LegacyCronRow): TaskExecutionMode {
  if (!legacy) return 'once';
  const sched = (legacy.raw as { schedule?: { kind?: string } }).schedule;
  const kind = sched?.kind;
  if (kind === 'loop') return 'loop';
  if (kind === 'at') return 'scheduled';
  // "every" / "cron" / undefined → recurring is the safe default for
  // legacy rows that don't have a resolvable schedule shape.
  return 'recurring';
}

function workspaceName(task?: Task, legacy?: LegacyCronRow): string {
  const raw = task?.workspacePath ?? legacy?.workspacePath ?? '';
  if (!raw) return '—';
  const parts = raw.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] ?? raw;
}

function formatAbsolute(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (sameDay) return `今天 ${hh}:${mm}`;
  // Tomorrow check — diff of 1 day, sensitive to DST transitions is fine
  // for a display string.
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (
    d.getFullYear() === tomorrow.getFullYear() &&
    d.getMonth() === tomorrow.getMonth() &&
    d.getDate() === tomorrow.getDate()
  ) {
    return `明天 ${hh}:${mm}`;
  }
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
}

function formatRecurring(task?: Task): string | null {
  if (!task) return null;
  if (task.cronExpression) {
    // Show the raw expression; too-clever "每日 08:30" inference would
    // need a cron→humanized mapper and a tz-aware clock. Keep it honest.
    return task.cronExpression;
  }
  if (task.intervalMinutes) {
    const m = task.intervalMinutes;
    if (m >= 60 && m % 60 === 0) return `每 ${m / 60} 小时`;
    return `每 ${m} 分钟`;
  }
  return null;
}

function relativeTime(ts: number): string {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} 小时前`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days} 天前`;
  return new Date(ts).toLocaleDateString();
}
