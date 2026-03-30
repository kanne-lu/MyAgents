/**
 * FilePreviewModal - File preview and edit modal for workspace files
 *
 * Features:
 * - Monaco Editor in read-only mode for code preview (with line numbers, word wrap, virtualized rendering)
 * - Rendered HTML preview for Markdown files
 * - Monaco Editor for editing mode
 * - Unsaved changes confirmation
 *
 * Edit capability comes from two sources (either is sufficient):
 * 1. Tab API (useTabApiOptional) — when rendered inside a Tab context
 * 2. Explicit onSave/onRevealFile props — when caller provides save logic directly
 */
import { Edit2, Expand, FileText, FolderOpen, Loader2, Save, X } from 'lucide-react';
import Tip from './Tip';
import { lazy, Suspense, useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { createPortal } from 'react-dom';

import { useTabApiOptional } from '@/context/TabContext';
import { getMonacoLanguage, isMarkdownFile } from '@/utils/languageUtils';
import { shortenPathForDisplay } from '@/utils/pathDetection';

import ConfirmDialog from './ConfirmDialog';
import Markdown from './Markdown';
import { useToast } from './Toast';

// Lazy load Monaco Editor: the ~3MB bundle is only loaded when user first opens a file
const MonacoEditor = lazy(() => import('./MonacoEditor'));

// No-op change handler for read-only Monaco (stable reference avoids re-renders)
const noop = () => {};

// Static loading spinner (module-level to avoid allocation per render)
const monacoLoading = (
    <div className="flex h-full items-center justify-center bg-[var(--paper-elevated)] text-[var(--ink-muted)]">
        <Loader2 className="h-5 w-5 animate-spin" />
    </div>
);


interface FilePreviewModalProps {
    /** File name to display */
    name: string;
    /** File content */
    content: string;
    /** File size in bytes */
    size: number;
    /** Relative path from agent directory (for saving) */
    path: string;
    /** Whether content is loading */
    isLoading?: boolean;
    /** Error message to display */
    error?: string | null;
    /** Callback when modal is closed */
    onClose: () => void;
    /** Callback after file is saved successfully */
    onSaved?: () => void;
    /** External save handler — enables editing even without Tab context */
    onSave?: (content: string) => Promise<void>;
    /** External reveal-in-finder handler — enables "Open in Finder" without Tab context */
    onRevealFile?: () => Promise<void>;
    /** When true, render inline (no portal/backdrop) for use in split-view panel */
    embedded?: boolean;
    /** Callback to open the fullscreen modal from embedded mode */
    onFullscreen?: () => void;
}

// Files above this threshold use plaintext mode (skip tokenization) to prevent UI freeze
const LARGE_FILE_TOKENIZATION_THRESHOLD = 100 * 1024; // 100KB

function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function FilePreviewModal({
    name,
    content,
    size,
    path,
    isLoading = false,
    error = null,
    onClose,
    onSaved,
    onSave,
    onRevealFile,
    embedded = false,
    onFullscreen,
}: FilePreviewModalProps) {
    const toast = useToast();
    // Stabilize toast reference to avoid unnecessary effect re-runs
    const toastRef = useRef(toast);
    toastRef.current = toast;

    const tabApi = useTabApiOptional();
    const apiPost = tabApi?.apiPost;

    // Edit: Tab API OR explicit onSave prop.  Reveal: Tab API OR explicit onRevealFile prop.
    const canEdit = !!(apiPost || onSave);
    const canReveal = !!(apiPost || onRevealFile);

    // State
    const [isEditing, setIsEditing] = useState(false);
    const [editContent, setEditContent] = useState(content);
    const [previewContent, setPreviewContent] = useState(content); // Content displayed in preview mode, updated after save
    const [isSaving, setIsSaving] = useState(false);
    const [showUnsavedConfirm, setShowUnsavedConfirm] = useState(false);

    // Sync content when prop changes (e.g., when file is reloaded externally)
    useEffect(() => {
        setEditContent(content);
        setPreviewContent(content);
    }, [content]);

    // Derived state - compare with previewContent (the last saved state)
    const hasUnsavedChanges = useMemo(() => {
        return isEditing && editContent !== previewContent;
    }, [isEditing, editContent, previewContent]);

    const monacoLanguage = useMemo(() => getMonacoLanguage(name), [name]);
    const isMarkdown = useMemo(() => isMarkdownFile(name), [name]);

    // Large files: force plaintext to skip tokenization
    const effectiveMonacoLanguage = useMemo(() => {
        if (size > LARGE_FILE_TOKENIZATION_THRESHOLD) return 'plaintext';
        return monacoLanguage;
    }, [size, monacoLanguage]);

    // Handlers
    const handleEdit = useCallback(() => {
        setEditContent(previewContent); // Start editing from current preview content
        setIsEditing(true);
    }, [previewContent]);

    const handleCancel = useCallback(() => {
        if (hasUnsavedChanges) {
            setShowUnsavedConfirm(true);
        } else {
            setIsEditing(false);
        }
    }, [hasUnsavedChanges]);

    const handleDiscardChanges = useCallback(() => {
        setShowUnsavedConfirm(false);
        setEditContent(previewContent); // Revert to current preview content
        setIsEditing(false);
    }, [previewContent]);

    const handleClose = useCallback(() => {
        if (hasUnsavedChanges) {
            setShowUnsavedConfirm(true);
        } else {
            onClose();
        }
    }, [hasUnsavedChanges, onClose]);

    const handleSave = useCallback(async () => {
        if (!canEdit) return;
        setIsSaving(true);
        try {
            if (onSave) {
                // Caller-provided save (e.g., direct Tauri fs for non-Tab contexts)
                await onSave(editContent);
            } else if (apiPost) {
                // Tab context — save via Sidecar API
                const response = await apiPost<{ success: boolean; error?: string }>(
                    '/agent/save-file',
                    { path, content: editContent }
                );
                if (!response.success) {
                    toastRef.current.error(response.error ?? '保存失败');
                    return;
                }
            }
            toastRef.current.success('文件保存成功');
            setPreviewContent(editContent); // Update preview content after successful save
            setIsEditing(false);
            onSaved?.();
        } catch (err) {
            toastRef.current.error(err instanceof Error ? err.message : '保存失败');
        } finally {
            setIsSaving(false);
        }
    }, [canEdit, onSave, apiPost, path, editContent, onSaved]);

    // Handle backdrop click — only close on genuine clicks (mousedown + mouseup both on backdrop).
    // Prevents closing when user drags a text selection out of the modal and releases on the backdrop.
    const mouseDownTargetRef = useRef<EventTarget | null>(null);

    const handleBackdropMouseDown = useCallback((e: React.MouseEvent) => {
        mouseDownTargetRef.current = e.target;
    }, []);

    const handleBackdropClick = useCallback((e: React.MouseEvent) => {
        if (e.target === e.currentTarget && mouseDownTargetRef.current === e.currentTarget) {
            handleClose();
        }
    }, [handleClose]);

    const handleOpenInFinder = useCallback(async () => {
        if (!canReveal) return;
        try {
            if (onRevealFile) {
                await onRevealFile();
            } else if (apiPost) {
                await apiPost('/agent/open-in-finder', { path });
            }
        } catch {
            toastRef.current.error('无法打开目录');
        }
    }, [canReveal, onRevealFile, apiPost, path]);

    // Render preview content based on file type
    const renderPreviewContent = () => {
        if (isLoading) {
            return monacoLoading;
        }

        if (error) {
            return (
                <div className="flex h-full flex-col items-center justify-center gap-2 text-[var(--error)]">
                    <X className="h-8 w-8" />
                    <span className="text-sm">{error}</span>
                </div>
            );
        }

        // Empty content: show placeholder with edit prompt
        if (!previewContent.trim() && !isEditing) {
            return (
                <div className="flex h-full flex-col items-center justify-center gap-3 bg-[var(--paper-elevated)] text-[var(--ink-muted)]">
                    <FileText className="h-10 w-10 opacity-20" />
                    <p className="text-sm">文档内容为空</p>
                    {canEdit && (
                        <button
                            type="button"
                            onClick={handleEdit}
                            className="text-sm text-[var(--accent)] hover:underline"
                        >
                            点击开始编辑
                        </button>
                    )}
                </div>
            );
        }

        // Editing mode: Monaco Editor (writable)
        if (isEditing) {
            return (
                <Suspense fallback={monacoLoading}>
                    <div className="h-full bg-[var(--paper-elevated)]">
                        <MonacoEditor
                            value={editContent}
                            onChange={setEditContent}
                            language={effectiveMonacoLanguage}
                        />
                    </div>
                </Suspense>
            );
        }

        // Preview mode: Markdown renders as HTML
        if (isMarkdown) {
            return (
                <div className="h-full overflow-auto overscroll-contain p-6 bg-[var(--paper-elevated)]">
                    <div className="prose prose-stone max-w-none dark:prose-invert">
                        <Markdown raw basePath={path ? path.substring(0, path.lastIndexOf('/')) : undefined}>{previewContent}</Markdown>
                    </div>
                </div>
            );
        }

        // Preview mode: Code files — Monaco Editor in read-only mode
        // Monaco handles line numbers, word wrap, syntax highlighting, and large files natively.
        return (
            <Suspense fallback={monacoLoading}>
                <div className="h-full bg-[var(--paper-elevated)]">
                    <MonacoEditor
                        value={previewContent}
                        onChange={noop}
                        language={effectiveMonacoLanguage}
                        readOnly
                    />
                </div>
            </Suspense>
        );
    };

    // Embedded mode: render content area only (for split-view panel in Chat.tsx)
    if (embedded) {
        return (
            <div className="flex h-full flex-col overflow-hidden">
                {/* Inline header with gradient fade (matches Chat header style) */}
                <div className="relative z-10 flex flex-shrink-0 items-center justify-between gap-2 px-4 py-2 after:pointer-events-none after:absolute after:inset-x-0 after:top-full after:h-6 after:bg-gradient-to-b after:from-[var(--paper-elevated)] after:to-transparent">
                    <div className="flex min-w-0 items-center gap-2">
                        <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md bg-[var(--accent-warm-muted)]">
                            <FileText className="h-3.5 w-3.5 text-[var(--accent)]" />
                        </div>
                        <span className="truncate text-[13px] font-medium text-[var(--ink)]">{name}</span>
                        <span className="flex-shrink-0 text-[11px] text-[var(--ink-muted)]">{formatFileSize(size)}</span>
                    </div>
                    <div className="flex flex-shrink-0 items-center gap-2">
                        {onFullscreen && !isEditing && (
                            <Tip label="全屏预览" position="bottom">
                                <button type="button" onClick={onFullscreen}
                                    className="rounded-md p-1 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]">
                                    <Expand className="h-3.5 w-3.5" />
                                </button>
                            </Tip>
                        )}
                        {canEdit && !isEditing && (
                            <Tip label="编辑" position="bottom">
                                <button type="button" onClick={handleEdit} disabled={isLoading || !!error}
                                    className="rounded-md p-1 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:opacity-40">
                                    <Edit2 className="h-3.5 w-3.5" />
                                </button>
                            </Tip>
                        )}
                        {canEdit && isEditing && (
                            <>
                                <button type="button" onClick={handleCancel}
                                    className="rounded-md px-2 py-1 text-[11px] font-medium text-[var(--ink-muted)] hover:bg-[var(--paper-inset)]">
                                    取消
                                </button>
                                <button type="button" onClick={handleSave} disabled={isSaving || !hasUnsavedChanges}
                                    className="rounded-md bg-[var(--accent)] px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-[var(--accent-warm-hover)] disabled:opacity-40">
                                    {isSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : '保存'}
                                </button>
                            </>
                        )}
                        <Tip label="关闭" position="bottom">
                            <button type="button" onClick={handleClose}
                                className="rounded-md p-1 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]">
                                <X className="h-3.5 w-3.5" />
                            </button>
                        </Tip>
                    </div>
                </div>
                {/* Content */}
                <div className="flex-1 overflow-hidden">
                    {renderPreviewContent()}
                </div>
                {showUnsavedConfirm && (
                    <ConfirmDialog
                        title="未保存的更改"
                        message="您有未保存的更改，确定要放弃吗？"
                        confirmText="放弃更改"
                        cancelText="继续编辑"
                        confirmVariant="danger"
                        onConfirm={handleDiscardChanges}
                        onCancel={() => setShowUnsavedConfirm(false)}
                    />
                )}
            </div>
        );
    }

    // Render via portal to document.body to escape parent stacking context
    // (prevents chat scrollbar from rendering on top of modal)
    return createPortal(
        <>
            {/* Modal backdrop */}
            <div
                className="fixed inset-0 z-[210] flex items-center justify-center bg-black/30 backdrop-blur-sm"
                style={{ padding: '3vh 3vw' }}
                onMouseDown={handleBackdropMouseDown}
                onClick={handleBackdropClick}
                onWheel={(e) => e.stopPropagation()}
            >
                {/* Modal content */}
                <div
                    className="glass-panel flex h-full w-full max-w-7xl flex-col overflow-hidden"
                    onClick={(e) => e.stopPropagation()}
                >
                    {/* Header */}
                    <div
                        className="flex flex-shrink-0 items-start justify-between gap-4 border-b border-[var(--line)] px-5 py-4 bg-[var(--paper-elevated)]"
                    >
                        <div className="flex items-center gap-3 min-w-0">
                            <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-[var(--accent-warm-muted)]">
                                <FileText className="h-4 w-4 text-[var(--accent)]" />
                            </div>
                            <div className="min-w-0">
                                <div className="flex items-center gap-3 truncate">
                                    <span className="truncate text-[13px] font-semibold text-[var(--ink)]">{name}</span>
                                    <span className="flex-shrink-0 text-[11px] text-[var(--ink-muted)]">{formatFileSize(size)}</span>
                                    {isEditing && (
                                        <span className="flex-shrink-0 text-[11px] text-[var(--accent)]">
                                            {hasUnsavedChanges ? '编辑中（未保存）' : '编辑中'}
                                        </span>
                                    )}
                                </div>
                                <div className="flex items-center gap-1.5">
                                    <span className="max-w-[400px] truncate text-[11px] text-[var(--ink-muted)]" title={path}>
                                        {shortenPathForDisplay(path)}
                                    </span>
                                    {canReveal && (
                                        <button
                                            type="button"
                                            onClick={handleOpenInFinder}
                                            className="flex-shrink-0 rounded p-0.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                                            title="打开所在文件夹"
                                        >
                                            <FolderOpen className="h-3.5 w-3.5" />
                                        </button>
                                    )}
                                </div>
                            </div>
                        </div>

                        {/* Action buttons - unified styling with smooth transitions */}
                        <div className="flex flex-shrink-0 items-center gap-1.5">
                            {canEdit && (isEditing ? (
                                <div key="editing" className="flex items-center gap-1.5">
                                    <button
                                        type="button"
                                        onClick={handleCancel}
                                        className="inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-medium text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1 active:scale-[0.98]"
                                    >
                                        <X className="h-3.5 w-3.5" />
                                        取消
                                    </button>
                                    <button
                                        type="button"
                                        onClick={handleSave}
                                        disabled={isSaving || !hasUnsavedChanges}
                                        className="inline-flex items-center justify-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1.5 text-[11px] font-semibold text-white shadow-sm transition-all duration-150 hover:bg-[var(--accent-warm-hover)] hover:shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
                                    >
                                        {isSaving ? (
                                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        ) : (
                                            <Save className="h-3.5 w-3.5" />
                                        )}
                                        保存
                                    </button>
                                </div>
                            ) : (
                                <button
                                    key="view"
                                    type="button"
                                    onClick={handleEdit}
                                    disabled={isLoading || !!error}
                                    className="inline-flex items-center justify-center gap-1.5 rounded-md bg-[var(--button-dark-bg)] px-3 py-1.5 text-[11px] font-semibold text-[var(--button-primary-text)] shadow-sm transition-all duration-150 hover:bg-[var(--button-dark-bg-hover)] hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
                                >
                                    <Edit2 className="h-3.5 w-3.5" />
                                    编辑
                                </button>
                            ))}
                            <button
                                type="button"
                                onClick={handleClose}
                                className="inline-flex items-center justify-center rounded-md border border-[var(--line-strong)] bg-[var(--button-secondary-bg)] px-3 py-1.5 text-[11px] font-semibold text-[var(--ink)] shadow-sm transition-all duration-150 hover:bg-[var(--button-secondary-bg-hover)] hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1 active:scale-[0.98]"
                            >
                                关闭
                            </button>
                        </div>
                    </div>

                    {/* Content area */}
                    <div className="flex-1 overflow-hidden">
                        {renderPreviewContent()}
                    </div>
                </div>
            </div>

            {/* Unsaved changes confirmation dialog */}
            {showUnsavedConfirm && (
                <ConfirmDialog
                    title="未保存的更改"
                    message="您有未保存的更改，确定要放弃吗？"
                    confirmText="放弃更改"
                    cancelText="继续编辑"
                    confirmVariant="danger"
                    onConfirm={handleDiscardChanges}
                    onCancel={() => setShowUnsavedConfirm(false)}
                />
            )}
        </>,
        document.body
    );
}
