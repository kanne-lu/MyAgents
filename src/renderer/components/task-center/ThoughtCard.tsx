// ThoughtCard — single thought row rendered in the left-column stream.
// Supports inline edit, delete, and "dispatch to task" split-button entry.

import { useCallback, useState } from 'react';
import { Trash2, Zap } from 'lucide-react';
import { thoughtDelete, thoughtUpdate } from '@/api/taskCenter';
import type { Thought } from '@/../shared/types/thought';
import { splitWithTagHighlights } from '@/utils/parseThoughtTags';

interface Props {
  thought: Thought;
  onChanged: (t: Thought | null) => void;
  onDispatch?: (t: Thought) => void;
  /** Click handler for inline tag chips — wires into the panel's tag filter. */
  onTagClick?: (tag: string) => void;
}

export function ThoughtCard({ thought, onChanged, onDispatch, onTagClick }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(thought.content);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = useCallback(async () => {
    if (draft.trim() === thought.content.trim()) {
      setEditing(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await thoughtUpdate({ id: thought.id, content: draft });
      onChanged(updated);
      setEditing(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [draft, thought.content, thought.id, onChanged]);

  const handleDelete = useCallback(async () => {
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

  const convertedCount = thought.convertedTaskIds?.length ?? 0;

  return (
    <div className="group rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--paper-elevated)] p-3 transition-all hover:border-[var(--line-strong)] hover:shadow-sm hover:-translate-y-[1px]">
      {editing ? (
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleEditKeyDown}
          autoFocus
          rows={Math.max(2, draft.split('\n').length)}
          className="w-full resize-none rounded-[var(--radius-sm)] bg-transparent text-[13px] text-[var(--ink)] focus:outline-none"
        />
      ) : (
        <div
          className="cursor-text whitespace-pre-wrap text-[13px] leading-[1.55] text-[var(--ink-secondary)]"
          onDoubleClick={() => setEditing(true)}
        >
          {renderWithTagHighlights(thought.content, onTagClick)}
        </div>
      )}
      {error && (
        <div className="mt-2 text-[11px] text-[var(--error)]">{error}</div>
      )}

      {thought.tags.length > 0 && !editing && (
        <div className="mt-2 flex flex-wrap gap-1">
          {thought.tags.map((t) => (
            <span
              key={t}
              className="rounded-[var(--radius-sm)] bg-[var(--paper-inset)] px-1.5 py-0.5 text-[11px] text-[var(--ink-muted)]"
            >
              #{t}
            </span>
          ))}
        </div>
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
        <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
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
              {onDispatch && (
                <button
                  type="button"
                  onClick={() => onDispatch(thought)}
                  title="派发为任务"
                  className="flex items-center gap-1 rounded-[var(--radius-md)] px-2 py-1 text-[12px] text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--accent-warm)]"
                >
                  <Zap className="h-3.5 w-3.5" />
                  派发
                </button>
              )}
              <button
                type="button"
                onClick={() => void handleDelete()}
                disabled={busy}
                title="删除"
                className="rounded-[var(--radius-md)] p-1 text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--error)]"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
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
  // Use the shared parser so the UI highlight stays in lock-step with the Rust
  // parser (`thought.tags[]`) — previously the regex accepted mid-word `#` and
  // any Unicode letter, causing UI/backend disagreement.
  const parts = splitWithTagHighlights(content);
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
          className="cursor-pointer text-[var(--accent-cool)] transition-colors hover:text-[var(--accent-cool-hover)] hover:underline"
        >
          {p.value}
        </button>
      ) : (
        <span key={i} className="text-[var(--accent-cool)]">
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
