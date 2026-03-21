/**
 * Admin API — Self-Configuration endpoints for the CLI tool.
 *
 * All handlers follow the same pattern:
 *   1. Validate input
 *   2. If dry-run → return preview
 *   3. Write config (atomicModifyConfig)
 *   4. Update Sidecar in-memory state
 *   5. Broadcast SSE event for frontend sync
 *   6. Return result
 */

import type { McpServerDefinition } from '../renderer/config/types';
import {
  loadConfig,
  atomicModifyConfig,
  getAllMcpServers,
  getEnabledMcpServerIds,
  loadProjects,
  saveProjects,
  redactSecret,
  type AdminAppConfig,
  type AgentConfigSlim,
  type ChannelConfigSlim,
} from './utils/admin-config';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { resolve } from 'path';
import { setMcpServers, getMcpServers, getAgentState } from './agent-session';
import { broadcast } from './sse';
import { getHomeDirOrNull } from './utils/platform';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AdminResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  hint?: string;
  dryRun?: boolean;
  preview?: unknown;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// MCP Handlers
// ---------------------------------------------------------------------------

export function handleMcpList(): AdminResponse {
  const config = loadConfig();
  const allServers = getAllMcpServers(config);
  const enabledIds = new Set(getEnabledMcpServerIds(config));

  const data = allServers.map(s => ({
    id: s.id,
    name: s.name,
    type: s.type,
    enabled: enabledIds.has(s.id),
    isBuiltin: s.isBuiltin,
    command: s.command,
    url: s.url,
    requiresConfig: s.requiresConfig,
    hasEnv: !!(s.env && Object.keys(s.env).length > 0),
  }));

  return { success: true, data };
}

export function handleMcpAdd(payload: {
  server: Partial<McpServerDefinition>;
  dryRun?: boolean;
}): AdminResponse {
  const { dryRun } = payload;
  const s = payload.server;

  // Validate required fields
  if (!s.id) return { success: false, error: 'Missing required field: id' };
  if (!s.type) return { success: false, error: 'Missing required field: type' };
  if (s.type === 'stdio' && !s.command) {
    return { success: false, error: 'stdio type requires "command" field' };
  }
  if ((s.type === 'sse' || s.type === 'http') && !s.url) {
    return { success: false, error: `${s.type} type requires "url" field` };
  }

  const server: McpServerDefinition = {
    id: s.id,
    name: s.name || s.id,
    type: s.type,
    description: s.description,
    command: s.command,
    args: s.args,
    env: s.env,
    url: s.url,
    headers: s.headers,
    isBuiltin: false,
    requiresConfig: s.requiresConfig,
    websiteUrl: s.websiteUrl,
    configHint: s.configHint,
  };

  if (dryRun) {
    return { success: true, dryRun: true, preview: server };
  }

  atomicModifyConfig(c => ({
    ...c,
    mcpServers: [...(c.mcpServers || []).filter(x => x.id !== server.id), server],
  }));

  notifyMcpChange('add', server.id);
  return {
    success: true,
    data: { id: server.id, name: server.name },
    hint: 'Server added. Use "myagents mcp enable" to activate.',
  };
}

export function handleMcpRemove(payload: { id: string }): AdminResponse {
  const { id } = payload;
  if (!id) return { success: false, error: 'Missing required field: id' };

  // Check if it's a built-in preset
  const allServers = getAllMcpServers();
  const target = allServers.find(s => s.id === id);
  if (!target) return { success: false, error: `MCP server '${id}' not found` };
  if (target.isBuiltin) {
    return { success: false, error: `Cannot remove built-in MCP server '${id}'. Only custom servers can be removed.` };
  }

  atomicModifyConfig(c => {
    const servers = (c.mcpServers || []).filter(s => s.id !== id);
    const enabled = (c.mcpEnabledServers || []).filter(s => s !== id);
    const envOverrides = { ...(c.mcpServerEnv || {}) };
    delete envOverrides[id];
    const argsOverrides = { ...(c.mcpServerArgs || {}) };
    delete argsOverrides[id];
    return { ...c, mcpServers: servers, mcpEnabledServers: enabled, mcpServerEnv: envOverrides, mcpServerArgs: argsOverrides };
  });

  notifyMcpChange('remove', id);
  return { success: true, data: { id }, hint: 'Server removed.' };
}

