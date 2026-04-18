// TaskListPanel — right column of Task Center: task cards + filter bar.
// Three sections: active (running/verifying), pending (todo/blocked/stopped),
// finished (done/archived). PRD §7.2.
//
// Two render modes: a 2-column card view (default) and a dense single-line
// list view (quick scan / filter). The choice is persisted in localStorage
// so returning users see their last-picked view.
//
// Legacy cron tasks (CronTasks with no `task_id` back-pointer) are "上浮" here
// alongside native tasks (PRD §11.4) — they render with a 「遗留」 badge and
// their "remain in source chat tab" management pattern.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Layers, Search, X } from 'lucide-react';

import {
  taskCenterAvailable,
  taskDelete,
  taskList,
  taskRerun,
  taskRun,
  taskUpdateStatus,
} from '@/api/taskCenter';
import { useToast } from '@/components/Toast';
import type { Task, TaskStatus } from '@/../shared/types/task';
import { LegacyCronOverlay } from './LegacyCronOverlay';
import { TaskDetailOverlay } from './TaskDetailOverlay';
import { TaskCardItem } from './views/TaskCardItem';
import { TaskListRow } from './views/TaskListRow';
import { ViewToggle, type TaskView } from './views/ViewToggle';
import type { LegacyCronRow } from './views/types';

/** Union of what the right-column list renders — a real Task or a legacy cron. */
type TaskCardLike =
  | { kind: 'task'; task: Task }
  | { kind: 'legacy-cron'; legacy: LegacyCronRow };

interface Props {
  highlightTaskId?: string | null;
  /** Bumped by parent to trigger re-fetch (tab activation, post-dispatch). */
  refreshKey?: unknown;
}

type Bucket = 'pending' | 'active' | 'finished';

const BUCKETS: Record<Bucket, { label: string; statuses: TaskStatus[] }> = {
  active: { label: '进行中', statuses: ['running', 'verifying'] },
  pending: { label: '待启动', statuses: ['todo', 'blocked', 'stopped'] },
  finished: { label: '已完成', statuses: ['done', 'archived'] },
};

const VIEW_STORAGE_KEY = 'myagents:task-center:view';

function loadStoredView(): TaskView {
  if (typeof window === 'undefined') return 'card';
  const raw = window.localStorage.getItem(VIEW_STORAGE_KEY);
  return raw === 'list' ? 'list' : 'card';
}

