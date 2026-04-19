// SearchPill — compact "always-on" search input for the task-center
// panel headers. Pill-shaped (rounded-full) with a muted paper-inset
// background + leading search icon + trailing clear button when there's
// a query.
//
// Replaces the prior "click-icon to expand" search toggle across
// ThoughtPanel and TaskListPanel — the reference mock keeps the
// search affordance constantly visible, and a permanent pill scan-reads
// better than a tiny icon button.

import { Search, X } from 'lucide-react';
import type { RefObject } from 'react';

interface Props {
  /** Imperative ref so parents can focus the input via shortcut. */
  inputRef?: RefObject<HTMLInputElement | null>;
  value: string;
  onChange: (next: string) => void;
  onClear?: () => void;
  placeholder?: string;
  /** Width cap — default 200px keeps the pill out of the way in narrow
   *  panels while still reading as a usable input. */
  maxWidthPx?: number;
}

export function SearchPill({
  inputRef,
  value,
  onChange,
  onClear,
  placeholder = '搜索…',
  maxWidthPx = 200,
}: Props) {
  return (
    <div
      className="inline-flex h-7 items-center gap-1.5 rounded-full bg-[var(--paper-inset)] px-3 text-[var(--ink-muted)]"
      style={{ maxWidth: `${maxWidthPx}px` }}
    >
      <Search className="h-3 w-3 shrink-0" strokeWidth={1.5} aria-hidden />
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value && onClear) {
            e.preventDefault();
            onClear();
          }
        }}
        placeholder={placeholder}
        className="min-w-0 flex-1 bg-transparent text-[12px] text-[var(--ink)] placeholder:text-[var(--ink-muted)] focus:outline-none"
      />
      {value && onClear && (
        <button
          type="button"
          onClick={onClear}
          aria-label="清空搜索"
          className="shrink-0 rounded-full p-0.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-elevated)] hover:text-[var(--ink)]"
        >
          <X className="h-3 w-3" strokeWidth={1.75} />
        </button>
      )}
    </div>
  );
}

export default SearchPill;
