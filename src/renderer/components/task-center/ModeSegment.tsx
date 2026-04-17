// ModeSegment — "任务 | 想法" mode declaration switcher.
// Shown above the input box on Launcher (big centered text) and Chat (compact).
// See DESIGN.md §6.8 Section Header and PRD §4.1 for visual spec.

import type { ReactNode } from 'react';

export type InputMode = 'task' | 'thought';

interface ModeSegmentProps {
  value: InputMode;
  onChange: (mode: InputMode) => void;
  /** `launcher` = `text-lg` (18px), `chat` = `text-sm` (13px). */
  size?: 'launcher' | 'chat';
  /** Optional slot on the right side (e.g. info tooltip). */
  suffix?: ReactNode;
}

export function ModeSegment({
  value,
  onChange,
  size = 'launcher',
  suffix,
}: ModeSegmentProps) {
  const textCls = size === 'launcher' ? 'text-lg' : 'text-sm';

  return (
    <div className="flex items-center justify-center select-none">
      <button
        type="button"
        onClick={() => onChange('task')}
        aria-pressed={value === 'task'}
        className={`${textCls} font-medium transition-colors duration-150 ${
          value === 'task'
            ? 'text-[var(--accent-warm)]'
            : 'text-[var(--ink-muted)] hover:text-[var(--ink-secondary)]'
        }`}
      >
        任务
      </button>
      <span className={`${textCls} px-3 text-[var(--line-strong)]`}>|</span>
      <button
        type="button"
        onClick={() => onChange('thought')}
        aria-pressed={value === 'thought'}
        className={`${textCls} font-medium transition-colors duration-150 ${
          value === 'thought'
            ? 'text-[var(--accent-warm)]'
            : 'text-[var(--ink-muted)] hover:text-[var(--ink-secondary)]'
        }`}
      >
        想法
      </button>
      {suffix && <span className="ml-2 flex items-center">{suffix}</span>}
    </div>
  );
}

export default ModeSegment;
