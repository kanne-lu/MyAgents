// IM Bot Bridge Tools — Proxy MCP tools from OpenClaw plugin Bridge
// Fetches tool definitions from Bridge's /mcp/tools endpoint, proxies calls to /mcp/call-tool
// Uses Bridge port passed via setImBridgeToolsContext()

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';

type CallToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

// ===== Bridge Tools Context =====

interface ImBridgeToolsContext {
  bridgePort: number;
  enabledToolGroups: string[];
  pluginId: string;
  /** Feishu sender open_id for tool calls that need user context */
  senderId?: string;
}

let bridgeToolsContext: ImBridgeToolsContext | null = null;

export function setImBridgeToolsContext(ctx: ImBridgeToolsContext): void {
  bridgeToolsContext = ctx;
  console.log(`[im-bridge-tools] Context set: bridge=${ctx.bridgePort}, groups=${ctx.enabledToolGroups.join(',')}, plugin=${ctx.pluginId}`);
}

export function clearImBridgeToolsContext(): void {
  bridgeToolsContext = null;
  console.log('[im-bridge-tools] Context cleared');
}

export function getImBridgeToolsContext(): ImBridgeToolsContext | null {
  return bridgeToolsContext;
}

// ===== Bridge API client =====

async function bridgeApi(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown): Promise<unknown> {
  if (!bridgeToolsContext) {
    throw new Error('Bridge tools context not set');
  }

  const url = `http://127.0.0.1:${bridgeToolsContext.bridgePort}${path}`;
  const options: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body && method === 'POST') {
    options.body = JSON.stringify(body);
  }

  const resp = await fetch(url, options);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Bridge API error ${resp.status}: ${text}`);
  }
  return resp.json();
}

// ===== Generic plugin tool handler =====
// A single MCP tool that proxies to any registered plugin tool

async function pluginToolCallHandler(args: {
  tool_name: string;
  arguments: string;
}): Promise<CallToolResult> {
  if (!bridgeToolsContext) {
    return {
      content: [{ type: 'text', text: 'Error: No Bridge context available. Plugin tools are only available within an IM Bot session using an OpenClaw plugin.' }],
      isError: true,
    };
  }

  try {
    let parsedArgs: Record<string, unknown>;
    try {
      parsedArgs = JSON.parse(args.arguments);
    } catch {
      parsedArgs = {};
    }

    const result = await bridgeApi('/mcp/call-tool', 'POST', {
      toolName: args.tool_name,
      args: parsedArgs,
      userId: bridgeToolsContext.senderId,
      enabledGroups: bridgeToolsContext.enabledToolGroups,
    }) as { ok: boolean; result?: unknown; error?: string };

    if (!result.ok) {
      return {
        content: [{ type: 'text', text: `Tool call failed: ${result.error || 'unknown error'}` }],
        isError: true,
      };
    }

    // Format the result for AI consumption
    const resultText = typeof result.result === 'string'
      ? result.result
      : JSON.stringify(result.result, null, 2);

    return {
      content: [{ type: 'text', text: resultText }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error calling plugin tool: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
}

// ===== List available tools handler =====

async function listPluginToolsHandler(_args: Record<string, never>): Promise<CallToolResult> {
  if (!bridgeToolsContext) {
    return {
      content: [{ type: 'text', text: 'No plugin tools available — not in a Bridge session.' }],
      isError: true,
    };
  }

  try {
    const groups = bridgeToolsContext.enabledToolGroups.join(',');
    const result = await bridgeApi(`/mcp/tools?groups=${groups}`) as {
      tools: Array<{ name: string; description: string; group: string; parameters: unknown }>;
    };

    if (!result.tools || result.tools.length === 0) {
      return { content: [{ type: 'text', text: 'No plugin tools are currently available.' }] };
    }

    const toolList = result.tools.map(t =>
      `- **${t.name}** (${t.group}): ${t.description}`
    ).join('\n');

    return {
      content: [{ type: 'text', text: `Available plugin tools (${result.tools.length}):\n\n${toolList}\n\nUse feishu_tool to call any of these tools.` }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error fetching tools: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
}

// ===== Server creation =====

export function createImBridgeToolServer() {
  return createSdkMcpServer({
    name: 'im-bridge-tools',
    version: '1.0.0',
    tools: [
      tool(
        'feishu_tool',
        `Call a Feishu plugin tool to interact with Feishu workspace resources.

Available tools (use list_feishu_tools to see full list):
- feishu_doc: Create, read, update cloud documents (actions: read, write, append, create, list_blocks, etc.)
- feishu_chat: Query chat info and member lists (actions: members, info)
- feishu_wiki: Manage knowledge base spaces and nodes (actions: spaces, nodes, get, create, move, rename)
- feishu_drive: Manage cloud storage files (actions: list, info, create_folder, move, delete)
- feishu_bitable_*: CRUD operations on Bitable (multidimensional tables)
- feishu_perm: Manage document permissions (actions: list, add, remove)
- feishu_app_scopes: List current app permissions

Pass the tool name and its arguments as a JSON string.

Example:
  tool_name: "feishu_doc"
  arguments: '{"action": "read", "document_id": "doxcnXXX"}'

Example:
  tool_name: "feishu_bitable_list_records"
  arguments: '{"app_token": "bascXXX", "table_id": "tblXXX"}'`,
        {
          tool_name: z.string().describe('Name of the Feishu plugin tool to call (e.g. "feishu_doc", "feishu_bitable_list_records")'),
          arguments: z.string().describe('JSON string of the tool arguments'),
        },
        pluginToolCallHandler,
      ),
      tool(
        'list_feishu_tools',
        'List all available Feishu plugin tools with their descriptions. Call this first to see what tools are available and how to use them.',
        {},
        listPluginToolsHandler,
      ),
    ],
  });
}

export const imBridgeToolServer = createImBridgeToolServer();
