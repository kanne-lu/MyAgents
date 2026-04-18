// ThoughtCard — single thought row rendered in the left-column stream.
// Supports inline edit, an overflow "更多" menu for destructive actions,
// and a "dispatch to task" split-button entry.
//
// Two height regimes:
//   • View (非编辑态): long content clamps to `VIEW_CLAMP_LINES` lines and
//     surfaces a 展开/收起 toggle. The overflow flag is measured post-render
//     so the toggle only appears when content is actually clipped.
//   • Edit (编辑态): textarea auto-resizes with content up to
//     `EDIT_MAX_HEIGHT_PX`, beyond which it scrolls internally. This keeps
//     a single oversized draft from eating the whole panel.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {
  MessageSquare,
  MoreHorizontal,
  Trash2,
  Zap,
} from 'lucide-react';
import { thoughtDelete, thoughtUpdate } from '@/api/taskCenter';
import type { Thought } from '@/../shared/types/thought';
import { splitWithTagHighlights } from '@/utils/parseThoughtTags';

interface Props {
  thought: Thought;
  onChanged: (t: Thought | null) => void;
  onDispatch?: (t: Thought) => void;
  /** Open a new chat tab with `/task-alignment` (PRD §8.3). */
  onDiscuss?: (t: Thought) => void;
  /** Click handler for inline tag chips — wires into the panel's tag filter. */
  onTagClick?: (tag: string) => void;
}

const VIEW_CLAMP_LINES = 5;
const EDIT_MAX_HEIGHT_PX = 224; // ~9–10 lines at 13px/1.55

