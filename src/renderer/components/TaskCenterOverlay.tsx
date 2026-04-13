/**
 * TaskCenterOverlay - Full-screen overlay for browsing all tasks.
 * Left column: sessions list with filters.
 * Right column: cron tasks list.
 */

import { memo, useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { Search, Loader2, BarChart2, Clock, Plus, Trash2, X } from 'lucide-react';

import { useCloseLayer } from '@/hooks/useCloseLayer';
import { searchSessions, type SessionSearchHit } from '@/api/searchClient';

import { TASK_CENTER_FRESHNESS_TTL_MS, type TaskCenterData } from '@/hooks/useTaskCenterData';
import WorkspaceIcon from '@/components/launcher/WorkspaceIcon';
import SessionTagBadge from '@/components/SessionTagBadge';
import SessionStatsModal from '@/components/SessionStatsModal';
import ConfirmDialog from '@/components/ConfirmDialog';
import CustomSelect from '@/components/CustomSelect';
import { useToast } from '@/components/Toast';
import { getFolderName, formatTime, isImSource, getSessionDisplayText, formatMessageCount } from '@/utils/taskCenterUtils';
import type { SessionMetadata } from '@/api/sessionClient';
import type { CronTask } from '@/types/cronTask';
import type { Project } from '@/config/types';
import {
    getCronStatusText,
    getCronStatusColor,
    formatScheduleDescription,
    formatNextExecution,
} from '@/types/cronTask';
import TaskCreateModal from '@/components/scheduled-tasks/TaskCreateModal';
import OverlayBackdrop from '@/components/OverlayBackdrop';
import SessionSearchItem from '@/components/search/SessionSearchItem';

interface TaskCenterOverlayProps {
    projects: Project[];
    onOpenTask: (session: SessionMetadata, project: Project) => void;
    onOpenCronDetail: (task: CronTask) => void;
    onClose: () => void;
    taskCenterData: TaskCenterData;
    initialMode?: 'default' | 'search';
}

type StatusFilter = 'all' | 'active' | 'desktop' | 'bot';

const FILTER_OPTIONS: { key: StatusFilter; label: string }[] = [
    { key: 'all', label: '全部' },
    { key: 'active', label: '活跃中' },
    { key: 'desktop', label: '桌面' },
    { key: 'bot', label: '聊天机器人' },
];

export default memo(function TaskCenterOverlay({
    projects,
    onOpenTask,
    onOpenCronDetail,
    onClose,
    taskCenterData,
    initialMode = 'default',
}: TaskCenterOverlayProps) {
    useCloseLayer(() => { onClose(); return true; }, 40);
    const { sessions, cronTasks, sessionTagsMap, cronBotInfoMap, refresh, actions } = taskCenterData;
    const toast = useToast();

    // Search state
    const [isSearchMode, setIsSearchMode] = useState(initialMode === 'search');
    const [searchQuery, setSearchQuery] = useState('');
    const [isSearching, setIsSearching] = useState(false);
    const [searchResults, setSearchResults] = useState<SessionSearchHit[]>([]);
    const searchInputRef = useRef<HTMLInputElement>(null);

    const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
    const [workspaceFilter, setWorkspaceFilter] = useState<string>('all');
    const [pendingDeleteSession, setPendingDeleteSession] = useState<{ id: string; title: string } | null>(null);
    const [statsSession, setStatsSession] = useState<{ id: string; title: string } | null>(null);
    const [showCreateModal, setShowCreateModal] = useState(false);

    useEffect(() => {
        refresh('all', {
            minIntervalMs: TASK_CENTER_FRESHNESS_TTL_MS,
            reason: 'task-center-overlay-open',
            silent: true,
        });
    }, [refresh]);

    // Auto-focus search input on mount when overlay opens in search mode
    useEffect(() => {
        if (initialMode === 'search') {
            const id = setTimeout(() => searchInputRef.current?.focus(), 50);
            return () => clearTimeout(id);
        }
    }, [initialMode]);

    // Unique workspace entries for dropdown (name + icon)
    const workspaceOptions = useMemo(() => {
        const seen = new Map<string, string | undefined>(); // name → icon
        for (const s of sessions) {
            const proj = projects.find(p => p.path === s.agentDir);
            if (proj) {
                const name = getFolderName(proj.path);
                if (!seen.has(name)) seen.set(name, proj.icon);
            }
        }
        return Array.from(seen.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([name, icon]) => ({ name, icon }));
    }, [sessions, projects]);

    // Memoize CustomSelect options to avoid re-creating JSX icons each render
    const workspaceSelectOptions = useMemo(() => [
        { value: 'all', label: '全部工作区' },
        ...workspaceOptions.map(({ name, icon }) => ({
            value: name,
            label: name,
            icon: <WorkspaceIcon icon={icon} size={14} />,
        })),
    ], [workspaceOptions]);

    // Filter sessions
    const filteredSessions = useMemo(() => {
        // 48h cutoff for "active" filter — computed per-filter to avoid stale mount-time values.
        // sessions is the dependency, so this recomputes whenever session data refreshes.
        const activeCutoff48h = new Date(+new Date() - 48 * 3600000).toISOString();
        return sessions.filter(session => {
            // Status filter (source-based for bot/desktop)
            if (statusFilter === 'active') {
                const tags = sessionTagsMap.get(session.id) ?? [];
                if (tags.length === 0) return false;
                // Require recent activity (48h) — prevents stale IM sessions
                // from permanently appearing as "active" just because they have a source tag
                if (session.lastActiveAt && session.lastActiveAt < activeCutoff48h) return false;
            }
            if (statusFilter === 'desktop' && isImSource(session.source)) return false;
            if (statusFilter === 'bot' && !isImSource(session.source)) return false;

            // Workspace filter
            if (workspaceFilter !== 'all') {
                const proj = projects.find(p => p.path === session.agentDir);
                if (!proj || getFolderName(proj.path) !== workspaceFilter) return false;
            }

            return true;
        });
    }, [sessions, sessionTagsMap, statusFilter, workspaceFilter, projects]);

    // Sort cron tasks: running first (by nextExecutionAt ASC), then stopped (by updatedAt DESC)
    const sortedCronTasks = useMemo(() => {
        return [...cronTasks].sort((a, b) => {
            // Primary: running tasks first
            if (a.status === 'running' && b.status !== 'running') return -1;
            if (a.status !== 'running' && b.status === 'running') return 1;

            if (a.status === 'running') {
                // Within running: soonest execution first
                if (a.nextExecutionAt && b.nextExecutionAt) {
                    return new Date(a.nextExecutionAt).getTime() - new Date(b.nextExecutionAt).getTime();
                }
                return 0;
            }

            // Within stopped: most recently active first
            const aTime = new Date(a.updatedAt || a.createdAt).getTime();
            const bTime = new Date(b.updatedAt || b.createdAt).getTime();
            return bTime - aTime;
        });
    }, [cronTasks]);

    // Search effect
    useEffect(() => {
        if (!isSearchMode) return;
        
        let isStale = false;
        const timeout = setTimeout(async () => {
            if (!searchQuery.trim()) {
                setSearchResults([]);
                setIsSearching(false);
                return;
            }
            
            setIsSearching(true);
            try {
                const result = await searchSessions(searchQuery);
                if (!isStale) {
                    setSearchResults(result.hits);
                }
            } catch (err) {
                console.error('[TaskCenterOverlay] Session search failed:', err);
                if (!isStale) setSearchResults([]);
            } finally {
                if (!isStale) setIsSearching(false);
            }
        }, 300); // 300ms debounce
        
        return () => {
            isStale = true;
            clearTimeout(timeout);
        };
    }, [searchQuery, isSearchMode]);

    const getProjectForSession = useCallback(
        (session: SessionMetadata): Project | undefined =>
            projects.find(p => p.path === session.agentDir),
        [projects]
    );

    const cronProtectedSessionIds = useMemo(
        () => new Set(cronTasks.filter(t => t.status === 'running').map(t => t.sessionId)),
        [cronTasks]
    );

    const handleDeleteClick = useCallback((e: React.MouseEvent, session: SessionMetadata) => {
        e.stopPropagation();
        setPendingDeleteSession({ id: session.id, title: getSessionDisplayText(session) });
    }, []);

    const handleConfirmDelete = useCallback(async () => {
        if (!pendingDeleteSession) return;
        const { id } = pendingDeleteSession;
        setPendingDeleteSession(null);
        try {
            const success = await actions.deleteSession(id);
            if (success) {
                toast.success('已删除');
            } else {
                toast.error('删除失败，请重试');
            }
        } catch (err) {
            console.error('[TaskCenterOverlay] Delete session failed:', err);
            toast.error('删除失败');
        }
    }, [actions, pendingDeleteSession, toast]);

    const handleShowStats = useCallback((e: React.MouseEvent, session: SessionMetadata) => {
        e.stopPropagation();
        setStatsSession({ id: session.id, title: getSessionDisplayText(session) });
    }, []);

    const handleCreated = useCallback(() => {
        refresh('all', { force: true, reason: 'task-center-cron-created', silent: true });
    }, [refresh]);

    return (
        <OverlayBackdrop onClose={onClose} className="z-40" style={{ animation: 'overlayFadeIn 200ms ease-out' }}>
            <div
                className="glass-panel flex h-[85vh] w-full max-w-5xl flex-col"
                style={{ padding: '2vh 2vw', animation: 'overlayPanelIn 250ms ease-out' }}
            >
                {/* Header */}
                <div className="mb-4 flex items-center justify-between">
                    <h2 className="text-[16px] font-semibold text-[var(--ink)]">任务中心</h2>
                    <button
                        onClick={onClose}
                        className="rounded-md p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                {/* Body: two columns */}
                <div className="flex min-h-0 flex-1 gap-5">
                    {/* Left: Sessions */}
                    <div className="flex min-w-0 flex-1 flex-col">
                        <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]/60">
                            最近任务
                        </h3>

                        {/* Filter bar / Search Input */}
                        <div className="mb-3 flex flex-wrap items-center gap-2 h-8">
                            {isSearchMode ? (
                                <div className="relative flex-1 h-full">
                                    <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-2.5 text-[var(--ink-muted)]/50">
                                        <Search className="h-3.5 w-3.5" />
                                    </div>
                                    <input
                                        ref={searchInputRef}
                                        type="text"
                                        value={searchQuery}
                                        onChange={(e) => setSearchQuery(e.target.value)}
                                        placeholder="搜索历史记录的内容或标题..."
                                        className="h-full w-full rounded-md outline-none border border-[var(--line)] bg-transparent py-1 pl-8 pr-10 text-[12px] text-[var(--ink)] transition-colors placeholder:text-[var(--ink-muted)]/60 focus:border-[var(--accent)]"
                                        onKeyDown={(e) => {
                                            if (e.key === "Escape") {
                                                setIsSearchMode(false);
                                                setSearchQuery("");
                                            }
                                        }}
                                    />
                                    <div className="absolute inset-y-0 right-0 flex items-center gap-1 pr-2">
                                        {isSearching && (
                                            <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--ink-muted)]/50" />
                                        )}
                                        <button
                                            onClick={() => {
                                                setIsSearchMode(false);
                                                setSearchQuery("");
                                                setSearchResults([]);
                                            }}
                                            title="退出搜索"
                                            className="flex items-center text-[var(--ink-muted)]/50 transition-colors hover:text-[var(--ink)]"
                                        >
                                            <X className="h-3.5 w-3.5" />
                                        </button>
                                    </div>
                                </div>
                            ) : (
                                <>
                                    {/* Status pills */}
                                    <div className="flex gap-1">
                                        {FILTER_OPTIONS.map(opt => (
                                            <button
                                                key={opt.key}
                                                onClick={() => setStatusFilter(opt.key)}
                                                className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
                                                    statusFilter === opt.key
                                                        ? 'bg-[var(--button-primary-bg)] text-[var(--button-primary-text)]'
                                                        : 'text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]'
                                                }`}
                                            >
                                                {opt.label}
                                            </button>
                                        ))}
                                    </div>

                                    {/* Workspace dropdown */}
                                    {workspaceOptions.length > 1 && (
                                        <CustomSelect
                                            value={workspaceFilter}
                                            options={workspaceSelectOptions}
                                            onChange={setWorkspaceFilter}
                                            compact
                                            className="w-[140px]"
                                        />
                                    )}
                                    <div className="flex-1" />
                                    <button
                                        onClick={() => {
                                            setIsSearchMode(true);
                                            setTimeout(() => searchInputRef.current?.focus(), 50);
                                        }}
                                        className="rounded-md p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                                    >
                                        <Search className="h-4 w-4" />
                                    </button>
                                </>
                            )}
                        </div>

                        {/* Session list */}
                        <div className="flex-1 overflow-y-auto overscroll-contain" style={{ scrollbarGutter: 'stable' }}>
                            {filteredSessions.length === 0 ? (
                                <div className="py-8 text-center text-[13px] text-[var(--ink-muted)]/60">
                                    暂无匹配的任务
                                </div>
                            ) : (
                                <div className="space-y-0.5">
                                    {isSearchMode && searchQuery.trim() !== '' ? (
                                        searchResults.length === 0 && !isSearching ? (
                                            <div className="py-8 text-center text-[13px] text-[var(--ink-muted)]/60">
                                                未找到结果
                                            </div>
                                        ) : (
                                            searchResults.map(hit => {
                                                const session = sessions.find(s => s.id === hit.sessionId);
                                                const project = projects.find(p => p.path === hit.agentDir);
                                                if (!session || !project) return null;
                                                const isCronProtected = cronProtectedSessionIds.has(session.id);
                                                return (
                                                    <SessionSearchItem
                                                        key={`${hit.sessionId}-${hit.matchType}`}
                                                        hit={hit}
                                                        session={session}
                                                        project={project}
                                                        isCronProtected={isCronProtected}
                                                        onClick={() => onOpenTask(session, project)}
                                                        onShowStats={(e) => handleShowStats(e, session)}
                                                        onDelete={(e) => handleDeleteClick(e, session)}
                                                    />
                                                );
                                            })
                                        )
                                    ) : (
                                        filteredSessions.map(session => {
                                            const project = getProjectForSession(session);
                                            if (!project) return null;
                                            const tags = sessionTagsMap.get(session.id) ?? [];
                                            const displayText = getSessionDisplayText(session);
                                            const msgCount = formatMessageCount(session);

                                            const isCronProtected = cronProtectedSessionIds.has(session.id);
                                            return (
                                                <div
                                                    key={session.id}
                                                    role="button"
                                                    onClick={() => onOpenTask(session, project)}
                                                    className="group relative flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-all hover:bg-[var(--hover-bg)]"
                                                >
                                                    <div className="flex w-14 shrink-0 items-center gap-1 text-[11px] text-[var(--ink-muted)]/50">
                                                        <Clock className="h-2.5 w-2.5" />
                                                        <span>{formatTime(session.lastActiveAt)}</span>
                                                    </div>
                                                    {tags.map((tag, i) => (
                                                        <SessionTagBadge key={i} tag={tag} />
                                                    ))}
                                                    <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--ink-secondary)] transition-colors group-hover:text-[var(--ink)]">
                                                        {displayText}
                                                        {msgCount && (
                                                            <span className="ml-1.5 text-[11px] text-[var(--ink-muted)]/40">
                                                                {msgCount}
                                                            </span>
                                                        )}
                                                    </span>
                                                    <div className="flex shrink-0 items-center gap-1.5 text-[11px] text-[var(--ink-muted)]/45">
                                                        <WorkspaceIcon icon={project.icon} size={14} />
                                                        <span className="max-w-[80px] truncate">
                                                            {getFolderName(project.path)}
                                                        </span>
                                                    </div>

                                                    {/* Hover actions overlay */}
                                                    <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
                                                        <div className="h-full w-10 bg-gradient-to-r from-transparent to-[var(--paper-inset)]" />
                                                        <div className="flex h-full items-center gap-1 bg-[var(--paper-inset)] pr-3">
                                                            <button
                                                                onClick={e => handleShowStats(e, session)}
                                                                title="查看统计"
                                                                className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper)] hover:text-[var(--ink)]"
                                                            >
                                                                <BarChart2 className="h-3.5 w-3.5" />
                                                            </button>
                                                            {isCronProtected ? (
                                                                <button
                                                                    disabled
                                                                    title="请先停止定时任务后再删除"
                                                                    className="flex h-7 w-7 cursor-not-allowed items-center justify-center rounded-md text-[var(--ink-muted)] opacity-40"
                                                                >
                                                                    <Trash2 className="h-3.5 w-3.5" />
                                                                </button>
                                                            ) : (
                                                                <button
                                                                    onClick={e => handleDeleteClick(e, session)}
                                                                    title="删除"
                                                                    className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--ink-muted)] transition-colors hover:bg-[var(--error-bg)] hover:text-[var(--error)]"
                                                                >
                                                                    <Trash2 className="h-3.5 w-3.5" />
                                                                </button>
                                                            )}
                                                        </div>
                                                    </div>
                                                </div>
                                            );
                                        })
                                    )}
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Right: Cron tasks */}
                    <div className="flex w-[340px] shrink-0 flex-col border-l border-[var(--line)] pl-5">
                        <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]/60">
                            定时任务
                        </h3>

                        <div className="flex-1 overflow-y-auto overscroll-contain" style={{ scrollbarGutter: 'stable' }}>
                            <div className="space-y-1">
                                {/* Create button — first item, matching RecentTasks style */}
                                <button
                                    onClick={() => setShowCreateModal(true)}
                                    className="mb-1 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-[var(--line)] py-2 text-[13px] font-medium text-[var(--ink-muted)] hover:border-[var(--line-strong)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)] transition-colors"
                                >
                                    <Plus className="h-3.5 w-3.5" />
                                    新建定时任务
                                </button>

                                {sortedCronTasks.length === 0 ? (
                                    <div className="py-6 text-center text-[13px] text-[var(--ink-muted)]/60">
                                        暂无定时任务
                                    </div>
                                ) : (
                                    sortedCronTasks.map(task => {
                                        const botInfo = task.sourceBotId
                                            ? cronBotInfoMap.get(task.sourceBotId)
                                            : undefined;
                                        const displayName =
                                            task.name ||
                                            task.prompt.slice(0, 30) + (task.prompt.length > 30 ? '...' : '');

                                        return (
                                            <button
                                                key={task.id}
                                                onClick={() => onOpenCronDetail(task)}
                                                className="group flex w-full flex-col gap-1 rounded-lg px-3 py-2 text-left transition-all hover:bg-[var(--hover-bg)]"
                                            >
                                                <div className="flex items-center gap-2">
                                                    <span
                                                        className={`text-[12px] font-medium ${getCronStatusColor(task.status)}`}
                                                    >
                                                        {getCronStatusText(task.status)}
                                                    </span>
                                                    <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--ink-secondary)] transition-colors group-hover:text-[var(--ink)]">
                                                        {displayName}
                                                    </span>
                                                </div>
                                                <div className="flex items-center gap-3 text-[11px] text-[var(--ink-muted)]/50">
                                                    {botInfo && (
                                                        <span>{botInfo.name} ({botInfo.platform})</span>
                                                    )}
                                                    {!botInfo && (
                                                        <span>{getFolderName(task.workspacePath)}</span>
                                                    )}
                                                    <span>{formatScheduleDescription(task)}</span>
                                                    {task.status === 'running' && (
                                                        <span className="ml-auto">
                                                            {formatNextExecution(task.nextExecutionAt, task.status)}
                                                        </span>
                                                    )}
                                                </div>
                                            </button>
                                        );
                                    })
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {pendingDeleteSession && (
                <ConfirmDialog
                    title="删除对话"
                    message={`确定要删除「${pendingDeleteSession.title}」吗？此操作不可撤销。`}
                    confirmText="删除"
                    confirmVariant="danger"
                    onConfirm={handleConfirmDelete}
                    onCancel={() => setPendingDeleteSession(null)}
                />
            )}
            {statsSession && (
                <SessionStatsModal
                    sessionId={statsSession.id}
                    sessionTitle={statsSession.title}
                    onClose={() => setStatsSession(null)}
                />
            )}
            {showCreateModal && (
                <TaskCreateModal
                    onClose={() => setShowCreateModal(false)}
                    onCreated={handleCreated}
                />
            )}
        </OverlayBackdrop>
    );
});
