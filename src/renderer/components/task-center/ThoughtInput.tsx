// ThoughtInput — compact freeform note input for Thought mode.
// Writes through to ~/.myagents/thoughts/ via `cmd_thought_create`.
//
// Visual structure mirrors SimpleChatInput so behavior is consistent across
// product surfaces: textarea on top, toolbar row at the bottom with a left
// slot (reserved for future attachment affordances — PRD §6.4 image attach)
// and a right-aligned send button. All inside the same bordered container.

import { useCallback, useState } from 'react';
import { Paperclip, Send } from 'lucide-react';
import { thoughtCreate } from '@/api/taskCenter';
import type { Thought } from '@/../shared/types/thought';

interface Props {
  onCreated?: (t: Thought) => void;
  placeholder?: string;
  autoFocus?: boolean;
}

export function ThoughtInput({
  onCreated,
  placeholder = '此刻有什么想法？',
  autoFocus = false,
}: Props) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = useCallback(async () => {
    const content = value.trim();
    if (!content || busy) return;
    setBusy(true);
    setError(null);
    try {
      const t = await thoughtCreate({ content });
      setValue('');
      onCreated?.(t);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [value, busy, onCreated]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void handleSubmit();
      }
    },
    [handleSubmit],
  );

  const canSend = value.trim().length > 0 && !busy;

  return (
    <div className="w-full">
      {/* Container mirrors SimpleChatInput — textarea stacked over a toolbar
          row. Tap focus is captured on the container border so clicking
          anywhere in the card focuses the textarea. */}
      <div className="flex flex-col rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--paper-elevated)] transition-colors focus-within:border-[var(--line-strong)]">
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          rows={3}
          disabled={busy}
          autoFocus={autoFocus}
          className="w-full resize-none bg-transparent px-3 pt-3 text-[13px] leading-relaxed text-[var(--ink)] placeholder:text-[var(--ink-muted)] focus:outline-none"
        />
        <div className="flex items-center justify-between px-2 pb-2 pt-1">
          {/* Left slot — future attachments, tag quick-pick, etc. Disabled
              placeholder keeps the visual alignment with SimpleChatInput. */}
          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled
              title="附件（即将推出）"
              className="rounded-lg p-1.5 text-[var(--ink-muted)]/50 disabled:cursor-not-allowed"
            >
              <Paperclip className="h-4 w-4" />
            </button>
          </div>
          {/* Right side — send */}
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!canSend}
            title="记下想法 (⌘/Ctrl + ↵)"
            className="rounded-lg bg-[var(--accent)] p-1.5 text-white transition-colors hover:bg-[var(--accent-warm-hover)] disabled:bg-[var(--ink-muted)]/15 disabled:text-[var(--ink-muted)]/60"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="mt-1.5 flex items-center justify-between text-[11px] text-[var(--ink-muted)]/70">
        <span>
          写下碎片想法，稍后可派发为任务 · <kbd className="font-mono">⌘</kbd>
          <kbd className="font-mono">↵</kbd> 发送
        </span>
      </div>
      {error && (
        <div className="mt-1.5 text-[11px] text-[var(--error)]">{error}</div>
      )}
    </div>
  );
}

export default ThoughtInput;
