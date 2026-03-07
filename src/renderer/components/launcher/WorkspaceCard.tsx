/**
 * WorkspaceCard - Compact clickable project card for the launcher
 * Single-click to launch, right-click context menu for edit/remove
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Trash2, Pencil } from 'lucide-react';

import type { Project } from '@/config/types';
import { getFolderName } from '@/types/tab';
import { shortenPathForDisplay } from '@/utils/pathDetection';
import WorkspaceIcon from './WorkspaceIcon';

interface WorkspaceCardProps {
    project: Project;
    onLaunch: (project: Project) => void;
    onRemove: (project: Project) => void;
    onEdit: (project: Project) => void;
    isLoading?: boolean;
}

export default memo(function WorkspaceCard({
    project,
    onLaunch,
    onRemove,
    onEdit,
    isLoading,
}: WorkspaceCardProps) {
    // Context menu state
    const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
    const menuRef = useRef<HTMLDivElement>(null);

    const handleContextMenu = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        // Clamp position so the menu stays within the viewport
        const menuWidth = 140;
        const menuHeight = 76;
        const x = Math.min(e.clientX, window.innerWidth - menuWidth);
        const y = Math.min(e.clientY, window.innerHeight - menuHeight);
        setContextMenu({ x, y });
    }, []);

    // Close context menu on click-outside or Escape
    useEffect(() => {
        if (!contextMenu) return;
        const handleClose = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
                setContextMenu(null);
            }
        };
        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setContextMenu(null);
        };
        document.addEventListener('mousedown', handleClose);
        document.addEventListener('keydown', handleEscape);
        return () => {
            document.removeEventListener('mousedown', handleClose);
            document.removeEventListener('keydown', handleEscape);
        };
    }, [contextMenu]);

    const displayName = project.displayName || getFolderName(project.path);

    return (
        <>
            <button
                type="button"
                onClick={() => !isLoading && onLaunch(project)}
                onContextMenu={handleContextMenu}
                disabled={isLoading}
                className={`group flex w-full items-center gap-3 rounded-xl bg-[var(--paper-elevated)] px-4 py-3 text-left transition-all duration-150 ease-out hover:bg-[var(--hover-bg)] active:scale-[0.98] ${
                    isLoading ? 'pointer-events-none opacity-60' : 'cursor-pointer'
                }`}
            >
                {/* Icon */}
                <div className="flex h-7 w-7 shrink-0 items-center justify-center">
                    {isLoading ? (
                        <Loader2 className="h-5 w-5 animate-spin text-[var(--ink-subtle)]" />
                    ) : (
                        <WorkspaceIcon icon={project.icon} size={28} />
                    )}
                </div>

                {/* Text */}
                <div className="min-w-0 flex-1">
                    <h3 className="truncate text-[13px] font-medium text-[var(--ink)]">
                        {displayName}
                    </h3>
                    <p className="mt-0.5 truncate text-[11px] text-[var(--ink-muted)]">
                        {shortenPathForDisplay(project.path)}
                    </p>
                </div>
            </button>

            {/* Right-click context menu */}
            {contextMenu && (
                <div
                    ref={menuRef}
                    className="fixed z-50 rounded-[10px] border border-[var(--line)] bg-[var(--paper-elevated)] py-1 shadow-md"
                    style={{ left: contextMenu.x, top: contextMenu.y }}
                    role="menu"
                    aria-label="工作区操作菜单"
                >
                    <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                            setContextMenu(null);
                            onEdit(project);
                        }}
                        className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] text-[var(--ink)] transition-colors hover:bg-[var(--hover-bg)]"
                    >
                        <Pencil className="h-3.5 w-3.5 text-[var(--ink-muted)]" />
                        编辑
                    </button>
                    <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                            setContextMenu(null);
                            onRemove(project);
                        }}
                        className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] text-[var(--error)] transition-colors hover:bg-[var(--hover-bg)]"
                    >
                        <Trash2 className="h-3.5 w-3.5" />
                        移除
                    </button>
                </div>
            )}
        </>
    );
});
