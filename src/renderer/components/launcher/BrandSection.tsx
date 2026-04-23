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
import { ThoughtInput, type ThoughtInputHandle } from '@/components/task-center/ThoughtInput';
import { useToast } from '@/components/Toast';
import { thoughtList, taskCenterAvailable } from '@/api/taskCenter';
import { useConfig } from '@/hooks/useConfig';
import { useThoughtTagCandidates } from '@/hooks/useThoughtTagCandidates';
import { hasOverlayLayer } from '@/utils/closeLayer';
import { CUSTOM_EVENTS } from '@/../shared/constants';
import { type Project, type Provider, type PermissionMode, type ProviderVerifyStatus } from '@/config/types';
import type { RuntimeType, RuntimeModelInfo, RuntimePermissionMode } from '../../../shared/types/runtime';
import type { Thought } from '../../../shared/types/thought';

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

    // Thought history — fetched once per mount (and after a just-created
    // thought, via the explicit reload below) to feed the `#` autocomplete
    // candidate list. Deliberately independent from `thoughtRefreshKey`:
    // that key is used for the RecentThoughtsRow, and coupling the two
    // would create a state dance (optimistic prepend → refreshKey bump →
    // fetch races prepend → potential "flash and reappear" if a concurrent
    // external change landed between).
    //
    // Skipped entirely in 任务 mode on mount so user's steady state (most
    // sessions) doesn't pay a full `thoughtList()` round-trip for a `#`
    // picker they never open. The moment the user flips to 想法, this
    // effect re-runs and populates the list before they can open the
    // picker.
    const [thoughts, setThoughts] = useState<Thought[]>([]);
    const reloadThoughts = useCallback(async () => {
        try {
            const list = await thoughtList({});
            setThoughts(list);
        } catch (err) {
            // Keep the previous list as a cache; tag candidates stay usable
            // (minus the very latest thought's tags). Non-critical path —
            // don't toast.
            console.warn('[BrandSection] thoughtList failed for tag candidates', err);
        }
    }, []);
    useEffect(() => {
        if (!modeSegmentEnabled) return;
        if (mode !== 'thought') return;
        let cancelled = false;
        void (async () => {
            if (cancelled) return;
            await reloadThoughts();
        })();
        return () => {
            cancelled = true;
        };
    }, [modeSegmentEnabled, mode, reloadThoughts]);

    const { config } = useConfig();
    const tagCandidates = useThoughtTagCandidates(thoughts, config.agents ?? null);

    // Refs for imperative focus. Both inputs stay mounted (hidden via CSS
    // when the other mode is active) so typed-but-not-yet-sent text
    // survives mode switches — cross-review found the prior conditional
    // render silently dropped drafts. Focus is driven by a mode-effect
    // below (not by the old mount-time one-shot) so the caret follows the
    // visible editor.
    //
    // ModeSegment buttons use `retainFocusOnMouseDown` (see
    // `utils/focusRetention.ts`) so the textarea never loses focus on
    // click in the first place — no rAF, no race with macOS WebKit
    // touchpad-tap synthesis. The effect below handles the programmatic
    // hand-off when a keyboard chord (Tab / Cmd+Shift+T) switches modes.
    const inputRef = useRef<SimpleChatInputHandle>(null);
    const thoughtInputRef = useRef<ThoughtInputHandle>(null);
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

    // Focus handoff — follows the visible input. Fires on mount (initial
    // mode) and every mode change; `retainFocusOnMouseDown` already keeps
    // focus on the correct textarea for mouse-driven ModeSegment clicks,
    // so this effect's job is the keyboard-chord path (Tab / Cmd+Shift+T).
    // Running in an effect keeps it out of the click-handler frame — no
    // touchpad-tap race.
    useEffect(() => {
        if (mode === 'thought') {
            thoughtInputRef.current?.focus();
        } else {
            inputRef.current?.focus();
        }
    }, [mode]);

    // Task-mode submit is a straight pass-through to the parent's `onSend`.
    // Thought-mode submit is owned entirely by ThoughtInput (below) — it
    // calls `thoughtCreate` itself and fires `handleThoughtCreated`, so
    // this handler never sees thought content anymore.
    const handleSend = useCallback(
        (text: string, images?: ImageAttachment[]) => {
            onSend(text, images);
        },
        [onSend],
    );

    // Called from ThoughtInput after a successful thoughtCreate. Mirrors the
    // TaskCenter pattern (prepend locally so the tag-candidate count updates
    // immediately) plus the Launcher-specific bits — refresh the Recent
    // Thoughts strip and toast so the user sees visible confirmation on the
    // otherwise mostly-empty launcher canvas.
    //
    // The thoughts list and the refreshKey are intentionally on different
    // rhythms: thoughts is optimistically prepended (authoritative for tag
    // candidates), and refreshKey only drives RecentThoughtsRow's own
    // independent fetch. Previously we bumped both, which meant the tag
    // candidate list would briefly re-fetch and could "undo" a concurrent
    // change made from Task Center.
    const handleThoughtCreated = useCallback((t: Thought) => {
        setThoughts((prev) => [t, ...prev]);
        setThoughtRefreshKey((k) => k + 1);
        toastRef.current.success('想法已记录，可在任务中心查看');
    }, []);

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
                // v0.1.69 polish: bottom gap tightened from mb-6 to mb-3 so
                // the toggle reads as an affordance OF the input below, not
                // a free-floating headline. Top gap kept at mt-6 to preserve
                // breathing room from the brand slogan above.
                <div className="mt-6 mb-3">
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
                    {/* Both inputs stay mounted so mode switches preserve
                        in-progress drafts (including SimpleChatInput's
                        attached images / queued messages). Visibility is
                        a CSS-only concern — the inactive input is hidden
                        from the layout + a11y tree via `hidden`, so it
                        doesn't participate in flow or tab order. */}
                    <div hidden={mode === 'thought'}>
                        <SimpleChatInput
                            ref={inputRef}
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
                    {modeSegmentEnabled && (
                        // Thought editor — shares behaviour with Task Center
                        // via the same ThoughtInput component. No autoFocus
                        // prop: the mode-change effect above drives focus
                        // imperatively (via thoughtInputRef), which keeps
                        // the two inputs' focus handoff coherent when the
                        // user flips modes with the keyboard.
                        <div hidden={mode !== 'thought'}>
                            <ThoughtInput
                                ref={thoughtInputRef}
                                existingTags={tagCandidates}
                                onCreated={handleThoughtCreated}
                            />
                        </div>
                    )}
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
