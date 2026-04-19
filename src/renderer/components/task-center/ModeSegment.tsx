// ModeSegment — "任务 / 想法" mode declaration switcher.
// Shown above the input box on Launcher (big centered) and Chat (compact).
//
// v0.1.69 redesign: replaced the prior "text | text" pipe layout with the
// macOS-settings-style icon segmented control (variant F in the
// `specs/playground/mode-segment.html` sandbox). The segmented control
// reads as one affordance rather than two free-floating buttons — it's
// clearer that these are mutually-exclusive modes of a single surface.
//
// Icons reuse the ones the rest of the task center already associates with
// each domain:
//   • 任务 → Layers (same as `TaskListPanel` header)
//   • 想法 → Lightbulb (same as `ThoughtPanel` header)
// so the switcher's icons foreshadow what the user gets after clicking.
//
// Sizing: per the v0.1.69 redesign brief, the segmented control renders
// at 14px regardless of the `size` prop — the prior 18px/13px dual scale
// was readable in isolation but created a distracting mismatch with the
// surrounding 13–14px input toolbar. The `size` prop is retained in the
// props signature for API compatibility; it currently has no visual effect.

import { Layers, Lightbulb } from 'lucide-react';
import type { ReactNode } from 'react';

export type InputMode = 'task' | 'thought';

interface ModeSegmentProps {
  value: InputMode;
  onChange: (mode: InputMode) => void;
  /**
   * Retained for API compatibility with prior callers. The v0.1.69
   * redesign renders at a fixed 14px scale for both surfaces; callers
   * can keep passing `'launcher'` / `'chat'` without breakage.
   */
  size?: 'launcher' | 'chat';
  /** Optional slot on the right side (e.g. info tooltip). */
  suffix?: ReactNode;
  /**
   * When true, each button surfaces a `title` tooltip hinting that Tab
   * toggles the segment. Used on the Launcher where BrandSection binds
   * a page-level Tab handler; omit on surfaces without that binding so
   * we don't advertise a shortcut that doesn't work there.
   */
  tabSwitchHint?: boolean;
}

export function ModeSegment({
  value,
  onChange,
  suffix,
  tabSwitchHint = false,
}: ModeSegmentProps) {
  const taskTitle = tabSwitchHint ? '按 Tab 切换到「想法」' : undefined;
  const thoughtTitle = tabSwitchHint ? '按 Tab 切换到「任务」' : undefined;

  // Segment button — the `active` state gets a raised paper-elevated
  // background (so the whole row reads as a track with a sliding
  // thumb), `shadow-xs` for the subtle macOS-style lift, and full ink
  // for the label. Inactive state stays ink-muted and relies on a soft
  // hover → ink-secondary step for feedback.
  const baseBtn =
    'inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] px-3.5 py-1.5 text-[14px] font-medium transition-all duration-150';
  const activeBtn =
    'bg-[var(--paper-elevated)] text-[var(--ink)] shadow-xs';
  const inactiveBtn =
    'text-[var(--ink-muted)] hover:text-[var(--ink-secondary)]';

  return (
    <div className="inline-flex items-center">
      <div className="inline-flex gap-0.5 rounded-[var(--radius-md)] bg-[var(--paper-inset)] p-[3px]">
        <button
          type="button"
          onClick={() => onChange('task')}
          aria-pressed={value === 'task'}
          title={taskTitle}
          className={`${baseBtn} ${value === 'task' ? activeBtn : inactiveBtn}`}
        >
          <Layers className="h-3.5 w-3.5" strokeWidth={1.75} />
          任务
        </button>
        <button
          type="button"
          onClick={() => onChange('thought')}
          aria-pressed={value === 'thought'}
          title={thoughtTitle}
          className={`${baseBtn} ${value === 'thought' ? activeBtn : inactiveBtn}`}
        >
          <Lightbulb className="h-3.5 w-3.5" strokeWidth={1.75} />
          想法
        </button>
      </div>
      {suffix && <span className="ml-2 flex items-center">{suffix}</span>}
    </div>
  );
}

export default ModeSegment;
