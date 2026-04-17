// ThoughtInput — compact freeform note input for Thought mode.
// Writes through to ~/.myagents/thoughts/ via `cmd_thought_create`.

import { useCallback, useState } from 'react';
import { thoughtCreate } from '@/api/taskCenter';
import type { Thought } from '@/../shared/types/thought';

interface Props {
  onCreated?: (t: Thought) => void;
  placeholder?: string;
  /** If true, input is multi-line and expands; otherwise single line. */
  multiline?: boolean;
  autoFocus?: boolean;
}

export function ThoughtInput({
  onCreated,
  placeholder = '此刻有什么想法？',
  multiline = true,
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

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void handleSubmit();
    }
  };

  const commonProps = {
    value,
    onChange: (e: React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) =>
      setValue(e.target.value),
    onKeyDown: handleKeyDown,
    placeholder,
    disabled: busy,
    autoFocus,
    className:
      'w-full resize-none rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--paper-elevated)] px-4 py-3 text-[var(--ink)] placeholder:text-[var(--ink-muted)] focus:border-[var(--line-strong)] focus:outline-none',
  } as const;

  return (
    <div className="w-full">
      {multiline ? (
        <textarea rows={3} {...commonProps} />
      ) : (
        <input type="text" {...commonProps} />
      )}
      <div className="mt-2 flex items-center justify-between">
        <span className="text-[11px] text-[var(--ink-muted)]/70">
          写下碎片想法，稍后可派发成任务 · <kbd className="font-mono">⌘</kbd>
          <kbd className="font-mono">↵</kbd> 发送
        </span>
        <button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={busy || !value.trim()}
          className="rounded-[var(--radius-full)] bg-[var(--button-primary-bg)] px-4 py-1.5 text-[13px] font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:opacity-50"
        >
          {busy ? '保存中…' : '记下来'}
        </button>
      </div>
      {error && (
        <div className="mt-2 text-[12px] text-[var(--error)]">{error}</div>
      )}
    </div>
  );
}

export default ThoughtInput;
