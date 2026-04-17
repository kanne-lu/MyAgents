// StatusHistoryList — renders a Task's statusHistory with pagination (PRD §7.3.1).
// Default view shows the most recent 50 transitions; "加载更多" reveals earlier
// ones in the same chunk size. "导出为 JSON" downloads the full history.

import { useMemo, useState } from 'react';
import { Download } from 'lucide-react';
import type { StatusTransition, Task, TaskStatus } from '@/../shared/types/task';

const PAGE_SIZE = 50;

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

interface Props {
  task: Task;
}

export function StatusHistoryList({ task }: Props) {
  const history = task.statusHistory;
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  // Newest first for UI; statusHistory is stored append-only, oldest first.
  const ordered = useMemo(() => [...history].reverse(), [history]);
  const shown = ordered.slice(0, visibleCount);
  const hasMore = ordered.length > visibleCount;

  if (history.length === 0) {
    return (
      <div className="py-6 text-center text-[12px] text-[var(--ink-muted)]">
        暂无状态变更记录
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">
          状态变更记录 ({history.length})
        </div>
        <button
          type="button"
          onClick={() => downloadAsJson(task)}
          className="flex items-center gap-1 rounded-[var(--radius-md)] px-2 py-1 text-[11px] text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
          title="下载完整 JSON"
        >
          <Download className="h-3 w-3" />
          导出为 JSON
        </button>
      </div>
      <ol className="relative flex flex-col gap-0 before:absolute before:left-[7px] before:top-1 before:bottom-1 before:w-px before:bg-[var(--line)]">
        {shown.map((t, i) => (
          <TransitionRow key={`${t.at}-${i}`} t={t} />
        ))}
      </ol>
      {hasMore && (
        <button
          type="button"
          onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
          className="self-center rounded-[var(--radius-md)] px-3 py-1 text-[12px] text-[var(--accent-warm)] transition-colors hover:bg-[var(--accent-warm-subtle)]"
        >
          加载更多（剩余 {ordered.length - visibleCount}）
        </button>
      )}
    </div>
  );
}

function TransitionRow({ t }: { t: StatusTransition }) {
  const from = t.from ? STATUS_LABEL[t.from] : '—';
  const to = STATUS_LABEL[t.to];
  return (
    <li className="relative flex gap-3 py-1.5 pl-5">
      <span
        className="absolute left-1 top-2.5 inline-block h-2 w-2 rounded-full bg-[var(--accent-warm)]"
        aria-hidden
      />
      <div className="flex-1 text-[12px]">
        <div className="flex items-center gap-1.5 text-[var(--ink)]">
          <span className="text-[var(--ink-muted)]">{from}</span>
          <span className="text-[var(--ink-muted)]">→</span>
          <span className="font-medium">{to}</span>
          <span className="text-[10px] text-[var(--ink-muted)]/70">
            · {actorLabel(t.actor)}
            {t.source && ` · ${t.source}`}
          </span>
        </div>
        {t.message && (
          <div className="mt-0.5 text-[11px] text-[var(--ink-muted)]">
            {t.message}
          </div>
        )}
      </div>
      <span className="shrink-0 text-[10px] tabular-nums text-[var(--ink-muted)]/60">
        {new Date(t.at).toLocaleString()}
      </span>
    </li>
  );
}

function actorLabel(a: StatusTransition['actor']): string {
  return a === 'user' ? 'user' : a === 'agent' ? 'agent' : 'system';
}

function downloadAsJson(task: Task) {
  const payload = {
    taskId: task.id,
    name: task.name,
    exportedAt: new Date().toISOString(),
    statusHistory: task.statusHistory,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${task.id}-history.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default StatusHistoryList;
