/**
 * CronTaskDetailPanel - Modal showing full cron task details with actions
 */

import { useCallback, useState } from 'react';
import { Clock, Play, Square, Trash2, X } from 'lucide-react';

import type { CronTask } from '@/types/cronTask';
import {
    getCronStatusText,
    getCronStatusColor,
    formatScheduleDescription,
    formatNextExecution,
    checkCanResume,
} from '@/types/cronTask';
import { getFolderName } from '@/utils/taskCenterUtils';
import ConfirmDialog from './ConfirmDialog';
import TaskRunHistory from './scheduled-tasks/TaskRunHistory';

interface CronTaskDetailPanelProps {
    task: CronTask;
    botInfo?: { name: string; platform: string };
    onClose: () => void;
    onDelete: (taskId: string) => Promise<void>;
    onResume: (taskId: string) => Promise<void>;
    onStop?: (taskId: string) => Promise<void>;
}

function InfoRow({ label, value }: { label: string; value: string | undefined }) {
    if (!value) return null;
    return (
        <div className="flex items-baseline justify-between gap-3 py-1.5">
            <span className="shrink-0 text-[12px] text-[var(--ink-muted)]/60">{label}</span>
            <span className="truncate text-right text-[13px] text-[var(--ink-secondary)]">{value}</span>
        </div>
    );
}

