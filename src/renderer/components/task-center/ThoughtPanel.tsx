// ThoughtPanel — left column of Task Center: Thought stream.
// Owns its own section header (icon + label + search toggle) so the search
// box is collapsed by default and matches the "最近历史" / "工作区文件管理"
// interaction pattern.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FolderOpen, Lightbulb, X } from 'lucide-react';
import { thoughtList, thoughtOpenDir, taskCenterAvailable } from '@/api/taskCenter';
import { SearchPill } from './SearchPill';
import { ThoughtInput } from './ThoughtInput';
import { ThoughtCard } from './ThoughtCard';
import { useConfig } from '@/hooks/useConfig';
import { useThoughtTagCandidates } from '@/hooks/useThoughtTagCandidates';
import type { Thought } from '@/../shared/types/thought';

interface Props {
  onDispatchThought?: (t: Thought) => void;
  onDiscussThought?: (t: Thought, workspaceId: string) => void;
  /**
   * When `true`, the panel re-fetches from disk. Parent should bump this on tab
   * activation so a thought created elsewhere (e.g. Launcher 想法 mode) appears
   * without requiring manual reload.
   */
  refreshKey?: unknown;
  /**
   * When `true`, the ThoughtInput auto-focuses its textarea. Parent (TaskCenter)
   * threads `isActive` through this so returning to the tab drops the caret
   * into the input box without a second click (v0.1.69 UX round).
   */
  autoFocusInput?: boolean;
}