export function handleMcpEnable(payload: { id: string; scope?: string }): AdminResponse {
  const { id, scope = 'both' } = payload;
  if (!id) return { success: false, error: 'Missing required field: id' };

  // Verify server exists
  const allServers = getAllMcpServers();
  if (!allServers.find(s => s.id === id)) {
    return { success: false, error: `MCP server '${id}' not found` };
  }

  if (scope === 'global' || scope === 'both') {
    atomicModifyConfig(c => {
      const enabled = new Set(c.mcpEnabledServers || []);
      enabled.add(id);
      return { ...c, mcpEnabledServers: Array.from(enabled) };
    });
  }

  if (scope === 'project' || scope === 'both') {
    enableMcpForCurrentProject(id);
  }

  notifyMcpChange('enable', id);
  const scopeLabel = scope === 'both' ? 'global + project' : scope;
  return { success: true, data: { id, scope: scopeLabel }, hint: `Enabled ${id} (${scopeLabel}).` };
}

export function handleMcpDisable(payload: { id: string; scope?: string }): AdminResponse {
  const { id, scope = 'both' } = payload;
  if (!id) return { success: false, error: 'Missing required field: id' };

  if (scope === 'global' || scope === 'both') {
    atomicModifyConfig(c => {
      const enabled = new Set(c.mcpEnabledServers || []);
      enabled.delete(id);
      return { ...c, mcpEnabledServers: Array.from(enabled) };
    });
  }

  if (scope === 'project' || scope === 'both') {
    disableMcpForCurrentProject(id);
  }

  notifyMcpChange('disable', id);
  return { success: true, data: { id } };
}

export function handleMcpEnv(payload: {
  id: string;
  action: 'set' | 'get' | 'delete';
  env?: Record<string, string>;
}): AdminResponse {
  const { id, action, env } = payload;
  if (!id) return { success: false, error: 'Missing required field: id' };

  if (action === 'get') {
    const config = loadConfig();
    const serverEnv = (config.mcpServerEnv ?? {})[id] ?? {};
    // Redact values for safety
    const redacted: Record<string, string> = {};
    for (const [k, v] of Object.entries(serverEnv)) {
      redacted[k] = redactSecret(v);
    }
    return { success: true, data: { id, env: redacted } };
  }

  if (action === 'set') {
    if (!env || Object.keys(env).length === 0) {
      return { success: false, error: 'No environment variables provided' };
    }
    atomicModifyConfig(c => {
      const mcpServerEnv = { ...(c.mcpServerEnv || {}) };
      mcpServerEnv[id] = { ...(mcpServerEnv[id] || {}), ...env };
      return { ...c, mcpServerEnv };
    });
    notifyMcpChange('env', id);
    return { success: true, data: { id, keys: Object.keys(env) }, hint: 'Environment variables updated.' };
  }

  if (action === 'delete') {
    if (!env || Object.keys(env).length === 0) {
      return { success: false, error: 'No keys specified for deletion' };
    }
    atomicModifyConfig(c => {
      const mcpServerEnv = { ...(c.mcpServerEnv || {}) };
      if (mcpServerEnv[id]) {
        for (const key of Object.keys(env)) {
          delete mcpServerEnv[id][key];
        }
        if (Object.keys(mcpServerEnv[id]).length === 0) {
          delete mcpServerEnv[id];
        }
      }
      return { ...c, mcpServerEnv };
    });
    notifyMcpChange('env', id);
    return { success: true, data: { id, deletedKeys: Object.keys(env) } };
  }

  return { success: false, error: `Unknown action: ${action}. Use 'set', 'get', or 'delete'.` };
}

