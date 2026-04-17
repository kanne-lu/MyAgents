/**
 * BrandSection - Left panel of the Launcher page
 * Layout: Logo+Slogan pinned to upper area, input box anchored to lower area
 * with workspace selector integrated into the input toolbar.
 *
 * Phase 2 (v0.1.69): a 任务 / 想法 ModeSegment sits between the slogan and the
 * input. Switching to 「想法」 repurposes the input as a freeform Thought entry
 * (persisted to ~/.myagents/thoughts/ via `thoughtCreate`), bypassing the full
 * Chat launch flow. Switching back to 「任务」 restores the default behavior.
 */

import { memo, useCallback, useEffect, useMemo, useState } from 'react';

import SimpleChatInput, { type ImageAttachment } from '@/components/SimpleChatInput';
import WorkspaceSelector from './WorkspaceSelector';
import ModeSegment, { type InputMode } from '@/components/task-center/ModeSegment';
import { useToast } from '@/components/Toast';
import { thoughtCreate, taskCenterAvailable } from '@/api/taskCenter';
import { type Project, type Provider, type PermissionMode, type ProviderVerifyStatus } from '@/config/types';
import type { RuntimeType, RuntimeModelInfo, RuntimePermissionMode } from '../../../shared/types/runtime';

interface BrandSectionProps {
    // Workspace
    projects: Project[];
    selectedProject: Project | null;
    defaultWorkspacePath?: string;
    onSelectWorkspace: (project: Project) => void;
    onAddFolder: () => void;
    // Input
    onSend: (text: string, images?: ImageAttachment[]) => void;
    isStarting?: boolean;
    // Provider/Model (pass-through to SimpleChatInput)
    provider?: Provider | null;
    providers?: Provider[];
    selectedModel?: string;
    onProviderChange?: (id: string, targetModel?: string) => void;
    onModelChange?: (id: string) => void;
    permissionMode?: PermissionMode;
    onPermissionModeChange?: (mode: PermissionMode) => void;
    apiKeys?: Record<string, string>;
    providerVerifyStatus?: Record<string, ProviderVerifyStatus>;
    // MCP
    workspaceMcpEnabled?: string[];
    globalMcpEnabled?: string[];
    mcpServers?: Array<{ id: string; name: string; description?: string }>;
    onWorkspaceMcpToggle?: (serverId: string, enabled: boolean) => void;
    onRefreshProviders?: () => void;
    // Navigation
    onGoToSettings?: () => void;
    // Runtime (external runtimes adapt model/permission selectors)
    runtime?: RuntimeType;
    runtimeModels?: RuntimeModelInfo[];
    runtimePermissionModes?: RuntimePermissionMode[];
}

