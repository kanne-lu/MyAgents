import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, FolderOpen, Loader2, Package } from 'lucide-react';
import { track } from '@/analytics';
import { isTauriEnvironment } from '@/utils/browserMock';
import { useToast } from '@/components/Toast';
import { useConfig } from '@/hooks/useConfig';
import { addProject } from '@/config/configService';
import { shortenPathForDisplay } from '@/utils/pathDetection';
import CustomSelect from '@/components/CustomSelect';
import type { ImBotConfig, ImBotStatus, ImPlatform } from '../../../shared/types/im';

export default function OpenClawWizard({
    onComplete,
    onCancel,
}: {
    onComplete: (botId: string) => void;
    onCancel: () => void;
}) {
    const toast = useToast();
    const toastRef = useRef(toast);
    toastRef.current = toast;
    const { projects, refreshConfig } = useConfig();
    const isMountedRef = useRef(true);

    // Step 1: Install plugin
    // Step 2: Configure plugin (simple key-value)
    // Step 3: Select workspace
    // Step 4: Start bot
    const [step, setStep] = useState(1);

    // Step 1 state
    const [npmSpec, setNpmSpec] = useState('');
    const [installing, setInstalling] = useState(false);
    const [pluginInfo, setPluginInfo] = useState<{
        pluginId: string;
        installDir: string;
        manifest: { name?: string; description?: string; version?: string };
    } | null>(null);

    // Step 2 state
    const [pluginConfig, setPluginConfig] = useState<Record<string, string>>({});

    // Step 3 state
    const [workspaceChoice, setWorkspaceChoice] = useState<'existing' | 'new'>('existing');
    const [selectedExistingPath, setSelectedExistingPath] = useState('');
    const [creatingWorkspace, setCreatingWorkspace] = useState(false);

    // Step 4 state
    const [starting, setStarting] = useState(false);

    const botId = useRef(crypto.randomUUID()).current;

    useEffect(() => {
        return () => { isMountedRef.current = false; };
    }, []);

    // Initialize workspace selection
    useEffect(() => {
        if (projects.length > 0 && !selectedExistingPath) {
            const mino = projects.find(p => p.path.replace(/\\/g, '/').endsWith('/mino'));
            setSelectedExistingPath(mino?.path || projects[0]?.path || '');
        }
    }, [projects, selectedExistingPath]);

    const handleInstall = useCallback(async () => {
        if (!npmSpec.trim()) {
            toastRef.current.error('请输入 npm 包名');
            return;
        }

        setInstalling(true);
        try {
            if (isTauriEnvironment()) {
                const { invoke } = await import('@tauri-apps/api/core');
                const result = await invoke<{ pluginId: string; installDir: string; manifest: { name?: string; description?: string; version?: string } }>('cmd_install_openclaw_plugin', {
                    npmSpec: npmSpec.trim(),
                });
                if (isMountedRef.current) {
                    setPluginInfo(result);
                    track('openclaw_plugin_installed', { npmSpec: npmSpec.trim() });
                    setStep(2);
                }
            }
        } catch (err) {
            if (isMountedRef.current) {
                toastRef.current.error(`安装失败: ${err}`);
            }
        } finally {
            if (isMountedRef.current) {
                setInstalling(false);
            }
        }
    }, [npmSpec]);

    const handleSelectWorkspace = useCallback(async () => {
        if (workspaceChoice === 'new') {
            if (!isTauriEnvironment()) return;
            setCreatingWorkspace(true);
            try {
                const { open } = await import('@tauri-apps/plugin-dialog');
                const selected = await open({ directory: true, multiple: false });
                if (selected && typeof selected === 'string') {
                    // Add to projects
                    await addProject(selected);
                    if (isMountedRef.current) {
                        setSelectedExistingPath(selected);
                        setWorkspaceChoice('existing');
                    }
                }
            } finally {
                if (isMountedRef.current) setCreatingWorkspace(false);
            }
            return;
        }

        setStep(4);
    }, [workspaceChoice]);

    const handleStart = useCallback(async () => {
        if (!pluginInfo || !isTauriEnvironment()) return;

        setStarting(true);
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            const pluginId = pluginInfo.pluginId;
            const platform: ImPlatform = `openclaw:${pluginId}`;

            // Build bot config
            const newConfig: ImBotConfig = {
                id: botId,
                name: pluginInfo.manifest?.name || pluginId,
                platform,
                botToken: '',
                allowedUsers: [],
                permissionMode: 'fullAgency',
                enabled: true,
                setupCompleted: true,
                defaultWorkspacePath: selectedExistingPath,
                openclawPluginId: pluginId,
                openclawNpmSpec: npmSpec.trim(),
                openclawPluginConfig: Object.keys(pluginConfig).length > 0 ? pluginConfig : undefined,
            };

            // Save config to disk
            await invoke('cmd_add_im_bot_config', { botConfig: newConfig });
            await refreshConfig();

            // Build start params
            const params = {
                botId,
                botToken: '',
                allowedUsers: [] as string[],
                permissionMode: 'fullAgency',
                workspacePath: selectedExistingPath,
                model: null,
                providerEnvJson: null,
                mcpServersJson: null,
                platform,
                feishuAppId: null,
                feishuAppSecret: null,
                dingtalkClientId: null,
                dingtalkClientSecret: null,
                dingtalkUseAiCard: false,
                dingtalkCardTemplateId: null,
                telegramUseDraft: false,
                heartbeatConfigJson: null,
                botName: newConfig.name,
                openclawPluginId: pluginId,
                openclawNpmSpec: npmSpec.trim(),
                openclawPluginConfig: Object.keys(pluginConfig).length > 0 ? pluginConfig : null,
            };

            await invoke<ImBotStatus>('cmd_start_im_bot', params);

            if (isMountedRef.current) {
                track('openclaw_bot_started', { pluginId });
                toastRef.current.success('Bot 启动成功！');
                onComplete(botId);
            }
        } catch (err) {
            if (isMountedRef.current) {
                toastRef.current.error(`启动失败: ${err}`);
                setStarting(false);
            }
        }
    }, [pluginInfo, botId, npmSpec, pluginConfig, selectedExistingPath, refreshConfig, onComplete]);

    const existingOptions = projects.map(p => ({
        value: p.path,
        label: shortenPathForDisplay(p.path),
    }));

    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="flex items-center gap-3">
                <button
                    onClick={onCancel}
                    className="rounded-lg p-2 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                >
                    <ArrowLeft className="h-4 w-4" />
                </button>
                <div>
                    <h2 className="text-lg font-semibold text-[var(--ink)]">安装社区插件</h2>
                    <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
                        步骤 {step} / 4 — {
                            step === 1 ? '安装插件' :
                            step === 2 ? '配置插件' :
                            step === 3 ? '选择工作区' :
                            '启动 Bot'
                        }
                    </p>
                </div>
            </div>

            {/* Step 1: Install */}
            {step === 1 && (
                <div className="space-y-4">
                    <div>
                        <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">
                            npm 包名
                        </label>
                        <input
                            type="text"
                            value={npmSpec}
                            onChange={(e) => setNpmSpec(e.target.value)}
                            placeholder="例如: @openclaw/channel-qqbot"
                            className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)] placeholder:text-[var(--ink-placeholder)] focus:border-[var(--button-primary-bg)] focus:outline-none"
                            onKeyDown={(e) => e.key === 'Enter' && handleInstall()}
                            disabled={installing}
                        />
                        <p className="mt-1.5 text-xs text-[var(--ink-muted)]">
                            输入 OpenClaw 兼容的 Channel Plugin 的 npm 包名
                        </p>
                    </div>
                    <button
                        onClick={handleInstall}
                        disabled={installing || !npmSpec.trim()}
                        className="flex items-center gap-2 rounded-lg bg-[var(--button-primary-bg)] px-4 py-2 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:opacity-90 disabled:opacity-50"
                    >
                        {installing ? (
                            <>
                                <Loader2 className="h-4 w-4 animate-spin" />
                                安装中…
                            </>
                        ) : (
                            <>
                                <Package className="h-4 w-4" />
                                安装插件
                            </>
                        )}
                    </button>
                </div>
            )}

            {/* Step 2: Configure */}
            {step === 2 && (
                <div className="space-y-4">
                    {pluginInfo && (
                        <div className="rounded-lg border border-[var(--line)] bg-[var(--paper-inset)] p-4">
                            <p className="text-sm font-medium text-[var(--ink)]">
                                {pluginInfo.manifest?.name || pluginInfo.pluginId}
                            </p>
                            {pluginInfo.manifest?.description && (
                                <p className="mt-1 text-xs text-[var(--ink-muted)]">
                                    {pluginInfo.manifest.description}
                                </p>
                            )}
                        </div>
                    )}

                    <div>
                        <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">
                            插件配置（可选）
                        </label>
                        <p className="mb-2 text-xs text-[var(--ink-muted)]">
                            输入插件需要的配置项（key=value 格式，每行一项）
                        </p>
                        <textarea
                            value={Object.entries(pluginConfig).map(([k, v]) => `${k}=${v}`).join('\n')}
                            onChange={(e) => {
                                const cfg: Record<string, string> = {};
                                e.target.value.split('\n').forEach(line => {
                                    const idx = line.indexOf('=');
                                    if (idx > 0) {
                                        cfg[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
                                    }
                                });
                                setPluginConfig(cfg);
                            }}
                            placeholder="appId=xxx&#10;appSecret=yyy"
                            rows={4}
                            className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 font-mono text-sm text-[var(--ink)] placeholder:text-[var(--ink-placeholder)] focus:border-[var(--button-primary-bg)] focus:outline-none"
                        />
                    </div>

                    <button
                        onClick={() => setStep(3)}
                        className="flex items-center gap-2 rounded-lg bg-[var(--button-primary-bg)] px-4 py-2 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:opacity-90"
                    >
                        下一步
                        <ArrowRight className="h-4 w-4" />
                    </button>
                </div>
            )}

            {/* Step 3: Workspace */}
            {step === 3 && (
                <div className="space-y-4">
                    <div>
                        <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">
                            工作区目录
                        </label>
                        <p className="mb-3 text-xs text-[var(--ink-muted)]">
                            AI Agent 将在此目录下工作
                        </p>
                    </div>

                    {existingOptions.length > 0 && (
                        <div className="space-y-2">
                            <label className="flex items-center gap-2">
                                <input
                                    type="radio"
                                    checked={workspaceChoice === 'existing'}
                                    onChange={() => setWorkspaceChoice('existing')}
                                    className="accent-[var(--button-primary-bg)]"
                                />
                                <span className="text-sm text-[var(--ink)]">使用已有工作区</span>
                            </label>
                            {workspaceChoice === 'existing' && (
                                <CustomSelect
                                    value={selectedExistingPath}
                                    options={existingOptions}
                                    onChange={setSelectedExistingPath}
                                />
                            )}
                        </div>
                    )}

                    <label className="flex items-center gap-2">
                        <input
                            type="radio"
                            checked={workspaceChoice === 'new'}
                            onChange={() => setWorkspaceChoice('new')}
                            className="accent-[var(--button-primary-bg)]"
                        />
                        <span className="text-sm text-[var(--ink)]">选择新目录</span>
                    </label>

                    <button
                        onClick={handleSelectWorkspace}
                        disabled={creatingWorkspace || (workspaceChoice === 'existing' && !selectedExistingPath)}
                        className="flex items-center gap-2 rounded-lg bg-[var(--button-primary-bg)] px-4 py-2 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:opacity-90 disabled:opacity-50"
                    >
                        {creatingWorkspace ? (
                            <>
                                <Loader2 className="h-4 w-4 animate-spin" />
                                选择中…
                            </>
                        ) : workspaceChoice === 'new' ? (
                            <>
                                <FolderOpen className="h-4 w-4" />
                                选择目录
                            </>
                        ) : (
                            <>
                                下一步
                                <ArrowRight className="h-4 w-4" />
                            </>
                        )}
                    </button>
                </div>
            )}

            {/* Step 4: Start */}
            {step === 4 && (
                <div className="space-y-4">
                    <div className="rounded-lg border border-[var(--line)] bg-[var(--paper-inset)] p-4 space-y-2">
                        <p className="text-sm text-[var(--ink)]">
                            <span className="font-medium">插件：</span>{pluginInfo?.manifest?.name || pluginInfo?.pluginId}
                        </p>
                        <p className="text-sm text-[var(--ink)]">
                            <span className="font-medium">工作区：</span>{shortenPathForDisplay(selectedExistingPath)}
                        </p>
                        {Object.keys(pluginConfig).length > 0 && (
                            <p className="text-sm text-[var(--ink)]">
                                <span className="font-medium">配置项：</span>{Object.keys(pluginConfig).length} 个
                            </p>
                        )}
                    </div>

                    <button
                        onClick={handleStart}
                        disabled={starting}
                        className="flex items-center gap-2 rounded-lg bg-[var(--button-primary-bg)] px-4 py-2 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:opacity-90 disabled:opacity-50"
                    >
                        {starting ? (
                            <>
                                <Loader2 className="h-4 w-4 animate-spin" />
                                启动中…
                            </>
                        ) : (
                            <>
                                <Check className="h-4 w-4" />
                                启动 Bot
                            </>
                        )}
                    </button>
                </div>
            )}
        </div>
    );
}