export async function handleMcpTest(payload: { id: string }): Promise<AdminResponse> {
  const { id } = payload;
  if (!id) return { success: false, error: 'Missing required field: id' };

  const allServers = getAllMcpServers();
  const server = allServers.find(s => s.id === id);
  if (!server) return { success: false, error: `MCP server '${id}' not found` };

  // Validate config completeness
  if (server.type === 'stdio' && !server.command) {
    return { success: false, error: `MCP server '${id}' has no command configured` };
  }
  if ((server.type === 'sse' || server.type === 'http') && !server.url) {
    return { success: false, error: `MCP server '${id}' has no URL configured` };
  }

  // Built-in MCP: delegate to registry
  if (server.command === '__builtin__') {
    try {
      const { getBuiltinMcp } = await import('./tools/builtin-mcp-registry');
      const entry = getBuiltinMcp(server.id);
      if (entry?.validate) {
        const validationError = await entry.validate(server.env || {});
        if (validationError) {
          const errMsg = typeof validationError === 'string' ? validationError : JSON.stringify(validationError);
          return { success: false, error: errMsg };
        }
      }
    } catch { /* registry not loaded */ }
    return { success: true, data: { id, type: 'builtin' }, hint: 'Built-in MCP validated.' };
  }

  // SSE/HTTP: test URL reachability
  if (server.type === 'sse' || server.type === 'http') {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const headers: Record<string, string> = {
        'Accept': server.type === 'sse' ? 'text/event-stream' : 'application/json, text/event-stream',
        'Accept-Encoding': 'identity',
        ...(server.headers || {}),
      };

      const resp = server.type === 'http'
        ? await fetch(server.url!, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'MyAgents', version: '1.0' } } }),
            signal: controller.signal,
          })
        : await fetch(server.url!, { method: 'GET', headers, signal: controller.signal });

      clearTimeout(timeout);

      if (resp.status === 401 || resp.status === 403) {
        return { success: false, error: `Authentication failed (HTTP ${resp.status}). Check headers or API key.` };
      }
      if (!resp.ok) {
        return { success: false, error: `Server returned HTTP ${resp.status}` };
      }

      return { success: true, data: { id, type: server.type, status: resp.status }, hint: `Connection OK (HTTP ${resp.status}).` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('abort')) return { success: false, error: 'Connection timed out (15s).' };
      return { success: false, error: `Connection failed: ${msg}` };
    }
  }

  // stdio: check command exists in PATH
  if (server.type === 'stdio' && server.command && server.command !== '__builtin__') {
    try {
      const { getShellEnv } = await import('./utils/shell');
      const checkCmd = process.platform === 'win32' ? 'where' : 'which';
      const { spawn } = await import('child_process');
      const code = await new Promise<number | null>(resolve => {
        const proc = spawn(checkCmd, [server.command!], { stdio: 'ignore', env: getShellEnv() });
        proc.on('close', resolve);
        proc.on('error', () => resolve(null));
      });
      if (code === 0) {
        return { success: true, data: { id, type: 'stdio', command: server.command }, hint: `Command '${server.command}' found.` };
      }
      return { success: false, error: `Command '${server.command}' not found in PATH.` };
    } catch (err) {
      return { success: false, error: `Failed to check command: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  return { success: true, data: { id, type: server.type }, hint: 'Configuration valid.' };
}

// ---------------------------------------------------------------------------
// Model Provider Handlers
// ---------------------------------------------------------------------------

export function handleModelList(): AdminResponse {
  const config = loadConfig();
  const apiKeys = config.providerApiKeys ?? {};
  const verifyStatus = config.providerVerifyStatus ?? {};

  // Load preset providers
  let presetProviders: Array<Record<string, unknown>> = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PRESET_PROVIDERS } = require('../renderer/config/types');
    presetProviders = PRESET_PROVIDERS ?? [];
  } catch { /* ignore */ }

  // Load custom providers
  const customProviders = loadCustomProviderFiles();

  const allProviders = [...presetProviders, ...customProviders];
  const data = allProviders.map(p => {
    const id = String(p.id);
    const cfg = p.config as Record<string, unknown> | undefined;
    return {
      id,
      name: String(p.name),
      vendor: p.vendor ? String(p.vendor) : undefined,
      baseUrl: cfg?.baseUrl ? String(cfg.baseUrl) : undefined,
      isBuiltin: !!p.isBuiltin,
      protocol: p.apiProtocol ? String(p.apiProtocol) : 'anthropic',
      hasApiKey: !!apiKeys[id],
      status: (verifyStatus[id] as Record<string, unknown>)?.status ?? 'not-set',
    };
  });

  return { success: true, data };
}

export function handleModelSetKey(payload: { id: string; apiKey: string }): AdminResponse {
  const { id, apiKey } = payload;
  if (!id) return { success: false, error: 'Missing required field: id' };
  if (!apiKey) return { success: false, error: 'Missing required field: apiKey' };

  atomicModifyConfig(c => ({
    ...c,
    providerApiKeys: { ...(c.providerApiKeys || {}), [id]: apiKey },
  }));

  broadcast('config:changed', { section: 'model', action: 'set-key', id });
  return { success: true, data: { id }, hint: `API key saved for ${id}.` };
}

export function handleModelSetDefault(payload: { id: string }): AdminResponse {
  const { id } = payload;
  if (!id) return { success: false, error: 'Missing required field: id' };

  atomicModifyConfig(c => ({
    ...c,
    defaultProviderId: id,
  }));

  broadcast('config:changed', { section: 'model', action: 'set-default', id });
  return { success: true, data: { id }, hint: `Default provider set to ${id}.` };
}

export async function handleModelVerify(payload: { id: string; model?: string }): Promise<AdminResponse> {
  const { id } = payload;
  if (!id) return { success: false, error: 'Missing required field: id' };

  const config = loadConfig();
  const apiKey = (config.providerApiKeys ?? {})[id];
  if (!apiKey) {
    return { success: false, error: `No API key set for provider '${id}'. Use 'myagents model set-key' first.` };
  }

  // Look up provider config (preset or custom)
  const provider = findProvider(id);
  if (!provider) {
    return { success: false, error: `Provider '${id}' not found in presets or custom providers.` };
  }

  const providerConfig = (provider.config ?? {}) as Record<string, unknown>;
  const baseUrl = String(providerConfig.baseUrl ?? '');
  const authType = String(provider.authType ?? 'both');
  const apiProtocol = provider.apiProtocol as 'anthropic' | 'openai' | undefined;
  const verifyModel = payload.model ?? String(provider.primaryModel ?? '');

  try {
    const { verifyProviderViaSdk } = await import('./provider-verify');
    const result = await verifyProviderViaSdk(
      baseUrl, apiKey, authType, verifyModel,
      apiProtocol,
      provider.maxOutputTokens ? Number(provider.maxOutputTokens) : undefined,
      provider.upstreamFormat as 'chat_completions' | 'responses' | undefined,
    );

    if (result.success) {
      // Persist verify status
      atomicModifyConfig(c => ({
        ...c,
        providerVerifyStatus: {
          ...(c.providerVerifyStatus ?? {}),
          [id]: { status: 'valid', verifiedAt: new Date().toISOString() },
        },
      }));
      broadcast('config:changed', { section: 'model', action: 'verify', id });
      return { success: true, data: { id, model: verifyModel }, hint: 'Verification successful.' };
    }

    return { success: false, error: result.error ?? 'Verification failed', data: { id, detail: result.detail } };
  } catch (err) {
    return { success: false, error: `Verification error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function handleModelAdd(payload: {
  provider: Record<string, unknown>;
  dryRun?: boolean;
}): AdminResponse {
  const { dryRun } = payload;
  const p = payload.provider;

  // Validate required fields
  if (!p.id) return { success: false, error: 'Missing required field: id' };
  if (!p.name) return { success: false, error: 'Missing required field: name' };
  if (!p.baseUrl) return { success: false, error: 'Missing required field: baseUrl (API endpoint)' };
  if (!p.models || !Array.isArray(p.models) || p.models.length === 0) {
    return { success: false, error: 'Missing required field: models (at least one model ID required)' };
  }

  // Build model entities
  const modelSeries = (p.modelSeries as string) || String(p.id);
  const modelIds = p.models as string[];
  const modelNames = (p.modelNames as string[]) || modelIds;
  const models = modelIds.map((model, i) => ({
    model,
    modelName: modelNames[i] || model,
    modelSeries,
  }));

  // Build aliases
  let modelAliases: Record<string, string> | undefined;
  if (p.aliases && typeof p.aliases === 'object') {
    modelAliases = p.aliases as Record<string, string>;
  } else if (modelIds.length > 0) {
    // Default: map sonnet/opus/haiku to first model
    modelAliases = { sonnet: modelIds[0], opus: modelIds[0], haiku: modelIds[0] };
  }

  const providerObj = {
    id: String(p.id),
    name: String(p.name),
    vendor: String(p.vendor ?? p.name),
    cloudProvider: String(p.cloudProvider ?? ''),
    type: 'api' as const,
    primaryModel: String(p.primaryModel ?? modelIds[0]),
    isBuiltin: false,
    config: {
      baseUrl: String(p.baseUrl),
      ...(p.timeout ? { timeout: Number(p.timeout) } : {}),
      ...(p.disableNonessential ? { disableNonessential: true } : {}),
    },
    authType: String(p.authType ?? 'auth_token'),
    ...(p.protocol === 'openai' || p.apiProtocol === 'openai' ? {
      apiProtocol: 'openai' as const,
      maxOutputTokens: Number(p.maxOutputTokens ?? 8192),
      upstreamFormat: String(p.upstreamFormat ?? 'chat_completions') as 'chat_completions' | 'responses',
    } : {}),
    websiteUrl: p.websiteUrl ? String(p.websiteUrl) : undefined,
    models,
    modelAliases,
  };

  if (dryRun) {
    return { success: true, dryRun: true, preview: providerObj };
  }

  // Write to ~/.myagents/providers/{id}.json
  saveCustomProviderFile(providerObj);
  broadcast('config:changed', { section: 'model', action: 'add', id: providerObj.id });
  return {
    success: true,
    data: { id: providerObj.id, name: providerObj.name, models: modelIds },
    hint: `Provider added. Use 'myagents model set-key ${providerObj.id} <key>' to set API key.`,
  };
}

export function handleModelRemove(payload: { id: string }): AdminResponse {
  const { id } = payload;
  if (!id) return { success: false, error: 'Missing required field: id' };

  // Check if it's a preset
  const provider = findProvider(id);
  if (provider?.isBuiltin) {
    return { success: false, error: `Cannot remove built-in provider '${id}'. Only custom providers can be removed.` };
  }

  // Delete provider file
  if (!deleteCustomProviderFile(id)) {
    return { success: false, error: `Custom provider '${id}' not found.` };
  }

  // Clean up API key and verify status
  atomicModifyConfig(c => {
    const apiKeys = { ...(c.providerApiKeys ?? {}) };
    delete apiKeys[id];
    const verifyStatus = { ...(c.providerVerifyStatus ?? {}) };
    delete verifyStatus[id];
    // If this was the default provider, clear it
    const defaultId = c.defaultProviderId === id ? undefined : c.defaultProviderId;
    return { ...c, providerApiKeys: apiKeys, providerVerifyStatus: verifyStatus, defaultProviderId: defaultId };
  });

  broadcast('config:changed', { section: 'model', action: 'remove', id });
  return { success: true, data: { id }, hint: 'Provider removed.' };
}

// ---------------------------------------------------------------------------
// Agent Handlers
// ---------------------------------------------------------------------------

export function handleAgentList(): AdminResponse {
  const config = loadConfig();
  const agents = (config.agents ?? []).map(a => ({
    id: a.id,
    name: a.name,
    enabled: a.enabled,
    workspacePath: a.workspacePath,
    channelCount: (a.channels ?? []).length,
    channels: (a.channels ?? []).map(ch => ({
      id: ch.id,
      type: ch.type,
      name: ch.name,
      enabled: ch.enabled,
    })),
  }));
  return { success: true, data: agents };
}

export function handleAgentEnable(payload: { id: string }): AdminResponse {
  const { id } = payload;
  return modifyAgent(id, agent => ({ ...agent, enabled: true }), 'enable');
}

export function handleAgentDisable(payload: { id: string }): AdminResponse {
  const { id } = payload;
  return modifyAgent(id, agent => ({ ...agent, enabled: false }), 'disable');
}

export function handleAgentSet(payload: { id: string; key: string; value: unknown }): AdminResponse {
  const { id, key, value } = payload;
  if (!id) return { success: false, error: 'Missing required field: id' };
  if (!key) return { success: false, error: 'Missing required field: key' };

  // Protect sensitive/structural fields
  const protectedFields = ['id', 'channels'];
  if (protectedFields.includes(key)) {
    return { success: false, error: `Cannot directly set field '${key}'. Use specific commands instead.` };
  }

  return modifyAgent(id, agent => ({ ...agent, [key]: value }), 'set');
}

export function handleAgentChannelList(payload: { agentId: string }): AdminResponse {
  const config = loadConfig();
  const agent = (config.agents ?? []).find(a => a.id === payload.agentId);
  if (!agent) return { success: false, error: `Agent '${payload.agentId}' not found` };

  return { success: true, data: (agent.channels ?? []).map(ch => ({
    id: ch.id,
    type: ch.type,
    name: ch.name,
    enabled: ch.enabled,
  })) };
}

export function handleAgentChannelAdd(payload: {
  agentId: string;
  channel: Record<string, unknown>;
}): AdminResponse {
  const { agentId, channel } = payload;
  if (!agentId) return { success: false, error: 'Missing required field: agentId' };
  if (!channel.type) return { success: false, error: 'Missing required field: channel.type' };

  const channelId = channel.id as string || crypto.randomUUID();
  const newChannel: ChannelConfigSlim = {
    ...channel,        // user-provided fields first
    id: channelId,     // override with guaranteed values
    type: channel.type as string,
    name: channel.name as string || `${channel.type} channel`,
    enabled: channel.enabled !== undefined ? !!channel.enabled : true,
  };

  return modifyAgent(agentId, agent => ({
    ...agent,
    channels: [...(agent.channels ?? []), newChannel],
  }), 'channel-add');
}

export function handleAgentChannelRemove(payload: { agentId: string; channelId: string }): AdminResponse {
  const { agentId, channelId } = payload;
  if (!agentId) return { success: false, error: 'Missing required field: agentId' };
  if (!channelId) return { success: false, error: 'Missing required field: channelId' };

  return modifyAgent(agentId, agent => ({
    ...agent,
    channels: (agent.channels ?? []).filter(ch => ch.id !== channelId),
  }), 'channel-remove');
}

// ---------------------------------------------------------------------------
// Config Handlers
// ---------------------------------------------------------------------------

export function handleConfigGet(payload: { key: string }): AdminResponse {
  const { key } = payload;
  if (!key) return { success: false, error: 'Missing required field: key' };

  const config = loadConfig();
  const value = getNestedValue(config, key);
  if (value === undefined) {
    return { success: false, error: `Config key '${key}' not found` };
  }

  // Redact sensitive fields recursively
  const redacted = redactSensitiveValues(key, value);
  return { success: true, data: { key, value: redacted } };
}

export function handleConfigSet(payload: { key: string; value: unknown; dryRun?: boolean }): AdminResponse {
  const { key, value, dryRun } = payload;
  if (!key) return { success: false, error: 'Missing required field: key' };

  // Protect structural/sensitive keys that have dedicated commands
  const protectedKeys = ['providerApiKeys', 'agents', 'mcpServers', 'mcpEnabledServers', 'mcpServerEnv', 'imBotConfigs'];
  const rootKey = key.split('.')[0];
  if (protectedKeys.includes(rootKey)) {
    return { success: false, error: `Cannot set '${key}' via config set. Use dedicated commands (e.g., 'myagents mcp', 'myagents agent', 'myagents model set-key').` };
  }

  if (dryRun) {
    return { success: true, dryRun: true, preview: { key, value } };
  }

  atomicModifyConfig(c => setNestedValue(c, key, value));
  broadcast('config:changed', { section: 'config', action: 'set', key });
  return { success: true, data: { key }, hint: `Config '${key}' updated.` };
}

// ---------------------------------------------------------------------------
// Status & Reload
// ---------------------------------------------------------------------------

export function handleStatus(): AdminResponse {
  const config = loadConfig();
  const allServers = getAllMcpServers(config);
  const enabledIds = getEnabledMcpServerIds(config);
  const currentMcp = getMcpServers();

  return {
    success: true,
    data: {
      mcpServers: { total: allServers.length, enabled: enabledIds.length },
      activeMcpInSession: currentMcp ? currentMcp.length : 0,
      defaultProvider: config.defaultProviderId ?? 'not set',
      agents: (config.agents ?? []).length,
    },
  };
}

export function handleReload(workspacePath?: string): AdminResponse {
  // Re-read config from disk and push effective MCP to in-memory state
  const config = loadConfig();
  const allServers = getAllMcpServers(config);
  const globalEnabled = new Set(getEnabledMcpServerIds(config));

  let effectiveServers: McpServerDefinition[];

  if (workspacePath) {
    // Filter by project if workspace is known
    const projects = loadProjects();
    const project = projects.find(p => p.path === workspacePath);
    const projectEnabled = new Set(project?.mcpEnabledServers ?? []);
    effectiveServers = allServers.filter(s => globalEnabled.has(s.id) && projectEnabled.has(s.id));
  } else {
    // Fallback: use all globally enabled servers
    effectiveServers = allServers.filter(s => globalEnabled.has(s.id));
  }

  setMcpServers(effectiveServers);
  broadcast('config:changed', { section: 'all', action: 'reload' });
  return { success: true, hint: 'Configuration reloaded. MCP tools will be available in next turn.' };
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

const HELP_TEXTS: Record<string, string> = {
  mcp: `myagents mcp — Manage MCP tool servers

Commands:
  list                     List all MCP servers
  add                      Add a new MCP server
  remove <id>              Remove a custom MCP server
  enable <id>              Enable an MCP server
  disable <id>             Disable an MCP server
  test <id>                Validate MCP server connectivity
  env <id> <action>        Manage environment variables

Options for 'add':
  --id          Server ID (required)
  --name        Display name (defaults to id)
  --type        stdio | sse | http (default: stdio)
  --command     Command to run (for stdio)
  --args        Arguments (repeatable)
  --url         Endpoint URL (for sse/http)
  --env         KEY=VALUE (repeatable)

Options for 'enable' / 'disable':
  --scope       global | project | both (default: both)

Options for 'env':
  set KEY=VALUE [KEY2=VALUE2 ...]
  get
  delete KEY [KEY2 ...]`,

  model: `myagents model — Manage model providers

Commands:
  list                     List all providers (preset + custom)
  add                      Add a custom provider
  remove <id>              Remove a custom provider
  set-key <id> <api-key>   Set API key for a provider
  verify <id> [--model m]  Verify API key (sends a test message)
  set-default <id>         Set default provider

Options for 'add':
  --id            Provider ID (required)
  --name          Display name (required)
  --base-url      API endpoint URL (required)
  --models        Model IDs (repeatable, at least one)
  --model-names   Display names for models (repeatable)
  --primary-model Default model (default: first in --models)
  --auth-type     auth_token | api_key | both (default: auth_token)
  --protocol      anthropic | openai (default: anthropic)
  --upstream-format  chat_completions | responses (openai only)
  --max-output-tokens  Max output limit (openai only)
  --aliases       SDK alias mapping: sonnet=model,opus=model,haiku=model
  --vendor        Vendor name
  --website-url   Provider website`,

  agent: `myagents agent — Manage agents & channels

Commands:
  list                     List all agents
  enable <id>              Enable an agent
  disable <id>             Disable an agent
  set <id> <key> <value>   Set agent config field
  channel list <agent-id>  List channels for an agent
  channel add <agent-id>   Add a channel
  channel remove <a-id> <ch-id>  Remove a channel

Options for 'channel add':
  --type        telegram | feishu | dingtalk (required)
  --token       Bot token (for telegram)
  --app-id      App ID (for feishu/dingtalk)
  --app-secret  App Secret (for feishu/dingtalk)`,

  config: `myagents config — Read/write application config

Commands:
  get <key>               Read a config value
  set <key> <value>       Set a config value`,
};

export function handleHelp(payload: { path?: string[] }): AdminResponse {
  const path = payload.path ?? [];
  const group = path[0];

  if (group && HELP_TEXTS[group]) {
    return { success: true, data: { text: HELP_TEXTS[group] } };
  }

  return {
    success: true,
    data: {
      text: `Available command groups: mcp, model, agent, config, status, reload
Use "myagents <group> --help" for details on a specific group.`,
    },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Provider file I/O (~/.myagents/providers/{id}.json)
// ---------------------------------------------------------------------------

function getProvidersDir(): string {
  const home = getHomeDirOrNull();
  if (!home) throw new Error('Cannot determine home directory');
  return resolve(home, '.myagents', 'providers');
}

/** Find a provider by ID (preset + custom) */
function findProvider(id: string): Record<string, unknown> | null {
  // Check presets first
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PRESET_PROVIDERS } = require('../renderer/config/types');
    const preset = (PRESET_PROVIDERS as Array<Record<string, unknown>>)?.find(
      (p: Record<string, unknown>) => p.id === id
    );
    if (preset) return preset;
  } catch { /* ignore */ }

  // Check custom providers
  const dir = getProvidersDir();
  const filePath = resolve(dir, `${id}.json`);
  if (existsSync(filePath)) {
    try {
      return JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
    } catch { /* ignore */ }
  }
  return null;
}

/** Load all custom provider files */
function loadCustomProviderFiles(): Array<Record<string, unknown>> {
  const dir = getProvidersDir();
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          return JSON.parse(readFileSync(resolve(dir, f), 'utf-8')) as Record<string, unknown>;
        } catch { return null; }
      })
      .filter((p): p is Record<string, unknown> => p !== null && !!p.id);
  } catch { return []; }
}