export default function CronTaskDetailPanel({ task, botInfo, onClose, onDelete, onResume, onStop }: CronTaskDetailPanelProps) {
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [showStopConfirm, setShowStopConfirm] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);
    const [isResuming, setIsResuming] = useState(false);
    const [isStopping, setIsStopping] = useState(false);

    const handleDelete = useCallback(async () => {
        setIsDeleting(true);
        try {
            await onDelete(task.id);
            onClose();
        } catch {
            // Error handling is in the caller (Launcher.handleCronDelete)
        } finally {
            setIsDeleting(false);
            setShowDeleteConfirm(false);
        }
    }, [task.id, onDelete, onClose]);

    const handleResume = useCallback(async () => {
        setIsResuming(true);
        try {
            await onResume(task.id);
        } finally {
            setIsResuming(false);
        }
    }, [task.id, onResume]);

    const handleStop = useCallback(async () => {
        if (!onStop) return;
        setIsStopping(true);
        try {
            await onStop(task.id);
        } catch {
            // Error handling is in the caller (Launcher.handleCronStop)
        } finally {
            setIsStopping(false);
            setShowStopConfirm(false);
        }
    }, [task.id, onStop]);

    const resumeCheck = checkCanResume(task);
    const displayName = task.name || task.prompt.slice(0, 40) + (task.prompt.length > 40 ? '...' : '');
    const scheduleDesc = formatScheduleDescription(task);
    const nextExec = formatNextExecution(task.nextExecutionAt, task.status);
    const runModeLabel = task.runMode === 'single_session' ? '保持上下文' : '每次新建';
    const maxExecLabel = task.endConditions.maxExecutions
        ? `${task.executionCount} / ${task.endConditions.maxExecutions}`
        : `${task.executionCount} 次`;

    const deadlineLabel = task.endConditions.deadline
        ? new Date(task.endConditions.deadline).toLocaleString('zh-CN')
        : undefined;
    const maxExecCondLabel = task.endConditions.maxExecutions
        ? `${task.endConditions.maxExecutions} 次`
        : '无限次';

    return (
        <>
            {showDeleteConfirm && (
                <ConfirmDialog
                    title="删除定时任务"
                    message={`确定要删除「${displayName}」吗？此操作不可撤销。`}
                    confirmText="删除"
                    cancelText="取消"
                    confirmVariant="danger"
                    loading={isDeleting}
                    onConfirm={handleDelete}
                    onCancel={() => setShowDeleteConfirm(false)}
                />
            )}

            {showStopConfirm && (
                <ConfirmDialog
                    title="停止定时任务"
                    message={`确定要停止「${displayName}」吗？停止后可以重新恢复。`}
                    confirmText="停止"
                    cancelText="取消"
                    confirmVariant="danger"
                    loading={isStopping}
                    onConfirm={handleStop}
                    onCancel={() => setShowStopConfirm(false)}
                />
            )}

            {/* Backdrop */}
            <div
                className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm"
                style={{ animation: 'overlayFadeIn 200ms ease-out' }}
                onMouseDown={(e) => {
                    if (e.target === e.currentTarget) onClose();
                }}
            >
                {/* Panel */}
                <div
                    className="glass-panel w-full max-w-lg"
                    style={{ animation: 'overlayPanelIn 250ms ease-out' }}
                    onClick={e => e.stopPropagation()}
                >
                    {/* Header */}
                    <div className="flex items-center justify-between border-b border-[var(--line)] px-5 py-4">
                        <div className="flex min-w-0 items-center gap-2.5">
                            <Clock className="h-4 w-4 shrink-0 text-[var(--ink-muted)]" />
                            <h3 className="min-w-0 truncate text-[14px] font-semibold text-[var(--ink)]">
                                {displayName}
                            </h3>
                            <span className={`shrink-0 text-[12px] font-medium ${getCronStatusColor(task.status)}`}>
                                {getCronStatusText(task.status)}
                            </span>
                        </div>
                        <button
                            onClick={onClose}
                            className="ml-2 shrink-0 rounded-md p-1 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                        >
                            <X className="h-4 w-4" />
                        </button>
                    </div>

                    {/* Body */}
                    <div className="max-h-[60vh] overflow-y-auto px-5 py-4">
                        {/* Schedule core card */}
                        <div className="mb-4 flex items-center justify-between rounded-lg bg-[var(--paper-inset)] px-3 py-2.5">
                            <span className="text-[13px] font-semibold text-[var(--ink)]">
                                {scheduleDesc}
                            </span>
                            <span className={`text-[12px] ${task.status === 'running' ? 'text-[var(--ink-secondary)]' : 'text-[var(--ink-muted)]/50'}`}>
                                {task.status === 'running' ? `下次: ${nextExec}` : '已停止'}
                            </span>
                        </div>

                        {/* Key attributes (no section header) */}
                        <div className="mb-4">
                            <InfoRow label="运行模式" value={runModeLabel} />
                            <InfoRow label="工作区" value={getFolderName(task.workspacePath)} />
                            {task.model && <InfoRow label="模型" value={task.model} />}
                            {botInfo && (
                                <InfoRow
                                    label="来源"
                                    value={`${botInfo.name} (${botInfo.platform})`}
                                />
                            )}
                        </div>

                        {/* Run statistics */}
                        <div className="mb-4">
                            <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--ink-muted)]/50">
                                运行统计
                            </h4>
                            <InfoRow label="执行次数" value={maxExecLabel} />
                            <InfoRow
                                label="上次执行"
                                value={task.lastExecutedAt ? new Date(task.lastExecutedAt).toLocaleString('zh-CN') : '尚未执行'}
                            />
                            {task.exitReason && <InfoRow label="退出原因" value={task.exitReason} />}
                            {task.lastError && (
                                <div className="mt-1 rounded bg-[var(--error-bg)] px-2.5 py-1.5 text-[12px] text-[var(--error)]">
                                    {task.lastError}
                                </div>
                            )}
                        </div>

                        {/* End conditions - inline tags */}
                        <div className="mb-4">
                            <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--ink-muted)]/50">
                                结束条件
                            </h4>
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-[var(--ink-muted)]">
                                <span>截止 {deadlineLabel || '无'}</span>
                                <span className="text-[var(--line-strong)]">&middot;</span>
                                <span>{maxExecCondLabel}</span>
                                <span className="text-[var(--line-strong)]">&middot;</span>
                                <span>AI{task.endConditions.aiCanExit ? '可' : '不可'}退出</span>
                            </div>
                        </div>

                        {/* Execution history */}
                        <div className="mb-4">
                            <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--ink-muted)]/50">
                                执行历史
                            </h4>
                            <TaskRunHistory taskId={task.id} />
                        </div>

                        {/* Prompt preview */}
                        {task.prompt && (
                            <div>
                                <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--ink-muted)]/50">
                                    提示词
                                </h4>
                                <div className="rounded-lg bg-[var(--paper-inset)] px-3 py-2 text-[12px] leading-relaxed text-[var(--ink-secondary)]">
                                    {task.prompt.length > 200 ? task.prompt.slice(0, 200) + '...' : task.prompt}
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Footer */}
                    <div className="flex items-center justify-between border-t border-[var(--line)] px-5 py-3">
                        <button
                            onClick={() => setShowDeleteConfirm(true)}
                            className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium text-[var(--error)] transition-colors hover:bg-[var(--error-bg)]"
                        >
                            <Trash2 className="h-3.5 w-3.5" />
                            删除任务
                        </button>
                        {task.status === 'running' && onStop && (
                            <button
                                onClick={() => setShowStopConfirm(true)}
                                disabled={isStopping}
                                className="flex items-center gap-1.5 rounded-full border border-[var(--error)]/30 px-4 py-1.5 text-[12px] font-semibold text-[var(--error)] transition-colors hover:bg-[var(--error-bg)] disabled:opacity-50"
                            >
                                <Square className="h-3.5 w-3.5" />
                                {isStopping ? '停止中...' : '停止任务'}
                            </button>
                        )}
                        {task.status === 'stopped' && (
                            resumeCheck.canResume ? (
                                <button
                                    onClick={handleResume}
                                    disabled={isResuming}
                                    className="flex items-center gap-1.5 rounded-full bg-[var(--button-primary-bg)] px-4 py-1.5 text-[12px] font-semibold text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:opacity-50"
                                >
                                    <Play className="h-3.5 w-3.5" />
                                    {isResuming ? '恢复中...' : '恢复任务'}
                                </button>
                            ) : (
                                <span className="text-[12px] text-[var(--ink-muted)]/50">
                                    {resumeCheck.reason}
                                </span>
                            )
                        )}
                    </div>
                </div>
            </div>
        </>
    );
}
