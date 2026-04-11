/**
 * useTaskCenterData - Shared hook for Task Center data fetching,
 * event listening, and tag computation.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { deleteSession as deleteSessionApi, getSessions, type SessionMetadata } from '@/api/sessionClient';
import { getAllCronTasks, getBackgroundSessions } from '@/api/cronTaskClient';
import { deactivateSession } from '@/api/tauriClient';
import { loadAppConfig } from '@/config/configService';
import { isTauriEnvironment } from '@/utils/browserMock';
import type { CronTask } from '@/types/cronTask';
import type { AgentConfig } from '../../shared/types/agent';
import type { AgentStatusMap } from '@/hooks/useAgentStatuses';
import { extractPlatformDisplay } from '@/utils/taskCenterUtils';
import { CUSTOM_EVENTS } from '../../shared/constants';

// ===== Types =====

export type SessionTag =
    | { type: 'im'; platform: string }
    | { type: 'cron' }
    | { type: 'background' };

export interface TaskCenterData {
    sessions: SessionMetadata[];
    cronTasks: CronTask[];
    sessionTagsMap: Map<string, SessionTag[]>;
    cronBotInfoMap: Map<string, { name: string; platform: string }>;
    isLoading: boolean;
    error: string | null;
    refresh: (scope?: TaskCenterRefreshScope, options?: TaskCenterRefreshOptions) => void;
    actions: TaskCenterActions;
}

export type TaskCenterRefreshScope = 'all' | 'sessions' | 'cronTasks' | 'backgroundSessions' | 'agentStatuses';

export interface TaskCenterRefreshOptions {
    force?: boolean;
    minIntervalMs?: number;
    reason?: string;
    silent?: boolean;
}

export interface TaskCenterActions {
    deleteSession: (sessionId: string) => Promise<boolean>;
    refreshSessions: () => void;
    refreshCronTasks: () => void;
}

interface UseTaskCenterDataOptions {
    isActive?: boolean;
}

// Constants
const MAX_AUTO_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const BACKGROUND_REFRESH_INTERVAL_MS = 60_000;
export const TASK_CENTER_FRESHNESS_TTL_MS = 2_000;

const sortSessionsByLastActive = (data: SessionMetadata[]) =>
    [...data].sort((a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime());

export function useTaskCenterData({ isActive }: UseTaskCenterDataOptions): TaskCenterData {
    const [sessions, setSessions] = useState<SessionMetadata[]>([]);
    const [cronTasks, setCronTasks] = useState<CronTask[]>([]);
    const [backgroundSessionIds, setBackgroundSessionIds] = useState<string[]>([]);
    const [agentStatuses, setAgentStatuses] = useState<AgentStatusMap>({});
    const [agents, setAgents] = useState<AgentConfig[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const isMountedRef = useRef(true);
    const retryTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const sessionRefreshTimerRef = useRef<NodeJS.Timeout | null>(null);
    const agentRefreshTimerRef = useRef<NodeJS.Timeout | null>(null);
    const cronRefreshTimerRef = useRef<NodeJS.Timeout | null>(null);
    const backgroundRefreshTimerRef = useRef<NodeJS.Timeout | null>(null);
    const lastFetchedAtRef = useRef<Partial<Record<TaskCenterRefreshScope, number>>>({});
    const requestSeqRef = useRef(0);
    const latestRequestSeqByScopeRef = useRef<Partial<Record<TaskCenterRefreshScope, number>>>({});
    const deletedSessionIdsRef = useRef<Set<string>>(new Set());

    const markFetched = useCallback((scope: TaskCenterRefreshScope) => {
        const now = Date.now();
        lastFetchedAtRef.current[scope] = now;
        if (scope === 'all') {
            lastFetchedAtRef.current.sessions = now;
            lastFetchedAtRef.current.cronTasks = now;
            lastFetchedAtRef.current.backgroundSessions = now;
            lastFetchedAtRef.current.agentStatuses = now;
        }
    }, []);

    const startRequest = useCallback((scope: TaskCenterRefreshScope) => {
        const requestSeq = ++requestSeqRef.current;
        latestRequestSeqByScopeRef.current[scope] = requestSeq;
        if (scope === 'all') {
            latestRequestSeqByScopeRef.current.sessions = requestSeq;
            latestRequestSeqByScopeRef.current.cronTasks = requestSeq;
            latestRequestSeqByScopeRef.current.backgroundSessions = requestSeq;
            latestRequestSeqByScopeRef.current.agentStatuses = requestSeq;
        }
        return requestSeq;
    }, []);

    const isLatestRequest = useCallback((scope: TaskCenterRefreshScope, requestSeq: number) => {
        return latestRequestSeqByScopeRef.current[scope] === requestSeq;
    }, []);

    const filterDeletedSessions = useCallback((data: SessionMetadata[]) => {
        const deletedSessionIds = deletedSessionIdsRef.current;
        if (deletedSessionIds.size === 0) return data;
        return data.filter(session => !deletedSessionIds.has(session.id));
    }, []);

    const fetchData = useCallback(async (retryCount = 0, silent = false) => {
        const requestSeq = startRequest('all');
        if (retryCount === 0 && !silent) setIsLoading(true);
        if (!silent) setError(null);

        try {
            const agentStatusPromise = isTauriEnvironment()
                ? import('@tauri-apps/api/core')
                    .then(({ invoke }) => invoke<AgentStatusMap>('cmd_all_agents_status'))
                    .catch(() => ({} as AgentStatusMap))
                : Promise.resolve({} as AgentStatusMap);

            const [sessionsData, tasksData, bgSessions, agentStatusResult, appConfig] = await Promise.all([
                getSessions(),
                getAllCronTasks().catch(() => [] as CronTask[]),
                getBackgroundSessions().catch(() => [] as string[]),
                agentStatusPromise,
                loadAppConfig().catch(() => null),
            ]);

            if (!isMountedRef.current) return;

            if (isLatestRequest('sessions', requestSeq)) {
                setSessions(sortSessionsByLastActive(filterDeletedSessions(sessionsData)));
            }
            if (isLatestRequest('cronTasks', requestSeq)) setCronTasks(tasksData);
            if (isLatestRequest('backgroundSessions', requestSeq)) setBackgroundSessionIds(bgSessions);
            if (isLatestRequest('agentStatuses', requestSeq)) setAgentStatuses(agentStatusResult);
            setAgents(appConfig?.agents ?? []);
            markFetched('all');
            setError(null);
        } catch (err) {
            if (!isMountedRef.current) return;
            console.error('[useTaskCenterData] Failed to load data:', err);
            if (!silent && retryCount < MAX_AUTO_RETRIES) {
                retryTimeoutRef.current = setTimeout(() => {
                    void fetchData(retryCount + 1, silent);
                }, RETRY_DELAY_MS);
            } else if (!silent) {
                setError('加载失败，请稍后重试');
            }
        } finally {
            if (isMountedRef.current && !silent) setIsLoading(false);
        }
    }, [filterDeletedSessions, isLatestRequest, markFetched, startRequest]);

    const refreshSessionsNow = useCallback(() => {
        const requestSeq = startRequest('sessions');
        getSessions().then(data => {
            if (!isMountedRef.current) return;
            if (!isLatestRequest('sessions', requestSeq)) return;
            setSessions(sortSessionsByLastActive(filterDeletedSessions(data)));
            markFetched('sessions');
        }).catch(err => {
            console.warn('[useTaskCenterData] Failed to refresh sessions:', err);
        });
    }, [filterDeletedSessions, isLatestRequest, markFetched, startRequest]);

    const refreshCronTasksNow = useCallback(() => {
        const requestSeq = startRequest('cronTasks');
        getAllCronTasks().then(tasks => {
            if (!isMountedRef.current) return;
            if (!isLatestRequest('cronTasks', requestSeq)) return;
            setCronTasks(tasks);
            markFetched('cronTasks');
        }).catch(err => {
            console.warn('[useTaskCenterData] Failed to refresh cron tasks:', err);
        });
    }, [isLatestRequest, markFetched, startRequest]);

    const refreshBackgroundSessionsNow = useCallback(() => {
        const requestSeq = startRequest('backgroundSessions');
        getBackgroundSessions().then(ids => {
            if (!isMountedRef.current) return;
            if (!isLatestRequest('backgroundSessions', requestSeq)) return;
            setBackgroundSessionIds(ids);
            markFetched('backgroundSessions');
        }).catch(err => {
            console.warn('[useTaskCenterData] Failed to refresh background sessions:', err);
        });
    }, [isLatestRequest, markFetched, startRequest]);

    const refreshAgentStatusNow = useCallback(() => {
        const requestSeq = startRequest('agentStatuses');
        if (!isTauriEnvironment()) return;
        import('@tauri-apps/api/core')
            .then(({ invoke }) => {
                invoke<AgentStatusMap>('cmd_all_agents_status')
                    .then(statuses => {
                        if (!isMountedRef.current) return;
                        if (!isLatestRequest('agentStatuses', requestSeq)) return;
                        setAgentStatuses(statuses);
                        markFetched('agentStatuses');
                    })
                    .catch(err => {
                        console.warn('[useTaskCenterData] Failed to refresh agent statuses:', err);
                    });
            })
            .catch(err => {
                console.warn('[useTaskCenterData] Failed to load Tauri API for agent statuses:', err);
            });
    }, [isLatestRequest, markFetched, startRequest]);

    // Debounced session refresh (avoids API flooding on rapid events)
    const refreshSessionsDebounced = useCallback((delayMs = 500) => {
        if (sessionRefreshTimerRef.current) clearTimeout(sessionRefreshTimerRef.current);
        sessionRefreshTimerRef.current = setTimeout(() => {
            sessionRefreshTimerRef.current = null;
            refreshSessionsNow();
        }, delayMs);
    }, [refreshSessionsNow]);

    const refreshCronTasksDebounced = useCallback((delayMs = 500) => {
        if (cronRefreshTimerRef.current) clearTimeout(cronRefreshTimerRef.current);
        cronRefreshTimerRef.current = setTimeout(() => {
            cronRefreshTimerRef.current = null;
            refreshCronTasksNow();
        }, delayMs);
    }, [refreshCronTasksNow]);

    const refreshBackgroundSessionsDebounced = useCallback((delayMs = 500) => {
        if (backgroundRefreshTimerRef.current) clearTimeout(backgroundRefreshTimerRef.current);
        backgroundRefreshTimerRef.current = setTimeout(() => {
            backgroundRefreshTimerRef.current = null;
            refreshBackgroundSessionsNow();
        }, delayMs);
    }, [refreshBackgroundSessionsNow]);

    // Debounced Agent status refresh
    const refreshAgentStatusDebounced = useCallback((delayMs = 1000) => {
        if (agentRefreshTimerRef.current) clearTimeout(agentRefreshTimerRef.current);
        agentRefreshTimerRef.current = setTimeout(() => {
            agentRefreshTimerRef.current = null;
            refreshAgentStatusNow();
        }, delayMs);
    }, [refreshAgentStatusNow]);

    // Initial fetch
    useEffect(() => {
        isMountedRef.current = true;
        void fetchData(0);
        return () => {
            isMountedRef.current = false;
            if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
            if (sessionRefreshTimerRef.current) clearTimeout(sessionRefreshTimerRef.current);
            if (agentRefreshTimerRef.current) clearTimeout(agentRefreshTimerRef.current);
            if (cronRefreshTimerRef.current) clearTimeout(cronRefreshTimerRef.current);
            if (backgroundRefreshTimerRef.current) clearTimeout(backgroundRefreshTimerRef.current);
        };
    }, [fetchData]);

    // Refresh on tab activation (inactive → active transition)
    const prevIsActiveRef = useRef(isActive);
    useEffect(() => {
        const wasInactive = !prevIsActiveRef.current;
        prevIsActiveRef.current = isActive;
        if (!wasInactive || !isActive) return;
        void fetchData(0, true);
    }, [isActive, fetchData]);

    // Lightweight fallback: while Launcher is active, reconcile all task-center data once a minute.
    useEffect(() => {
        if (!isActive) return;
        const interval = setInterval(() => {
            void fetchData(0, true);
        }, BACKGROUND_REFRESH_INTERVAL_MS);
        return () => clearInterval(interval);
    }, [isActive, fetchData]);

    // Refresh sessions when a session title changes (auto-generated or user rename)
    useEffect(() => {
        const handler = () => refreshSessionsDebounced(300);
        window.addEventListener(CUSTOM_EVENTS.SESSION_TITLE_CHANGED, handler);
        return () => window.removeEventListener(CUSTOM_EVENTS.SESSION_TITLE_CHANGED, handler);
    }, [refreshSessionsDebounced]);

    // Event listeners for real-time updates
    useEffect(() => {
        if (!isTauriEnvironment()) return;

        let mounted = true;
        const unlisteners: (() => void)[] = [];

        (async () => {
            const { listen } = await import('@tauri-apps/api/event');
            if (!mounted) return;

            // Background completion events
            const u1 = await listen('session:background-complete', () => {
                if (!mounted) return;
                refreshBackgroundSessionsDebounced();
                refreshSessionsDebounced();
            });
            unlisteners.push(u1);

            // Cron task events
            const u2 = await listen('cron:task-stopped', () => {
                if (!mounted) return;
                refreshCronTasksDebounced();
            });
            unlisteners.push(u2);

            const u2b = await listen('cron:task-started', () => {
                if (!mounted) return;
                refreshCronTasksDebounced();
            });
            unlisteners.push(u2b);

            const u3 = await listen('cron:execution-complete', () => {
                if (!mounted) return;
                refreshCronTasksDebounced();
                refreshSessionsDebounced();
            });
            unlisteners.push(u3);

            // Scheduler started (resume / recovery)
            const u4 = await listen('cron:scheduler-started', () => {
                if (!mounted) return;
                refreshCronTasksDebounced();
                refreshSessionsDebounced();
            });
            unlisteners.push(u4);

            // Task deleted
            const u5 = await listen('cron:task-deleted', () => {
                if (!mounted) return;
                refreshCronTasksDebounced();
            });
            unlisteners.push(u5);

            // Task updated (fields edited via cmd_update_cron_task_fields)
            const u6 = await listen('cron:task-updated', () => {
                if (!mounted) return;
                refreshCronTasksDebounced();
            });
            unlisteners.push(u6);

            // Agent status changes (channel started/stopped, session created)
            const u7 = await listen('agent:status-changed', () => {
                if (!mounted) return;
                refreshAgentStatusDebounced();
                refreshSessionsDebounced(1000);
            });
            unlisteners.push(u7);
        })();

        return () => {
            mounted = false;
            unlisteners.forEach(fn => fn());
            if (sessionRefreshTimerRef.current) clearTimeout(sessionRefreshTimerRef.current);
            if (agentRefreshTimerRef.current) clearTimeout(agentRefreshTimerRef.current);
            if (cronRefreshTimerRef.current) clearTimeout(cronRefreshTimerRef.current);
            if (backgroundRefreshTimerRef.current) clearTimeout(backgroundRefreshTimerRef.current);
        };
    }, [refreshSessionsDebounced, refreshCronTasksDebounced, refreshBackgroundSessionsDebounced, refreshAgentStatusDebounced]);

    // Compute session tags (memoized)
    const sessionTagsMap = useMemo(() => {
        const map = new Map<string, SessionTag[]>();

        // Build IM session map: sessionId → platform display name
        const imSessionPlatformMap = new Map<string, string>();

        // From agent channel statuses
        for (const agentStatus of Object.values(agentStatuses)) {
            for (const channel of agentStatus.channels) {
                if (channel.status !== 'online' && channel.status !== 'connecting') continue;
                for (const activeSession of (channel.activeSessions as { sessionKey: string; sessionId: string }[])) {
                    imSessionPlatformMap.set(activeSession.sessionId, extractPlatformDisplay(activeSession.sessionKey));
                }
            }
        }

        // Build running cron task session set
        // Use internalSessionId (actual SDK session) when available, falling back to sessionId
        const cronSessionIds = new Set(
            cronTasks.filter(t => t.status === 'running').map(t => t.internalSessionId || t.sessionId)
        );

        // Build background session set
        const bgSessionIds = new Set(backgroundSessionIds);

        // Assign tags to each session
        for (const session of sessions) {
            const tags: SessionTag[] = [];
            const imPlatform = imSessionPlatformMap.get(session.id);
            if (imPlatform) tags.push({ type: 'im', platform: imPlatform });
            if (cronSessionIds.has(session.id)) tags.push({ type: 'cron' });
            if (bgSessionIds.has(session.id)) tags.push({ type: 'background' });
            if (tags.length > 0) map.set(session.id, tags);
        }

        return map;
    }, [sessions, cronTasks, backgroundSessionIds, agentStatuses]);

    // Compute cron bot info map from agents[].channels[] (memoized)
    const cronBotInfoMap = useMemo(() => {
        const map = new Map<string, { name: string; platform: string }>();
        for (const agent of agents) {
            for (const channel of (agent.channels ?? [])) {
                map.set(channel.id, {
                    name: channel.name || agent.name,
                    platform: channel.type,
                });
            }
        }
        return map;
    }, [agents]);

    const refresh = useCallback((scope: TaskCenterRefreshScope = 'all', options: TaskCenterRefreshOptions = {}) => {
        if (!options.force && options.minIntervalMs) {
            const lastFetchedAt = lastFetchedAtRef.current[scope] ?? 0;
            if (Date.now() - lastFetchedAt < options.minIntervalMs) return;
        }
        if (scope === 'sessions') {
            refreshSessionsNow();
            return;
        }
        if (scope === 'cronTasks') {
            refreshCronTasksNow();
            return;
        }
        if (scope === 'backgroundSessions') {
            refreshBackgroundSessionsNow();
            return;
        }
        if (scope === 'agentStatuses') {
            refreshAgentStatusNow();
            return;
        }
        void fetchData(0, options.silent ?? false);
    }, [fetchData, refreshAgentStatusNow, refreshBackgroundSessionsNow, refreshCronTasksNow, refreshSessionsNow]);

    const actions = useMemo<TaskCenterActions>(() => ({
        deleteSession: async (sessionId: string) => {
            const success = await deleteSessionApi(sessionId);
            if (!success) return false;

            deletedSessionIdsRef.current.add(sessionId);
            setSessions(prev => prev.filter(s => s.id !== sessionId));

            try {
                await deactivateSession(sessionId);
            } catch (err) {
                console.warn('[useTaskCenterData] Failed to deactivate deleted session:', err);
            }

            refresh('sessions', { force: true, reason: 'delete-session', silent: true });
            return true;
        },
        refreshSessions: () => refresh('sessions', { force: true, silent: true }),
        refreshCronTasks: () => refresh('cronTasks', { force: true, silent: true }),
    }), [refresh]);

    return {
        sessions,
        cronTasks,
        sessionTagsMap,
        cronBotInfoMap,
        isLoading,
        error,
        refresh,
        actions,
    };
}
