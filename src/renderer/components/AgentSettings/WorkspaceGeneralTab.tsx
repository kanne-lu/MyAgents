// WorkspaceGeneralTab — the "通用" tab in WorkspaceConfigPanel
// Flat layout: section titles + dividers, no outer card borders

import { useState, useCallback, useEffect, useRef } from 'react';
import { useConfig } from '@/hooks/useConfig';
import { useToast } from '@/components/Toast';
import { useAgentStatuses } from '@/hooks/useAgentStatuses';
import { isTauriEnvironment } from '@/utils/browserMock';
import { getAgentById, addAgentConfig, patchAgentConfig, invokeStartAgentChannel } from '@/config/services/agentConfigService';
import type { AgentConfig } from '../../../shared/types/agent';
import WorkspaceBasicsSection from './WorkspaceBasicsSection';
import AgentChannelsSection from './sections/AgentChannelsSection';
import AgentHeartbeatSection from './sections/AgentHeartbeatSection';
import AgentTasksSection from './sections/AgentTasksSection';
import WorkspaceIcon from '../launcher/WorkspaceIcon';
import { DEFAULT_WORKSPACE_ICON } from '@/assets/workspace-icons';
import { shortenPathForDisplay } from '@/utils/pathDetection';

interface WorkspaceGeneralTabProps {
  agentDir: string;
}