export function ThoughtCard({
  thought,
  onChanged,
  onDispatch,
  onDiscuss,
  onTagClick,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(thought.content);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [hasOverflow, setHasOverflow] = useState(false);
  const [showMenu, setShowMenu] = useState(false);

  const viewRef = useRef<HTMLDivElement>(null);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Overflow detection — measure only in collapsed state so flipping to
  // expanded doesn't reset the flag (clientHeight would grow to match).
  useLayoutEffect(() => {
    if (editing || expanded) return;
    const el = viewRef.current;
    if (!el) return;
    setHasOverflow(el.scrollHeight > el.clientHeight + 1);
  }, [thought.content, editing, expanded]);

  // Auto-resize the edit textarea on every draft change, bounded by
  // EDIT_MAX_HEIGHT_PX. Beyond that the textarea scrolls internally.
  useLayoutEffect(() => {
    if (!editing) return;
    const el = editRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, EDIT_MAX_HEIGHT_PX)}px`;
  }, [draft, editing]);

  // Close the kebab menu on outside click or Escape — keyboard parity
  // with the tag autocomplete in ThoughtInput.
  useEffect(() => {
    if (!showMenu) return;
    const clickHandler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowMenu(false);
    };
    document.addEventListener('mousedown', clickHandler);
    document.addEventListener('keydown', keyHandler);
    return () => {
      document.removeEventListener('mousedown', clickHandler);
      document.removeEventListener('keydown', keyHandler);
    };
  }, [showMenu]);

  const handleSave = useCallback(async () => {
    if (draft.trim() === thought.content.trim()) {
      setEditing(false);
      setExpanded(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await thoughtUpdate({ id: thought.id, content: draft });
      onChanged(updated);
      setEditing(false);
      // Return to collapsed state so the effect re-measures against the new
      // content; otherwise `hasOverflow` can stay stale from the pre-edit
      // body length.
      setExpanded(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [draft, thought.content, thought.id, onChanged]);

  const handleDelete = useCallback(async () => {
    setShowMenu(false);
    setBusy(true);
    setError(null);
    try {
      await thoughtDelete(thought.id);
      onChanged(null);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }, [thought.id, onChanged]);

  const handleEditKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setDraft(thought.content);
        setEditing(false);
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void handleSave();
      }
    },
    [thought.content, handleSave],
  );

  const enterEdit = useCallback(() => {
    setDraft(thought.content);
    setEditing(true);
    setExpanded(true); // opening edit always shows the full body
  }, [thought.content]);

  const convertedCount = thought.convertedTaskIds?.length ?? 0;

  return (
    <div className="group rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--paper-elevated)] p-3 transition-all hover:border-[var(--line-strong)] hover:shadow-sm hover:-translate-y-[1px]">
      {editing ? (
        <textarea
          ref={editRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleEditKeyDown}
          autoFocus
          rows={2}
          style={{
            minHeight: '2.75rem',
            maxHeight: `${EDIT_MAX_HEIGHT_PX}px`,
            overflowY: 'auto',
          }}
          className="w-full resize-none rounded-[var(--radius-sm)] bg-transparent text-[13px] leading-[1.55] text-[var(--ink)] focus:outline-none"
        />
      ) : (
        <div
          ref={viewRef}
          className="cursor-text whitespace-pre-wrap break-words text-[13px] leading-[1.55] text-[var(--ink-secondary)]"
          style={
            expanded
              ? undefined
              : {
                  display: '-webkit-box',
                  WebkitLineClamp: VIEW_CLAMP_LINES,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                }
          }
          onDoubleClick={enterEdit}
        >
          {renderWithTagHighlights(thought.content, onTagClick)}
        </div>
      )}

      {/* Expand/collapse toggle — only when the clamp actually clipped
          content. Sits directly below the body so it feels attached to it. */}
      {!editing && hasOverflow && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-[12px] text-[var(--accent-warm)] hover:underline"
        >
          {expanded ? '收起' : '展开全文'}
        </button>
      )}

      {error && (
        <div className="mt-2 text-[11px] text-[var(--error)]">{error}</div>
      )}

      <div className="mt-2 flex items-center justify-between">
        <span className="text-[11px] text-[var(--ink-muted)]/60">
          {formatRelative(thought.updatedAt)}
          {convertedCount > 0 && (
            <span className="ml-2 text-[var(--accent-warm)]">
              已派生 {convertedCount} 个任务
            </span>
          )}
        </span>
        <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          {editing ? (
            <>
              <button
                type="button"
                onClick={() => {
                  setDraft(thought.content);
                  setEditing(false);
                }}
                disabled={busy}
                className="rounded-[var(--radius-md)] px-2 py-1 text-[12px] text-[var(--ink-muted)] hover:bg-[var(--paper-inset)]"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={busy}
                className="rounded-[var(--radius-md)] bg-[var(--accent-warm)] px-2.5 py-1 text-[12px] font-medium text-white hover:bg-[var(--accent-warm-hover)]"
              >
                保存
              </button>
            </>
          ) : (
            <>
              {onDiscuss && (
                <button
                  type="button"
                  onClick={() => onDiscuss(thought)}
                  title="AI 讨论 — 开新对话用 /task-alignment 聊出方案"
                  className="flex items-center gap-1 rounded-[var(--radius-md)] px-2 py-1 text-[12px] text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--accent-cool)]"
                >
                  <MessageSquare className="h-3.5 w-3.5" />
                  AI 讨论
                </button>
              )}
              {onDispatch && (
                <button
                  type="button"
                  onClick={() => onDispatch(thought)}
                  title="直接派发为任务（不讨论）"
                  className="flex items-center gap-1 rounded-[var(--radius-md)] px-2 py-1 text-[12px] text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--accent-warm)]"
                >
                  <Zap className="h-3.5 w-3.5" />
                  派发
                </button>
              )}
              {/* More menu — houses destructive actions so they're not
                  one-click-adjacent to the primary 派发 affordance. */}
              <div className="relative" ref={menuRef}>
                <button
                  type="button"
                  onClick={() => setShowMenu((v) => !v)}
                  disabled={busy}
                  title="更多操作"
                  className="rounded-[var(--radius-md)] p-1 text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </button>
                {showMenu && (
                  <div className="absolute right-0 top-full z-10 mt-1 min-w-[120px] overflow-hidden rounded-[var(--radius-md)] border border-[var(--line)] bg-[var(--paper-elevated)] py-1 shadow-md">
                    <button
                      type="button"
                      onClick={() => {
                        setShowMenu(false);
                        enterEdit();
                      }}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-[var(--ink-secondary)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDelete()}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-[var(--error)] hover:bg-[var(--error-bg)]"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      删除
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function renderWithTagHighlights(
  content: string,
  onTagClick?: (tag: string) => void,
) {
  // Pill styling matches the ThoughtInput overlay — single source of truth
  // for what a `#tag` looks like across authoring & display. Parser is
  // shared with Rust (`thought.tags[]`) so highlight ≡ persisted tags.
  const parts = splitWithTagHighlights(content);
  const pillCls =
    'rounded-[3px] bg-[var(--accent-warm-subtle)] px-1 text-[var(--accent-warm)]';
  return parts.map((p, i) => {
    if (p.type === 'tag' && p.tag) {
      const body = p.tag;
      return onTagClick ? (
        <button
          key={i}
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onTagClick(body);
          }}
          className={`${pillCls} cursor-pointer transition-colors hover:bg-[var(--accent-warm-muted)]`}
        >
          {p.value}
        </button>
      ) : (
        <span key={i} className={pillCls}>
          {p.value}
        </span>
      );
    }
    return <span key={i}>{p.value}</span>;
  });
}

function formatRelative(ts: number): string {
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

export default ThoughtCard;
