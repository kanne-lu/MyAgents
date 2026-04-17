// TaskCard — compact row in the right column task list.
// Click → open TaskDetailOverlay. Hover reveals action buttons (rerun / archive).

import { Layers, Bot, User } from 'lucide-react';
import type { Task } from '@/../shared/types/task';
import { TaskStatusBadge } from './TaskStatusBadge';
import { DispatchOriginBadge } from './DispatchOriginBadge';

interface Props {
  task: Task;
  onClick?: (task: Task) => void;
  highlighted?: boolean;
}

export function TaskCard({ task, onClick, highlighted }: Props) {
  const executorIcon =
    task.executor === 'agent' ? (
      <Bot className="h-3.5 w-3.5 text-[var(--accent-warm)]" aria-label="Agent" />
    ) : (
      <User className="h-3.5 w-3.5 text-[var(--ink-muted)]" aria-label="User" />
    );

  return (
    <button
      type="button"
      onClick={() => onClick?.(task)}
      className={`group w-full rounded-[var(--radius-lg)] border bg-[var(--paper-elevated)] p-3 text-left transition-all hover:border-[var(--line-strong)] hover:shadow-sm hover:-translate-y-[1px] ${
        highlighted
          ? 'border-[var(--accent-warm)] shadow-sm'
          : 'border-[var(--line)]'
      }`}
    >
      <div className="flex items-start gap-2">
        <Layers className="mt-0.5 h-4 w-4 shrink-0 text-[var(--ink-muted)]" />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--ink)]">
              {task.name}
            </div>
            <TaskStatusBadge status={task.status} compact />
          </div>
          {task.description && (
            <div className="mt-1 line-clamp-2 text-[12px] text-[var(--ink-muted)]">
              {task.description}
            </div>
          )}
          <div className="mt-2 flex items-center gap-2 text-[11px] text-[var(--ink-muted)]/70">
            {executorIcon}
            <DispatchOriginBadge origin={task.dispatchOrigin} compact />
            {task.executionMode !== 'once' && (
              <span className="rounded-[var(--radius-sm)] bg-[var(--paper-inset)] px-1.5 py-0.5 text-[10px]">
                {modeLabel(task.executionMode)}
              </span>
            )}
            <span className="ml-auto">{relativeTime(task.updatedAt)}</span>
          </div>
          {task.tags.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {task.tags.slice(0, 4).map((t) => (
                <span
                  key={t}
                  className="text-[10px] text-[var(--ink-muted)]/60"
                >
                  #{t}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </button>
  );
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

function relativeTime(ts: number): string {
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

export default TaskCard;
