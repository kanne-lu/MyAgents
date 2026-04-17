// TaskStatusBadge — compact colored label for a TaskStatus.
// Maps to DESIGN.md §6 status colors. Used in TaskCard + TaskDetailOverlay.

import type { TaskStatus } from '@/../shared/types/task';

const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: '待启动',
  running: '进行中',
  verifying: '验证中',
  done: '已完成',
  blocked: '已阻塞',
  stopped: '已暂停',
  archived: '已归档',
  deleted: '已删除',
};

const STATUS_STYLE: Record<TaskStatus, { bg: string; fg: string; dot?: string }> = {
  todo: { bg: 'bg-[var(--paper-inset)]', fg: 'text-[var(--ink-muted)]' },
  running: {
    bg: 'bg-[var(--info-bg)]',
    fg: 'text-[var(--info)]',
    dot: 'bg-[var(--info)]',
  },
  verifying: {
    bg: 'bg-[var(--accent-warm-subtle)]',
    fg: 'text-[var(--accent-warm)]',
    dot: 'bg-[var(--accent-warm)]',
  },
  done: {
    bg: 'bg-[var(--success-bg)]',
    fg: 'text-[var(--success)]',
    dot: 'bg-[var(--success)]',
  },
  blocked: {
    bg: 'bg-[var(--warning-bg)]',
    fg: 'text-[var(--warning)]',
    dot: 'bg-[var(--warning)]',
  },
  stopped: { bg: 'bg-[var(--paper-inset)]', fg: 'text-[var(--ink-subtle)]' },
  archived: { bg: 'bg-[var(--paper-inset)]', fg: 'text-[var(--ink-subtle)]' },
  deleted: { bg: 'bg-[var(--error-bg)]', fg: 'text-[var(--error)]' },
};

interface Props {
  status: TaskStatus;
  compact?: boolean;
}

export function TaskStatusBadge({ status, compact }: Props) {
  const style = STATUS_STYLE[status];
  const label = STATUS_LABEL[status];
  const size = compact ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-[11px]';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-[var(--radius-sm)] font-medium ${style.bg} ${style.fg} ${size}`}
    >
      {style.dot && (
        <span
          className={`inline-block h-1.5 w-1.5 rounded-full ${style.dot}`}
          aria-hidden
        />
      )}
      {label}
    </span>
  );
}

export default TaskStatusBadge;
