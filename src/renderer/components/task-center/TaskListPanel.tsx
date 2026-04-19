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
import { Layers } from 'lucide-react';

import {
  taskCenterAvailable,
  taskDelete,
  taskList,
  taskRerun,
  taskRun,
  taskUpdateStatus,
} from '@/api/taskCenter';
import { useToast } from '@/components/Toast';
import { useConfig } from '@/hooks/useConfig';
import type { Task, TaskStatus } from '@/../shared/types/task';
import { canAutoUpgrade, upgradeLegacyCron, type LegacyCronRaw } from './legacyUpgrade';
import { LegacyCronOverlay } from './LegacyCronOverlay';
import { TaskDetailOverlay } from './TaskDetailOverlay';
import { TaskCardItem } from './views/TaskCardItem';
import { TaskListRow } from './views/TaskListRow';
import { SearchPill } from './SearchPill';
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

// "进行中" 的产品语义是「应当被执行的任务」，不是字面"正在跑"。
// `stopped`（用户暂停）和 `blocked`（执行受阻）都是**临时子状态**，
// 任务本身仍被认为该跑 —— 徽章的黄/灰配色已经区分了子状态，列表聚合
// 不必再按这些小波动分桶。`规划中` 留给真正的新建未调度态（todo）——
// 任务已被构思并创建，但尚未被调度器首次触发。
const BUCKETS: Record<Bucket, { label: string; statuses: TaskStatus[] }> = {
  active: { label: '进行中', statuses: ['running', 'verifying', 'stopped', 'blocked'] },
  pending: { label: '规划中', statuses: ['todo'] },
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
  const { projects } = useConfig();
  const projectsRef = useRef(projects);
  useEffect(() => {
    projectsRef.current = projects;
  }, [projects]);
  // Serialize reload() calls — belt-and-braces alongside the server-side
  // `cmd_cron_set_task_id` link-if-null guard. Prevents the auto-upgrade
  // sweep from interleaving with itself when SSE events and refreshKey
  // bumps arrive back-to-back. A trailing `pending` flag catches reloads
  // that land during an in-flight run so we never miss a state change.
  const reloadInflightRef = useRef(false);
  const reloadPendingRef = useRef(false);

  const [tasks, setTasks] = useState<Task[]>([]);
  const [legacy, setLegacy] = useState<LegacyCronRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
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
    if (reloadInflightRef.current) {
      reloadPendingRef.current = true;
      return;
    }
    reloadInflightRef.current = true;
    reloadPendingRef.current = false;
    setLoading(true);
    try {
      const [nativeList, legacyList] = await Promise.all([
        taskList({}),
        fetchLegacyCronTasks(),
      ]);
      // Silent auto-upgrade (PRD §11.4 / §16.2). Any legacy row that has
      // the prerequisites (prompt + resolvable workspace) is upgraded in
      // place before we commit state. Rows that fail eligibility remain
      // in the legacy list and can still be upgraded manually via the
      // `LegacyCronOverlay` button (where we surface the actual error).
      //
      // The operation is idempotent — once a cron has `task_id` set,
      // `fetchLegacyCronTasks` filters it out, so re-running this does
      // nothing on subsequent reloads.
      const { upgradedTasks, remainingLegacy, failedCount, firstError } =
        await autoUpgradeEligible(legacyList, projectsRef.current);
      const mergedNative = upgradedTasks.length
        ? [...upgradedTasks, ...nativeList]
        : nativeList;
      setTasks(mergedNative);
      setLegacy(remainingLegacy);
      if (upgradedTasks.length > 0) {
        toastRef.current.success(
          `已自动升级 ${upgradedTasks.length} 个旧定时任务为新版任务`,
        );
      }
      // Surface auto-upgrade failures so the user understands why the
      // legacy badge is still there. Detail goes to the console; the
      // toast trims to the first error (at most one per reload).
      if (failedCount > 0) {
        toastRef.current.error(
          `${failedCount} 个遗留任务自动升级失败：${firstError ?? '未知错误'}。可在详情面板点击「升级为新版任务」手动重试。`,
          8000,
        );
      }
    } catch (err) {
      console.error('[TaskListPanel] load failed', err);
      setTasks([]);
      setLegacy([]);
    } finally {
      setLoading(false);
      reloadInflightRef.current = false;
      if (reloadPendingRef.current) {
        // A status change landed during this run — kick another pass so
        // we don't lose the state that arrived mid-flight.
        reloadPendingRef.current = false;
        void reloadRef.current?.();
      }
    }
  }, []);
  // Self-reference so the trailing re-kick above can call the latest
  // closure without adding `reload` to its own dep array.
  const reloadRef = useRef<typeof reload>(reload);
  useEffect(() => {
    reloadRef.current = reload;
  }, [reload]);

  useEffect(() => {
    void reload();
  }, [reload, refreshKey]);

  // Projects are loaded asynchronously by `useConfig()` — when Task Center
  // mounts before config is ready, `projects=[]` and the auto-upgrade sweep
  // finds nothing eligible. Re-kick reload the moment config transitions
  // from empty → populated so eligible legacy rows get upgraded without
  // having to wait for an unrelated SSE event.
  const hadProjectsRef = useRef(projects.length > 0);
  useEffect(() => {
    if (!hadProjectsRef.current && projects.length > 0) {
      hadProjectsRef.current = true;
      void reload();
    }
  }, [projects.length, reload]);


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
      // Legacy → new-model status mapping. We use `hasExited` (derived
      // from `CronTask.exit_reason`) to distinguish "ended naturally"
      // from "user paused" — the scheduler sets exit_reason when end
      // conditions trigger or the AI calls ExitCronTask, so this is a
      // reliable signal that the cron is done, not just idle.
      //   • running              → `running`  (active bucket)
      //   • stopped + exited     → `done`     (finished bucket)
      //   • stopped (no reason)  → `stopped`  (pending bucket — user
      //                                        can restart from here)
      const status: TaskStatus =
        c.kind === 'task'
          ? c.task.status
          : c.legacy.status === 'running'
            ? 'running'
            : c.legacy.hasExited
              ? 'done'
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

  const clearSearch = useCallback(() => {
    setQuery('');
    searchInputRef.current?.blur();
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
      {/* Section header — label + persistent search pill + view toggle.
          h-12 per DESIGN.md §7.4 (aligns with TaskCenter page header).
          The search pill is always visible (no toggle modal state) — per
          the reference mock, searching is a constant affordance, not a
          hidden mode the user has to enter first. */}
      <div className="flex h-12 items-center gap-3 border-b border-[var(--line-subtle)] px-4">
        <div className="flex items-center gap-2">
          <Layers className="h-3.5 w-3.5 text-[var(--ink-muted)]" strokeWidth={1.5} />
          <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">
            任务
          </span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <SearchPill
            inputRef={searchInputRef}
            value={query}
            onChange={setQuery}
            onClear={clearSearch}
            placeholder="搜索任务…"
          />
          <ViewToggle value={view} onChange={updateView} />
        </div>
      </div>

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
                {/* Bucket header — 11px uppercase small-caps + count +
                    flex-1 hairline rule (per the reference mock). The
                    previous "big semibold" treatment was too loud — the
                    header should read as a quiet section divider, with
                    the task cards below carrying the visual weight. */}
                <BucketHeader label={BUCKETS[b].label} count={rows.length} />
                <div className="grid grid-cols-2 gap-3">
                  {rows.map(renderCard)}
                </div>
              </section>
            ) : (
              <section key={b} className="mb-4">
                <div className="px-3 pt-3">
                  <BucketHeader label={BUCKETS[b].label} count={rows.length} />
                </div>
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
          onUpgraded={(upgradedTask) => {
            // PRD §11.4 — after upgrade the legacy back-pointer is set, so
            // next reload filters it out of the legacy list. Switch the open
            // overlay to the new TaskDetailOverlay for continuity.
            setSelectedLegacy(null);
            setTasks((prev) => {
              const idx = prev.findIndex((x) => x.id === upgradedTask.id);
              if (idx === -1) return [upgradedTask, ...prev];
              return prev.map((x) => (x.id === upgradedTask.id ? upgradedTask : x));
            });
            setSelectedTask(upgradedTask);
            toastRef.current.success(`「${upgradedTask.name}」已升级为新版任务`);
            void reload();
          }}
        />
      )}
    </div>
  );
}

