// ThoughtInput — compact freeform note input for Thought mode.
// Writes through to ~/.myagents/thoughts/ via `cmd_thought_create`.
//
// flomo-style inline tag editor: `#word ` as you type → `#word` renders
// highlighted inline; typing `#` (or clicking the # toolbar button) opens
// a tag picker filtered by the partial tag; Enter / Tab / click picks.
//
// Implementation: a transparent <textarea> layered on top of a mirror
// <div> that renders the same text with `#tag` runs coloured via
// `splitWithTagHighlights` (the shared parser with Rust + ThoughtCard, so
// highlight ≡ server-extracted `thought.tags[]`).

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Hash, PenLine } from 'lucide-react';
import { thoughtCreate } from '@/api/taskCenter';
import Tip from '@/components/Tip';
import { Popover } from '@/components/ui/Popover';
import {
  findActiveTagContext,
  isBoundaryChar,
  splitWithTagHighlights,
  tagBodyEndOffset,
} from '@/utils/parseThoughtTags';
import type { Thought } from '@/../shared/types/thought';

export interface ThoughtInputHandle {
  /** Programmatically focus the textarea. Mirrors SimpleChatInputHandle so
   *  parents (e.g. Launcher BrandSection) can drive focus on mode switches
   *  without relying on the `autoFocus` prop-flip heuristic. */
  focus: () => void;
}

// Auto-grow bounds for the idle textarea. 14px text × 1.6 line-height
// ≈ 22.4px/row, plus 12px top padding. We target 2 rows idle and ~8 rows
// max (+6 rows of growth before internal scroll kicks in).
const TEXTAREA_MIN_HEIGHT_PX = 12 + 22 * 2;   // ≈ 56
const TEXTAREA_MAX_HEIGHT_PX = 12 + 22 * 8;   // ≈ 188

interface Props {
  onCreated?: (t: Thought) => void;
  placeholder?: string;
  autoFocus?: boolean;
  /**
   * Existing tags sorted by frequency. Populates the `#` autocomplete menu.
   * Parent (ThoughtPanel / BrandSection) aggregates this via
   * `useThoughtTagCandidates`; we accept it as a prop so there's one
   * source of truth.
   *
   * **`count === 0` is a sentinel**, not a bug: entries with zero
   * frequency are "known good tag options that no thought has used yet"
   * (most commonly Agent workspace names). Keep them visible — filtering
   * them out would hide brand-new workspaces from the picker and defeat
   * the whole point of the discovery merge.
   */
  existingTags?: Array<[string, number]>;
}

