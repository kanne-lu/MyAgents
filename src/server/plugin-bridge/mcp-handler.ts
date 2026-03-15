/**
 * MCP Tool Proxy Handler
 *
 * Takes captured tools from compat-api, resolves their factories with context,
 * and exposes list-tools / call-tool interfaces for MCP proxy endpoints.
 */

import type { CapturedTool } from './compat-api';

export interface McpToolDefinition {
  name: string;
  description: string;
  group: string;
  parameters: Record<string, unknown>;
}

// ===== Tool group mapping (hardcoded for feishu plugin) =====

const TOOL_GROUPS: Record<string, string> = {
  feishu_doc: 'doc',
  feishu_app_scopes: 'doc',
  feishu_chat: 'chat',
  feishu_wiki: 'wiki_drive',
  feishu_drive: 'wiki_drive',
  feishu_perm: 'perm',
};

function getToolGroup(toolName: string): string {
  if (toolName.startsWith('feishu_bitable_')) return 'bitable';
  return TOOL_GROUPS[toolName] || 'other';
}

// ===== Resolved tool cache =====

interface ResolvedTool {
  name: string;
  description: string;
  group: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, userId?: string) => Promise<unknown>;
}

export function createMcpHandler(
  getCapturedTools: () => CapturedTool[],
  pluginConfig: Record<string, unknown>,
) {
  // Cache resolved tools (resolved once from factories, reused across calls)
  let resolvedToolsCache: ResolvedTool[] | null = null;

  function resolveAllTools(): ResolvedTool[] {
    if (resolvedToolsCache) return resolvedToolsCache;

    const captured = getCapturedTools();
    const resolved: ResolvedTool[] = [];

    // Build a context object that factories may use for configuration
    const ctx: Record<string, unknown> = {
      config: pluginConfig,
      ...pluginConfig,
    };

    for (const ct of captured) {
      try {
        const result = ct.factory(ctx);
        if (!result) continue;

        const tools = Array.isArray(result) ? result : [result];
        for (const tool of tools) {
          const name = String(tool.name || ct.name || 'unknown');
          const description = String(tool.description || '');
          const parameters = (tool.parameters || tool.inputSchema || {}) as Record<string, unknown>;
          const execute = typeof tool.execute === 'function'
            ? (tool.execute as ResolvedTool['execute'])
            : async () => ({ error: 'Tool has no execute method' });

          resolved.push({
            name,
            description,
            group: getToolGroup(name),
            parameters,
            execute,
          });
        }
      } catch (err) {
        console.warn(`[mcp-handler] Failed to resolve tool factory "${ct.name}":`, err);
      }
    }

    resolvedToolsCache = resolved;
    console.log(`[mcp-handler] Resolved ${resolved.length} tools from ${captured.length} factories`);
    return resolved;
  }

  /**
   * List available tools, optionally filtered by enabled groups.
   */
  function resolveTools(enabledGroups?: string[]): McpToolDefinition[] {
    const all = resolveAllTools();
    const filtered = enabledGroups?.length
      ? all.filter((t) => enabledGroups.includes(t.group))
      : all;

    return filtered.map((t) => ({
      name: t.name,
      description: t.description,
      group: t.group,
      parameters: t.parameters,
    }));
  }

  /**
   * Call a tool by name with the given arguments.
   */
  async function callTool(
    toolName: string,
    args: Record<string, unknown>,
    userId?: string,
  ): Promise<unknown> {
    const all = resolveAllTools();
    const tool = all.find((t) => t.name === toolName);
    if (!tool) {
      throw new Error(`Tool not found: ${toolName}`);
    }
    return tool.execute(args, userId);
  }

  /**
   * Get unique tool group IDs from all resolved tools.
   */
  function getToolGroups(): string[] {
    const all = resolveAllTools();
    return [...new Set(all.map((t) => t.group))];
  }

  /**
   * Invalidate the resolved tool cache (e.g. after config changes).
   */
  function invalidateCache(): void {
    resolvedToolsCache = null;
  }

  return { resolveTools, callTool, getToolGroups, invalidateCache };
}
