// TaskItemActions — hover-revealed quick action + overflow menu, shared by
// both the card and list views of the task panel. Consolidates the per-status
// primary action and the secondary overflow into a single component so the
// two views don't drift.
//
// Callers pass the task (or a legacy-cron descriptor) and the imperative
// action callbacks; this component renders the right buttons based on the
// current status. Legacy cron rows surface only the `…` menu since they
// live in the separate LegacyCronOverlay.

import { useRef, useState } from 'react';
import { MoreHorizontal, Play, RotateCcw, Square, Trash2 } from 'lucide-react';

import { Popover } from '@/components/ui/Popover';
import type { Task, TaskStatus } from '@/../shared/types/task';

export interface TaskItemActionsProps {
  variant: 'task' | 'legacy';
  /** Live status — native task value, or derived for legacy. */
  status: TaskStatus;
  /** Busy flag locks all actions during a pending async op. */
  busy?: boolean;
  /** Fired by the primary action (▶ for todo, ■ for running, ↻ for rerun). */
  onRun?: () => void;
  onStop?: () => void;
  onRerun?: () => void;
  onOpenDetail: () => void;
  onDelete?: () => void;
  /** When true, keep the action row visible even without hover (e.g. running
   *  tasks should always advertise the ■ button). */
  alwaysVisible?: boolean;
}

export function TaskItemActions({
  variant,
  status,
  busy,
  onRun,
  onStop,
  onRerun,
  onOpenDetail,
  onDelete,
  alwaysVisible = false,
}: TaskItemActionsProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuBtnRef = useRef<HTMLButtonElement>(null);

  const primary = variant === 'legacy'
    ? null
    : primaryActionFor(status, { onRun, onStop, onRerun });

  // The menu anchor always shows, primary is status-dependent. `menuOpen`
  // pins the whole row visible while the menu is open — otherwise hovering
  // off the card would collapse the row mid-click.
  const visible = alwaysVisible || menuOpen;

  return (
    <div
      className={`flex items-center gap-0.5 transition-opacity ${
        visible ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
      }`}
      onClick={(e) => e.stopPropagation()}
    >
      {primary && (
        <button
          type="button"
          disabled={busy}
          onClick={(e) => {
            e.stopPropagation();
            primary.handler?.();
          }}
          title={primary.title}
          className={`flex h-6 w-6 items-center justify-center rounded-md transition-colors disabled:opacity-50 ${primary.className}`}
        >
          {primary.icon}
        </button>
      )}
      <button
        ref={menuBtnRef}
        type="button"
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation();
          setMenuOpen((v) => !v);
        }}
        title="更多操作"
        className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:opacity-50"
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </button>
      <Popover
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        anchorRef={menuBtnRef}
        placement="bottom-end"
        className="min-w-[140px] py-1"
      >
        <button
          type="button"
          onClick={() => {
            setMenuOpen(false);
            onOpenDetail();
          }}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-[var(--ink-secondary)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
        >
          打开详情
        </button>
        {onDelete && (
          <button
            type="button"
            onClick={() => {
              setMenuOpen(false);
              onDelete();
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-[var(--error)] hover:bg-[var(--error-bg)]"
          >
            <Trash2 className="h-3.5 w-3.5" />
            删除
          </button>
        )}
      </Popover>
    </div>
  );
}

interface PrimaryAction {
  icon: React.ReactNode;
  title: string;
  className: string;
  handler: (() => void) | undefined;
}

function primaryActionFor(
  status: TaskStatus,
  handlers: Pick<TaskItemActionsProps, 'onRun' | 'onStop' | 'onRerun'>,
): PrimaryAction | null {
  switch (status) {
    case 'todo':
      return {
        icon: <Play className="h-3.5 w-3.5" />,
        title: '立即执行',
        className: 'text-[var(--accent-warm)] hover:bg-[var(--accent-warm-subtle)]',
        handler: handlers.onRun,
      };
    case 'running':
    case 'verifying':
      return {
        icon: <Square className="h-3.5 w-3.5" />,
        title: '中止',
        className: 'text-[var(--ink-muted)] hover:bg-[var(--error-bg)] hover:text-[var(--error)]',
        handler: handlers.onStop,
      };
    case 'blocked':
    case 'stopped':
    case 'done':
      return {
        icon: <RotateCcw className="h-3.5 w-3.5" />,
        title: '重新派发',
        className: 'text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]',
        handler: handlers.onRerun,
      };
    default:
      return null;
  }
}

/** Derive a TaskStatus-compatible value from a native Task or a legacy cron. */
export function deriveTaskRowStatus(task: Task | null, legacyRunning?: boolean): TaskStatus {
  if (task) return task.status;
  return legacyRunning ? 'running' : 'stopped';
}
