// ThoughtPanel — left column of Task Center: Thought stream.
// Owns its own section header (icon + label + search toggle) so the search
// box is collapsed by default and matches the "最近历史" / "工作区文件管理"
// interaction pattern.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Lightbulb, Search, X } from 'lucide-react';
import { thoughtList, taskCenterAvailable } from '@/api/taskCenter';
import { ThoughtInput } from './ThoughtInput';
import { ThoughtCard } from './ThoughtCard';
import type { Thought } from '@/../shared/types/thought';

interface Props {
  onDispatchThought?: (t: Thought) => void;
  onDiscussThought?: (t: Thought) => void;
  /**
   * When `true`, the panel re-fetches from disk. Parent should bump this on tab
   * activation so a thought created elsewhere (e.g. Launcher 想法 mode) appears
   * without requiring manual reload.
   */
  refreshKey?: unknown;
}

export function ThoughtPanel({
  onDispatchThought,
  onDiscussThought,
  refreshKey,
}: Props) {
  const [thoughts, setThoughts] = useState<Thought[]>([]);
  const [query, setQuery] = useState('');
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [isSearchMode, setIsSearchMode] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

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

  // Auto-focus the search input when the user toggles search mode on.
  useEffect(() => {
    if (isSearchMode) {
      searchInputRef.current?.focus();
    }
  }, [isSearchMode]);

  // When a task transitions (including creation → convertedTaskIds backlink on
  // its source thought), refetch so "已派生 N 个任务" count stays live.
  useEffect(() => {
    if (!taskCenterAvailable()) return;
    let off: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      const { listen } = await import('@tauri-apps/api/event');
      if (cancelled) return;
      const unlisten = await listen('task:status-changed', () => {
        void reload();
      });
      if (cancelled) {
        unlisten();
      } else {
        off = unlisten;
      }
    })();
    return () => {
      cancelled = true;
      off?.();
    };
  }, [reload]);

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

  // Full tag list, sorted by frequency. Feeds both the `#` autocomplete in
  // ThoughtInput and the search-expanded tag panel below.
  const allTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of thoughts) {
      for (const tag of t.tags) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [thoughts]);

  // Search panel shows the tag cloud only when the user hasn't narrowed by
  // text or picked a tag yet — typing text or selecting a tag collapses the
  // cloud (animated) so the result list takes over.
  const showTagCloud =
    isSearchMode && query.trim() === '' && activeTag === null && allTags.length > 0;

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return thoughts.filter((t) => {
      if (activeTag && !t.tags.some((x) => x === activeTag)) return false;
      if (needle && !t.content.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [thoughts, query, activeTag]);

  const exitSearch = useCallback(() => {
    setIsSearchMode(false);
    setQuery('');
  }, []);

  return (
    <div className="flex h-full flex-col">
      {/* Section header — fixed-height outer wrapper so toggling between
          "label + search icon" and "search input" never shifts the layout
          below by the 10px the two modes' natural content heights differ
          by. Content swaps inside, frame stays put. */}
      <div className="relative flex h-11 shrink-0 items-center border-b border-[var(--line-subtle)] px-4">
        {isSearchMode ? (
          <div className="group relative w-full">
            <div
              className={`rounded-md border bg-transparent transition-colors ${
                showTagCloud
                  ? 'rounded-b-none border-[var(--accent)]'
                  : 'border-[var(--line)] group-focus-within:border-[var(--accent)]'
              }`}
            >
              <div className="relative flex items-center">
                <Search className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-[var(--ink-muted)]" />
                <input
                  ref={searchInputRef}
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="搜索想法，或点击下方标签快速筛选"
                  className="h-7 w-full bg-transparent pl-8 pr-7 text-[13px] text-[var(--ink)] placeholder:text-[var(--ink-muted)]/70 outline-none"
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

            {/* Floating tail — absolute so it overlays rather than pushes
                the list below. Background matches the input row (via
                `--paper`, the panel's own base) so the compound reads as
                one surface; a single inset grey line — not reaching the
                border — divides input area from tag cloud per the spec's
                "用不到顶的灰色线弱风格" ask. */}
            <div
              className="absolute left-0 right-0 top-full z-30 overflow-hidden rounded-b-md border border-t-0 border-[var(--accent)] bg-[var(--paper)] shadow-sm"
              style={{
                maxHeight: showTagCloud ? '220px' : '0px',
                opacity: showTagCloud ? 1 : 0,
                pointerEvents: showTagCloud ? 'auto' : 'none',
                transition:
                  'max-height 220ms cubic-bezier(0.22, 1, 0.36, 1), opacity 160ms ease-out',
              }}
            >
              {/* Hair-thin divider — inset enough that it reads as a
                  whisper, not a cut. Uses a low-opacity `--ink-muted`
                  directly so the line stays visibly grey even when the
                  surrounding `--accent` border is present. */}
              <div className="mx-8 h-px bg-[var(--ink-muted)]/15" />
              <div className="flex max-h-[220px] flex-wrap gap-1.5 overflow-y-auto p-2">
                {allTags.map(([tag, n]) => (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => setActiveTag(tag)}
                    className="rounded-[var(--radius-md)] bg-[var(--paper-inset)] px-2 py-0.5 text-[11px] text-[var(--ink-muted)] transition-colors hover:bg-[var(--accent-warm-subtle)] hover:text-[var(--accent-warm)]"
                  >
                    #{tag}
                    <span className="ml-1 text-[var(--ink-muted)]/60">{n}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <Lightbulb className="h-3.5 w-3.5 text-[var(--ink-muted)]" />
              <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">
                想法
              </span>
            </div>
            <button
              type="button"
              onClick={() => setIsSearchMode(true)}
              title="搜索想法"
              className="ml-auto flex h-6 w-6 items-center justify-center rounded p-1 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
            >
              <Search className="h-3.5 w-3.5" />
            </button>
          </>
        )}
      </div>

      {/* Input — new thought */}
      <div className="border-b border-[var(--line-subtle)] p-3">
        <ThoughtInput
          onCreated={(t) => setThoughts((prev) => [t, ...prev])}
          existingTags={allTags}
        />
      </div>

      {/* Dynamic list header — occupies a consistent row above the cards
          so the layout doesn't shift when the filter chip appears:
            • default: 「想法 (N)」 on the left, right side reserved for
              future actions (e.g. sort, bulk-select).
            • when `activeTag` is set: the title flips to 「筛选」 and the
              filter chip replaces the count, so the state-change reads as
              in-place rather than a new row sliding in.
          No bottom border — visually the header and the card list read as
          a single surface. */}
      <div className="flex min-h-[34px] items-center justify-between px-4 py-1.5">
        {activeTag ? (
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">
              筛选
            </span>
            <button
              type="button"
              onClick={() => setActiveTag(null)}
              className="flex items-center gap-1 rounded-[var(--radius-md)] bg-[var(--accent-warm-muted)] px-2 py-0.5 text-[12px] text-[var(--accent-warm)]"
              title="清除筛选"
            >
              #{activeTag}
              <X className="h-3 w-3" />
            </button>
          </div>
        ) : (
          <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">
            想法 <span className="text-[var(--ink-muted)]/60">({thoughts.length})</span>
          </span>
        )}
        {/* Right slot — reserved for future actions. Empty placeholder keeps
            the row height stable as we add buttons here later. */}
        <div />
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
                onDiscuss={onDiscussThought}
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
