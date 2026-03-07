import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Plus } from 'lucide-react';
import { track } from '@/analytics';
import { isTauriEnvironment } from '@/utils/browserMock';
import { useToast } from '@/components/Toast';
import { shortenPathForDisplay } from '@/utils/pathDetection';
import { getAllMcpServers, getEnabledMcpServerIds } from '@/config/configService';
import type { ImBotConfig, ImBotStatus } from '../../../shared/types/im';
import telegramIcon from './assets/telegram.png';
import feishuIcon from './assets/feishu.jpeg';
import dingtalkIcon from './assets/dingtalk.svg';

export default function ImBotList({
    configs,
    onAdd,
    onSelect,
}: {
    configs: ImBotConfig[];
    onAdd: () => void;
    onSelect: (botId: string) => void;
}) {
    const toast = useToast();
    const toastRef = useRef(toast);
    toastRef.current = toast;
    const isMountedRef = useRef(true);

    // Bot statuses: botId → status
    const [statuses, setStatuses] = useState<Record<string, ImBotStatus>>({});
    const [togglingIds, setTogglingIds] = useState<Set<string>>(new Set());
    const togglingIdsRef = useRef(togglingIds);
    togglingIdsRef.current = togglingIds;
    const statusesRef = useRef(statuses);
    statusesRef.current = statuses;

    useEffect(() => {
        return () => { isMountedRef.current = false; };
    }, []);

    // Poll all bot statuses
    const configsRef = useRef(configs);
    configsRef.current = configs;

    useEffect(() => {
        if (!isTauriEnvironment()) return;

        const fetchAllStatuses = async () => {
            try {
                const { invoke } = await import('@tauri-apps/api/core');
                const result = await invoke<Record<string, ImBotStatus>>('cmd_im_all_bots_status');
                if (isMountedRef.current) {
                    // Build a complete status map: bots in the poll result keep their
                    // status; bots NOT in the result are explicitly marked as stopped.
                    // This prevents the cfg.enabled fallback from kicking in after a
                    // stop (the fallback can be stale due to useConfig state isolation).
                    const stoppedDefault: ImBotStatus = {
                        status: 'stopped',
                        uptimeSeconds: 0,
                        activeSessions: [],
                        restartCount: 0,
                        bufferedMessages: 0,
                    };
                    const complete: Record<string, ImBotStatus> = {};
                    for (const cfg of configsRef.current) {
                        complete[cfg.id] = result[cfg.id] ?? stoppedDefault;
                    }

                    const toggling = togglingIdsRef.current;
                    if (toggling.size > 0) {
                        setStatuses(prev => {
                            const merged = { ...complete };
                            for (const id of toggling) {
                                if (prev[id]) merged[id] = prev[id];
                            }
                            return merged;
                        });
                    } else {
                        setStatuses(complete);
                    }
                }
            } catch {
                // Command not available
            }
        };

        fetchAllStatuses();
        const interval = setInterval(fetchAllStatuses, 5000);
        return () => clearInterval(interval);
    }, []);

    // Build start params — providerEnvJson is already persisted on disk by Rust,
    // so we read it directly from the config instead of rebuilding from React state.
    const buildStartParams = useCallback(async (cfg: ImBotConfig) => {
        const allServers = await getAllMcpServers();
        const globalEnabled = await getEnabledMcpServerIds();
        const botMcpIds = cfg.mcpEnabledServers ?? [];
        const enabledMcpDefs = allServers.filter(
            s => globalEnabled.includes(s.id) && botMcpIds.includes(s.id)
        );

        return {
            botId: cfg.id,
            botToken: cfg.botToken,
            allowedUsers: cfg.allowedUsers,
            permissionMode: cfg.permissionMode,
            workspacePath: cfg.defaultWorkspacePath || '',
            model: cfg.model || null,
            providerEnvJson: cfg.providerEnvJson || null,
            mcpServersJson: enabledMcpDefs.length > 0 ? JSON.stringify(enabledMcpDefs) : null,
            platform: cfg.platform,
            feishuAppId: cfg.feishuAppId || null,
            feishuAppSecret: cfg.feishuAppSecret || null,
            dingtalkClientId: cfg.dingtalkClientId || null,
            dingtalkClientSecret: cfg.dingtalkClientSecret || null,
            dingtalkUseAiCard: cfg.dingtalkUseAiCard ?? false,
            dingtalkCardTemplateId: cfg.dingtalkCardTemplateId || null,
            telegramUseDraft: cfg.telegramUseDraft ?? false,
            heartbeatConfigJson: cfg.heartbeat ? JSON.stringify(cfg.heartbeat) : null,
            botName: cfg.name || null,
        };
    }, []);

    // Toggle bot start/stop
    const toggleBot = useCallback(async (cfg: ImBotConfig) => {
        if (!isTauriEnvironment()) return;

        const botId = cfg.id;
        setTogglingIds(prev => new Set(prev).add(botId));

        try {
            const { invoke } = await import('@tauri-apps/api/core');
            // Read from ref to get latest status (avoids stale closure)
            const status = statusesRef.current[botId];
            const isRunning = status?.status === 'online' || status?.status === 'connecting';

            if (isRunning) {
                await invoke('cmd_stop_im_bot', { botId });
                if (isMountedRef.current) {
                    // Optimistic status update so button reflects change immediately
                    setStatuses(prev => {
                        const next = { ...prev };
                        if (next[botId]) {
                            next[botId] = { ...next[botId], status: 'stopped' as const };
                        }
                        return next;
                    });
                    track('im_bot_toggle', { platform: cfg.platform, enabled: false });
                    toastRef.current.success(`${cfg.name} 已停止`);
                    await invoke('cmd_update_im_bot_config', { botId, patch: { enabled: false } });
                }
            } else {
                const hasCredentials = cfg.platform === 'feishu'
                    ? (cfg.feishuAppId && cfg.feishuAppSecret)
                    : cfg.platform === 'dingtalk'
                        ? (cfg.dingtalkClientId && cfg.dingtalkClientSecret)
                        : cfg.botToken;
                if (!hasCredentials) {
                    toastRef.current.error(cfg.platform === 'telegram' ? '请先配置 Bot Token' : '请先配置应用凭证');
                    return;
                }
                const params = await buildStartParams(cfg);
                const newStatus = await invoke<ImBotStatus>('cmd_start_im_bot', params);
                if (isMountedRef.current) {
                    setStatuses(prev => ({ ...prev, [botId]: newStatus }));
                    track('im_bot_toggle', { platform: cfg.platform, enabled: true });
                    toastRef.current.success(`${cfg.name} 已启动`);
                    await invoke('cmd_update_im_bot_config', { botId, patch: { enabled: true } });
                }
            }
        } catch (err) {
            if (isMountedRef.current) {
                toastRef.current.error(`操作失败: ${err}`);
            }
        } finally {
            if (isMountedRef.current) {
                setTogglingIds(prev => {
                    const next = new Set(prev);
                    next.delete(botId);
                    return next;
                });
            }
        }
    }, [buildStartParams]);

    // Platform icon
    const platformIcon = (platform: string) => {
        if (platform === 'telegram') return <img src={telegramIcon} alt="Telegram" className="h-5 w-5" />;
        if (platform === 'feishu') return <img src={feishuIcon} alt="飞书" className="h-5 w-5 rounded" />;
        if (platform === 'dingtalk') return <img src={dingtalkIcon} alt="钉钉" className="h-5 w-5 rounded" />;
        return <span className="text-base">💬</span>;
    };

    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-lg font-semibold text-[var(--ink)]">聊天机器人 Bot</h2>
                    <p className="mt-1 text-sm text-[var(--ink-muted)]">
                        通过聊天机器人Bot远程使用 AI Agent
                    </p>
                </div>
                {configs.length > 0 && (
                    <button
                        onClick={onAdd}
                        className="flex items-center gap-2 rounded-lg bg-[var(--button-primary-bg)] px-4 py-2 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)]"
                    >
                        <Plus className="h-4 w-4" />
                        添加 Bot
                    </button>
                )}
            </div>

            {/* Bot cards */}
            {configs.length === 0 ? (
                <div className="flex flex-col items-center rounded-xl border border-dashed border-[var(--line)] px-8 py-16">
                    <div className="text-4xl">🤖</div>
                    <p className="mt-4 text-base font-medium text-[var(--ink)]">
                        还没有聊天机器人
                    </p>
                    <p className="mt-1.5 text-sm text-[var(--ink-muted)]">
                        添加一个 Bot，通过 Telegram 等聊天机器人远程使用 AI Agent
                    </p>
                    <button
                        onClick={onAdd}
                        className="mt-6 flex items-center gap-2 rounded-xl bg-[var(--button-primary-bg)] px-6 py-3 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)]"
                    >
                        <Plus className="h-5 w-5" />
                        添加 Bot
                    </button>
                </div>
            ) : (
                <div className="grid grid-cols-2 gap-3">
                    {configs.map((cfg) => {
                        const status = statuses[cfg.id];
                        // Use cfg.enabled as hint before first poll to avoid button color flash
                        const isRunning = status
                            ? (status.status === 'online' || status.status === 'connecting')
                            : cfg.enabled;
                        const isToggling = togglingIds.has(cfg.id);

                        const displayName = status?.botUsername
                            ? (cfg.platform === 'telegram' ? `@${status.botUsername}` : status.botUsername)
                            : cfg.name;

                        return (
                            <div
                                key={cfg.id}
                                onClick={() => onSelect(cfg.id)}
                                className="cursor-pointer rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-4 transition-all hover:border-[var(--line-strong)] hover:shadow-sm hover:translate-y-[-1px]"
                            >
                                {/* Top row: icon + name + status */}
                                <div className="flex items-start justify-between">
                                    <div className="flex items-center gap-2 min-w-0">
                                        <span className="flex-shrink-0">{platformIcon(cfg.platform)}</span>
                                        <span className="text-sm font-medium text-[var(--ink)] truncate">
                                            {displayName}
                                        </span>
                                    </div>
                                    <div className="flex items-center gap-1.5 flex-shrink-0">
                                        <div className={`h-1.5 w-1.5 rounded-full ${
                                            isRunning ? 'bg-[var(--success)]' : 'bg-[var(--ink-subtle)]'
                                        }`} />
                                        <span className={`text-xs ${
                                            isRunning ? 'text-[var(--success)]' : 'text-[var(--ink-muted)]'
                                        }`}>
                                            {isRunning ? '运行中' : '已停止'}
                                        </span>
                                    </div>
                                </div>

                                {/* Bottom row: workspace + toggle */}
                                <div className="mt-3 flex items-center justify-between text-xs text-[var(--ink-muted)]">
                                    <div className="flex items-center gap-1.5 min-w-0 truncate">
                                        {cfg.defaultWorkspacePath && (
                                            <span className="truncate">
                                                {shortenPathForDisplay(cfg.defaultWorkspacePath)}
                                            </span>
                                        )}
                                        {cfg.defaultWorkspacePath && <span>·</span>}
                                        <span className="flex-shrink-0">{cfg.platform === 'feishu' ? '飞书' : cfg.platform === 'dingtalk' ? '钉钉' : 'Telegram'}</span>
                                    </div>
                                    {/* Capsule toggle button */}
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            toggleBot(cfg);
                                        }}
                                        disabled={isToggling || (!(cfg.platform === 'feishu' ? (cfg.feishuAppId && cfg.feishuAppSecret) : cfg.platform === 'dingtalk' ? (cfg.dingtalkClientId && cfg.dingtalkClientSecret) : cfg.botToken) && !isRunning)}
                                        className={`flex-shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${
                                            isRunning
                                                ? 'border border-[var(--error)]/40 text-[var(--error)] hover:bg-[var(--error)]/10'
                                                : 'bg-[var(--button-primary-bg)] text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)]'
                                        }`}
                                    >
                                        {isToggling ? (
                                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        ) : isRunning ? (
                                            '停止'
                                        ) : (
                                            '启动'
                                        )}
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
