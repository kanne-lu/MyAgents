// TaskListPanel — right column of Task Center: task cards + filter bar.
// Three sections: pending (todo/blocked/stopped), active (running/verifying),
// finished (done/archived). PRD §7.2.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { taskList } from '@/api/taskCenter';
import type { Task, TaskStatus } from '@/../shared/types/task';
import { TaskCard } from './TaskCard';
import { TaskDetailOverlay } from './TaskDetailOverlay';

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

export function TaskListPanel({ highlightTaskId, refreshKey }: Props) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const list = await taskList({});
      setTasks(list);
    } catch (err) {
      console.error('[TaskListPanel] load failed', err);
      setTasks([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload, refreshKey]);

  const buckets = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? tasks.filter(
          (t) =>
            t.name.toLowerCase().includes(needle) ||
            t.description?.toLowerCase().includes(needle) ||
            t.tags.some((x) => x.toLowerCase().includes(needle)),
        )
      : tasks;
    const out: Record<Bucket, Task[]> = {
      active: [],
      pending: [],
      finished: [],
    };
    for (const t of filtered) {
      for (const [name, cfg] of Object.entries(BUCKETS) as Array<
        [Bucket, typeof BUCKETS[Bucket]]
      >) {
        if (cfg.statuses.includes(t.status)) {
          out[name].push(t);
          break;
        }
      }
    }
    return out;
  }, [tasks, query]);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-[var(--line-subtle)] px-4 py-2.5">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--ink-muted)]" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索任务"
            className="w-full rounded-[var(--radius-md)] border border-[var(--line)] bg-[var(--paper)] py-1.5 pl-8 pr-3 text-[13px] text-[var(--ink)] placeholder:text-[var(--ink-muted)] focus:border-[var(--line-strong)] focus:outline-none"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {loading ? (
          <div className="py-8 text-center text-[13px] text-[var(--ink-muted)]">
            加载中…
          </div>
        ) : tasks.length === 0 ? (
          <div className="py-12 text-center text-[13px] text-[var(--ink-muted)]">
            还没有任务。在左栏记下想法后点「派发」即可创建任务。
          </div>
        ) : (
          (['active', 'pending', 'finished'] as Bucket[]).map((b) => {
            const rows = buckets[b];
            if (rows.length === 0) return null;
            return (
              <section key={b} className="mb-6">
                <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">
                  {BUCKETS[b].label}（{rows.length}）
                </h3>
                <div className="flex flex-col gap-2">
                  {rows.map((t) => (
                    <TaskCard
                      key={t.id}
                      task={t}
                      onClick={setSelectedTask}
                      highlighted={highlightTaskId === t.id}
                    />
                  ))}
                </div>
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
    </div>
  );
}

export default TaskListPanel;
