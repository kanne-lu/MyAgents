// LegacyCronCard — renders a pre-v0.1.69 cron task (no `task_id` back-pointer)
// alongside native Task Center tasks. PRD §11.4 "legacy upsurface".
// Visual affordances mirror TaskCard but with a 「遗留」 text badge so the
// user understands this row is managed in the legacy cron panel.

import { Clock } from 'lucide-react';

interface Props {
  name: string;
  status: 'running' | 'stopped';
  workspacePath: string;
  updatedAt: number;
  onClick: () => void;
}

export function LegacyCronCard({
  name,
  status,
  workspacePath,
  updatedAt,
  onClick,
}: Props) {
  const statusLabel = status === 'running' ? '进行中' : '已暂停';
  const statusBg =
    status === 'running' ? 'bg-[var(--info-bg)]' : 'bg-[var(--paper-inset)]';
  const statusFg =
    status === 'running' ? 'text-[var(--info)]' : 'text-[var(--ink-subtle)]';

  return (
    <button
      type="button"
      onClick={onClick}
      className="group w-full rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--paper-elevated)] p-3 text-left transition-all hover:border-[var(--line-strong)] hover:shadow-sm hover:-translate-y-[1px]"
    >
      <div className="flex items-start gap-2">
        <Clock className="mt-0.5 h-4 w-4 shrink-0 text-[var(--ink-muted)]" />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--ink)]">
              {name}
            </div>
            <span
              className={`inline-flex items-center rounded-[var(--radius-sm)] ${statusBg} ${statusFg} px-1.5 py-0.5 text-[10px] font-medium`}
            >
              {statusLabel}
            </span>
          </div>
          <div className="mt-2 flex items-center gap-2 text-[11px] text-[var(--ink-muted)]/70">
            <span
              className="inline-flex items-center rounded-[var(--radius-sm)] bg-[var(--paper-inset)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--ink-muted)]"
              title="旧版定时任务，管理入口仍在对话 Tab 的定时面板"
            >
              遗留
            </span>
            {workspacePath && (
              <span className="truncate">{shortenPath(workspacePath)}</span>
            )}
            <span className="ml-auto">{relativeTime(updatedAt)}</span>
          </div>
        </div>
      </div>
    </button>
  );
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

export default LegacyCronCard;
