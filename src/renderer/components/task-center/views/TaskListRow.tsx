// TaskListRow — dense single-line row used by the list view for fast scan +
// filter. No card chrome (no rounded corners, no shadow, no per-row border
// box) so the list reads as a table. Actions only appear on hover.
//
// Layout (left → right): status pill · mode icon · name (flex-1) · workspace
// · updated-at · hover-actions.

import { Clock, Repeat, Timer, Calendar, Play } from 'lucide-react';

import type { Task } from '@/../shared/types/task';
import { TaskStatusBadge } from '../TaskStatusBadge';
import { TaskItemActions, deriveTaskRowStatus } from './TaskItemActions';
import type { LegacyCronRow } from './types';

export interface TaskListRowProps {
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

export function TaskListRow(props: TaskListRowProps) {
  const { task, legacy, highlighted, busy, onOpen, onRun, onStop, onRerun, onDelete } = props;
  const isLegacy = !!legacy && !task;
  const status = deriveTaskRowStatus(task ?? null, legacy?.status === 'running');
  const name = task?.name ?? legacy?.name ?? '—';
  const workspace = legacy?.workspacePath
    ? shortenPath(legacy.workspacePath)
    : '';
  const updatedAt = task?.updatedAt ?? legacy?.updatedAt ?? 0;
  const actionAlwaysVisible = status === 'running' || status === 'verifying';

  return (
    <button
      type="button"
      onClick={onOpen}
      className={`group flex w-full items-center gap-3 border-b border-[var(--line-subtle)] px-3 py-2 text-left transition-colors hover:bg-[var(--hover-bg)] ${
        highlighted ? 'bg-[var(--accent-warm-subtle)]' : ''
      }`}
    >
      {/* Status badge — fixed slot so rows line up vertically */}
      <span className="w-[68px] shrink-0">
        {isLegacy ? (
          <span className="inline-flex items-center rounded-[var(--radius-sm)] bg-[var(--paper-inset)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--ink-muted)]">
            遗留
          </span>
        ) : (
          <TaskStatusBadge status={status} compact />
        )}
      </span>
      <ModeIconSlot isLegacy={isLegacy} mode={task?.executionMode} />
      <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--ink)]">
        {name}
      </span>
      {workspace && (
        <span className="hidden max-w-[110px] shrink-0 truncate text-[11px] text-[var(--ink-muted)] sm:block">
          {workspace}
        </span>
      )}
      <span className="w-[80px] shrink-0 text-right text-[11px] text-[var(--ink-muted)]/80">
        {relativeTime(updatedAt)}
      </span>
      <TaskItemActions
        variant={isLegacy ? 'legacy' : 'task'}
        status={status}
        busy={busy}
        onRun={onRun}
        onStop={onStop}
        onRerun={onRerun}
        onOpenDetail={onOpen}
        onDelete={onDelete}
        alwaysVisible={actionAlwaysVisible}
      />
    </button>
  );
}

/** Inline icon slot — kept as its own component so the render path never
 *  capitalises a local binding (which `react-hooks/static-components` treats
 *  as a new component created during render). */
function ModeIconSlot({ isLegacy, mode }: { isLegacy: boolean; mode: Task['executionMode'] | undefined }) {
  const cls = 'h-3.5 w-3.5 shrink-0 text-[var(--ink-muted)]';
  if (isLegacy) return <Clock className={cls} />;
  switch (mode) {
    case 'scheduled':
      return <Calendar className={cls} />;
    case 'recurring':
      return <Timer className={cls} />;
    case 'loop':
      return <Repeat className={cls} />;
    default:
      return <Play className={cls} />;
  }
}

function shortenPath(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function relativeTime(ts: number): string {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins}分钟前`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}小时前`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}天前`;
  return new Date(ts).toLocaleDateString();
}
