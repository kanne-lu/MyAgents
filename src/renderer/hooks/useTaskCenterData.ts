/**
 * useTaskCenterData - Shared hook for Task Center data fetching,
 * event listening, and tag computation.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getSessions, type SessionMetadata } from '@/api/sessionClient';
import { getAllCronTasks, getBackgroundSessions } from '@/api/cronTaskClient';
import { loadAppConfig } from '@/config/configService';
import { isTauriEnvironment } from '@/utils/browserMock';
import type { CronTask } from '@/types/cronTask';
import type { ImBotStatus, ImBotConfig } from '../../shared/types/im';

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
    refresh: () => void;
    removeSession: (sessionId: string) => void;
}

interface UseTaskCenterDataOptions {
    isActive?: boolean;
}

// Constants
const MAX_AUTO_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

export function useTaskCenterData({ isActive }: UseTaskCenterDataOptions): TaskCenterData {
    const [sessions, setSessions] = useState<SessionMetadata[]>([]);
    const [cronTasks, setCronTasks] = useState<CronTask[]>([]);
    const [backgroundSessionIds, setBackgroundSessionIds] = useState<string[]>([]);
    const [imBotStatuses, setImBotStatuses] = useState<Record<string, ImBotStatus>>({});
    const [imBotConfigs, setImBotConfigs] = useState<ImBotConfig[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const isMountedRef = useRef(true);
    const retryTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const sessionRefreshTimerRef = useRef<NodeJS.Timeout | null>(null);
    const imRefreshTimerRef = useRef<NodeJS.Timeout | null>(null);

    const fetchData = useCallback(async (retryCount = 0) => {
        if (retryCount === 0) setIsLoading(true);
        setError(null);

        try {
            const imStatusPromise = isTauriEnvironment()
                ? import('@tauri-apps/api/core')
                    .then(({ invoke }) => invoke<Record<string, ImBotStatus>>('cmd_im_all_bots_status'))
                    .catch(() => ({} as Record<string, ImBotStatus>))
                : Promise.resolve({} as Record<string, ImBotStatus>);

            const [sessionsData, tasksData, bgSessions, imStatuses, appConfig] = await Promise.all([
                getSessions(),
                getAllCronTasks().catch(() => [] as CronTask[]),
                getBackgroundSessions().catch(() => [] as string[]),
                imStatusPromise,
                loadAppConfig().catch(() => null),
            ]);

            if (!isMountedRef.current) return;

            // Sort sessions by lastActiveAt descending (spread to avoid mutating original)
            const sorted = [...sessionsData].sort(
                (a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime()
            );
            setSessions(sorted);
            setCronTasks(tasksData);
            setBackgroundSessionIds(bgSessions);
            setImBotStatuses(imStatuses);
            setImBotConfigs(appConfig?.imBotConfigs ?? []);
        } catch (err) {
            if (!isMountedRef.current) return;
            console.error('[useTaskCenterData] Failed to load data:', err);
            if (retryCount < MAX_AUTO_RETRIES) {
                retryTimeoutRef.current = setTimeout(() => {
                    void fetchData(retryCount + 1);
                }, RETRY_DELAY_MS);
            } else {
                setError('加载失败，请稍后重试');
            }
        } finally {
            if (isMountedRef.current) setIsLoading(false);
        }
    }, []);

    // Debounced session refresh (avoids API flooding on rapid events)
    const refreshSessionsDebounced = useCallback((delayMs = 500) => {
        if (sessionRefreshTimerRef.current) clearTimeout(sessionRefreshTimerRef.current);
        sessionRefreshTimerRef.current = setTimeout(() => {
            sessionRefreshTimerRef.current = null;
            getSessions().then(data => {
                if (!isMountedRef.current) return;
                const sorted = [...data].sort(
                    (a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime()
                );
                setSessions(sorted);
            }).catch(() => {});
        }, delayMs);
    }, []);

    // Debounced IM status refresh
    const refreshImStatusDebounced = useCallback((delayMs = 1000) => {
        if (imRefreshTimerRef.current) clearTimeout(imRefreshTimerRef.current);
        imRefreshTimerRef.current = setTimeout(() => {
            imRefreshTimerRef.current = null;
            if (!isTauriEnvironment()) return;
            import('@tauri-apps/api/core')
                .then(({ invoke }) => invoke<Record<string, ImBotStatus>>('cmd_im_all_bots_status'))
                .then(statuses => { if (isMountedRef.current) setImBotStatuses(statuses); })
                .catch(() => {});
        }, delayMs);
    }, []);

    // Initial fetch
    useEffect(() => {
        isMountedRef.current = true;
        void fetchData(0);
        return () => {
            isMountedRef.current = false;
            if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
            if (sessionRefreshTimerRef.current) clearTimeout(sessionRefreshTimerRef.current);
            if (imRefreshTimerRef.current) clearTimeout(imRefreshTimerRef.current);
        };
    }, [fetchData]);

    // Refresh on tab activation (inactive → active transition)
    const prevIsActiveRef = useRef(isActive);
    useEffect(() => {
        const wasInactive = !prevIsActiveRef.current;
        prevIsActiveRef.current = isActive;
        if (!wasInactive || !isActive) return;
        void fetchData(0);
    }, [isActive, fetchData]);

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
                getBackgroundSessions().then(ids => {
                    if (mounted) setBackgroundSessionIds(ids);
                }).catch(() => {});
                refreshSessionsDebounced();
            });
            unlisteners.push(u1);

            // Cron task events
            const u2 = await listen('cron:task-stopped', () => {
                if (!mounted) return;
                getAllCronTasks().then(tasks => {
                    if (mounted) setCronTasks(tasks);
                }).catch(() => {});
            });
            unlisteners.push(u2);

            const u2b = await listen('cron:task-started', () => {
                if (!mounted) return;
                getAllCronTasks().then(tasks => {
                    if (mounted) setCronTasks(tasks);
                }).catch(() => {});
            });
            unlisteners.push(u2b);

            const u3 = await listen('cron:execution-complete', () => {
                if (!mounted) return;
                getAllCronTasks().then(tasks => {
                    if (mounted) setCronTasks(tasks);
                }).catch(() => {});
                refreshSessionsDebounced();
            });
            unlisteners.push(u3);

            // Scheduler started (resume / recovery)
            const u4 = await listen('cron:scheduler-started', () => {
                if (!mounted) return;
                getAllCronTasks().then(tasks => {
                    if (mounted) setCronTasks(tasks);
                }).catch(() => {});
                refreshSessionsDebounced();
            });
            unlisteners.push(u4);

            // Task deleted
            const u5 = await listen('cron:task-deleted', () => {
                if (!mounted) return;
                getAllCronTasks().then(tasks => {
                    if (mounted) setCronTasks(tasks);
                }).catch(() => {});
            });
            unlisteners.push(u5);

            // IM status changes (bot online/offline, session created)
            const u6 = await listen('im:status-changed', () => {
                if (!mounted) return;
                refreshImStatusDebounced();
                refreshSessionsDebounced(1000);
            });
            unlisteners.push(u6);
        })();

        return () => {
            mounted = false;
            unlisteners.forEach(fn => fn());
            if (sessionRefreshTimerRef.current) clearTimeout(sessionRefreshTimerRef.current);
            if (imRefreshTimerRef.current) clearTimeout(imRefreshTimerRef.current);
        };
    }, [refreshSessionsDebounced, refreshImStatusDebounced]);

    // Compute session tags (memoized)
    const sessionTagsMap = useMemo(() => {
        const map = new Map<string, SessionTag[]>();

        // Build IM session map: sessionId → platform
        const imSessionPlatformMap = new Map<string, string>();
        for (const status of Object.values(imBotStatuses)) {
            if (status.status !== 'online' && status.status !== 'connecting') continue;
            for (const activeSession of status.activeSessions) {
                const parts = activeSession.sessionKey.split(':');
                const platform = parts[1] ?? 'unknown';
                const displayName = platform.charAt(0).toUpperCase() + platform.slice(1);
                imSessionPlatformMap.set(activeSession.sessionId, displayName);
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
    }, [sessions, cronTasks, backgroundSessionIds, imBotStatuses]);

    // Compute cron bot info map (memoized)
    const cronBotInfoMap = useMemo(() => {
        const map = new Map<string, { name: string; platform: string }>();
        for (const botConfig of imBotConfigs) {
            map.set(botConfig.id, { name: botConfig.name, platform: botConfig.platform });
        }
        return map;
    }, [imBotConfigs]);

    const refresh = useCallback(() => {
        void fetchData(0);
    }, [fetchData]);

    const removeSession = useCallback((sessionId: string) => {
        setSessions(prev => prev.filter(s => s.id !== sessionId));
    }, []);

    return {
        sessions,
        cronTasks,
        sessionTagsMap,
        cronBotInfoMap,
        isLoading,
        error,
        refresh,
        removeSession,
    };
}
