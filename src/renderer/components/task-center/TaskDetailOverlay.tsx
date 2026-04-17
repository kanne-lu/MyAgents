// TaskDetailOverlay — modal covering Task Center with full details of one Task.
// PRD §7.3. Uses the shared OverlayBackdrop + closeLayer Cmd+W integration.

import { useCallback, useEffect, useState } from 'react';
import { X, Play, Archive, Trash2, Square, RotateCcw, CheckCircle } from 'lucide-react';
import OverlayBackdrop from '@/components/OverlayBackdrop';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import {
  taskArchive,
  taskDelete,
  taskGet,
  taskUpdateStatus,
} from '@/api/taskCenter';
import type { Task } from '@/../shared/types/task';
import { TaskStatusBadge } from './TaskStatusBadge';
import { DispatchOriginBadge } from './DispatchOriginBadge';
import { StatusHistoryList } from './StatusHistoryList';

const OVERLAY_Z = 200;

interface Props {
  task: Task;
  onClose: () => void;
  onChanged?: (next: Task | null) => void;
}

export function TaskDetailOverlay({ task: initial, onClose, onChanged }: Props) {
  const [task, setTask] = useState<Task>(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useCloseLayer(() => {
    onClose();
    return true;
  }, OVERLAY_Z);

  // Refetch on mount so we show the latest statusHistory (in case UI was out of sync).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const fresh = await taskGet(task.id);
        if (!cancelled && fresh) setTask(fresh);
      } catch {
        /* silent — use `initial` */
      }
    })();
    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- we only want this on mount
  }, []);

  const runStatus = useCallback(
    async (next: Task['status']) => {
      setBusy(true);
      setErr(null);
      try {
        const updated = await taskUpdateStatus({ id: task.id, status: next });
        setTask(updated);
        onChanged?.(updated);
      } catch (e) {
        setErr(extractErrorMessage(e));
      } finally {
        setBusy(false);
      }
    },
    [task.id, onChanged],
  );

  const doArchive = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const updated = await taskArchive(task.id);
      setTask(updated);
      onChanged?.(updated);
    } catch (e) {
      setErr(extractErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }, [task.id, onChanged]);

  const doDelete = useCallback(async () => {
    if (!window.confirm('确定删除此任务？软删除后 30 天内可恢复。')) return;
    setBusy(true);
    setErr(null);
    try {
      await taskDelete(task.id);
      onChanged?.(null);
      onClose();
    } catch (e) {
      setErr(extractErrorMessage(e));
      setBusy(false);
    }
  }, [task.id, onChanged, onClose]);

  return (
    <OverlayBackdrop onClose={onClose} className="z-[200]">
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85vh] w-[min(780px,92vw)] flex-col overflow-hidden rounded-[var(--radius-2xl)] bg-[var(--paper-elevated)] shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-[var(--line)] px-5 py-4">
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <TaskStatusBadge status={task.status} />
              <DispatchOriginBadge origin={task.dispatchOrigin} />
            </div>
            <h2 className="mt-1.5 text-[18px] font-semibold text-[var(--ink)]">
              {task.name}
            </h2>
            {task.description && (
              <p className="mt-1 text-[13px] text-[var(--ink-muted)]">
                {task.description}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-[var(--radius-md)] p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
            title="关闭 (Cmd+W)"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Action bar */}
        <div className="flex items-center gap-2 border-b border-[var(--line-subtle)] px-5 py-3">
          {task.status === 'todo' && (
            <ActionBtn
              icon={<Play className="h-3.5 w-3.5" />}
              label="立即执行"
              disabled
              title="Phase 4 实装"
            />
          )}
          {(task.status === 'running' || task.status === 'verifying') && (
            <ActionBtn
              icon={<Square className="h-3.5 w-3.5" />}
              label="中止"
              variant="danger"
              disabled={busy}
              onClick={() => runStatus('stopped')}
            />
          )}
          {(task.status === 'blocked' ||
            task.status === 'stopped' ||
            task.status === 'done' ||
            task.status === 'archived') && (
            <ActionBtn
              icon={<RotateCcw className="h-3.5 w-3.5" />}
              label="重新派发"
              disabled
              title="Phase 4 实装：reset → todo → run"
            />
          )}
          {task.status === 'verifying' && (
            <ActionBtn
              icon={<CheckCircle className="h-3.5 w-3.5" />}
              label="标记完成"
              disabled={busy}
              onClick={() => runStatus('done')}
            />
          )}
          {task.status === 'done' && (
            <ActionBtn
              icon={<Archive className="h-3.5 w-3.5" />}
              label="归档"
              disabled={busy}
              onClick={doArchive}
            />
          )}
          <ActionBtn
            icon={<Trash2 className="h-3.5 w-3.5" />}
            label="删除"
            variant="danger"
            disabled={busy}
            onClick={doDelete}
          />
        </div>

        {err && (
          <div className="border-b border-[var(--error)]/30 bg-[var(--error-bg)] px-5 py-2 text-[12px] text-[var(--error)]">
            {err}
          </div>
        )}

        {/* Body: scrollable */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          <Meta task={task} />

          <hr className="my-4 border-[var(--line-subtle)]" />

          <StatusHistoryList task={task} />

          <hr className="my-4 border-[var(--line-subtle)]" />

          {/* Notification / verify / associated sessions blocks are placeholders for
              Phase 4-5 wiring. We show their presence so users understand the
              surface area. */}
          <Placeholder
            title="通知设置"
            hint="Phase 5 将接入桌面 / Bot 通知配置"
          />
          <Placeholder
            title="验收标准 verify.md"
            hint="Phase 5 将读取 .task/<id>/verify.md"
          />
          <Placeholder
            title="关联会话"
            hint={`${task.sessionIds.length} 个历史会话`}
          />
        </div>
      </div>
    </OverlayBackdrop>
  );
}