/** Save a custom provider JSON file */
function saveCustomProviderFile(provider: Record<string, unknown>): void {
  const dir = getProvidersDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const filePath = resolve(dir, `${provider.id}.json`);
  writeFileSync(filePath, JSON.stringify(provider, null, 2), 'utf-8');
}

/** Delete a custom provider file. Returns true if file existed. */
function deleteCustomProviderFile(id: string): boolean {
  const filePath = resolve(getProvidersDir(), `${id}.json`);
  if (!existsSync(filePath)) return false;
  unlinkSync(filePath);
  return true;
}

// ---------------------------------------------------------------------------
// MCP helpers
// ---------------------------------------------------------------------------

/** Update Sidecar MCP state and notify frontend after config change.
 *  Respects project-scope: only servers enabled both globally AND in the
 *  current workspace project are pushed to the session. */
function notifyMcpChange(action: string, id: string): void {
  const workspacePath = getCurrentWorkspacePath();
  const config = loadConfig();
  const allServers = getAllMcpServers(config);
  const globalEnabled = new Set(getEnabledMcpServerIds(config));

  let effectiveServers: McpServerDefinition[];
  if (workspacePath) {
    const projects = loadProjects();
    const project = projects.find(p => p.path === workspacePath);
    const projectEnabled = new Set(project?.mcpEnabledServers ?? []);
    effectiveServers = allServers.filter(s => globalEnabled.has(s.id) && projectEnabled.has(s.id));
  } else {
    effectiveServers = allServers.filter(s => globalEnabled.has(s.id));
  }

  setMcpServers(effectiveServers);
  broadcast('config:changed', { section: 'mcp', action, id });
}

