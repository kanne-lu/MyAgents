// TaskCenter — single-instance tab combining Thought stream (left) and Task list (right).
// PRD §5 / §6.

import { useCallback, useState } from 'react';
import { ThoughtPanel } from '@/components/task-center/ThoughtPanel';
import { TaskListPanel } from '@/components/task-center/TaskListPanel';
import { DispatchTaskDialog } from '@/components/task-center/DispatchTaskDialog';
import { taskCenterAvailable } from '@/api/taskCenter';
import { CUSTOM_EVENTS } from '@/../shared/constants';
import type { Thought } from '@/../shared/types/thought';

interface Props {
  isActive?: boolean;
}

export default function TaskCenter({ isActive }: Props) {
  const [dispatching, setDispatching] = useState<Thought | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // Child panels react to `isActive` transitions on their own (via refreshKey
  // derived from it below). We do NOT setState in an effect here — the lint
  // rule `react-hooks/set-state-in-effect` flags that. `isActive` itself is
  // passed down as the refresh signal.
  //
  // Tabs stay mounted with `content-visibility: hidden` when inactive, so
  // panels need to know "I just became active again" to reload. Passing
  // `isActive` straight through accomplishes that without a derived counter.

  const handleDispatch = useCallback((t: Thought) => {
    setDispatching(t);
  }, []);

  const handleDiscuss = useCallback((t: Thought) => {
    // Hand off to App.tsx which owns tab creation. It'll pick a workspace via
    // smart default (match thought.tags → project name), open a new Chat tab,
    // and auto-send the task-alignment prompt.
    window.dispatchEvent(
      new CustomEvent(CUSTOM_EVENTS.OPEN_AI_DISCUSSION, {
        detail: {
          thoughtId: t.id,
          content: t.content,
          tags: t.tags,
        },
      }),
    );
  }, []);

  const handleDispatched = useCallback(() => {
    setDispatching(null);
    setRefreshKey((k) => k + 1);
  }, []);

  // The DispatchTaskDialog returns the full Task, but for Phase 4 we only need
  // to know "something changed" to re-fetch both panels. Future Phase 5 hook:
  // pass the task down so the newly created one can be highlighted/scrolled to.

  if (!taskCenterAvailable()) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--paper)] px-8 text-center">
        <div className="max-w-md text-[13px] leading-relaxed text-[var(--ink-muted)]">
          <p className="font-medium text-[var(--ink-secondary)]">任务中心</p>
          <p className="mt-2">
            此功能仅在桌面客户端内可用。
          </p>
          <p className="mt-2 text-[var(--ink-muted)]/70">
            当前是浏览器开发模式（Tauri 未就绪），Thought/Task 的本地存储未挂载。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-[var(--paper)]">
      {/* Header */}
      <div className="flex h-12 items-center border-b border-[var(--line)] px-4">
        <h1 className="text-[15px] font-semibold text-[var(--ink)]">任务中心</h1>
        <span className="ml-3 text-[12px] text-[var(--ink-muted)]">
          沉淀想法 → 派发任务 → 让 AI 执行
        </span>
      </div>

      {/* Two-column body — each panel renders its own section header
          (icon + label + collapsible 🔍 search toggle). */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: Thought stream */}
        <div
          className="flex flex-col overflow-hidden"
          style={{ width: '420px' }}
        >
          <ThoughtPanel
            onDispatchThought={handleDispatch}
            onDiscussThought={handleDiscuss}
            refreshKey={`${refreshKey}:${isActive ? '1' : '0'}`}
          />
        </div>

        {/* Divider */}
        <div className="w-px bg-[var(--line)]" />

        {/* Right: Task list */}
        <div className="flex flex-1 flex-col overflow-hidden">
          <TaskListPanel
            refreshKey={`${refreshKey}:${isActive ? '1' : '0'}`}
          />
        </div>
      </div>

      {dispatching && (
        <DispatchTaskDialog
          thought={dispatching}
          onClose={() => setDispatching(null)}
          onDispatched={handleDispatched}
        />
      )}
    </div>
  );
}

