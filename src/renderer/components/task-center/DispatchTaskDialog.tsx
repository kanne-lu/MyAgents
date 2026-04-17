// DispatchTaskDialog — Phase 3 placeholder; Phase 4 replaces with real form.
//
// In Phase 3 we only demonstrate the "thought → task" wiring: clicking 派发 on
// a ThoughtCard opens this dialog, Phase 4 will flesh out the form
// (workspace picker, execution mode, runtime, notification, end conditions)
// and actually call `taskCreateDirect`.

import { X } from 'lucide-react';
import OverlayBackdrop from '@/components/OverlayBackdrop';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import type { Thought } from '@/../shared/types/thought';

const OVERLAY_Z = 200;

interface Props {
  thought: Thought;
  onClose: () => void;
  onDispatched: () => void;
}

export function DispatchTaskDialog({ thought, onClose, onDispatched: _onDispatched }: Props) {
  useCloseLayer(() => {
    onClose();
    return true;
  }, OVERLAY_Z);

  return (
    <OverlayBackdrop onClose={onClose} className="z-[200]">
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[min(560px,92vw)] overflow-hidden rounded-[var(--radius-2xl)] bg-[var(--paper-elevated)] shadow-2xl"
      >
        <div className="flex items-start justify-between border-b border-[var(--line)] px-5 py-4">
          <div>
            <h2 className="text-[16px] font-semibold text-[var(--ink)]">
              派发为任务
            </h2>
            <p className="mt-1 text-[12px] text-[var(--ink-muted)]">
              Phase 4 将接入完整派发表单（工作区 / 执行模式 / 通知 / 结束条件）
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-[var(--radius-md)] p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-5 py-5">
          <div className="rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--paper)] p-3">
            <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--ink-muted)]">
              想法原文
            </div>
            <div className="mt-1 whitespace-pre-wrap text-[13px] leading-[1.55] text-[var(--ink-secondary)]">
              {thought.content}
            </div>
          </div>
          <div className="mt-4 text-[12px] text-[var(--ink-muted)]">
            Phase 4 will add the dispatch form here.
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-[var(--line)] px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-[var(--radius-md)] bg-[var(--button-secondary-bg)] px-4 py-1.5 text-[13px] font-medium text-[var(--button-secondary-text)] hover:bg-[var(--button-secondary-bg-hover)]"
          >
            关闭
          </button>
        </div>
      </div>
    </OverlayBackdrop>
  );
}

export default DispatchTaskDialog;