export default function WorkspaceGeneralTab({ agentDir }: WorkspaceGeneralTabProps) {
  const { config, projects, patchProject, refreshConfig } = useConfig();
  const project = projects.find(p => p.path.replace(/\\/g, '/') === agentDir.replace(/\\/g, '/'));
  const agent = project?.agentId ? getAgentById(config, project.agentId) : undefined;
  const isProactive = !!(project?.isAgent && agent?.enabled);
  const { statuses, refresh: refreshStatuses } = useAgentStatuses(isProactive);
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const isMountedRef = useRef(true);
  const [toggling, setToggling] = useState(false);

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  const handleAgentChanged = useCallback(async () => {
    await refreshConfig();
    await refreshStatuses();
  }, [refreshConfig, refreshStatuses]);

  // Toggle proactive agent mode
  const handleToggleProactive = useCallback(async () => {
    if (!project || toggling) return;
    setToggling(true);
    try {
      if (!project.isAgent || !agent) {
        // First time: create AgentConfig + mark project
        const newAgent: AgentConfig = {
          id: crypto.randomUUID(),
          name: project.displayName || project.name || agentDir.split('/').pop() || 'Agent',
          icon: project.icon,
          enabled: true,
          workspacePath: agentDir,
          providerId: project.providerId ?? undefined,
          model: project.model ?? undefined,
          permissionMode: project.permissionMode || config.defaultPermissionMode || 'plan',
          mcpEnabledServers: project.mcpEnabledServers,
          channels: [],
        };
        await addAgentConfig(newAgent);
        await patchProject(project.id, { isAgent: true, agentId: newAgent.id });
        toastRef.current.success('主动 Agent 模式已开启');
      } else if (agent.enabled) {
        // Disable — stop all running channels first
        let stoppedCount = 0;
        if (isTauriEnvironment()) {
          const { invoke } = await import('@tauri-apps/api/core');
          for (const ch of agent.channels) {
            try {
              await invoke('cmd_stop_agent_channel', { agentId: agent.id, channelId: ch.id });
              stoppedCount++;
            } catch { /* channel may not be running */ }
          }
        }
        await patchAgentConfig(agent.id, { enabled: false });
        toastRef.current.success(
          stoppedCount > 0
            ? `主动 Agent 模式已关闭，${stoppedCount} 个渠道已停止`
            : '主动 Agent 模式已关闭',
        );
      } else {
        // Re-enable — auto-restart channels that have credentials (setupCompleted)
        await patchAgentConfig(agent.id, { enabled: true });
        await refreshConfig(); // Refresh first so invokeStartAgentChannel reads latest config
        // Re-read the latest agent config after refresh
        const latestAgent = getAgentById(await (async () => {
          const { loadAppConfig } = await import('@/config/services/appConfigService');
          return loadAppConfig();
        })(), agent.id);
        if (latestAgent && isTauriEnvironment()) {
          const startable = latestAgent.channels.filter(ch => ch.enabled && ch.setupCompleted);
          let startedCount = 0;
          for (const ch of startable) {
            try {
              await invokeStartAgentChannel(latestAgent, ch);
              startedCount++;
            } catch (e) {
              console.warn(`[WorkspaceGeneralTab] Auto-start channel ${ch.id} failed:`, e);
            }
          }
          toastRef.current.success(
            startedCount > 0
              ? `主动 Agent 模式已开启，${startedCount} 个渠道已启动`
              : '主动 Agent 模式已开启',
          );
        } else {
          toastRef.current.success('主动 Agent 模式已开启');
        }
        if (isMountedRef.current) await refreshStatuses();
        if (isMountedRef.current) setToggling(false);
        return; // refreshConfig already called above
      }
      await refreshConfig();
      if (isMountedRef.current) await refreshStatuses();
    } catch (e) {
      console.error('[WorkspaceGeneralTab] Toggle proactive failed:', e);
      toastRef.current.error('操作失败');
    } finally {
      if (isMountedRef.current) setToggling(false);
    }
  }, [project, agent, agentDir, config.defaultPermissionMode, toggling, patchProject, refreshConfig, refreshStatuses]);

  const status = agent ? statuses[agent.id] : undefined;
  const displayName = project?.displayName || project?.name || agentDir.split(/[/\\]/).filter(Boolean).pop() || 'Workspace';

  if (!project) {
    return (
      <div className="flex items-center justify-center py-12">
        <span className="text-sm text-[var(--ink-subtle)]">未找到工作区配置</span>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto px-8 py-6">
      <div className="mx-auto max-w-2xl space-y-0 pb-8">
        {/* Header: icon + name + path */}
        <div className="flex items-center gap-3 pb-6">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--paper-inset)]">
            <WorkspaceIcon icon={project.icon || DEFAULT_WORKSPACE_ICON} size={24} />
          </div>
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-[var(--ink)]">{displayName}</h2>
            <p className="truncate text-xs text-[var(--ink-muted)]">{shortenPathForDisplay(agentDir)}</p>
          </div>
        </div>

        {/* Section 1: Workspace Basics (L1) */}
        <div className="border-b border-[var(--line)] pb-6">
          <h3 className="mb-4 text-lg font-semibold text-[var(--ink)]">基础设置</h3>
          <WorkspaceBasicsSection project={project} agent={agent} />
        </div>

        {/* Section 2: Proactive Agent Toggle (L1) */}
        <div className="pt-6">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-lg font-semibold text-[var(--ink)]">主动 Agent 模式</h3>
              <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
                启用后可添加 IM 渠道（飞书、Telegram、钉钉等），让 AI 主动与用户交互
              </p>
            </div>
            <button
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus:outline-none ${
                isProactive ? 'bg-[var(--accent)]' : 'bg-[var(--line-strong)]'
              }`}
              onClick={handleToggleProactive}
              disabled={toggling}
            >
              <span
                className={`pointer-events-none inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm ring-0 transition-transform ${
                  isProactive ? 'translate-x-4' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>
        </div>

        {/* Section 3: Proactive Agent sections (only when enabled) */}
        {isProactive && agent && (
          <>
            {/* Channels */}
            <div className="border-b border-[var(--line)] pb-6 pt-6">
              <AgentChannelsSection agent={agent} status={status} onAgentChanged={handleAgentChanged} />
            </div>

            {/* Heartbeat */}
            <div className="border-b border-[var(--line)] pb-6 pt-6">
              <AgentHeartbeatSection agent={agent} onAgentChanged={handleAgentChanged} />
            </div>

            {/* Tasks */}
            <div className="pt-6">
              <AgentTasksSection agent={agent} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
