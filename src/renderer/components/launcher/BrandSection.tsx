/**
 * BrandSection - Left panel of the Launcher page
 * Layout: Logo+Slogan pinned to upper area, input box anchored to lower area
 * with workspace selector integrated into the input toolbar
 */

import { memo, useCallback, useMemo } from 'react';

import SimpleChatInput, { type ImageAttachment } from '@/components/SimpleChatInput';
import WorkspaceSelector from './WorkspaceSelector';
import { type Project, type Provider, type PermissionMode, type ProviderVerifyStatus } from '@/config/types';

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
    onProviderChange?: (id: string) => void;
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
}: BrandSectionProps) {
    const handleSend = useCallback((text: string, images?: ImageAttachment[]) => {
        onSend(text, images);
        return undefined; // SimpleChatInput expects boolean | void
    }, [onSend]);

    // Check if any provider is available (has valid subscription or API key)
    const hasAnyProvider = useMemo(() => {
        return providers?.some(p => {
            if (p.type === 'subscription') {
                const v = providerVerifyStatus?.[p.id];
                return v?.status === 'valid' && !!v?.accountEmail;
            }
            return !!apiKeys?.[p.id] && providerVerifyStatus?.[p.id]?.status !== 'invalid';
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

            {/* Lower area: Input box with workspace selector in toolbar */}
            <div className="mt-8 w-full max-w-[640px] pb-[12vh]">
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
