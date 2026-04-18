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

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import SimpleChatInput, { type ImageAttachment } from '@/components/SimpleChatInput';
import WorkspaceSelector from './WorkspaceSelector';
import ModeSegment, { type InputMode } from '@/components/task-center/ModeSegment';
import RecentThoughtsRow from '@/components/task-center/RecentThoughtsRow';
import { useToast } from '@/components/Toast';
import { thoughtCreate, taskCenterAvailable } from '@/api/taskCenter';
import { hasOverlayLayer } from '@/utils/closeLayer';
import { CUSTOM_EVENTS } from '@/../shared/constants';
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
    // Project convention: keep `toast` behind a ref so it stays out of
    // useCallback dep arrays and doesn't re-trigger memoization (see
    // specs/tech_docs/react_stability_rules.md). Updated via effect to
    // satisfy the `react-hooks/refs` no-mutate-during-render rule.
    const toastRef = useRef(toast);
    useEffect(() => {
        toastRef.current = toast;
    }, [toast]);
    const [mode, setMode] = useState<InputMode>('task');
    // Bumped after each successful thoughtCreate so the Recent Thoughts strip
    // re-fetches and the just-saved note slides in as the first chip.
    const [thoughtRefreshKey, setThoughtRefreshKey] = useState(0);
    // Gracefully degrade in browser dev mode — ModeSegment is Tauri-only.
    const modeSegmentEnabled = taskCenterAvailable();

    const handleSend = useCallback(
        async (text: string, images?: ImageAttachment[]) => {
            if (mode === 'thought' && modeSegmentEnabled) {
                // Thought mode: persist to ~/.myagents/thoughts/; stay in
                // 想法 mode so the just-saved note appears in
                // RecentThoughtsRow and the user can keep jotting.
                try {
                    await thoughtCreate({ content: text });
                    toastRef.current.success('想法已记录，可在任务中心查看');
                    setThoughtRefreshKey((k) => k + 1);
                    return true;
                } catch (e) {
                    toastRef.current.error(`保存想法失败：${e}`);
                    return false;
                }
            }
            onSend(text, images);
            return undefined;
        },
        [mode, modeSegmentEnabled, onSend],
    );

    const openTaskCenter = useCallback(() => {
        window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_TASK_CENTER));
    }, []);

    // Scoping ref for the Tab handler below — we only hijack Tab when the
    // focus is inside this Launcher subtree, so Chat tabs / settings /
    // modals keep their native focus navigation.
    const sectionRef = useRef<HTMLElement | null>(null);

    // PRD §4.1.1 hotkeys:
    //   • Cmd/Ctrl+Shift+T toggles mode globally while the Launcher is
    //     mounted — an explicit chord, safe to listen on `window`.
    //   • Plain Tab also toggles, but only when (a) no editable target
    //     has focus, (b) no overlay is open (Cmd+W stack), and (c) focus
    //     is inside the Launcher subtree or on `<body>`. These guards
    //     keep Tab's default focus-nav semantics everywhere else.
    useEffect(() => {
        if (!modeSegmentEnabled) return;
        const isEditableTarget = (t: EventTarget | null): boolean => {
            if (!(t instanceof HTMLElement)) return false;
            if (t.isContentEditable) return true;
            const tag = t.tagName;
            return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
        };
        const handler = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'T' || e.key === 't')) {
                e.preventDefault();
                setMode((m) => (m === 'task' ? 'thought' : 'task'));
                return;
            }
            if (
                e.key !== 'Tab' ||
                e.metaKey ||
                e.ctrlKey ||
                e.altKey ||
                e.shiftKey ||
                isEditableTarget(e.target) ||
                hasOverlayLayer()
            ) {
                return;
            }
            const section = sectionRef.current;
            const target = e.target as Node | null;
            const inScope =
                !target || target === document.body || (section?.contains(target) ?? false);
            if (!inScope) return;
            e.preventDefault();
            setMode((m) => (m === 'task' ? 'thought' : 'task'));
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
        <section ref={sectionRef} className="flex flex-1 flex-col items-center px-12">
            {/* Upper area: Brand Name + Slogans */}
            <div className="flex flex-1 flex-col items-center justify-center">
                <h1 className="brand-title mb-5 text-[2.5rem] text-[var(--ink)] md:text-[3.5rem]">
                    MyAgents
                </h1>
                <p className="brand-slogan text-center text-[15px] text-[var(--ink-muted)] md:text-[17px]">
                    每个人都应享受智能的推背感，欢迎来到言出法随的世界
                </p>
            </div>

            {/* Mode declaration: 任务 / 想法 (see DESIGN.md §6.8, PRD §4.1).
                `tabSwitchHint` surfaces the Tab-toggle shortcut as a hover
                tooltip, matching the global handler installed above. */}
            {modeSegmentEnabled && (
                <div className="mt-3 mb-4">
                    <ModeSegment
                        value={mode}
                        onChange={setMode}
                        size="launcher"
                        tabSwitchHint
                    />
                </div>
            )}

            {/* Lower area: Input box with workspace selector in toolbar.
                When 「想法」 mode is active, a compact Recent Thoughts strip is
                absolute-positioned below the input so it hangs in the existing
                `pb-[12vh]` bottom space without shifting the brand/input
                vertically (PRD §4.2). */}
            <div className="w-full max-w-[640px] pb-[12vh]">
                <div className="relative w-full">
                    <SimpleChatInput
                        mode="launcher"
                        thoughtMode={mode === 'thought'}
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
                    {mode === 'thought' && modeSegmentEnabled && (
                        <div className="absolute left-0 right-0 top-full mt-3">
                            <RecentThoughtsRow
                                refreshKey={thoughtRefreshKey}
                                onOpenTaskCenter={openTaskCenter}
                            />
                        </div>
                    )}
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