export function ThoughtPanel({
  onDispatchThought,
  onDiscussThought,
  refreshKey,
  autoFocusInput = false,
}: Props) {
  const [thoughts, setThoughts] = useState<Thought[]>([]);
  const [query, setQuery] = useState('');
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // `searchFocused` opens the tag-cloud panel below the search pill when
  // the user has focused the input without typing anything yet — gives
  // them a shortcut to "oh, pick a tag" vs. "type a search". Set on
  // focus, cleared on blur; the blur is delayed by a frame so clicking
  // a cloud tag doesn't get swallowed.
  const [searchFocused, setSearchFocused] = useState(false);
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

  // History-only tag list — drives the search-box tag cloud below, which is
  // an inventory of tags the user has *actually used*. Including agent names
  // here would make the cloud show phantom tags that filter nothing.
  const allTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of thoughts) {
      for (const tag of t.tags) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [thoughts]);

  // Picker candidates — history tags + agent workspace names (sanitized to
  // pass the Rust `#` parser). Workspace names surface as default options
  // even when no thought has used them yet, so a brand-new agent is
  // discoverable the first time the user presses `#`.
  const { config } = useConfig();
  const tagCandidates = useThoughtTagCandidates(thoughts, config.agents ?? null);

  // Search panel shows the tag cloud only when the user has focused the
  // search input AND hasn't narrowed by text or picked a tag yet. Typing
  // text or selecting a tag collapses the cloud (animated) so the result
  // list takes over.
  const showTagCloud =
    searchFocused && query.trim() === '' && activeTag === null && allTags.length > 0;

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return thoughts.filter((t) => {
      if (activeTag && !t.tags.some((x) => x === activeTag)) return false;
      if (needle && !t.content.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [thoughts, query, activeTag]);

  const clearSearch = useCallback(() => {
    setQuery('');
    searchInputRef.current?.blur();
  }, []);

  return (
    <div className="flex h-full flex-col">
      {/* Section header — label on the left, persistent search pill on
          the right. The search pill replaces the prior "icon toggle →
          full-width input" pattern with an always-visible affordance
          per the reference mock. Tag-cloud dropdown is re-attached
          relative to this header's container so it still appears right
          under the search input, via absolute positioning. */}
      {/* Panel header — v0.1.69 polish: hairline below removed;
          the gap between this row and the content below is now
          pure breathing room (via the input row's own padding) so
          the column reads as one continuous surface. Vertical
          divider between the two panels remains (handled in
          TaskCenter.tsx). */}
      <div className="relative flex h-12 shrink-0 items-center px-4">
        {/* When the search pill is active (focused or has a query), the
            "想法" label folds out of the row so the input can claim the
            full width. We keep the label in the DOM with width:0 +
            opacity so there's no reflow flash; the SearchPill owns the
            animation via its own width transition. */}
        {(() => {
          const searchActive = searchFocused || query.length > 0;
          return (
            <>
              <div
                className="flex items-center gap-2 overflow-hidden"
                style={{
                  maxWidth: searchActive ? '0px' : '120px',
                  opacity: searchActive ? 0 : 1,
                  marginRight: searchActive ? '0' : '8px',
                  transition:
                    'max-width 200ms cubic-bezier(0.22, 1, 0.36, 1), opacity 150ms ease-out, margin-right 200ms cubic-bezier(0.22, 1, 0.36, 1)',
                  pointerEvents: searchActive ? 'none' : 'auto',
                }}
              >
                {/* `relative top-[1px]` nudges the icon down ~1px so its
                    optical center aligns with the Chinese label's ink
                    center — lucide icons are geometrically centered in
                    their viewBox but Chinese glyphs sit slightly below
                    the em box center, making items-center alone read as
                    icon-too-high. Same tweak on TaskListPanel's CheckSquare. */}
                <Lightbulb
                  className="relative top-[1px] h-4 w-4 shrink-0 text-[var(--ink-muted)]"
                  strokeWidth={1.5}
                />
                <span className="whitespace-nowrap text-[16px] font-semibold text-[var(--ink)]">
                  想法
                </span>
              </div>
              {/* "打开想法存储的文件夹" — ghost icon button, no label.
                  Sits OUTSIDE the fold container because that container is
                  `overflow: hidden` to drive the label slide-out animation;
                  a tooltip rendered inside would be clipped at the bottom
                  edge and never appear. Here it's a sibling whose own
                  visibility is gated by `searchActive` via opacity /
                  pointer-events, and the dark-pill tooltip is free to
                  render below the button without clipping. */}
              <div
                className="group/openDir relative"
                style={{
                  opacity: searchActive ? 0 : 1,
                  pointerEvents: searchActive ? 'none' : 'auto',
                  transition: 'opacity 150ms ease-out',
                }}
              >
                <button
                  type="button"
                  onClick={() => {
                    if (!taskCenterAvailable()) return;
                    void thoughtOpenDir().catch((err) => {
                      console.error('[ThoughtPanel] open dir failed', err);
                    });
                  }}
                  aria-label="打开想法存储的文件夹"
                  className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                >
                  <FolderOpen className="h-3.5 w-3.5" strokeWidth={1.75} />
                </button>
                <span className="pointer-events-none absolute left-1/2 top-full z-50 mt-1.5 -translate-x-1/2 whitespace-nowrap rounded-md bg-[var(--ink)] px-2 py-1 text-[11px] font-medium text-[var(--paper)] opacity-0 shadow-md transition-opacity duration-150 group-hover/openDir:opacity-100">
                  打开想法存储的文件夹
                </span>
              </div>
              <div className="ml-auto flex min-w-0 flex-1 justify-end">
                <SearchPill
                  inputRef={searchInputRef}
                  value={query}
                  onChange={setQuery}
                  onClear={clearSearch}
                  placeholder="搜索想法…"
                  expandedFull
                  onFocus={() => setSearchFocused(true)}
                  // Delay blur so clicking a tag inside the floating cloud
                  // registers before the cloud collapses. The tag buttons use
                  // `onMouseDown` + preventDefault to re-focus the input, but
                  // that sequence still triggers a blur→focus round-trip —
                  // the 120ms grace absorbs it cleanly.
                  onBlur={() =>
                    setTimeout(() => setSearchFocused(false), 120)
                  }
                />
              </div>
            </>
          );
        })()}

        {/* Tag cloud — floats under the search pill when focused and
            the input is empty. Spans the same horizontal range as the
            expanded SearchPill (pill takes full-row width when focused
            via `expandedFull`, which is also left-4→right-4 of this
            header) by absolutely positioning with both edges instead
            of a fixed pixel width. */}
        <div
          className="absolute left-4 right-4 top-full z-30 mt-1 overflow-hidden rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] shadow-md"
          style={{
            maxHeight: showTagCloud ? '220px' : '0px',
            opacity: showTagCloud ? 1 : 0,
            pointerEvents: showTagCloud ? 'auto' : 'none',
            transition:
              'max-height 220ms cubic-bezier(0.22, 1, 0.36, 1), opacity 160ms ease-out',
          }}
        >
          <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--ink-muted)]/60">
            按标签筛选
          </div>
          <div className="flex max-h-[190px] flex-wrap gap-1.5 overflow-y-auto px-2 pb-2">
            {allTags.map(([tag, n]) => (
              <button
                key={tag}
                type="button"
                onMouseDown={(e) => {
                  // mousedown so we set state before the input's blur
                  // triggers and collapses the cloud.
                  e.preventDefault();
                  setActiveTag(tag);
                  searchInputRef.current?.blur();
                }}
                className="rounded-[var(--radius-md)] bg-[var(--paper-inset)] px-2 py-0.5 text-[11px] text-[var(--ink-muted)] transition-colors hover:bg-[var(--accent-warm-subtle)] hover:text-[var(--accent-warm)]"
              >
                #{tag}
                <span className="ml-1 text-[var(--ink-muted)]/60">{n}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Input — new thought */}
      <div className="p-3">
        <ThoughtInput
          onCreated={(t) => setThoughts((prev) => [t, ...prev])}
          existingTags={tagCandidates}
          autoFocus={autoFocusInput}
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
          <div className="flex flex-col gap-3">
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
