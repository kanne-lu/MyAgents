// DispatchOriginBadge — text badge distinguishing "direct" from "ai-aligned"
// task creation path. Per PRD §7.3 and v1.4 no-emoji rule.

import type { TaskDispatchOrigin } from '@/../shared/types/task';

interface Props {
  origin: TaskDispatchOrigin;
  compact?: boolean;
}

export function DispatchOriginBadge({ origin, compact }: Props) {
  const size = compact ? 'text-[10px] px-1.5 py-0.5' : 'text-[11px] px-2 py-0.5';
  if (origin === 'direct') {
    return (
      <span
        className={`inline-flex items-center rounded-[var(--radius-sm)] bg-[var(--paper-inset)] font-medium text-[var(--ink-muted)] ${size}`}
        title="直接派发：以想法原文为 task.md"
      >
        直接派发
      </span>
    );
  }
  return (
    <span
      className={`inline-flex items-center rounded-[var(--radius-sm)] bg-[var(--accent-warm-subtle)] font-medium text-[var(--accent-warm)] ${size}`}
      title="对齐讨论：通过 /task-alignment 生成完整四份文档"
    >
      对齐讨论
    </span>
  );
}

export default DispatchOriginBadge;