/** Enable MCP for the current workspace project */
function enableMcpForCurrentProject(serverId: string): void {
  // The workspace path is set via process-global; use it to find the project
  const workspacePath = getCurrentWorkspacePath();
  if (!workspacePath) return;

  const projects = loadProjects();
  const idx = projects.findIndex(p => p.path === workspacePath);
  if (idx < 0) return;

  const project = projects[idx];
  const enabled = new Set(project.mcpEnabledServers ?? []);
  enabled.add(serverId);
  projects[idx] = { ...project, mcpEnabledServers: Array.from(enabled) };
  saveProjects(projects);
}

/** Disable MCP for the current workspace project */
function disableMcpForCurrentProject(serverId: string): void {
  const workspacePath = getCurrentWorkspacePath();
  if (!workspacePath) return;

  const projects = loadProjects();
  const idx = projects.findIndex(p => p.path === workspacePath);
  if (idx < 0) return;

  const project = projects[idx];
  const enabled = new Set(project.mcpEnabledServers ?? []);
  enabled.delete(serverId);
  projects[idx] = { ...project, mcpEnabledServers: Array.from(enabled) };
  saveProjects(projects);
}

/** Get workspace path from agent-session (set during session init) */
function getCurrentWorkspacePath(): string | undefined {
  const state = getAgentState();
  return state.agentDir || undefined;
}

