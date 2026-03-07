import React, { useCallback, useRef, useState } from 'react';
import { ArrowLeft, Check, Loader2, Package } from 'lucide-react';
import { track } from '@/analytics';
import { isTauriEnvironment } from '@/utils/browserMock';
import { useToast } from '@/components/Toast';

export default function PluginInstall({
    onComplete,
    onCancel,
}: {
    onComplete: () => void;
    onCancel: () => void;
}) {
    const toast = useToast();
    const toastRef = useRef(toast);
    toastRef.current = toast;

    const [npmSpec, setNpmSpec] = useState('');
    const [installing, setInstalling] = useState(false);
    const [installed, setInstalled] = useState(false);
    const [pluginName, setPluginName] = useState('');

    const handleInstall = useCallback(async () => {
        if (!npmSpec.trim()) {
            toastRef.current.error('请输入 npm 包名');
            return;
        }

        setInstalling(true);
        try {
            if (isTauriEnvironment()) {
                const { invoke } = await import('@tauri-apps/api/core');
                const result = await invoke<{
                    pluginId: string;
                    installDir: string;
                    manifest: { name?: string; description?: string } | null;
                }>('cmd_install_openclaw_plugin', {
                    npmSpec: npmSpec.trim(),
                });
                track('openclaw_plugin_installed', { npmSpec: npmSpec.trim() });
                setPluginName(result.manifest?.name || result.pluginId);
                setInstalled(true);
            }
        } catch (err) {
            toastRef.current.error(`安装失败: ${err}`);
        } finally {
            setInstalling(false);
        }
    }, [npmSpec]);

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
                        从 npm 安装 OpenClaw 社区 Channel Plugin
                    </p>
                </div>
            </div>

            {installed ? (
                /* Success state */
                <div className="space-y-4">
                    <div className="flex items-center gap-3 rounded-[var(--radius-lg)] border border-[var(--success)]/20 bg-[var(--success-bg)] p-4">
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--success)]/15">
                            <Check className="h-4 w-4 text-[var(--success)]" />
                        </div>
                        <div>
                            <p className="text-sm font-medium text-[var(--ink)]">
                                {pluginName} 安装成功
                            </p>
                            <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
                                返回平台列表即可开始配置
                            </p>
                        </div>
                    </div>
                    <button
                        onClick={onComplete}
                        className="flex items-center gap-2 rounded-[var(--radius-md)] bg-[var(--button-primary-bg)] px-4 py-2 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)]"
                    >
                        返回平台列表
                    </button>
                </div>
            ) : (
                /* Install form */
                <div className="space-y-4">
                    <div>
                        <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">
                            npm 包名
                        </label>
                        <input
                            type="text"
                            value={npmSpec}
                            onChange={(e) => setNpmSpec(e.target.value)}
                            placeholder="例如: @sliverp/qqbot"
                            className="w-full rounded-[var(--radius-sm)] border border-[var(--line)] bg-transparent px-3 py-2.5 text-sm text-[var(--ink)] placeholder:text-[var(--ink-muted)] focus:border-[var(--button-primary-bg)] focus:outline-none transition-colors"
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
                        className="flex items-center gap-2 rounded-[var(--radius-md)] bg-[var(--button-primary-bg)] px-4 py-2 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:opacity-50"
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
        </div>
    );
}
