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

import SimpleChatInput, { type ImageAttachment, type SimpleChatInputHandle } from '@/components/SimpleChatInput';
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

    // Ref into SimpleChatInput — used ONLY for mount-time focus (below).
    // Intentionally NOT used inside the ModeSegment click handler: see
    // `utils/focusRetention.ts`. Calling `.focus()` from within a click
    // handler (even inside `requestAnimationFrame`) races the macOS
    // WebKit touchpad-tap event synthesis and can drop the click entirely.
    // ModeSegment buttons instead use `retainFocusOnMouseDown` so the
    // textarea never loses focus in the first place — no rAF, no race.
    const inputRef = useRef<SimpleChatInputHandle>(null);
    // Single helper for BOTH the segment click path (explicit mode) and
    // the keyboard paths (Tab / Cmd+Shift+T toggle). Without this the
    // two call sites diverged on `setMode(next)` vs `setMode((m) => …)`
    // and future work added to one would silently skip the other.
    const setModeAndFocus = useCallback((next: InputMode | 'toggle') => {
        if (next === 'toggle') {
            setMode((m) => (m === 'task' ? 'thought' : 'task'));
        } else {
            setMode(next);
        }
    }, []);

    // Mount-time focus — drops the caret in the textarea the first time
    // the Launcher renders so the user can start typing immediately.
    // Runs on mount only (empty deps), not inside an interaction event,
    // so it doesn't race touchpad-tap click synthesis. Subsequent mode
    // switches DON'T re-focus — `retainFocusOnMouseDown` on ModeSegment
    // buttons keeps the existing focus in place so re-focusing would be
    // a no-op anyway.
    useEffect(() => {
        inputRef.current?.focus();
    }, []);

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
    //   • Plain Tab toggles too, and — crucially — fires even when the
    //     textarea is focused. The tooltip on the ModeSegment buttons
    //     ("按 Tab 切换到「任务」") promises this behaviour; guarding
    //     against editable targets like earlier iterations did made the
    //     tooltip a lie the moment mount-time focus landed the caret in
    //     the textarea. Child components that legitimately need to
    //     consume Tab (SimpleChatInput's slash-menu / file-search
    //     autocomplete) call `event.stopPropagation()` inside their
    //     onKeyDown handlers — React's `stopPropagation` halts the
    //     underlying native bubble, so this window listener truly won't
    //     fire when a child has first claim on the Tab keystroke.
    useEffect(() => {
        if (!modeSegmentEnabled) return;
        const handler = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'T' || e.key === 't')) {
                e.preventDefault();
                setModeAndFocus('toggle');
                return;
            }
            if (
                e.key !== 'Tab' ||
                e.metaKey ||
                e.ctrlKey ||
                e.altKey ||
                e.shiftKey ||
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
            setModeAndFocus('toggle');
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [modeSegmentEnabled, setModeAndFocus]);

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
            {/* Upper area: Brand Name + Slogans as ONE visual group.
                `mb-2` tightens the title↔slogan gap so they read as a
                paired brand block rather than two free-floating lines;
                the larger breathing room below that group (on the
                ModeSegment wrapper) separates "who we are" from "what
                you're about to do". */}
            <div className="flex flex-1 flex-col items-center justify-center">
                <h1 className="brand-title mb-2 text-[2.5rem] text-[var(--ink)] md:text-[3.5rem]">
                    MyAgents
                </h1>
                <p className="brand-slogan text-center text-[15px] text-[var(--ink-muted)] md:text-[17px]">
                    每个人都应享受智能的推背感，欢迎来到言出法随的世界
                </p>
            </div>

            {/* Mode declaration: 任务 / 想法 (see DESIGN.md §6.8, PRD §4.1).
                `mt-6 mb-6` opens breathing room above (separating from
                the brand group) and below (separating from the input
                affordance) — deliberately generous so the Launcher
                doesn't feel compressed even with the newly 3-row input.
                No `tabSwitchHint` — the hover tooltip was more noise than
                signal; power users who need the shortcut will discover
                it naturally, casual users shouldn't have a persistent
                tooltip popping every time their cursor brushes past. */}
            {modeSegmentEnabled && (
                <div className="mt-6 mb-6">
                    <ModeSegment
                        value={mode}
                        onChange={setModeAndFocus}
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
                        ref={inputRef}
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
