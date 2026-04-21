// TaskSessionsList — "任务执行" section inside Task Detail overlay.
//
// Renders the sessions on which a task has actually executed (one per cron
// tick for new_session mode, or a single reused row for single_session).
// Clicking a row opens that session in a fresh Chat tab via the
// `OPEN_SESSION_IN_NEW_TAB` custom event — routed by App.tsx which reuses
// the same `handleLaunchProject(project, provider, sessionId)` path that
// Launcher's 历史对话 entries call through. This is why the visual
// language deliberately mirrors that list (DESIGN.md §15.6): `rounded-lg
// hover:bg-[var(--hover-bg)]` row with a timestamp column on the left and
// truncated title on the right.
//
// Only Task.sessionIds[] are rendered — new_session mode appends per tick,
// single_session mode stays at length 1. For an empty list (task hasn't
// executed yet) the whole section renders a muted empty-state line instead.

import { useEffect, useMemo, useState } from 'react';
import { Clock } from 'lucide-react';

import { getSessions, type SessionMetadata } from '@/api/sessionClient';
import { CUSTOM_EVENTS } from '@/../shared/constants';
import type { Task } from '@/../shared/types/task';

interface Props {
  task: Task;
}

const MAX_VISIBLE = 5;

function formatTimestamp(iso: string | number | undefined): string {
  if (!iso) return '';
  const d = typeof iso === 'number' ? new Date(iso) : new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return sameYear ? `${mm}-${dd} ${hh}:${mi}` : `${d.getFullYear()}-${mm}-${dd} ${hh}:${mi}`;
}

export function TaskSessionsList({ task }: Props) {
  const [sessions, setSessions] = useState<SessionMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);

  // Fetch all sessions for the task's workspace once, then filter to the
  // task's sessionIds[]. Cheaper than N-round trips; session metadata is
  // small and the workspace-scoped endpoint already exists. We DON'T reset
  // `loading` to true when task changes — the existing list stays visible
  // briefly until the new fetch lands, which is less disruptive than a
  // full loading flash. The initial useState(true) covers first mount.
  useEffect(() => {
    let cancelled = false;
    void getSessions(task.workspacePath)
      .then((all) => {
        if (cancelled) return;
        const idSet = new Set(task.sessionIds);
        const matched = all.filter((s) => idSet.has(s.id));
        // Sort by lastActiveAt desc so newest executions surface first.
        matched.sort((a, b) => {
          const ta = new Date(a.lastActiveAt).getTime();
          const tb = new Date(b.lastActiveAt).getTime();
          return tb - ta;
        });
        setSessions(matched);
      })
      .catch((err) => {
        if (!cancelled) {
          console.warn('[TaskSessionsList] fetch sessions failed', err);
          setSessions([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [task.workspacePath, task.sessionIds]);

  const visible = useMemo(
    () => (expanded ? sessions : sessions.slice(0, MAX_VISIBLE)),
    [sessions, expanded],
  );

  const handleOpen = (sessionId: string) => {
    window.dispatchEvent(
      new CustomEvent(CUSTOM_EVENTS.OPEN_SESSION_IN_NEW_TAB, {
        detail: { sessionId, workspacePath: task.workspacePath },
      }),
    );
  };

  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">
          任务执行
        </h3>
        <span className="text-[11px] tabular-nums text-[var(--ink-subtle)]">
          {task.sessionIds.length}
        </span>
      </div>
      {loading ? (
        <div className="py-3 text-[12px] text-[var(--ink-muted)]/60">
          加载中…
        </div>
      ) : sessions.length === 0 ? (
        <div className="py-3 text-[12px] text-[var(--ink-muted)]/60">
          {task.sessionIds.length === 0 ? '尚未执行过' : '相关 session 记录已不存在'}
        </div>
      ) : (
        <div className="space-y-0.5">
          {visible.map((session) => (
            <div
              key={session.id}
              role="button"
              onClick={() => handleOpen(session.id)}
              title={`打开此次执行的 session（${session.id}）`}
              className="group flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-colors hover:bg-[var(--hover-bg)]"
            >
              <div className="flex w-[84px] shrink-0 items-center gap-1 text-[11px] text-[var(--ink-muted)]/50">
                <Clock className="h-2.5 w-2.5" />
                <span className="tabular-nums">{formatTimestamp(session.lastActiveAt)}</span>
              </div>
              <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--ink-secondary)] transition-colors group-hover:text-[var(--ink)]">
                {session.title || '未命名对话'}
              </span>
            </div>
          ))}
          {sessions.length > MAX_VISIBLE && !expanded && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="mt-1 px-3 py-1 text-[11px] text-[var(--ink-muted)] transition-colors hover:text-[var(--ink)]"
            >
              展开全部 {sessions.length} 条
            </button>
          )}
          {expanded && sessions.length > MAX_VISIBLE && (
            <button
              type="button"
              onClick={() => setExpanded(false)}
              className="mt-1 px-3 py-1 text-[11px] text-[var(--ink-muted)] transition-colors hover:text-[var(--ink)]"
            >
              收起
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default TaskSessionsList;