function Meta({ task }: { task: Task }) {
  const rows: Array<[string, string]> = [
    ['创建', new Date(task.createdAt).toLocaleString()],
    ['更新', new Date(task.updatedAt).toLocaleString()],
    [
      '上次执行',
      task.lastExecutedAt
        ? new Date(task.lastExecutedAt).toLocaleString()
        : '—',
    ],
    ['执行者', task.executor === 'agent' ? 'Agent' : '用户'],
    ['执行模式', task.executionMode],
    [
      '工作区',
      task.workspacePath ?? task.workspaceId,
    ],
    ['Runtime', task.runtime ?? 'builtin'],
  ];
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[12px]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-[var(--ink-muted)]/70">{k}</dt>
          <dd className="truncate text-[var(--ink)]">{v}</dd>
        </div>
      ))}
      {task.tags.length > 0 && (
        <div className="contents">
          <dt className="text-[var(--ink-muted)]/70">标签</dt>
          <dd className="flex flex-wrap gap-1">
            {task.tags.map((t) => (
              <span
                key={t}
                className="rounded-[var(--radius-sm)] bg-[var(--paper-inset)] px-1.5 py-0.5 text-[11px] text-[var(--ink-muted)]"
              >
                #{t}
              </span>
            ))}
          </dd>
        </div>
      )}
    </dl>
  );
}

function Placeholder({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="mt-3 rounded-[var(--radius-lg)] border border-dashed border-[var(--line)] bg-[var(--paper)] p-3">
      <div className="text-[12px] font-medium text-[var(--ink-secondary)]">
        {title}
      </div>
      <div className="mt-0.5 text-[11px] text-[var(--ink-muted)]">{hint}</div>
    </div>
  );
}

interface ActionBtnProps {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  variant?: 'default' | 'danger';
}

function ActionBtn({
  icon,
  label,
  onClick,
  disabled,
  title,
  variant,
}: ActionBtnProps) {
  const base =
    'flex items-center gap-1.5 rounded-[var(--radius-md)] px-2.5 py-1.5 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50';
  const variantCls =
    variant === 'danger'
      ? 'text-[var(--ink-muted)] hover:bg-[var(--error-bg)] hover:text-[var(--error)]'
      : 'text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`${base} ${variantCls}`}
    >
      {icon}
      {label}
    </button>
  );
}

function extractErrorMessage(e: unknown): string {
  const s = String(e);
  // Rust layer serializes TaskOpError as JSON-stringified `{code, message}`.
  try {
    const parsed = JSON.parse(s) as { code?: string; message?: string };
    if (parsed && parsed.message) return parsed.message;
  } catch {
    /* not JSON */
  }
  return s;
}

export default TaskDetailOverlay;
