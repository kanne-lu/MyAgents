import React, { useEffect, useState } from 'react';
import { ArrowLeft, Download, Loader2, Puzzle } from 'lucide-react';
import { isTauriEnvironment } from '@/utils/browserMock';
import type { ImPlatform, InstalledPlugin } from '../../../shared/types/im';
import telegramIcon from './assets/telegram.png';
import feishuIcon from './assets/feishu.jpeg';
import dingtalkIcon from './assets/dingtalk.svg';

interface PlatformEntry {
    id: ImPlatform;
    name: string;
    description: string;
    icon?: string;
    iconElement?: React.ReactNode;
    plugin?: InstalledPlugin;
}

const STATIC_PLATFORMS: PlatformEntry[] = [
    {
        id: 'telegram',
        name: 'Telegram',
        description: '通过 Telegram Bot 远程使用 AI Agent',
        icon: telegramIcon,
    },
    {
        id: 'feishu',
        name: '飞书',
        description: '通过飞书自建应用 Bot 远程使用 AI Agent',
        icon: feishuIcon,
    },
    {
        id: 'dingtalk',
        name: '钉钉',
        description: '通过钉钉自建应用 Bot 远程使用 AI Agent',
        icon: dingtalkIcon,
    },
];

export default function PlatformSelect({
    onSelect,
    onSelectPlugin,
    onInstallPlugin,
    onCancel,
}: {
    onSelect: (platform: ImPlatform) => void;
    onSelectPlugin: (plugin: InstalledPlugin) => void;
    onInstallPlugin: () => void;
    onCancel: () => void;
}) {
    const [installedPlugins, setInstalledPlugins] = useState<InstalledPlugin[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            if (!isTauriEnvironment()) {
                setLoading(false);
                return;
            }
            try {
                const { invoke } = await import('@tauri-apps/api/core');
                const plugins = await invoke<InstalledPlugin[]>('cmd_list_openclaw_plugins');
                if (!cancelled) setInstalledPlugins(plugins);
            } catch {
                // Ignore errors — just show no plugins
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, []);

    // Build dynamic platform entries from installed plugins
    const pluginPlatforms: PlatformEntry[] = installedPlugins.map((p) => ({
        id: `openclaw:${p.pluginId}` as ImPlatform,
        name: p.manifest?.name || p.pluginId,
        description: p.manifest?.description || `社区插件 — ${p.npmSpec}`,
        iconElement: (
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[var(--accent-warm-subtle)]">
                <Puzzle className="h-6 w-6 text-[var(--accent-warm)]" />
            </div>
        ),
        plugin: p,
    }));

    const allPlatforms = [...STATIC_PLATFORMS, ...pluginPlatforms];

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
                    <h2 className="text-lg font-semibold text-[var(--ink)]">选择平台</h2>
                    <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
                        选择要接入的聊天平台
                    </p>
                </div>
            </div>

            {/* Platform cards */}
            <div className="grid grid-cols-2 gap-4">
                {allPlatforms.map((p) => (
                    <button
                        key={p.id}
                        onClick={() => {
                            if (p.plugin) {
                                onSelectPlugin(p.plugin);
                            } else {
                                onSelect(p.id);
                            }
                        }}
                        className="flex flex-col items-center gap-3 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-6 transition-all hover:border-[var(--line-strong)] hover:shadow-sm hover:translate-y-[-1px]"
                    >
                        {p.icon ? (
                            <img src={p.icon} alt={p.name} className="h-12 w-12 rounded-xl" />
                        ) : p.iconElement ? (
                            p.iconElement
                        ) : null}
                        <div className="text-center">
                            <p className="text-sm font-medium text-[var(--ink)]">{p.name}</p>
                            <p className="mt-1 text-xs text-[var(--ink-muted)]">{p.description}</p>
                        </div>
                    </button>
                ))}

                {/* Install new plugin card */}
                <button
                    onClick={onInstallPlugin}
                    disabled={loading}
                    className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-[var(--line-strong)] bg-transparent p-6 transition-all hover:border-[var(--accent-warm)] hover:bg-[var(--accent-warm-subtle)]"
                >
                    {loading ? (
                        <Loader2 className="h-6 w-6 animate-spin text-[var(--ink-muted)]" />
                    ) : (
                        <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-dashed border-[var(--ink-subtle)]">
                            <Download className="h-6 w-6 text-[var(--ink-muted)]" />
                        </div>
                    )}
                    <div className="text-center">
                        <p className="text-sm font-medium text-[var(--ink-muted)]">安装新插件</p>
                        <p className="mt-1 text-xs text-[var(--ink-subtle)]">从 npm 安装 OpenClaw 社区插件</p>
                    </div>
                </button>
            </div>
        </div>
    );
}
