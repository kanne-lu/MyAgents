/**
 * OpenClaw Channel Plugin Bridge
 *
 * Independent Bun process that loads an OpenClaw channel plugin and bridges
 * communication between the plugin and Rust (management API).
 *
 * CLI args:
 *   --plugin-dir <path>   Plugin installation directory
 *   --port <number>       HTTP server port for Rust → Bridge communication
 *   --rust-port <number>  Management API port for Bridge → Rust communication
 *   --bot-id <string>     Bot ID for message routing
 *
 * Env:
 *   BRIDGE_PLUGIN_CONFIG  Plugin configuration JSON (env var to avoid leaking secrets in `ps`)
 */

import { createCompatApi, type CapturedPlugin, type CapturedTool } from './compat-api';
import { createCompatRuntime } from './compat-runtime';
import { FeishuStreamingSession } from './streaming-adapter';
import { createMcpHandler } from './mcp-handler';
import { parseArgs } from 'util';

// Parse CLI arguments
const { values: args } = parseArgs({
  args: process.argv.slice(2),
  strict: false,
  options: {
    'plugin-dir': { type: 'string' },
    'port': { type: 'string' },
    'rust-port': { type: 'string' },
    'bot-id': { type: 'string' },
  },
});

const pluginDir = args['plugin-dir'] as string | undefined;
const port = parseInt((args['port'] as string) || '0', 10);
const rustPort = parseInt((args['rust-port'] as string) || '0', 10);
const botId = (args['bot-id'] as string) || '';
// Read config from env var (not CLI arg) to avoid leaking secrets in process listing
const pluginConfig = JSON.parse(process.env.BRIDGE_PLUGIN_CONFIG || '{}');

if (!pluginDir || !port || !rustPort || !botId) {
  console.error('[plugin-bridge] Missing required args: --plugin-dir, --port, --rust-port, --bot-id');
  process.exit(1);
}

console.log(`[plugin-bridge] Starting: plugin-dir=${pluginDir} port=${port} rust-port=${rustPort} bot-id=${botId}`);

let capturedPlugin: CapturedPlugin | null = null;
let pluginName = 'unknown';
let gatewayError: string | null = null;
let gatewayStarted = false; // true once startAccount() has been invoked

// Streaming sessions (keyed by streamId)
const streamingSessions = new Map<string, FeishuStreamingSession>();
let streamIdCounter = 0;

// MCP handler — initialized after plugin loads and captures tools
let mcpHandler: ReturnType<typeof createMcpHandler> | null = null;
let getCapturedToolsFn: (() => CapturedTool[]) | null = null;

