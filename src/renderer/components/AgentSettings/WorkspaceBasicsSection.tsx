// WorkspaceBasicsSection — workspace name, icon, model, permission, MCP tools
// Reads from Project, writes to both Project and AgentConfig (for Rust shim compat)

import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { ChevronRight } from 'lucide-react';
import { useConfig } from '@/hooks/useConfig';
import { getAllMcpServers, getEnabledMcpServerIds } from '@/config/configService';
import { patchAgentConfig } from '@/config/services/agentConfigService';
import { PERMISSION_MODES, type Project, type McpServerDefinition } from '@/config/types';
import type { AgentConfig } from '../../../shared/types/agent';
import { ALL_WORKSPACE_ICON_IDS, DEFAULT_WORKSPACE_ICON } from '@/assets/workspace-icons';
import WorkspaceIcon from '../launcher/WorkspaceIcon';

interface WorkspaceBasicsSectionProps {
  project: Project | undefined;
  agent: AgentConfig | undefined;
  agentDir: string;
}

export default function WorkspaceBasicsSection({ project, agent, agentDir }: WorkspaceBasicsSectionProps) {
  const { providers, patchProject, refreshConfig } = useConfig();
  // Derive canonical name from project — use as initializer key to reset input
  const canonicalName = useMemo(
    () => project?.displayName || project?.name || '',
    [project?.displayName, project?.name],
  );
  const [name, setName] = useState(canonicalName);
  const [openPopup, setOpenPopup] = useState<'icon' | 'model' | 'permission' | 'mcp' | null>(null);
  const [mcpServers, setMcpServers] = useState<McpServerDefinition[]>([]);
  const [globalEnabledMcp, setGlobalEnabledMcp] = useState<string[]>([]);
  const isMountedRef = useRef(true);

  // Sync name when canonical name changes externally
  useEffect(() => {
    setName(canonicalName);
  }, [canonicalName]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  // Load globally available MCP servers
  useEffect(() => {
    void (async () => {
      const [servers, enabled] = await Promise.all([
        getAllMcpServers(),
        getEnabledMcpServerIds(),
      ]);
      if (isMountedRef.current) {
        setMcpServers(servers);
        setGlobalEnabledMcp(enabled);
      }
    })();
  }, []);

  const availableMcpServers = mcpServers.filter(s => globalEnabledMcp.includes(s.id));

  // Save to Project + sync relevant fields to AgentConfig for Rust shim
  const saveToProject = useCallback(async (updates: Partial<Omit<Project, 'id'>>) => {
    if (!project) return;
    await patchProject(project.id, updates);
    // Sync AI-related fields to AgentConfig if it exists
    if (agent) {
      const agentPatch: Record<string, unknown> = {};
      if (updates.displayName !== undefined) agentPatch.name = updates.displayName || project.name;
      if (updates.icon !== undefined) agentPatch.icon = updates.icon;
      if (updates.providerId !== undefined) agentPatch.providerId = updates.providerId;
      if (updates.model !== undefined) agentPatch.model = updates.model;
      if (updates.permissionMode !== undefined) agentPatch.permissionMode = updates.permissionMode || 'plan';
      if (updates.mcpEnabledServers !== undefined) agentPatch.mcpEnabledServers = updates.mcpEnabledServers;
      if (Object.keys(agentPatch).length > 0) {
        // patchAgentConfig auto-resolves providerEnvJson when providerId changes
        await patchAgentConfig(agent.id, agentPatch as Partial<Omit<AgentConfig, 'id'>>);
      }
    }
    await refreshConfig();
  }, [project, agent, patchProject, refreshConfig]);

  const handleNameBlur = useCallback(() => {
    const trimmed = name.trim();
    const currentName = project?.displayName || project?.name || '';
    if (trimmed && trimmed !== currentName) {
      void saveToProject({ displayName: trimmed });
    }
  }, [name, project, saveToProject]);

  const handleIconSelect = useCallback((iconId: string) => {
    void saveToProject({ icon: iconId || undefined });
    setOpenPopup(null);
  }, [saveToProject]);

  const handleModelSelect = useCallback((providerId: string, model: string) => {
    void saveToProject({ providerId, model });
    setOpenPopup(null);
  }, [saveToProject]);

  const handlePermissionSelect = useCallback((mode: string) => {
    void saveToProject({ permissionMode: mode as Project['permissionMode'] });
    setOpenPopup(null);
  }, [saveToProject]);

  const handleMcpToggle = useCallback((serverId: string) => {
    const current = project?.mcpEnabledServers || [];
    const newEnabled = current.includes(serverId)
      ? current.filter(id => id !== serverId)
      : [...current, serverId];
    void saveToProject({ mcpEnabledServers: newEnabled });
  }, [project?.mcpEnabledServers, saveToProject]);

  // Derived display values
  const selectedProvider = providers.find(p => p.id === project?.providerId);
  const modelName = project?.model
    ? (selectedProvider?.models?.find(m => m.model === project.model)?.modelName || project.model)
    : (selectedProvider?.primaryModel || '未设置');
  const providerName = selectedProvider?.name || '默认';

  const permissionMode = PERMISSION_MODES.find(m => m.value === project?.permissionMode) || PERMISSION_MODES[0];

  const enabledMcpNames = availableMcpServers
    .filter(s => project?.mcpEnabledServers?.includes(s.id))
    .map(s => s.name);
  const mcpSummary = enabledMcpNames.length === 0
    ? '未启用工具'
    : enabledMcpNames.length <= 2
      ? enabledMcpNames.join(' / ')
      : `${enabledMcpNames.slice(0, 2).join(' / ')} +${enabledMcpNames.length - 2}`;

  if (!project) {
    return <p className="text-sm text-[var(--ink-subtle)]">未找到工作区配置</p>;
  }

  return (
    <div className="space-y-3">
      {/* Name + Icon — single row: [label] [icon] [input] */}
      <div className="relative flex items-center gap-3">
        <label className="w-14 shrink-0 text-sm text-[var(--ink-muted)]">名称</label>
        <button
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border transition-colors ${
            openPopup === 'icon'
              ? 'border-[var(--accent)] bg-[var(--accent-warm-muted)]'
              : 'border-[var(--line)] hover:border-[var(--line-strong)]'
          }`}
          onClick={() => setOpenPopup(openPopup === 'icon' ? null : 'icon')}
          title="选择图标"
        >
          <WorkspaceIcon icon={project.icon || DEFAULT_WORKSPACE_ICON} size={22} />
        </button>
        <input
          className="flex-1 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-1.5 text-sm text-[var(--ink)] placeholder:text-[var(--ink-subtle)] focus:border-[var(--accent)] focus:outline-none"
          value={name}
          onChange={e => setName(e.target.value)}
          onBlur={handleNameBlur}
          onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
          placeholder="工作区名称"
        />

        {openPopup === 'icon' && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOpenPopup(null)} />
            <div className="absolute left-20 top-10 z-50 max-h-[260px] w-[320px] overflow-y-auto overscroll-contain rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-2 shadow-lg">
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => handleIconSelect('')}
                  className={`flex h-9 w-9 items-center justify-center rounded-lg transition-all ${
                    !project.icon ? 'bg-[var(--accent-warm-muted)] ring-1 ring-[var(--accent-warm)]' : 'hover:bg-[var(--hover-bg)]'
                  }`}
                  title="默认"
                >
                  <WorkspaceIcon icon={DEFAULT_WORKSPACE_ICON} size={20} />
                </button>
                {ALL_WORKSPACE_ICON_IDS
                  .filter(id => id !== 'folder-open' && id !== DEFAULT_WORKSPACE_ICON)
                  .map(iconId => (
                    <button
                      key={iconId}
                      type="button"
                      onClick={() => handleIconSelect(iconId)}
                      className={`flex h-9 w-9 items-center justify-center rounded-lg transition-all ${
                        project.icon === iconId
                          ? 'bg-[var(--accent-warm-muted)] ring-1 ring-[var(--accent-warm)]'
                          : 'hover:bg-[var(--hover-bg)]'
                      }`}
                      title={iconId}
                    >
                      <WorkspaceIcon icon={iconId} size={20} />
                    </button>
                  ))}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Workspace path — read-only */}
      <div className="flex items-center gap-3">
        <label className="w-14 shrink-0 text-sm text-[var(--ink-muted)]">工作区</label>
        <span className="flex-1 truncate rounded-lg px-3 py-1.5 text-sm text-[var(--ink-subtle)]" title={agentDir}>
          {agentDir}
        </span>
      </div>

      {/* Model */}
      <div className="relative flex items-center gap-3">
        <label className="w-14 shrink-0 text-sm text-[var(--ink-muted)]">模型</label>
        <button
          className="flex flex-1 items-center justify-between rounded-lg border border-[var(--line)] px-3 py-1.5 text-left text-sm text-[var(--ink)] transition-colors hover:border-[var(--line-strong)]"
          onClick={() => setOpenPopup(openPopup === 'model' ? null : 'model')}
        >
          <span className="truncate">{providerName} / {modelName}</span>
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--ink-subtle)]" />
        </button>

        {openPopup === 'model' && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOpenPopup(null)} />
            <div className="absolute left-20 top-0 z-50 max-h-[300px] w-[320px] overflow-y-auto overscroll-contain rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-2 shadow-lg">
              {providers.map(provider => (
                <div key={provider.id} className="mb-1">
                  <div className="px-2 py-1 text-xs font-medium text-[var(--ink-muted)]">{provider.name}</div>
                  {provider.models?.map(model => (
                    <button
                      key={`${provider.id}:${model.model}`}
                      className={`flex w-full items-center rounded-lg px-3 py-1.5 text-left text-sm transition-colors ${
                        project.providerId === provider.id && project.model === model.model
                          ? 'bg-[var(--accent-warm-muted)] text-[var(--accent-warm)]'
                          : 'text-[var(--ink)] hover:bg-[var(--hover-bg)]'
                      }`}
                      onClick={() => handleModelSelect(provider.id, model.model)}
                    >
                      {model.modelName}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Permission */}
      <div className="relative flex items-center gap-3">
        <label className="w-14 shrink-0 text-sm text-[var(--ink-muted)]">权限</label>
        <button
          className="flex flex-1 items-center justify-between rounded-lg border border-[var(--line)] px-3 py-1.5 text-left text-sm text-[var(--ink)] transition-colors hover:border-[var(--line-strong)]"
          onClick={() => setOpenPopup(openPopup === 'permission' ? null : 'permission')}
        >
          <span>{permissionMode.icon} {permissionMode.label}</span>
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--ink-subtle)]" />
        </button>

        {openPopup === 'permission' && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOpenPopup(null)} />
            <div className="absolute left-20 top-0 z-50 w-[280px] rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-2 shadow-lg">
              {PERMISSION_MODES.map(mode => (
                <button
                  key={mode.value}
                  className={`flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left transition-colors ${
                    project.permissionMode === mode.value
                      ? 'bg-[var(--accent-warm-muted)] text-[var(--accent-warm)]'
                      : 'text-[var(--ink)] hover:bg-[var(--hover-bg)]'
                  }`}
                  onClick={() => handlePermissionSelect(mode.value)}
                >
                  <span className="shrink-0">{mode.icon}</span>
                  <div>
                    <div className="text-sm font-medium">{mode.label}</div>
                    <div className="text-xs text-[var(--ink-muted)]">{mode.description}</div>
                  </div>
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {/* MCP Tools */}
      <div className="relative flex items-center gap-3">
        <label className="w-14 shrink-0 text-sm text-[var(--ink-muted)]">工具</label>
        <button
          className="flex flex-1 items-center justify-between rounded-lg border border-[var(--line)] px-3 py-1.5 text-left text-sm text-[var(--ink)] transition-colors hover:border-[var(--line-strong)]"
          onClick={() => setOpenPopup(openPopup === 'mcp' ? null : 'mcp')}
        >
          <span className="truncate">{mcpSummary}</span>
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--ink-subtle)]" />
        </button>

        {openPopup === 'mcp' && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOpenPopup(null)} />
            <div className="absolute left-20 top-0 z-50 max-h-[300px] w-[320px] overflow-y-auto overscroll-contain rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-2 shadow-lg">
              {availableMcpServers.length === 0 ? (
                <p className="px-3 py-2 text-xs text-[var(--ink-subtle)]">
                  尚未启用全局 MCP 工具。请先在系统设置中启用。
                </p>
              ) : (
                availableMcpServers.map(server => {
                  const checked = project.mcpEnabledServers?.includes(server.id) ?? false;
                  return (
                    <label
                      key={server.id}
                      className="flex cursor-pointer items-center gap-3 rounded-lg p-2 transition-colors hover:bg-[var(--hover-bg)]"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => handleMcpToggle(server.id)}
                        className="h-4 w-4 rounded border-[var(--line)]"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-[var(--ink)]">{server.name}</p>
                        {server.description && (
                          <p className="truncate text-xs text-[var(--ink-muted)]">{server.description}</p>
                        )}
                      </div>
                    </label>
                  );
                })
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