export function TaskListPanel({ highlightTaskId, refreshKey }: Props) {
  const toast = useToast();
  const toastRef = useRef(toast);
  useEffect(() => {
    toastRef.current = toast;
  }, [toast]);

  const [tasks, setTasks] = useState<Task[]>([]);
  const [legacy, setLegacy] = useState<LegacyCronRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [isSearchMode, setIsSearchMode] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [selectedLegacy, setSelectedLegacy] = useState<LegacyCronRow | null>(null);
  const [view, setView] = useState<TaskView>(loadStoredView);
  // Per-id busy flag so only the affected card/row greys out during an action,
  // instead of locking the whole panel.
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());

  const updateView = useCallback((next: TaskView) => {
    setView(next);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(VIEW_STORAGE_KEY, next);
    }
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [nativeList, legacyList] = await Promise.all([
        taskList({}),
        fetchLegacyCronTasks(),
      ]);
      setTasks(nativeList);
      setLegacy(legacyList);
    } catch (err) {
      console.error('[TaskListPanel] load failed', err);
      setTasks([]);
      setLegacy([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload, refreshKey]);

  useEffect(() => {
    if (isSearchMode) {
      searchInputRef.current?.focus();
    }
  }, [isSearchMode]);

  // SSE: listen for task:status-changed events fired by Rust `update_status`
  // and refetch so every open TaskCenter tab stays in sync with the source of
  // truth. Guarded on Tauri because `listen` is a Tauri-only import.
  useEffect(() => {
    if (!taskCenterAvailable()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      const { listen } = await import('@tauri-apps/api/event');
      if (cancelled) return;
      const off = await listen('task:status-changed', () => {
        void reload();
      });
      if (cancelled) {
        off();
      } else {
        unlisten = off;
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [reload]);

  // ── Per-task action handlers. Shared by card and list views via callbacks.
  // Each one toggles `pendingIds[id]` around the RPC so only that one card
  // disables its buttons while the request is in flight.
  const runAction = useCallback(
    async (taskId: string, label: string, fn: () => Promise<unknown>) => {
      setPendingIds((prev) => {
        const next = new Set(prev);
        next.add(taskId);
        return next;
      });
      try {
        await fn();
        // SSE will trigger a reload and refresh the list in-place.
      } catch (e) {
        toastRef.current.error(`${label}失败：${String(e)}`);
      } finally {
        setPendingIds((prev) => {
          const next = new Set(prev);
          next.delete(taskId);
          return next;
        });
      }
    },
    [],
  );

  const handleRun = useCallback(
    (task: Task) => runAction(task.id, '执行', () => taskRun(task.id)),
    [runAction],
  );
  const handleStop = useCallback(
    (task: Task) =>
      runAction(task.id, '中止', () =>
        taskUpdateStatus({ id: task.id, status: 'stopped', message: '用户手动中止' }),
      ),
    [runAction],
  );
  const handleRerun = useCallback(
    (task: Task) => runAction(task.id, '重新派发', () => taskRerun(task.id)),
    [runAction],
  );
  const handleDelete = useCallback(
    (task: Task) => {
      if (!window.confirm(`确认删除任务「${task.name}」？此操作不可恢复。`)) return;
      void runAction(task.id, '删除', async () => {
        await taskDelete(task.id);
        // Optimistic removal — SSE will not fire a status-changed for delete.
        setTasks((prev) => prev.filter((x) => x.id !== task.id));
      });
    },
    [runAction],
  );

  const buckets = useMemo(() => {
    const needle = query.trim().toLowerCase();

    const nativeCards: TaskCardLike[] = tasks.map((t) => ({
      kind: 'task' as const,
      task: t,
    }));
    const legacyCards: TaskCardLike[] = legacy.map((l) => ({
      kind: 'legacy-cron' as const,
      legacy: l,
    }));
    const all = [...nativeCards, ...legacyCards];
    const filtered = needle
      ? all.filter((c) => {
          if (c.kind === 'task') {
            const t = c.task;
            return (
              t.name.toLowerCase().includes(needle) ||
              t.description?.toLowerCase().includes(needle) ||
              t.tags.some((x) => x.toLowerCase().includes(needle))
            );
          }
          return c.legacy.name.toLowerCase().includes(needle);
        })
      : all;

    const out: Record<Bucket, TaskCardLike[]> = {
      active: [],
      pending: [],
      finished: [],
    };
    for (const c of filtered) {
      const status: TaskStatus =
        c.kind === 'task'
          ? c.task.status
          : c.legacy.status === 'running'
            ? 'running'
            : 'stopped';
      for (const [name, cfg] of Object.entries(BUCKETS) as Array<
        [Bucket, typeof BUCKETS[Bucket]]
      >) {
        if (cfg.statuses.includes(status)) {
          out[name].push(c);
          break;
        }
      }
    }
    // Sort each bucket by updatedAt desc.
    for (const bucket of Object.values(out)) {
      bucket.sort((a, b) => {
        const ta = a.kind === 'task' ? a.task.updatedAt : a.legacy.updatedAt;
        const tb = b.kind === 'task' ? b.task.updatedAt : b.legacy.updatedAt;
        return tb - ta;
      });
    }
    return out;
  }, [tasks, legacy, query]);

  const exitSearch = useCallback(() => {
    setIsSearchMode(false);
    setQuery('');
  }, []);

  const totalCount = tasks.length + legacy.length;

  const renderCard = (c: TaskCardLike) => {
    if (c.kind === 'task') {
      const t = c.task;
      return (
        <TaskCardItem
          key={`t-${t.id}`}
          task={t}
          highlighted={highlightTaskId === t.id}
          busy={pendingIds.has(t.id)}
          onOpen={() => setSelectedTask(t)}
          onRun={() => handleRun(t)}
          onStop={() => handleStop(t)}
          onRerun={() => handleRerun(t)}
          onDelete={() => handleDelete(t)}
        />
      );
    }
    return (
      <TaskCardItem
        key={`l-${c.legacy.id}`}
        legacy={c.legacy}
        onOpen={() => setSelectedLegacy(c.legacy)}
      />
    );
  };

  const renderRow = (c: TaskCardLike) => {
    if (c.kind === 'task') {
      const t = c.task;
      return (
        <TaskListRow
          key={`t-${t.id}`}
          task={t}
          highlighted={highlightTaskId === t.id}
          busy={pendingIds.has(t.id)}
          onOpen={() => setSelectedTask(t)}
          onRun={() => handleRun(t)}
          onStop={() => handleStop(t)}
          onRerun={() => handleRerun(t)}
          onDelete={() => handleDelete(t)}
        />
      );
    }
    return (
      <TaskListRow
        key={`l-${c.legacy.id}`}
        legacy={c.legacy}
        onOpen={() => setSelectedLegacy(c.legacy)}
      />
    );
  };

  return (
    <div className="flex h-full flex-col">
      {/* Section header — label + view toggle + search toggle. */}
      {isSearchMode ? (
        <div className="flex items-center gap-2 border-b border-[var(--line-subtle)] px-4 py-2">
          <div className="relative flex flex-1 items-center">
            <Search className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-[var(--ink-muted)]" />
            <input
              ref={searchInputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索任务（名称 / 描述 / 标签）"
              className="h-7 w-full rounded-md border border-[var(--line)] bg-transparent pl-8 pr-7 text-[13px] text-[var(--ink)] placeholder:text-[var(--ink-muted)]/70 outline-none transition-colors focus:border-[var(--accent)]"
              onKeyDown={(e) => {
                if (e.key === 'Escape') exitSearch();
              }}
            />
            <button
              type="button"
              onClick={exitSearch}
              title="退出搜索"
              className="absolute right-2 flex items-center text-[var(--ink-muted)]/60 transition-colors hover:text-[var(--ink)]"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between border-b border-[var(--line-subtle)] px-4 py-2.5">
          <div className="flex items-center gap-2">
            <Layers className="h-3.5 w-3.5 text-[var(--ink-muted)]" />
            <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">
              任务
            </span>
          </div>
          <div className="flex items-center gap-2">
            <ViewToggle value={view} onChange={updateView} />
            <button
              type="button"
              onClick={() => setIsSearchMode(true)}
              title="搜索任务"
              className="flex h-6 w-6 items-center justify-center rounded p-1 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
            >
              <Search className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      <div className={`flex-1 overflow-y-auto ${view === 'list' ? '' : 'px-4 py-3'}`}>
        {loading ? (
          <div className="py-8 text-center text-[13px] text-[var(--ink-muted)]">
            加载中…
          </div>
        ) : totalCount === 0 ? (
          <div className="py-12 text-center text-[13px] text-[var(--ink-muted)]">
            还没有任务。在左栏记下想法后点「派发」即可创建任务。
          </div>
        ) : (
          (['active', 'pending', 'finished'] as Bucket[]).map((b) => {
            const rows = buckets[b];
            if (rows.length === 0) return null;
            return view === 'card' ? (
              <section key={b} className="mb-6">
                <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">
                  {BUCKETS[b].label}（{rows.length}）
                </h3>
                <div className="grid grid-cols-2 gap-2.5">
                  {rows.map(renderCard)}
                </div>
              </section>
            ) : (
              <section key={b} className="mb-4">
                <h3 className="mb-1 px-3 pt-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">
                  {BUCKETS[b].label}（{rows.length}）
                </h3>
                <div>{rows.map(renderRow)}</div>
              </section>
            );
          })
        )}
      </div>

      {selectedTask && (
        <TaskDetailOverlay
          task={selectedTask}
          onClose={() => setSelectedTask(null)}
          onChanged={(next) => {
            if (next === null) {
              setTasks((prev) =>
                prev.filter((x) => x.id !== selectedTask.id),
              );
              setSelectedTask(null);
            } else {
              setTasks((prev) =>
                prev.map((x) => (x.id === next.id ? next : x)),
              );
              setSelectedTask(next);
            }
          }}
        />
      )}

      {selectedLegacy && (
        <LegacyCronOverlay
          legacy={selectedLegacy.raw}
          onClose={() => setSelectedLegacy(null)}
          onChanged={() => {
            void reload();
          }}
        />
      )}
    </div>
  );
}

/**
 * Pull every CronTask across workspaces and surface the ones that don't have
 * a Task Center back-pointer (PRD §11.4 legacy upsurface). Returns `[]` when
 * the Tauri environment isn't ready or the CLI round-trip fails — we don't
 * want a transient error to blank out the whole task list.
 */
async function fetchLegacyCronTasks(): Promise<LegacyCronRow[]> {
  if (!taskCenterAvailable()) return [];
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const all = (await invoke<Record<string, unknown>[]>(
      'cmd_get_cron_tasks',
    )) as Array<Record<string, unknown>>;
    return all
      .filter((t) => !t.taskId && !t.task_id)
      .map<LegacyCronRow>((t) => {
        const status = (t.status as string | undefined) === 'running' ? 'running' : 'stopped';
        const updatedAt =
          typeof t.updatedAt === 'string'
            ? Date.parse(t.updatedAt)
            : typeof t.createdAt === 'string'
              ? Date.parse(t.createdAt)
              : 0;
        return {
          id: String(t.id ?? ''),
          name: String(t.name ?? t.prompt ?? '未命名定时任务').slice(0, 80),
          status,
          raw: t,
          workspacePath: String(t.workspacePath ?? ''),
          updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
        };
      });
  } catch (err) {
    console.warn('[TaskListPanel] fetchLegacyCronTasks failed', err);
    return [];
  }
}

export default TaskListPanel;
