import { ChevronRight, FolderOpen } from "lucide-react";
import { memo } from "react";

import type { StickyAncestor } from "./treeTypes";

interface WorkspaceTreeStickyAncestorsProps {
  ancestors: StickyAncestor[];
  rowHeight: number;
  onClosePath: (path: string) => void;
}

export const WorkspaceTreeStickyAncestors = memo(
  function WorkspaceTreeStickyAncestors({
    ancestors,
    rowHeight,
    onClosePath,
  }: WorkspaceTreeStickyAncestorsProps) {
    if (ancestors.length === 0) {
      return null;
    }

    return (
      <div className="absolute left-0 right-0 top-0 z-10 border-b border-[var(--line-subtle)] bg-[var(--paper-elevated)] shadow-xs">
        {ancestors.map((ancestor) => (
          <button
            key={ancestor.path}
            type="button"
            className="flex w-full cursor-pointer items-center gap-2 px-3 text-[13px] font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
            style={{
              height: rowHeight,
              paddingLeft: `${12 + ancestor.depth * 16}px`,
            }}
            onClick={() => onClosePath(ancestor.path)}
          >
            <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center">
              <ChevronRight className="h-3 w-3 rotate-90 transition-transform" />
            </span>
            <FolderOpen className="h-3.5 w-3.5 flex-shrink-0 text-[var(--accent-warm)]/70" />
            <span className="min-w-0 flex-1 truncate text-left">
              {ancestor.name}
            </span>
          </button>
        ))}
      </div>
    );
  },
);