async function loadPlugin() {
  // Create compat API and runtime for plugin registration
  const compatApi = createCompatApi(pluginConfig);
  // Runtime must be created early — plugins call setRuntime(api.runtime) during register()
  const runtime = createCompatRuntime(rustPort, botId, 'unknown');
  compatApi.runtime = runtime;

  // Find the plugin entry point
  const pkgJsonPath = `${pluginDir}/package.json`;
  const pkgJson = await Bun.file(pkgJsonPath).json().catch(() => ({}));

  // Find installed packages (look in node_modules for packages with openclaw metadata)
  const deps = { ...pkgJson.dependencies, ...pkgJson.devDependencies };
  let entryModule: string | null = null;

  for (const depName of Object.keys(deps || {})) {
    if (depName === 'openclaw') continue; // Skip the shim
    try {
      const depPkg = await Bun.file(`${pluginDir}/node_modules/${depName}/package.json`).json();
      if (depPkg.openclaw || depPkg.keywords?.includes('openclaw')) {
        entryModule = depName;
        pluginName = depPkg.name || depName;
        break;
      }
    } catch {
      // Not an openclaw plugin, skip
    }
  }

  if (!entryModule) {
    throw new Error('No OpenClaw channel plugin found in dependencies');
  }

  console.log(`[plugin-bridge] Loading plugin: ${entryModule}`);

  // Import the plugin module
  const pluginModule = await import(`${pluginDir}/node_modules/${entryModule}`);

  // Plugins can export their registration in several patterns:
  //   1. default export = { register(api) { ... } }  (OpenClaw standard)
  //   2. default export = function(api) { ... }       (simple)
  //   3. module.default.default                       (double-wrapped ESM)
  const exported = pluginModule.default || pluginModule;
  if (typeof exported === 'object' && typeof exported.register === 'function') {
    await exported.register(compatApi);
  } else if (typeof exported === 'function') {
    await exported(compatApi);
  } else if (typeof exported === 'object' && typeof exported.default?.register === 'function') {
    await exported.default.register(compatApi);
  }

  capturedPlugin = compatApi.getCapturedPlugin();

  if (!capturedPlugin) {
    throw new Error('Plugin did not register a channel via registerChannel()');
  }

  console.log(`[plugin-bridge] Plugin registered: ${capturedPlugin.id} (${capturedPlugin.name})`);

  // Update runtime with actual plugin ID (was 'unknown' at creation time)
  if (runtime && typeof (runtime as Record<string, unknown>).setPluginId === 'function') {
    (runtime as Record<string, unknown> & { setPluginId: (id: string) => void }).setPluginId(capturedPlugin.id);
  }

  // Set up MCP handler with captured tools
  getCapturedToolsFn = () => compatApi.getCapturedTools();
  mcpHandler = createMcpHandler(getCapturedToolsFn, pluginConfig);
  const toolCount = compatApi.getCapturedTools().length;
  if (toolCount > 0) {
    console.log(`[plugin-bridge] MCP handler initialized with ${toolCount} captured tool factories`);
  }

  // Build OpenClaw-format config from our flat pluginConfig
  // QQBot expects: cfg.channels.qqbot.appId, cfg.channels.qqbot.clientSecret, etc.
  const openclawCfg: Record<string, unknown> = {
    channels: {
      [capturedPlugin.id]: {
        enabled: true,
        ...pluginConfig,
        // Force open policies — MyAgents handles access control at the Rust layer
        // via BIND_xxx codes + allowedUsers whitelist. OpenClaw's pairing mechanism
        // requires an external dashboard that MyAgents doesn't have.
        dmPolicy: 'open',
        groupPolicy: 'open',
      },
    },
  };

  // Resolve account using the plugin's own config.resolveAccount if available
  const configAccessor = capturedPlugin.raw?.config as Record<string, unknown> | undefined;
  let account: Record<string, unknown>;
  if (typeof configAccessor?.resolveAccount === 'function') {
    try {
      account = (configAccessor.resolveAccount as (cfg: unknown, id?: string) => Record<string, unknown>)(openclawCfg);
    } catch (err) {
      console.warn(`[plugin-bridge] resolveAccount failed, using flat config:`, err);
      account = { accountId: 'default', enabled: true, ...pluginConfig };
    }
  } else {
    account = { accountId: 'default', enabled: true, ...pluginConfig };
  }

  // Log account with secrets redacted
  const redactedAccount = Object.fromEntries(
    Object.entries(account).map(([k, v]) =>
      /secret|token|password|key/i.test(k) && typeof v === 'string'
        ? [k, v.slice(0, 4) + '***']
        : [k, v]
    )
  );
  console.log(`[plugin-bridge] Resolved account:`, JSON.stringify(redactedAccount));

  // Wrap outbound.sendText/sendMedia if top-level handlers are missing
  // OpenClaw plugins put send functions under plugin.outbound with signature:
  //   outbound.sendText({ to, text, accountId, replyToId, cfg })
  // We need to wrap them to match our CapturedPlugin interface:
  //   sendText(chatId, text) → outbound.sendText({ to: chatId, text, cfg })
  const outbound = capturedPlugin.raw?.outbound as Record<string, unknown> | undefined;
  if (!capturedPlugin.sendText && typeof outbound?.sendText === 'function') {
    const outboundSendText = outbound.sendText as (params: Record<string, unknown>) => Promise<{ messageId?: string; error?: Error }>;
    capturedPlugin.sendText = async (chatId: string, text: string) => {
      const result = await outboundSendText({ to: chatId, text, accountId: account.accountId || 'default', cfg: openclawCfg });
      if (result?.error) throw result.error;
      return { messageId: result?.messageId };
    };
    console.log('[plugin-bridge] Wrapped outbound.sendText as sendText handler');
  }
  if (!capturedPlugin.sendMedia && typeof outbound?.sendMedia === 'function') {
    const outboundSendMedia = outbound.sendMedia as (params: Record<string, unknown>) => Promise<{ messageId?: string; error?: Error }>;
    capturedPlugin.sendMedia = async (params: Record<string, unknown>) => {
      const result = await outboundSendMedia({ ...params, accountId: account.accountId || 'default', cfg: openclawCfg });
      if (result?.error) throw result.error;
      return { messageId: result?.messageId };
    };
    console.log('[plugin-bridge] Wrapped outbound.sendMedia as sendMedia handler');
  }
  // Store textChunkLimit from outbound config for max_message_length
  if (outbound?.textChunkLimit && typeof outbound.textChunkLimit === 'number') {
    console.log(`[plugin-bridge] Plugin textChunkLimit: ${outbound.textChunkLimit}`);
  }

  // Validate credentials before starting gateway
  // Check if the plugin's isConfigured function reports the account as configured
  const isConfigured = capturedPlugin.raw?.config as Record<string, unknown> | undefined;
  if (typeof isConfigured?.isConfigured === 'function') {
    const configured = (isConfigured.isConfigured as (a: unknown) => boolean)(account);
    if (!configured) {
      const errMsg = 'Plugin reports account is not configured (missing required credentials)';
      console.error(`[plugin-bridge] ${errMsg}`);
      gatewayError = errMsg;
      return; // Don't start gateway — credentials are missing
    }
  }

  // Start the plugin's gateway
  const startAccount = capturedPlugin.gateway?.startAccount;
  if (typeof startAccount === 'function') {
    const abortController = new AbortController();
    let status: Record<string, unknown> = { running: false, connected: false };

    const ctx = {
      account,
      abortSignal: abortController.signal,
      log: console,
      cfg: openclawCfg,
      getStatus: () => status,
      setStatus: (s: Record<string, unknown>) => { status = s; },
    };

    // Don't await — let the gateway run in background (it may be long-lived)
    gatewayStarted = true;
    (startAccount as (ctx: Record<string, unknown>) => Promise<void>)(ctx)
      .then(() => console.log(`[plugin-bridge] Plugin gateway started`))
      .catch((err: unknown) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[plugin-bridge] Gateway error:`, errMsg);
        gatewayError = errMsg;
      });

    // Store abort controller for graceful shutdown
    (globalThis as Record<string, unknown>).__bridgeAbort = abortController;
  } else {
    // No gateway — plugin is a send-only channel, mark as ready immediately
    gatewayStarted = true;
  }
}

// Start HTTP server for Rust → Bridge communication
const server = Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === '/health') {
      return Response.json({ ok: true, pluginName });
    }

    if (path === '/status') {
      return Response.json({
        ok: !gatewayError,
        pluginName,
        pluginId: capturedPlugin?.id || 'unknown',
        ready: !!capturedPlugin && !gatewayError && gatewayStarted,
        error: gatewayError || undefined,
      });
    }

    if (path === '/capabilities') {
      const outbound = capturedPlugin?.raw?.outbound as Record<string, unknown> | undefined;
      const capabilities = capturedPlugin?.raw?.capabilities as Record<string, unknown> | undefined;
      const hasCardKitStreaming = !!(pluginConfig.appId && pluginConfig.appSecret);
      const toolGroups = mcpHandler ? mcpHandler.getToolGroups() : [];
      const hasTools = getCapturedToolsFn ? getCapturedToolsFn().length > 0 : false;
      return Response.json({
        pluginId: capturedPlugin?.id || 'unknown',
        textChunkLimit: outbound?.textChunkLimit ?? 4096,
        chunkerMode: outbound?.chunkerMode ?? 'text',
        deliveryMode: outbound?.deliveryMode ?? 'direct',
        capabilities: {
          chatTypes: capabilities?.chatTypes ?? ['direct'],
          media: capabilities?.media ?? false,
          reactions: capabilities?.reactions ?? false,
          threads: capabilities?.threads ?? false,
          edit: capabilities?.edit ?? false,
          blockStreaming: capabilities?.blockStreaming ?? false,
          streaming: hasCardKitStreaming,
          streamingCardKit: hasCardKitStreaming,
          hasTools,
          toolGroups,
        },
      });
    }

    if (path === '/send-text' && req.method === 'POST') {
      const body = await req.json() as { chatId: string; text: string };
      const { chatId, text } = body;

      if (!capturedPlugin?.sendText) {
        return Response.json({ ok: false, error: 'Plugin has no sendText handler' }, { status: 501 });
      }

      try {
        const result = await capturedPlugin.sendText(chatId, text);
        return Response.json({ ok: true, messageId: result?.messageId });
      } catch (err) {
        return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }

    if (path === '/edit-message' && req.method === 'POST') {
      const body = await req.json() as { chatId: string; messageId: string; text: string };
      const { chatId, messageId, text } = body;

      if (!capturedPlugin?.editMessage) {
        return Response.json({ ok: false, error: 'Not supported' }, { status: 501 });
      }

      try {
        await capturedPlugin.editMessage(chatId, messageId, text);
        return Response.json({ ok: true });
      } catch (err) {
        return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }

    if (path === '/delete-message' && req.method === 'POST') {
      const body = await req.json() as { chatId: string; messageId: string };
      const { chatId, messageId } = body;

      if (!capturedPlugin?.deleteMessage) {
        return Response.json({ ok: false, error: 'Not supported' }, { status: 501 });
      }

      try {
        await capturedPlugin.deleteMessage(chatId, messageId);
        return Response.json({ ok: true });
      } catch (err) {
        return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }

    if (path === '/send-media' && req.method === 'POST') {
      const body = await req.json() as Record<string, unknown>;

      if (!capturedPlugin?.sendMedia) {
        return Response.json({ ok: false, error: 'Not supported' }, { status: 501 });
      }

      try {
        const result = await capturedPlugin.sendMedia(body);
        return Response.json({ ok: true, messageId: result?.messageId });
      } catch (err) {
        return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }

    if (path === '/validate-credentials' && req.method === 'POST') {
      // Generic credential validation using the plugin's own isConfigured() check
      if (!capturedPlugin) {
        return Response.json({ ok: false, error: 'Plugin not loaded yet' }, { status: 503 });
      }
      const configCheck = capturedPlugin.raw?.config as Record<string, unknown> | undefined;
      if (typeof configCheck?.isConfigured !== 'function') {
        // Plugin has no isConfigured — assume credentials are fine if plugin loaded
        return Response.json({ ok: true, message: 'Plugin has no credential validator (assumed valid)' });
      }
      try {
        const body = await req.json() as Record<string, unknown>;
        // Build a temporary account-like object from the provided credentials
        const tempAccount = { accountId: 'default', enabled: true, ...body };
        const configured = (configCheck.isConfigured as (a: unknown) => boolean)(tempAccount);
        if (configured) {
          return Response.json({ ok: true, message: 'Credentials valid (isConfigured passed)' });
        } else {
          return Response.json({ ok: false, error: 'Plugin reports credentials incomplete' });
        }
      } catch (err) {
        return Response.json({ ok: false, error: `Validation error: ${err instanceof Error ? err.message : String(err)}` }, { status: 500 });
      }
    }

    // ===== Streaming endpoints (CardKit streaming cards) =====

    if (path === '/start-stream' && req.method === 'POST') {
      const body = await req.json() as {
        chatId: string;
        initialContent?: string;
        streamMode?: 'text' | 'cardkit';
        receiveIdType?: 'open_id' | 'user_id' | 'union_id' | 'email' | 'chat_id';
        replyToMessageId?: string;
        replyInThread?: boolean;
        rootId?: string;
        header?: { title: string; template?: string };
      };

      if (!pluginConfig.appId || !pluginConfig.appSecret) {
        return Response.json({ ok: false, error: 'CardKit streaming requires appId and appSecret in plugin config' }, { status: 400 });
      }

      const creds = {
        appId: String(pluginConfig.appId),
        appSecret: String(pluginConfig.appSecret),
        domain: (pluginConfig.domain as string) || undefined,
      };

      const session = new FeishuStreamingSession(creds, (msg) => console.log(`[streaming] ${msg}`));

      try {
        await session.start(body.chatId, body.receiveIdType || 'chat_id', {
          replyToMessageId: body.replyToMessageId,
          replyInThread: body.replyInThread,
          rootId: body.rootId,
          header: body.header,
        });

        // If initial content provided, send first update
        if (body.initialContent) {
          await session.update(body.initialContent);
        }

        const streamId = `stream_${++streamIdCounter}_${Date.now()}`;
        streamingSessions.set(streamId, session);

        const state = session.getState();
        return Response.json({
          ok: true,
          streamId,
          cardId: state?.cardId,
          messageId: state?.messageId,
        });
      } catch (err) {
        return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }

    if (path === '/stream-chunk' && req.method === 'POST') {
      const body = await req.json() as {
        streamId: string;
        content: string;
        sequence?: number;
        isThinking?: boolean;
      };

      const session = streamingSessions.get(body.streamId);
      if (!session) {
        return Response.json({ ok: false, error: 'Stream not found' }, { status: 404 });
      }
      if (!session.isActive()) {
        return Response.json({ ok: false, error: 'Stream is no longer active' }, { status: 409 });
      }

      try {
        // Skip thinking/activity chunks — don't merge them into CardKit content
        // The streaming card only shows actual response text
        if (body.isThinking) {
          return Response.json({ ok: true });
        }
        await session.update(body.content);
        return Response.json({ ok: true });
      } catch (err) {
        return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }

    if (path === '/finalize-stream' && req.method === 'POST') {
      const body = await req.json() as { streamId: string; finalContent?: string };

      const session = streamingSessions.get(body.streamId);
      if (!session) {
        return Response.json({ ok: false, error: 'Stream not found' }, { status: 404 });
      }

      try {
        await session.close(body.finalContent);
        streamingSessions.delete(body.streamId);
        return Response.json({ ok: true });
      } catch (err) {
        return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }

    if (path === '/abort-stream' && req.method === 'POST') {
      const body = await req.json() as { streamId: string };

      const session = streamingSessions.get(body.streamId);
      if (!session) {
        return Response.json({ ok: false, error: 'Stream not found' }, { status: 404 });
      }

      try {
        // Close with an abort marker so the card shows it was interrupted
        await session.close('[Aborted]');
        streamingSessions.delete(body.streamId);
        return Response.json({ ok: true });
      } catch (err) {
        return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }

    // ===== MCP tool proxy endpoints =====

    if (path === '/mcp/tools' && req.method === 'GET') {
      if (!mcpHandler) {
        return Response.json({ ok: false, error: 'MCP handler not initialized (no tools captured)' }, { status: 503 });
      }

      const groupsParam = url.searchParams.get('groups');
      const enabledGroups = groupsParam ? groupsParam.split(',').map((g) => g.trim()).filter(Boolean) : undefined;

      try {
        const tools = mcpHandler.resolveTools(enabledGroups);
        return Response.json({ ok: true, tools });
      } catch (err) {
        return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }

    if (path === '/mcp/call-tool' && req.method === 'POST') {
      if (!mcpHandler) {
        return Response.json({ ok: false, error: 'MCP handler not initialized (no tools captured)' }, { status: 503 });
      }

      const body = await req.json() as { toolName: string; args: Record<string, unknown>; userId?: string; enabledGroups?: string[] };

      if (!body.toolName) {
        return Response.json({ ok: false, error: 'Missing required field: toolName' }, { status: 400 });
      }

      // Enforce tool group restrictions: only allow tools in enabled groups
      if (body.enabledGroups && body.enabledGroups.length > 0) {
        const allowedTools = mcpHandler.resolveTools(body.enabledGroups);
        const isAllowed = allowedTools.some(t => t.name === body.toolName);
        if (!isAllowed) {
          return Response.json({ ok: false, error: `Tool "${body.toolName}" is not in the enabled tool groups` }, { status: 403 });
        }
      }

      try {
        const result = await mcpHandler.callTool(body.toolName, body.args || {}, body.userId);
        return Response.json({ ok: true, result });
      } catch (err) {
        return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
      }
    }

    // ===== Lifecycle endpoints =====

    if (path === '/stop' && req.method === 'POST') {
      console.log('[plugin-bridge] Received stop signal');
      // Close any active streaming sessions before shutdown
      for (const [id, session] of streamingSessions) {
        try {
          if (session.isActive()) await session.close('[Bridge stopping]');
        } catch { /* best-effort */ }
        streamingSessions.delete(id);
      }
      // Abort the gateway via AbortController
      const abortCtrl = (globalThis as Record<string, unknown>).__bridgeAbort as AbortController | undefined;
      if (abortCtrl) abortCtrl.abort();
      // Also try calling stopAccount if available
      const stopAccount = capturedPlugin?.gateway?.stopAccount;
      if (typeof stopAccount === 'function') {
        try {
          await (stopAccount as () => Promise<void>)();
        } catch (err) {
          console.error('[plugin-bridge] Error stopping plugin gateway:', err);
        }
      }
      // Graceful shutdown
      setTimeout(() => process.exit(0), 500);
      return Response.json({ ok: true });
    }

    return Response.json({ error: 'Not found' }, { status: 404 });
  },
});

console.log(`[plugin-bridge] HTTP server listening on port ${server.port}`);

// Load the plugin
loadPlugin().catch((err) => {
  console.error('[plugin-bridge] Failed to load plugin:', err);
  process.exit(1);
});
