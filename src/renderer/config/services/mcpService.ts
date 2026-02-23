// MCP server management — CRUD, env, args, effective servers
import type { McpServerDefinition } from '../types';
import { PRESET_MCP_SERVERS } from '../types';
import { withProjectsLock } from './configStore';
import { loadAppConfig, atomicModifyConfig } from './appConfigService';
import { loadProjects, saveProjects } from './projectService';

/**
 * Get all available MCP servers (preset + custom), with user-configured args/env merged in
 */
export async function getAllMcpServers(): Promise<McpServerDefinition[]> {
    const config = await loadAppConfig();
    const customServers = config.mcpServers ?? [];
    const allServers = [...PRESET_MCP_SERVERS, ...customServers];
    const serverArgsConfig = config.mcpServerArgs ?? {};
    const serverEnvConfig = config.mcpServerEnv ?? {};

    return allServers.map(server => {
        const extraArgs = serverArgsConfig[server.id];
        const extraEnv = serverEnvConfig[server.id];
        if (extraArgs === undefined && !extraEnv) return server;
        return {
            ...server,
            ...(extraArgs !== undefined && { args: [...(server.args ?? []), ...extraArgs] }),
            ...(extraEnv && { env: { ...server.env, ...extraEnv } }),
        };
    });
}

export async function getEnabledMcpServerIds(): Promise<string[]> {
    const config = await loadAppConfig();
    return config.mcpEnabledServers ?? [];
}

export async function toggleMcpServerEnabled(serverId: string, enabled: boolean): Promise<void> {
    await atomicModifyConfig(c => {
        const enabledServers = new Set(c.mcpEnabledServers ?? []);
        if (enabled) {
            enabledServers.add(serverId);
        } else {
            enabledServers.delete(serverId);
        }
        return { ...c, mcpEnabledServers: Array.from(enabledServers) };
    });
    console.log('[configService] MCP server toggled:', serverId, enabled);
}

export async function addCustomMcpServer(server: McpServerDefinition): Promise<void> {
    await atomicModifyConfig(c => {
        const customServers = [...(c.mcpServers ?? [])];
        const existingIndex = customServers.findIndex(s => s.id === server.id);
        if (existingIndex >= 0) {
            customServers[existingIndex] = server;
        } else {
            customServers.push(server);
        }
        return { ...c, mcpServers: customServers };
    });
    console.log('[configService] Custom MCP server added:', server.id);
}

export async function deleteCustomMcpServer(serverId: string): Promise<void> {
    await atomicModifyConfig(c => ({
        ...c,
        mcpServers: (c.mcpServers ?? []).filter(s => s.id !== serverId),
        mcpEnabledServers: (c.mcpEnabledServers ?? []).filter(id => id !== serverId),
    }));
    console.log('[configService] Custom MCP server deleted:', serverId);
}

export async function saveMcpServerEnv(serverId: string, env: Record<string, string>): Promise<void> {
    await atomicModifyConfig(c => ({
        ...c,
        mcpServerEnv: { ...(c.mcpServerEnv ?? {}), [serverId]: env },
    }));
    console.log('[configService] MCP server env saved:', serverId);
}

export async function getMcpServerEnv(serverId: string): Promise<Record<string, string>> {
    const config = await loadAppConfig();
    return config.mcpServerEnv?.[serverId] ?? {};
}

export async function saveMcpServerArgs(serverId: string, args: string[]): Promise<void> {
    await atomicModifyConfig(c => ({
        ...c,
        mcpServerArgs: { ...(c.mcpServerArgs ?? {}), [serverId]: args },
    }));
    console.log('[configService] MCP server args saved:', serverId);
}

export async function getMcpServerArgs(serverId: string): Promise<string[] | undefined> {
    const config = await loadAppConfig();
    return config.mcpServerArgs?.[serverId];
}

export async function updateProjectMcpServers(projectId: string, enabledServerIds: string[]): Promise<void> {
    return withProjectsLock(async () => {
        const projects = await loadProjects();
        const index = projects.findIndex(p => p.id === projectId);
        if (index >= 0) {
            projects[index] = { ...projects[index], mcpEnabledServers: enabledServerIds };
            await saveProjects(projects);
            console.log('[configService] Project MCP servers updated:', projectId, enabledServerIds);
        }
    });
}

export async function getEffectiveMcpServers(projectId: string): Promise<McpServerDefinition[]> {
    const projects = await loadProjects();
    const project = projects.find(p => p.id === projectId);
    const workspaceEnabledIds = project?.mcpEnabledServers ?? [];

    if (workspaceEnabledIds.length === 0) {
        return [];
    }

    const allServers = await getAllMcpServers();
    const config = await loadAppConfig();
    const globalEnabledIds = new Set(config.mcpEnabledServers ?? []);

    return allServers.filter(s =>
        globalEnabledIds.has(s.id) && workspaceEnabledIds.includes(s.id)
    );
}
