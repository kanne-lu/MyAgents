// ThoughtPanel — left column of Task Center: Thought stream.
// Loads thoughts from Rust store, supports search, filter, create, inline edit, delete.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Search, X } from 'lucide-react';
import { thoughtList } from '@/api/taskCenter';
import { ThoughtInput } from './ThoughtInput';
import { ThoughtCard } from './ThoughtCard';
import type { Thought } from '@/../shared/types/thought';

interface Props {
  onDispatchThought?: (t: Thought) => void;
  /**
   * When `true`, the panel re-fetches from disk. Parent should bump this on tab
   * activation so a thought created elsewhere (e.g. Launcher 想法 mode) appears
   * without requiring manual reload.
   */
  refreshKey?: unknown;
}

export function ThoughtPanel({ onDispatchThought, refreshKey }: Props) {
  const [thoughts, setThoughts] = useState<Thought[]>([]);
  const [query, setQuery] = useState('');
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const list = await thoughtList({});
      setThoughts(list);
    } catch (err) {
      console.error('[ThoughtPanel] load failed', err);
      setThoughts([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload, refreshKey]);

  const handleCardChanged = useCallback(
    (prevId: string, next: Thought | null) => {
      if (next === null) {
        setThoughts((prev) => prev.filter((x) => x.id !== prevId));
      } else {
        setThoughts((prev) => prev.map((x) => (x.id === prevId ? next : x)));
      }
    },
    [],
  );

  const allTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of thoughts) {
      for (const tag of t.tags) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20);
  }, [thoughts]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return thoughts.filter((t) => {
      if (activeTag && !t.tags.some((x) => x === activeTag)) return false;
      if (needle && !t.content.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [thoughts, query, activeTag]);

  return (
    <div className="flex h-full flex-col">
      {/* Input header */}
      <div className="border-b border-[var(--line)] p-4">
        <ThoughtInput
          onCreated={(t) => setThoughts((prev) => [t, ...prev])}
        />
      </div>

      {/* Search + tag filter bar */}
      <div className="border-b border-[var(--line-subtle)] px-4 py-2.5">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--ink-muted)]" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索想法"
              className="w-full rounded-[var(--radius-md)] border border-[var(--line)] bg-[var(--paper)] py-1.5 pl-8 pr-3 text-[13px] text-[var(--ink)] placeholder:text-[var(--ink-muted)] focus:border-[var(--line-strong)] focus:outline-none"
            />
          </div>
          {activeTag && (
            <button
              type="button"
              onClick={() => setActiveTag(null)}
              className="flex items-center gap-1 rounded-[var(--radius-md)] bg-[var(--accent-warm-muted)] px-2 py-1 text-[12px] text-[var(--accent-warm)]"
            >
              #{activeTag}
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
        {allTags.length > 0 && !activeTag && (
          <div className="mt-2 flex flex-wrap gap-1">
            {allTags.map(([tag, n]) => (
              <button
                key={tag}
                type="button"
                onClick={() => setActiveTag(tag)}
                className="rounded-[var(--radius-sm)] bg-[var(--paper-inset)] px-2 py-0.5 text-[11px] text-[var(--ink-muted)] transition-colors hover:text-[var(--accent-warm)]"
              >
                #{tag}
                <span className="ml-1 text-[var(--ink-muted)]/60">{n}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {loading ? (
          <div className="py-8 text-center text-[13px] text-[var(--ink-muted)]">
            加载中…
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-12 text-center text-[13px] text-[var(--ink-muted)]">
            {thoughts.length === 0
              ? '还没有想法，写下第一条吧'
              : '没有匹配的想法'}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {filtered.map((t) => (
              <ThoughtCard
                key={t.id}
                thought={t}
                onChanged={(next) => handleCardChanged(t.id, next)}
                onDispatch={onDispatchThought}
                onTagClick={setActiveTag}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default ThoughtPanel;