export default memo(function BrandSection({
    projects,
    selectedProject,
    defaultWorkspacePath,
    onSelectWorkspace,
    onAddFolder,
    onSend,
    isStarting,
    provider,
    providers,
    selectedModel,
    onProviderChange,
    onModelChange,
    permissionMode,
    onPermissionModeChange,
    apiKeys,
    providerVerifyStatus,
    workspaceMcpEnabled,
    globalMcpEnabled,
    mcpServers,
    onWorkspaceMcpToggle,
    onRefreshProviders,
    onGoToSettings,
    runtime,
    runtimeModels,
    runtimePermissionModes,
}: BrandSectionProps) {
    const toast = useToast();
    const [mode, setMode] = useState<InputMode>('task');
    // Gracefully degrade in browser dev mode — ModeSegment is Tauri-only.
    const modeSegmentEnabled = taskCenterAvailable();

    const handleSend = useCallback(
        async (text: string, images?: ImageAttachment[]) => {
            if (mode === 'thought' && modeSegmentEnabled) {
                // Thought mode: persist to ~/.myagents/thoughts/ and drop back
                // to the input without launching a chat / workspace.
                try {
                    await thoughtCreate({ content: text });
                    toast.success('想法已记录，可在任务中心查看');
                    // PRD §4.4: after save, clear input, keep focus, auto-revert
                    // to 「任务」 so the next press is a normal launch.
                    setMode('task');
                    return true; // tell SimpleChatInput to clear the textarea
                } catch (e) {
                    toast.error(`保存想法失败：${e}`);
                    return false;
                }
            }
            onSend(text, images);
            return undefined; // SimpleChatInput expects boolean | void
        },
        [mode, modeSegmentEnabled, onSend, toast],
    );

    // PRD §4.1.1 hotkey: Cmd/Ctrl+Shift+T toggles task ↔ thought.
    useEffect(() => {
        if (!modeSegmentEnabled) return;
        const handler = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'T' || e.key === 't')) {
                e.preventDefault();
                setMode((m) => (m === 'task' ? 'thought' : 'task'));
            }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [modeSegmentEnabled]);

    // Check if any provider is available (has valid subscription or API key configured)
    // Validation status is informational — having a key is enough to be "available"
    const hasAnyProvider = useMemo(() => {
        return providers?.some(p => {
            if (p.type === 'subscription') {
                const v = providerVerifyStatus?.[p.id];
                return v?.status === 'valid' && !!v?.accountEmail;
            }
            return !!apiKeys?.[p.id];
        }) ?? false;
    }, [providers, apiKeys, providerVerifyStatus]);

    return (
        <section className="flex flex-1 flex-col items-center px-12">
            {/* Upper area: Brand Name + Slogans */}
            <div className="flex flex-1 flex-col items-center justify-center">
                <h1 className="brand-title mb-5 text-[2.5rem] text-[var(--ink)] md:text-[3.5rem]">
                    MyAgents
                </h1>
                <p className="brand-slogan text-center text-[15px] text-[var(--ink-muted)] md:text-[17px]">
                    每个人都应享受智能的推背感，欢迎来到言出法随的世界
                </p>
            </div>

            {/* Mode declaration: 任务 / 想法 (see DESIGN.md §6.8, PRD §4.1) */}
            {modeSegmentEnabled && (
                <div className="mt-3 mb-4">
                    <ModeSegment value={mode} onChange={setMode} size="launcher" />
                </div>
            )}

            {/* Lower area: Input box with workspace selector in toolbar */}
            <div className="w-full max-w-[640px] pb-[12vh]">
                <div className="relative w-full">
                    <SimpleChatInput
                        mode="launcher"
                        onSend={handleSend}
                        isLoading={!!isStarting}
                        provider={provider}
                        providers={providers}
                        selectedModel={selectedModel}
                        onProviderChange={onProviderChange}
                        onModelChange={onModelChange}
                        permissionMode={permissionMode}
                        onPermissionModeChange={onPermissionModeChange}
                        apiKeys={apiKeys}
                        providerVerifyStatus={providerVerifyStatus}
                        workspaceMcpEnabled={workspaceMcpEnabled}
                        globalMcpEnabled={globalMcpEnabled}
                        mcpServers={mcpServers}
                        onWorkspaceMcpToggle={onWorkspaceMcpToggle}
                        onRefreshProviders={onRefreshProviders}
                        runtime={runtime}
                        runtimeModels={runtimeModels}
                        runtimePermissionModes={runtimePermissionModes}
                        toolbarPrefix={
                            <WorkspaceSelector
                                projects={projects}
                                selectedProject={selectedProject}
                                defaultWorkspacePath={defaultWorkspacePath}
                                onSelect={onSelectWorkspace}
                                onAddFolder={onAddFolder}
                            />
                        }
                    />
                </div>
                {!hasAnyProvider && (
                    <p className="mt-6 text-center text-[13px] text-[var(--ink-muted)]">
                        ✨ 只需一步，即刻开启 AI 之旅 —
                        <button
                            type="button"
                            onClick={onGoToSettings}
                            className="ml-1 text-[var(--accent-warm)] hover:underline"
                        >
                            配置模型供应商 →
                        </button>
                    </p>
                )}
            </div>
        </section>
    );
});
