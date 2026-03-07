import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ChevronDown, FolderOpen, Loader2, Plus, Power, PowerOff, Trash2 } from 'lucide-react';
import { track } from '@/analytics';
import ConfirmDialog from '@/components/ConfirmDialog';
import { isTauriEnvironment } from '@/utils/browserMock';
import { useToast } from '@/components/Toast';
import { useConfig } from '@/hooks/useConfig';
import { shortenPathForDisplay } from '@/utils/pathDetection';
import { getAllMcpServers, getEnabledMcpServerIds } from '@/config/configService';
import { getProviderModels, type McpServerDefinition } from '@/config/types';
import CustomSelect from '@/components/CustomSelect';
import BotTokenInput from './components/BotTokenInput';
import FeishuCredentialInput from './components/FeishuCredentialInput';
import DingtalkCredentialInput from './components/DingtalkCredentialInput';
import WhitelistManager from './components/WhitelistManager';
import PermissionModeSelect from './components/PermissionModeSelect';
import BotStatusPanel from './components/BotStatusPanel';
import BindQrPanel from './components/BindQrPanel';
import BindCodePanel from './components/BindCodePanel';
import AiConfigCard from './components/AiConfigCard';
import McpToolsCard from './components/McpToolsCard';
import HeartbeatConfigCard from './components/HeartbeatConfigCard';
import DingtalkCardConfig from './components/DingtalkCardConfig';
import GroupPermissionList from './components/GroupPermissionList';
import type { ImBotConfig, ImBotStatus, GroupActivation } from '../../../shared/types/im';