/** Modify an agent in config by ID */
function modifyAgent(
  id: string,
  modifier: (agent: AgentConfigSlim) => AgentConfigSlim,
  action: string,
): AdminResponse {
  // Pre-check existence (fast-fail before acquiring write)
  const config = loadConfig();
  if (!(config.agents ?? []).some(a => a.id === id)) {
    return { success: false, error: `Agent '${id}' not found` };
  }

  // Find by ID inside the modifier to avoid TOCTOU stale-index bugs
  atomicModifyConfig(c => {
    const updated = [...(c.agents ?? [])];
    const freshIdx = updated.findIndex(a => a.id === id);
    if (freshIdx < 0) return c; // agent disappeared between reads — no-op
    updated[freshIdx] = modifier(updated[freshIdx]);
    return { ...c, agents: updated };
  });

  broadcast('config:changed', { section: 'agent', action, id });
  return { success: true, data: { id } };
}

/** Keys and patterns that contain secrets and must be redacted in config get */
const SENSITIVE_KEY_PATTERNS = /apikey|api_key|secret|token|password/i;
const SENSITIVE_TOP_KEYS = new Set(['providerApiKeys', 'mcpServerEnv']);

/** Recursively redact sensitive values in config output */
function redactSensitiveValues(key: string, value: unknown): unknown {
  const rootKey = key.split('.')[0];

  // Top-level known sensitive maps
  if (SENSITIVE_TOP_KEYS.has(rootKey) && typeof value === 'object' && value !== null) {
    return deepRedact(value);
  }

  // Any key path containing sensitive patterns
  if (SENSITIVE_KEY_PATTERNS.test(key) && typeof value === 'string') {
    return redactSecret(value);
  }

  // For arrays/objects that may contain sensitive nested fields (e.g., agents, imBotConfigs)
  if (typeof value === 'object' && value !== null) {
    return deepRedact(value);
  }

  return value;
}

/** Recursively walk an object and redact string values whose keys match sensitive patterns */
function deepRedact(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return obj;
  if (Array.isArray(obj)) return obj.map(item => deepRedact(item));
  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof v === 'string' && SENSITIVE_KEY_PATTERNS.test(k)) {
        result[k] = redactSecret(v);
      } else if (typeof v === 'object' && v !== null) {
        result[k] = deepRedact(v);
      } else {
        result[k] = v;
      }
    }
    return result;
  }
  return obj;
}

/** Get nested value from object by dot-separated key */
function getNestedValue(obj: Record<string, unknown>, key: string): unknown {
  const parts = key.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Set nested value in object by dot-separated key */
function setNestedValue(obj: AdminAppConfig, key: string, value: unknown): AdminAppConfig {
  const parts = key.split('.');
  if (parts.length === 1) {
    return { ...obj, [key]: value };
  }
  const [first, ...rest] = parts;
  const child = (obj[first] ?? {}) as Record<string, unknown>;
  return { ...obj, [first]: setNestedValue(child as AdminAppConfig, rest.join('.'), value) };
}