/**
 * Bucket header — 11px uppercase label + muted count + flex-1 hairline
 * rule, per the v0.1.69 visual mockup. Quiet enough to read as a
 * section divider rather than a page heading; the task cards below
 * carry the actual visual weight.
 */
function BucketHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">
        {label}
      </span>
      <span className="text-[11px] tabular-nums text-[var(--ink-subtle)]">
        {count}
      </span>
      <span className="ml-1 h-px flex-1 bg-[var(--line-subtle)]" aria-hidden />
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
        // `exit_reason` is populated by the scheduler when end-conditions
        // trigger or the AI calls ExitCronTask — the signal we use to say
        // "this cron is done, not paused". Defend against snake/camel as
        // other raw fields do.
        const exitReason =
          (t.exitReason as string | null | undefined) ??
          (t.exit_reason as string | null | undefined);
        return {
          id: String(t.id ?? ''),
          name: String(t.name ?? t.prompt ?? '未命名定时任务').slice(0, 80),
          status,
          hasExited: status === 'stopped' && !!exitReason,
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

/**
 * Sweep a freshly-fetched legacy list and upgrade every eligible row to
 * a new-model Task. Uses the same `upgradeLegacyCron` flow as the manual
 * button in `LegacyCronOverlay` so the behaviour is identical — only the
 * trigger differs. Rows that fail eligibility (no prompt, unknown
 * workspace, etc.) stay in the legacy list untouched; the user can still
 * upgrade them manually or dismiss them via the existing delete path.
 *
 * Errors are logged but do not abort the sweep — one bad row shouldn't
 * leave the rest unmigrated.
 */
async function autoUpgradeEligible(
  legacy: LegacyCronRow[],
  projects: import('@/config/types').Project[],
): Promise<{
  upgradedTasks: Task[];
  remainingLegacy: LegacyCronRow[];
  failedCount: number;
  firstError: string | null;
}> {
  const upgradedTasks: Task[] = [];
  const remainingLegacy: LegacyCronRow[] = [];
  let failedCount = 0;
  let firstError: string | null = null;
  for (const row of legacy) {
    const raw = row.raw as LegacyCronRaw;
    if (!canAutoUpgrade(raw, projects)) {
      // Not counted as "failed" — these are known-ineligible (missing
      // prompt / unresolvable workspace) and the user sees them in the
      // legacy list with the manual upgrade button.
      remainingLegacy.push(row);
      continue;
    }
    try {
      const { task } = await upgradeLegacyCron(raw, projects);
      upgradedTasks.push(task);
    } catch (err) {
      console.warn('[TaskListPanel] auto-upgrade failed for', row.id, err);
      remainingLegacy.push(row);
      failedCount += 1;
      if (!firstError) firstError = String(err);
    }
  }
  return { upgradedTasks, remainingLegacy, failedCount, firstError };
}

export default TaskListPanel;