export default function ImBotDetail({
    botId,
    onBack,
}: {
    botId: string;
    onBack: () => void;
}) {
    const { config, providers, apiKeys, projects, addProject, refreshConfig: _refreshConfig } = useConfig();
    const toast = useToast();
    const toastRef = useRef(toast);
    toastRef.current = toast;
    const isMountedRef = useRef(true);
    const nameSyncedRef = useRef(false);

    // Find bot config from app config
    const botConfig = useMemo(
        () => (config.imBotConfigs ?? []).find(c => c.id === botId),
        [config.imBotConfigs, botId],
    );

    // MCP state
    const [mcpServers, setMcpServers] = useState<McpServerDefinition[]>([]);
    const [globalMcpEnabled, setGlobalMcpEnabled] = useState<string[]>([]);

    // Bot runtime status
    const [botStatus, setBotStatus] = useState<ImBotStatus | null>(null);
    const [verifyStatus, setVerifyStatus] = useState<'idle' | 'verifying' | 'valid' | 'invalid'>('idle');
    const [botUsername, setBotUsername] = useState<string | undefined>();
    const [toggling, setToggling] = useState(false);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [credentialsExpanded, setCredentialsExpanded] = useState<boolean | null>(null);
    const [bindingExpanded, setBindingExpanded] = useState<boolean | null>(null);
    const [groupsExpanded, setGroupsExpanded] = useState<boolean | null>(null);

    // Whether credentials are filled
    const hasCredentials = botConfig
        ? botConfig.platform === 'feishu'
            ? !!(botConfig.feishuAppId && botConfig.feishuAppSecret)
            : botConfig.platform === 'dingtalk'
                ? !!(botConfig.dingtalkClientId && botConfig.dingtalkClientSecret)
                : !!botConfig.botToken
        : false;
    const hasUsers = (botConfig?.allowedUsers.length ?? 0) > 0;

    // Auto-collapse: default collapsed when filled, expanded when empty
    const isCredentialsExpanded = credentialsExpanded ?? !hasCredentials;
    const isBindingExpanded = bindingExpanded ?? !hasUsers;

    useEffect(() => {
        return () => { isMountedRef.current = false; };
    }, []);

    // Invoke Rust to update bot config (persists + pushes to Sidecar + emits event)
    const invokePatch = useCallback(async (patch: Record<string, unknown>) => {
        if (!isTauriEnvironment()) return;
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('cmd_update_im_bot_config', { botId, patch });
    }, [botId]);

    // Ref for bot config (used in effects without re-triggering)
    const botConfigRef = useRef(botConfig);
    botConfigRef.current = botConfig;

    // Poll bot status (skip while toggling to avoid overwriting optimistic update)
    const togglingRef = useRef(toggling);
    togglingRef.current = toggling;

    useEffect(() => {
        if (!isTauriEnvironment()) return;

        const fetchStatus = async () => {
            if (togglingRef.current) return; // Skip poll during toggle
            try {
                const { invoke } = await import('@tauri-apps/api/core');
                const status = await invoke<ImBotStatus>('cmd_im_bot_status', { botId });
                if (isMountedRef.current && !togglingRef.current) {
                    setBotStatus(status);
                    if (status.botUsername) {
                        setBotUsername(status.botUsername);
                        setVerifyStatus('valid');
                        // Auto-sync bot name from platform username (once, skip during toggle)
                        if (!nameSyncedRef.current && !togglingRef.current) {
                            nameSyncedRef.current = true;
                            // Telegram uses @username, Feishu uses plain app name
                            const platform = botConfigRef.current?.platform;
                            const displayName = platform === 'telegram'
                                ? `@${status.botUsername}`
                                : status.botUsername;
                            if (botConfigRef.current?.name !== displayName) {
                                import('@tauri-apps/api/core').then(({ invoke }) =>
                                    invoke('cmd_update_im_bot_config', { botId, patch: { name: displayName } })
                                ).catch(err => {
                                    console.error('[ImBotDetail] Failed to sync bot name:', err);
                                });
                            }
                        }
                    }
                }
            } catch {
                if (isMountedRef.current && !togglingRef.current) setBotStatus(null);
            }
        };

        fetchStatus();
        const interval = setInterval(fetchStatus, 5000);
        return () => clearInterval(interval);
    }, [botId]);

    // Load MCP servers
    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const servers = await getAllMcpServers();
                const enabledIds = await getEnabledMcpServerIds();
                if (!cancelled) {
                    setMcpServers(servers);
                    setGlobalMcpEnabled(enabledIds);
                }
            } catch (err) {
                console.error('[ImBotDetail] Failed to load MCP servers:', err);
            }
        })();
        return () => { cancelled = true; };
    }, []);

    // Listen for user-bound events — Rust already persists to config.json,
    // so we just refresh React state from disk and show a toast.
    useEffect(() => {
        if (!isTauriEnvironment()) return;
        let cancelled = false;
        let unlisten: (() => void) | undefined;

        import('@tauri-apps/api/event').then(({ listen }) => {
            if (cancelled) return;
            listen<{ botId: string; userId: string; username?: string }>('im:user-bound', (event) => {
                if (!isMountedRef.current || event.payload.botId !== botId) return;
                const { userId, username } = event.payload;
                const displayName = username || userId;

                toastRef.current.success(`用户 ${displayName} 已通过二维码绑定`);
                // Config refresh handled by im:bot-config-changed listener
            }).then(fn => {
                if (cancelled) fn();
                else unlisten = fn;
            });
        });

        return () => {
            cancelled = true;
            unlisten?.();
        };
    }, [botId]); // refreshConfig not used in this effect; config refresh handled by im:bot-config-changed listener

    // im:bot-config-changed listener moved to ConfigProvider (shared state auto-updates)

    // Listen for group permission changes (new group added/removed) — show toast
    useEffect(() => {
        if (!isTauriEnvironment()) return;
        let cancelled = false;
        let unlisten: (() => void) | undefined;
        import('@tauri-apps/api/event').then(({ listen }) => {
            if (cancelled) return;
            listen<{ botId: string; event: string; groupName?: string }>('im:group-permission-changed', (ev) => {
                if (!isMountedRef.current || ev.payload.botId !== botId) return;
                if (ev.payload.event === 'added') {
                    toastRef.current.info(`群聊「${ev.payload.groupName ?? ''}」待审核`);
                }
            }).then(fn => {
                if (cancelled) fn();
                else unlisten = fn;
            });
        });
        return () => { cancelled = true; unlisten?.(); };
    }, [botId]);

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

    // Toggle bot
    const botStatusRef = useRef(botStatus);
    botStatusRef.current = botStatus;

    const toggleBot = useCallback(async () => {
        if (!isTauriEnvironment() || !botConfigRef.current) return;

        setToggling(true);
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            // Read from refs to get latest state (avoids stale closure)
            const isRunning = botStatusRef.current?.status === 'online' || botStatusRef.current?.status === 'connecting';

            if (isRunning) {
                await invoke('cmd_stop_im_bot', { botId });
                if (isMountedRef.current) {
                    track('im_bot_toggle', { platform: botConfigRef.current.platform, enabled: false });
                    toastRef.current.success('Bot 已停止');
                    setBotStatus(null);
                    await invokePatch({ enabled: false });
                }
            } else {
                const cfg = botConfigRef.current;
                const hasCredentials = cfg.platform === 'feishu'
                    ? (cfg.feishuAppId && cfg.feishuAppSecret)
                    : cfg.platform === 'dingtalk'
                        ? (cfg.dingtalkClientId && cfg.dingtalkClientSecret)
                        : cfg.botToken;
                if (!hasCredentials) {
                    toastRef.current.error(cfg.platform === 'telegram' ? '请先配置 Bot Token' : '请先配置应用凭证');
                    setToggling(false);
                    return;
                }
                const params = await buildStartParams(botConfigRef.current);
                await invoke('cmd_start_im_bot', params);
                if (isMountedRef.current) {
                    track('im_bot_toggle', { platform: botConfigRef.current.platform, enabled: true });
                    toastRef.current.success('Bot 已启动');
                    await invokePatch({ enabled: true });
                }
            }
        } catch (err) {
            if (isMountedRef.current) {
                toastRef.current.error(`操作失败: ${err}`);
            }
        } finally {
            if (isMountedRef.current) setToggling(false);
        }
    }, [botId, buildStartParams, invokePatch]);

    // Delete bot (called after ConfirmDialog confirmation)
    const executeDelete = useCallback(async () => {
        setDeleting(true);
        try {
            if (isTauriEnvironment()) {
                const { invoke } = await import('@tauri-apps/api/core');
                // Rust cmd_remove_im_bot_config stops the bot, removes from config, emits event
                await invoke('cmd_remove_im_bot_config', { botId });
            }
            track('im_bot_remove', { platform: botConfigRef.current?.platform ?? 'unknown' });
            toastRef.current.success('Bot 已删除');
            onBack();
        } catch (err) {
            if (isMountedRef.current) {
                toastRef.current.error(`删除失败: ${err}`);
                setDeleting(false);
                setShowDeleteConfirm(false);
            }
        }
    }, [botId, onBack]);

    // Computed values
    const availableMcpServers = useMemo(
        () => mcpServers.filter(s => globalMcpEnabled.includes(s.id)),
        [mcpServers, globalMcpEnabled],
    );

    const providerOptions = useMemo(() => {
        const options = [{ value: '', label: '默认 (Anthropic 订阅)' }];
        for (const p of providers) {
            if (p.type === 'subscription') continue;
            if (p.type === 'api' && apiKeys[p.id]) {
                options.push({ value: p.id, label: p.name });
            }
        }
        return options;
    }, [providers, apiKeys]);

    const selectedProvider = useMemo(
        () => providers.find(p => p.id === (botConfig?.providerId || 'anthropic-sub')),
        [providers, botConfig?.providerId],
    );

    const modelOptions = useMemo(() => {
        if (!selectedProvider) return [];
        return getProviderModels(selectedProvider).map(m => ({
            value: m.model,
            label: m.modelName,
        }));
    }, [selectedProvider]);

    // Default to provider's primaryModel (or first model) when not explicitly set
    const effectiveModel = useMemo(() => {
        if (botConfig?.model) return botConfig.model;
        if (selectedProvider?.primaryModel) return selectedProvider.primaryModel;
        if (modelOptions.length > 0) return modelOptions[0].value;
        return '';
    }, [botConfig?.model, selectedProvider?.primaryModel, modelOptions]);

    const handleWorkspaceChange = useCallback(async (path: string) => {
        if (!path) return;
        await invokePatch({ defaultWorkspacePath: path });
    }, [invokePatch]);

    if (!botConfig) {
        return (
            <div className="text-center py-12">
                <p className="text-sm text-[var(--ink-muted)]">Bot 配置未找到</p>
                <button onClick={onBack} className="mt-4 text-sm text-[var(--button-primary-bg)] hover:underline">
                    返回列表
                </button>
            </div>
        );
    }

    const isRunning = botStatus?.status === 'online' || botStatus?.status === 'connecting';

    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <button
                        onClick={onBack}
                        className="rounded-lg p-2 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                    >
                        <ArrowLeft className="h-4 w-4" />
                    </button>
                    <h2 className="text-lg font-semibold text-[var(--ink)]">{botUsername ? (botConfig.platform === 'telegram' ? `@${botUsername}` : botUsername) : botConfig.name}</h2>
                </div>
                <button
                    onClick={toggleBot}
                    disabled={toggling || (!(botConfig.platform === 'feishu' ? (botConfig.feishuAppId && botConfig.feishuAppSecret) : botConfig.platform === 'dingtalk' ? (botConfig.dingtalkClientId && botConfig.dingtalkClientSecret) : botConfig.botToken) && !isRunning)}
                    className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                        isRunning
                            ? 'bg-[var(--error-bg)] text-[var(--error)] hover:brightness-95'
                            : 'bg-[var(--button-primary-bg)] text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)]'
                    } disabled:opacity-50`}
                >
                    {toggling ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                    ) : isRunning ? (
                        <PowerOff className="h-4 w-4" />
                    ) : (
                        <Power className="h-4 w-4" />
                    )}
                    {isRunning ? '停止 Bot' : '启动 Bot'}
                </button>
            </div>

            {/* Bot Status */}
            <BotStatusPanel status={botStatus} />

            {/* Platform credentials */}
            <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)]">
                <button
                    type="button"
                    onClick={() => setCredentialsExpanded(!isCredentialsExpanded)}
                    className="flex w-full items-center justify-between p-5"
                >
                    <div className="flex items-center gap-2">
                        <h3 className="text-sm font-semibold text-[var(--ink)]">
                            {botConfig.platform === 'feishu' ? '飞书应用凭证' : botConfig.platform === 'dingtalk' ? '钉钉应用凭证' : 'Telegram Bot'}
                        </h3>
                        {!isCredentialsExpanded && hasCredentials && (
                            <span className="text-xs text-[var(--success)]">
                                {botUsername ? `已验证: ${botUsername}` : '已配置'}
                            </span>
                        )}
                    </div>
                    <ChevronDown className={`h-4 w-4 text-[var(--ink-muted)] transition-transform ${isCredentialsExpanded ? '' : '-rotate-90'}`} />
                </button>
                {isCredentialsExpanded && (
                    <div className="px-5 pb-5">
                        {botConfig.platform === 'dingtalk' ? (
                            <DingtalkCredentialInput
                                clientId={botConfig.dingtalkClientId ?? ''}
                                clientSecret={botConfig.dingtalkClientSecret ?? ''}
                                onClientIdChange={(clientId) => {
                                    const others = (config.imBotConfigs ?? []).filter(b => b.id !== botId && b.setupCompleted);
                                    if (others.some(b => b.dingtalkClientId === clientId)) {
                                        toastRef.current.error('该钉钉应用凭证已被其他 Bot 使用');
                                        return;
                                    }
                                    invokePatch({ dingtalkClientId: clientId });
                                }}
                                onClientSecretChange={(clientSecret) => invokePatch({ dingtalkClientSecret: clientSecret })}
                                verifyStatus={verifyStatus}
                                botName={botUsername}
                            />
                        ) : botConfig.platform === 'feishu' ? (
                            <FeishuCredentialInput
                                appId={botConfig.feishuAppId ?? ''}
                                appSecret={botConfig.feishuAppSecret ?? ''}
                                onAppIdChange={(appId) => {
                                    const others = (config.imBotConfigs ?? []).filter(b => b.id !== botId && b.setupCompleted);
                                    if (others.some(b => b.feishuAppId === appId)) {
                                        toastRef.current.error('该飞书应用凭证已被其他 Bot 使用');
                                        return;
                                    }
                                    invokePatch({ feishuAppId: appId });
                                }}
                                onAppSecretChange={(appSecret) => invokePatch({ feishuAppSecret: appSecret })}
                                verifyStatus={verifyStatus}
                                botName={botUsername}
                            />
                        ) : (
                            <BotTokenInput
                                value={botConfig.botToken}
                                onChange={(token) => {
                                    const others = (config.imBotConfigs ?? []).filter(b => b.id !== botId && b.setupCompleted);
                                    if (others.some(b => b.botToken === token)) {
                                        toastRef.current.error('该 Bot Token 已被其他 Bot 使用');
                                        return;
                                    }
                                    invokePatch({ botToken: token });
                                }}
                                verifyStatus={verifyStatus}
                                botUsername={botUsername}
                            />
                        )}
                    </div>
                )}
            </div>

            {/* User binding */}
            <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)]">
                <button
                    type="button"
                    onClick={() => setBindingExpanded(!isBindingExpanded)}
                    className="flex w-full items-center justify-between p-5"
                >
                    <div className="flex items-center gap-2">
                        <h3 className="text-sm font-semibold text-[var(--ink)]">用户绑定</h3>
                        {!isBindingExpanded && hasUsers && (
                            <span className="text-xs text-[var(--ink-muted)]">
                                {botConfig.allowedUsers.length} 个用户
                            </span>
                        )}
                    </div>
                    <ChevronDown className={`h-4 w-4 text-[var(--ink-muted)] transition-transform ${isBindingExpanded ? '' : '-rotate-90'}`} />
                </button>
                {isBindingExpanded && (
                    <div className="space-y-5 px-5 pb-5">
                        {isRunning && (botConfig.platform === 'feishu' || botConfig.platform === 'dingtalk') && botStatus?.bindCode && (
                            <BindCodePanel
                                bindCode={botStatus.bindCode}
                                hasWhitelistUsers={botConfig.allowedUsers.length > 0}
                                platformName={botConfig.platform === 'dingtalk' ? '钉钉' : '飞书'}
                            />
                        )}
                        {isRunning && botConfig.platform === 'telegram' && botStatus?.bindUrl && (
                            <BindQrPanel
                                bindUrl={botStatus.bindUrl}
                                hasWhitelistUsers={botConfig.allowedUsers.length > 0}
                            />
                        )}
                        <WhitelistManager
                            users={botConfig.allowedUsers}
                            onChange={async (users) => {
                                await invokePatch({ allowedUsers: users });
                            }}
                            platform={botConfig.platform}
                        />
                    </div>
                )}
            </div>

            {/* Group Permissions (v0.1.28) */}
            {(() => {
                const groupPerms = botConfig.groupPermissions ?? [];
                const hasGroups = groupPerms.length > 0;
                const pendingCount = groupPerms.filter(g => g.status === 'pending').length;
                const approvedCount = groupPerms.filter(g => g.status === 'approved').length;
                // Auto-expand when there are pending groups, collapse when empty
                const isGroupsExpanded = groupsExpanded ?? (pendingCount > 0 || hasGroups);
                return (
                    <div className="overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)]">
                        <button
                            type="button"
                            onClick={() => setGroupsExpanded(!isGroupsExpanded)}
                            className="flex w-full items-center justify-between p-5"
                        >
                            <div className="flex items-center gap-2">
                                <h3 className="text-sm font-semibold text-[var(--ink)]">群聊管理</h3>
                                {!isGroupsExpanded && hasGroups && (
                                    <span className="text-xs text-[var(--ink-muted)]">
                                        {approvedCount > 0 && `${approvedCount} 个群聊`}
                                        {pendingCount > 0 && approvedCount > 0 && '，'}
                                        {pendingCount > 0 && `${pendingCount} 个待审核`}
                                    </span>
                                )}
                                {pendingCount > 0 && (
                                    <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--warning)] px-1.5 text-[10px] font-bold text-white">
                                        {pendingCount}
                                    </span>
                                )}
                            </div>
                            <ChevronDown className={`h-4 w-4 text-[var(--ink-muted)] transition-transform ${isGroupsExpanded ? '' : '-rotate-90'}`} />
                        </button>
                        {isGroupsExpanded && (
                            <div className="space-y-4 px-5 pb-5">
                                {/* Group activation mode */}
                                <div className="flex items-center justify-between">
                                    <div>
                                        <p className="text-sm font-medium text-[var(--ink)]">群聊触发方式</p>
                                        <p className="text-xs text-[var(--ink-muted)]">
                                            {(botConfig.groupActivation ?? 'mention') === 'mention'
                                                ? '仅在 @Bot 或回复 Bot 时响应'
                                                : '收到所有群消息，AI 自行判断是否回复'}
                                        </p>
                                    </div>
                                    <div className="flex rounded-lg bg-[var(--paper-inset)] p-0.5">
                                        {(['mention', 'always'] as GroupActivation[]).map(mode => (
                                            <button
                                                key={mode}
                                                onClick={async () => {
                                                    await invokePatch({ groupActivation: mode });
                                                }}
                                                className={`rounded-md px-3 py-1 text-xs font-medium transition-all ${
                                                    (botConfig.groupActivation ?? 'mention') === mode
                                                        ? 'bg-[var(--accent)] text-white'
                                                        : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'
                                                }`}
                                            >
                                                {mode === 'mention' ? '@提及' : '全部消息'}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                                {/* Group list */}
                                <GroupPermissionList
                                    permissions={groupPerms}
                                    onApprove={async (groupId) => {
                                        if (!isTauriEnvironment()) return;
                                        const { invoke } = await import('@tauri-apps/api/core');
                                        await invoke('cmd_approve_group', { botId, groupId });
                                    }}
                                    onReject={async (groupId) => {
                                        if (!isTauriEnvironment()) return;
                                        const { invoke } = await import('@tauri-apps/api/core');
                                        await invoke('cmd_reject_group', { botId, groupId });
                                    }}
                                    onRemove={async (groupId) => {
                                        if (!isTauriEnvironment()) return;
                                        const { invoke } = await import('@tauri-apps/api/core');
                                        await invoke('cmd_remove_group', { botId, groupId });
                                    }}
                                />
                            </div>
                        )}
                    </div>
                );
            })()}

            {/* Default Workspace */}
            <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                <div className="flex items-center justify-between">
                    <div className="flex-1 pr-4">
                        <p className="text-sm font-medium text-[var(--ink)]">Bot 默认工作区</p>
                        <p className="text-xs text-[var(--ink-muted)]">
                            新对话默认关联的工作区，可通过 <code className="rounded bg-[var(--paper-inset)] px-1 py-0.5 text-[10px]">/workspace</code> 命令切换
                        </p>
                    </div>
                    <CustomSelect
                        value={botConfig.defaultWorkspacePath ?? ''}
                        options={projects.map(p => ({
                            value: p.path,
                            label: shortenPathForDisplay(p.path),
                            icon: <FolderOpen className="h-3.5 w-3.5" />,
                        }))}
                        onChange={handleWorkspaceChange}
                        placeholder="选择工作区"
                        triggerIcon={<FolderOpen className="h-3.5 w-3.5" />}
                        className="w-[240px]"
                        footerAction={{
                            label: '选择文件夹...',
                            icon: <Plus className="h-3.5 w-3.5" />,
                            onClick: async () => {
                                const { open } = await import('@tauri-apps/plugin-dialog');
                                const selected = await open({ directory: true, multiple: false, title: '选择 Bot 工作区' });
                                if (selected && typeof selected === 'string') {
                                    if (!projects.find(p => p.path === selected)) {
                                        await addProject(selected);
                                    }
                                    handleWorkspaceChange(selected);
                                }
                            },
                        }}
                    />
                </div>
            </div>

            {/* Permission mode */}
            <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                <h3 className="mb-4 text-sm font-semibold text-[var(--ink)]">权限模式</h3>
                <PermissionModeSelect
                    value={botConfig.permissionMode}
                    onChange={async (mode) => {
                        await invokePatch({ permissionMode: mode });
                    }}
                />
            </div>

            {/* AI Configuration */}
            <AiConfigCard
                providerId={botConfig.providerId ?? ''}
                model={effectiveModel}
                providerOptions={providerOptions}
                modelOptions={modelOptions}
                onProviderChange={async (providerId) => {
                    const provider = providers.find(p => p.id === providerId);
                    const newModel = provider ? provider.primaryModel : undefined;
                    let providerEnvJson: string | undefined;
                    if (provider && provider.type !== 'subscription') {
                        providerEnvJson = JSON.stringify({
                            baseUrl: provider.config.baseUrl,
                            apiKey: apiKeys[provider.id],
                            authType: provider.authType,
                            apiProtocol: provider.apiProtocol,
                        });
                    }
                    await invokePatch({
                        providerId: providerId || undefined,
                        model: newModel,
                        providerEnvJson,
                    });
                }}
                onModelChange={async (model) => {
                    await invokePatch({ model: model || undefined });
                }}
            />

            {/* MCP Tools */}
            <McpToolsCard
                availableMcpServers={availableMcpServers}
                enabledServerIds={botConfig.mcpEnabledServers ?? []}
                onToggle={async (serverId) => {
                    const current = botConfig.mcpEnabledServers ?? [];
                    const updated = current.includes(serverId)
                        ? current.filter(id => id !== serverId)
                        : [...current, serverId];
                    const enabledDefs = mcpServers.filter(
                        s => globalMcpEnabled.includes(s.id) && updated.includes(s.id)
                    );
                    await invokePatch({
                        mcpEnabledServers: updated,
                        mcpServersJson: enabledDefs.length > 0 ? JSON.stringify(enabledDefs) : '',
                    });
                }}
            />

            {/* DingTalk AI Card Config */}
            {botConfig.platform === 'dingtalk' && (
                <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                    <DingtalkCardConfig
                        useAiCard={botConfig.dingtalkUseAiCard ?? false}
                        cardTemplateId={botConfig.dingtalkCardTemplateId ?? ''}
                        onUseAiCardChange={async (value) => {
                            await invokePatch({ dingtalkUseAiCard: value });
                        }}
                        onCardTemplateIdChange={async (value) => {
                            await invokePatch({ dingtalkCardTemplateId: value || undefined });
                        }}
                    />
                </div>
            )}

            {/* Telegram Draft Streaming (experimental) */}
            {botConfig.platform === 'telegram' && (
                <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                    <div className="flex items-center justify-between">
                        <div>
                            <p className="text-sm font-medium text-[var(--ink)]">Draft 流式模式</p>
                            <p className="text-xs text-[var(--ink-muted)] mt-0.5">
                                使用 sendMessageDraft 实现打字机效果，默认开启。如果消息加载异常可以关闭此选项，修改后需重启 Bot 生效。
                            </p>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={botConfig.telegramUseDraft ?? true}
                            onClick={async () => {
                                await invokePatch({ telegramUseDraft: !(botConfig.telegramUseDraft ?? true) });
                            }}
                            className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                                (botConfig.telegramUseDraft ?? true) ? 'bg-[var(--accent)]' : 'bg-[var(--ink-muted)]/30'
                            }`}
                        >
                            <span
                                className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                                    (botConfig.telegramUseDraft ?? true) ? 'translate-x-4' : 'translate-x-0'
                                }`}
                            />
                        </button>
                    </div>
                </div>
            )}

            {/* Heartbeat Config */}
            <HeartbeatConfigCard
                heartbeat={botConfig.heartbeat}
                onChange={async (hb) => {
                    await invokePatch({ heartbeatConfigJson: hb ? JSON.stringify(hb) : undefined });
                }}
            />

            {/* Danger zone */}
            <div className="rounded-xl border border-[var(--error)]/20 bg-[var(--error-bg)]/50 p-5">
                <h3 className="mb-3 text-sm font-semibold text-[var(--error)]">危险操作</h3>
                <button
                    onClick={() => setShowDeleteConfirm(true)}
                    className="flex items-center gap-2 rounded-lg bg-[var(--error-bg)] px-4 py-2 text-sm font-medium text-[var(--error)] transition-colors hover:brightness-95"
                >
                    <Trash2 className="h-4 w-4" />
                    删除 Bot
                </button>
            </div>

            {/* Delete confirmation dialog */}
            {showDeleteConfirm && (
                <ConfirmDialog
                    title="删除 Bot"
                    message="确定要删除此 Bot 吗？此操作不可撤销。"
                    confirmText="删除"
                    cancelText="取消"
                    confirmVariant="danger"
                    loading={deleting}
                    onConfirm={executeDelete}
                    onCancel={() => setShowDeleteConfirm(false)}
                />
            )}
        </div>
    );
}
