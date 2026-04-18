// TaskCardItem — richer card rendered in the 2-column card view.
// Replaces the previous flat TaskCard. Adds a left status stripe (only for
// active/blocked states so calm states stay calm), a persistent hover
// action row wired through <TaskItemActions>, and a meta row that doesn't
// try to squeeze every field onto one line.
//
// Deliberately omits the "来自想法: ..." reference (per product decision:
// that context lives in the detail overlay instead) to keep the card scan-
// friendly.

import { Bot, Clock, Layers, User } from 'lucide-react';

import type { Task } from '@/../shared/types/task';
import { DispatchOriginBadge } from '../DispatchOriginBadge';
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
  const stripeClass = stripeFor(status);
  const Icon = isLegacy ? Clock : Layers;
  const name = task?.name ?? legacy?.name ?? '—';
  const description = task?.description ?? '';
  const tags = task?.tags ?? [];
  const updatedAt = task?.updatedAt ?? legacy?.updatedAt ?? 0;
  // Running/verifying tasks keep their hover row pinned so the ■ button
  // is always visible — users expect to be able to stop an active task
  // without having to find the right hover target.
  const actionAlwaysVisible = status === 'running' || status === 'verifying';

  return (
    <button
      type="button"
      onClick={onOpen}
      className={`group relative flex w-full items-stretch overflow-hidden rounded-[var(--radius-lg)] border bg-[var(--paper-elevated)] text-left transition-all hover:border-[var(--line-strong)] hover:shadow-sm hover:-translate-y-[1px] ${
        highlighted ? 'border-[var(--accent-warm)] shadow-sm' : 'border-[var(--line)]'
      }`}
    >
      {stripeClass && (
        <span className={`absolute inset-y-0 left-0 w-1 ${stripeClass}`} aria-hidden />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-2 px-3 py-3">
        {/* Row 1 — icon + name + status chip + hover actions */}
        <div className="flex items-start gap-2">
          <Icon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--ink-muted)]" />
          <div className="min-w-0 flex-1">
            <div className="line-clamp-2 text-[13px] font-medium leading-snug text-[var(--ink)]">
              {name}
            </div>
          </div>
          <div className="flex shrink-0 items-start gap-1.5">
            {isLegacy ? (
              <span
                className="rounded-[var(--radius-sm)] bg-[var(--paper-inset)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--ink-muted)]"
                title="v0.1.69 之前的定时任务"
              >
                遗留
              </span>
            ) : (
              <TaskStatusBadge status={status} compact />
            )}
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
          </div>
        </div>

        {/* Description — two-line clamp, optional */}
        {description && (
          <div className="line-clamp-2 text-[12px] leading-relaxed text-[var(--ink-muted)]">
            {description}
          </div>
        )}

        {/* Meta row — executor / mode / dispatch origin / time, then tags */}
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--ink-muted)]/80">
          {task && task.executor === 'agent' ? (
            <Bot className="h-3.5 w-3.5 text-[var(--accent-warm)]" aria-label="Agent" />
          ) : task ? (
            <User className="h-3.5 w-3.5 text-[var(--ink-muted)]" aria-label="User" />
          ) : null}
          {task && <DispatchOriginBadge origin={task.dispatchOrigin} compact />}
          {task && task.executionMode !== 'once' && (
            <span className="rounded-[var(--radius-sm)] bg-[var(--paper-inset)] px-1.5 py-0.5 text-[10px]">
              {modeLabel(task.executionMode)}
            </span>
          )}
          {legacy?.workspacePath && (
            <span className="truncate">{shortenPath(legacy.workspacePath)}</span>
          )}
          <span className="ml-auto">{relativeTime(updatedAt)}</span>
        </div>

        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {tags.slice(0, 4).map((t) => (
              <span
                key={t}
                className="rounded-[3px] bg-[var(--accent-warm-subtle)] px-1 text-[10px] text-[var(--accent-warm)]"
              >
                #{t}
              </span>
            ))}
          </div>
        )}
      </div>
    </button>
  );
}

function stripeFor(status: string): string | null {
  if (status === 'running' || status === 'verifying') return 'bg-[var(--accent-warm)]';
  if (status === 'blocked') return 'bg-[var(--error)]';
  return null;
}

function modeLabel(m: Task['executionMode']): string {
  switch (m) {
    case 'scheduled':
      return '定时';
    case 'recurring':
      return '周期';
    case 'loop':
      return '循环';
    default:
      return '';
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
  if (mins < 60) return `${mins} 分钟前`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} 小时前`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days} 天前`;
  return new Date(ts).toLocaleDateString();
}