export const ThoughtInput = forwardRef<ThoughtInputHandle, Props>(function ThoughtInput({
  onCreated,
  // Guide-style placeholder — tells new users both *what* to write and
  // *how* to tag it, so the empty state doesn't look like dead space.
  // §6.3 rules the placeholder color (--ink-muted) which is already
  // applied by the textarea className below.
  placeholder = '写下此刻的想法… 用 #标签 归类',
  autoFocus = false,
  existingTags = [],
}, ref) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Tag autocomplete state.
  const [tagMenu, setTagMenu] = useState<{ anchor: number; query: string } | null>(null);
  const [tagIndex, setTagIndex] = useState(0);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const overlayInnerRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  // Imperative focus — exposed through the forwarded ref so parents can
  // drive focus on mode/tab switches. Matches SimpleChatInputHandle.
  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
  }), []);
  // Pending caret position — consumed by the useLayoutEffect below after
  // React commits the new value, so `setSelectionRange` runs against the
  // up-to-date DOM instead of racing with rAF.
  const pendingCaretRef = useRef<number | null>(null);

  const segments = useMemo(() => splitWithTagHighlights(value), [value]);

  // Substring (not prefix) match — flomo behaviour; typing "ag" finds
  // "myagents", "tags", etc. Capped at 8 rows.
  const filteredTags = useMemo(() => {
    if (!tagMenu) return [];
    const q = tagMenu.query.toLowerCase();
    const list = q
      ? existingTags.filter(([t]) => t.toLowerCase().includes(q))
      : existingTags;
    return list.slice(0, 8);
  }, [existingTags, tagMenu]);

  useEffect(() => {
    setTagIndex(0);
  }, [tagMenu?.query, tagMenu?.anchor]);

  // Programmatic focus when `autoFocus` flips true. The textarea's
  // `autoFocus` HTML attribute only fires on initial mount, but the
  // TaskCenter tab is a singleton — the user can leave and come back
  // without a remount. `autoFocus` effectively becomes a "focus intent"
  // signal now: each time the parent passes `true` (TaskCenter
  // re-activates) we reassert focus. Guarded by the prop value so
  // `false` transitions don't steal focus from other fields.
  useEffect(() => {
    if (!autoFocus) return;
    // Defer one frame so the focus lands after the tab's layout pass
    // and the textarea is actually part of the visible tree (the
    // hidden-tab branch uses `content-visibility: hidden`).
    const raf = requestAnimationFrame(() => textareaRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [autoFocus]);

  // The overlay wrapper is `overflow: hidden` (to clip past the textarea
  // bounds), so setting `scrollTop` on it would no-op. Instead we translate
  // the inner content upward by the textarea's scrollTop — produces the
  // same visual scroll without needing a scrollable overlay container.
  const syncScroll = useCallback(() => {
    const ta = textareaRef.current;
    const inner = overlayInnerRef.current;
    if (!ta || !inner) return;
    inner.style.transform = `translateY(${-ta.scrollTop}px)`;
  }, []);

  useLayoutEffect(() => {
    syncScroll();
  }, [value, syncScroll]);

  // Auto-grow the textarea with content. Floor = 2 rows (idle state stays
  // compact); ceiling = 8 rows (~2 idle + 6 extra, per product spec). Past
  // the ceiling the textarea scrolls internally and the mirror overlay
  // tracks via `syncScroll`. We measure `scrollHeight` which includes
  // padding but not border — clamp via CSS values instead of px math so
  // font-size changes stay in sync without recomputing constants here.
  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    // Reset to 0 before reading scrollHeight so a shrinking value also
    // triggers a recompute (otherwise the textarea is stuck at its tallest
    // historical height).
    ta.style.height = '0px';
    const next = Math.min(ta.scrollHeight, TEXTAREA_MAX_HEIGHT_PX);
    ta.style.height = `${Math.max(next, TEXTAREA_MIN_HEIGHT_PX)}px`;
  }, [value]);

  // Consume any pending caret position after React flushes `setValue` to
  // the DOM — safer than `requestAnimationFrame`, which can run before
  // the commit.
  useLayoutEffect(() => {
    const pos = pendingCaretRef.current;
    if (pos === null) return;
    const ta = textareaRef.current;
    if (!ta) return;
    ta.setSelectionRange(pos, pos);
    ta.focus();
    pendingCaretRef.current = null;
  }, [value]);

  const recomputeTagMenu = useCallback((nextValue: string, cursor: number) => {
    setTagMenu(findActiveTagContext(nextValue, cursor));
  }, []);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const next = e.target.value;
      setValue(next);
      recomputeTagMenu(next, e.target.selectionStart ?? next.length);
    },
    [recomputeTagMenu],
  );

  const handleSelect = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    recomputeTagMenu(ta.value, ta.selectionStart ?? ta.value.length);
  }, [recomputeTagMenu]);

  const insertTag = useCallback(
    (tag: string) => {
      if (!tagMenu) return;
      const { anchor } = tagMenu;
      // Replace the WHOLE tag body at the anchor — including any chars
      // after the caret that are still valid tag chars — so picking a
      // suggestion while the cursor is mid-word doesn't orphan the tail
      // (e.g. caret in `#abc|def` + pick `#abc` no longer leaves `def`).
      const bodyEnd = tagBodyEndOffset(value, anchor);
      const before = value.slice(0, anchor);
      const after = value.slice(bodyEnd);
      const insertion = `#${tag} `;
      const next = before + insertion + after;
      pendingCaretRef.current = before.length + insertion.length;
      setValue(next);
      setTagMenu(null);
    },
    [tagMenu, value],
  );

  const handleHashButton = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    // Replace any active selection — matches standard form-input
    // semantics when a new character is inserted.
    const start = ta.selectionStart ?? value.length;
    const end = ta.selectionEnd ?? start;
    const prev = start === 0 ? '' : value[start - 1];
    const needsSpace = start > 0 && start === end && !isBoundaryChar(prev);
    const insertion = needsSpace ? ' #' : '#';
    const next = value.slice(0, start) + insertion + value.slice(end);
    const newPos = start + insertion.length;
    pendingCaretRef.current = newPos;
    setValue(next);
    recomputeTagMenu(next, newPos);
  }, [recomputeTagMenu, value]);

  const handleSubmit = useCallback(async () => {
    const content = value.trim();
    if (!content || busy) return;
    setBusy(true);
    setError(null);
    try {
      const t = await thoughtCreate({ content });
      setValue('');
      setTagMenu(null);
      onCreated?.(t);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [value, busy, onCreated]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Skip all custom key handling during IME composition — otherwise
      // pressing Enter to commit a pinyin candidate would instead pick a
      // tag suggestion (or submit).
      if (e.nativeEvent.isComposing || e.keyCode === 229) return;

      if (tagMenu && filteredTags.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setTagIndex((i) => Math.min(filteredTags.length - 1, i + 1));
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setTagIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          insertTag(filteredTags[tagIndex][0]);
          return;
        }
      }
      if (tagMenu && e.key === 'Escape') {
        e.preventDefault();
        setTagMenu(null);
        return;
      }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void handleSubmit();
      }
    },
    [tagMenu, filteredTags, tagIndex, insertTag, handleSubmit],
  );

  const canSend = value.trim().length > 0 && !busy;

  return (
    <div className="w-full">
      <div
        ref={cardRef}
        className="relative flex flex-col rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--paper-elevated)] transition-colors focus-within:border-[var(--line-strong)]"
      >
        {/* Mirror layer: same text as the textarea but with coloured `#tag`
            runs. Must match the textarea's font metrics so the highlighted
            spans sit under the same glyphs the user is typing.
            `pointer-events: none` keeps clicks reaching the textarea. */}
        <div className="relative">
          {/* Overlay clip box — matches textarea bounds (absolute inset-0)
              and hides anything past its edges. The actual text lives in
              an inner `overlayInnerRef` div that gets `translateY(-scrollTop)`
              applied whenever the textarea scrolls, so highlighted spans
              track the real text when the thought is long. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 overflow-hidden"
          >
            <div
              ref={overlayInnerRef}
              className="px-3 pt-3 text-[14px] leading-relaxed text-[var(--ink)]"
              style={{
                fontFamily: 'inherit',
                whiteSpace: 'pre-wrap',
                overflowWrap: 'break-word',
                willChange: 'transform',
              }}
            >
              {segments.map((seg, i) =>
                seg.type === 'tag' ? (
                  <span
                    key={i}
                    className="rounded-[var(--radius-sm)] bg-[var(--accent-warm-subtle)] text-[var(--accent-warm)]"
                  >
                    {seg.value}
                  </span>
                ) : (
                  <span key={i}>{seg.value}</span>
                ),
              )}
              {value.endsWith('\n') && '\u200b'}
            </div>
          </div>
          <textarea
            ref={textareaRef}
            value={value}
            onChange={handleChange}
            onSelect={handleSelect}
            onClick={handleSelect}
            onKeyDown={handleKeyDown}
            onScroll={syncScroll}
            placeholder={placeholder}
            // Height is driven by the `useLayoutEffect` above (2-row
            // minimum, 8-row max, internal scroll past that). We don't
            // set `rows={N}` here because it would re-inject a min-height
            // attribute that fights the JS sizer on first paint.
            disabled={busy}
            // NB: no HTML `autoFocus` attribute. The `autoFocus` prop
            // drives a `useEffect` above that calls `.focus()` via
            // `requestAnimationFrame` — that effect fires on every
            // `false → true` transition (tab re-activation), which the
            // mount-only HTML attribute cannot do. Keeping both would
            // just double-fire `.focus()` on first mount.
            // The textarea's own text is transparent (mirror layer above
            // renders the glyphs) — but `-webkit-text-fill-color`
            // overrides `::placeholder { color }` in WebKit, so without
            // the `placeholder:[-webkit-text-fill-color:...]` override
            // the placeholder inherits the transparent fill and is
            // invisible. That was the silent bug in the prior rev.
            className="relative w-full resize-none overflow-y-auto bg-transparent px-3 pt-3 text-[14px] leading-relaxed text-transparent caret-[var(--ink)] placeholder:text-[var(--ink-subtle)] placeholder:[-webkit-text-fill-color:var(--ink-subtle)] focus:outline-none"
            style={{
              fontFamily: 'inherit',
              WebkitTextFillColor: 'transparent',
              overflowWrap: 'break-word',
              minHeight: `${TEXTAREA_MIN_HEIGHT_PX}px`,
              maxHeight: `${TEXTAREA_MAX_HEIGHT_PX}px`,
            }}
          />
        </div>

        {/* Tag autocomplete — Escape dismissal is owned by the textarea's
            onKeyDown (sets tagMenu=null explicitly), so we disable the
            Popover's own Escape handler to keep the two paths from
            double-firing. Outside-click close from the primitive is fine
            since textarea clicks are the anchor and don't count as outside. */}
        <Popover
          open={!!tagMenu && filteredTags.length > 0}
          onClose={() => setTagMenu(null)}
          anchorRef={cardRef}
          placement="bottom-start"
          closeOnEscape={false}
          className="w-56 py-1 shadow-md"
        >
          {tagMenu && (
            <div className="px-3 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--ink-muted)]/60">
              {tagMenu.query ? `匹配 #${tagMenu.query}` : '选择标签'}
            </div>
          )}
          {filteredTags.map(([tag, n], i) => (
            <button
              key={tag}
              type="button"
              onMouseDown={(e) => {
                // Prevent textarea blur so the selection state survives.
                e.preventDefault();
                insertTag(tag);
              }}
              onMouseEnter={() => setTagIndex(i)}
              className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-[12px] transition-colors ${
                i === tagIndex
                  ? 'bg-[var(--accent-warm-subtle)] text-[var(--accent-warm)]'
                  : 'text-[var(--ink-secondary)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]'
              }`}
            >
              <span>#{tag}</span>
              <span className="text-[10px] text-[var(--ink-muted)]/60">{n}</span>
            </button>
          ))}
        </Popover>

        <div className="flex items-center justify-between px-2 pb-2 pt-1">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={handleHashButton}
              disabled={busy}
              title="插入 # 标签"
              className="rounded-lg p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--accent-warm)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Hash className="h-4 w-4" />
            </button>
          </div>
          <Tip label="记录想法" shortcut="⌘ + Enter" align="end">
            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={!canSend}
              className="rounded-lg bg-[var(--accent)] p-1.5 text-white transition-colors hover:bg-[var(--accent-warm-hover)] disabled:bg-[var(--ink-muted)]/15 disabled:text-[var(--ink-muted)]/60"
            >
              <PenLine className="h-4 w-4" />
            </button>
          </Tip>
        </div>
      </div>
      {error && (
        <div className="mt-1.5 text-[11px] text-[var(--error)]">{error}</div>
      )}
    </div>
  );
});

export default ThoughtInput;
