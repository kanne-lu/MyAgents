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
 *   --config <json>       Plugin configuration JSON
 */

import { createCompatApi, type CapturedPlugin } from './compat-api';
import { createCompatRuntime } from './compat-runtime';
import { parseArgs } from 'util';

// Parse CLI arguments
const { values: args } = parseArgs({
  args: process.argv.slice(2),
  options: {
    'plugin-dir': { type: 'string' },
    'port': { type: 'string' },
    'rust-port': { type: 'string' },
    'bot-id': { type: 'string' },
    'config': { type: 'string' },
  },
});

const pluginDir = args['plugin-dir'];
const port = parseInt(args['port'] || '0', 10);
const rustPort = parseInt(args['rust-port'] || '0', 10);
const botId = args['bot-id'] || '';
const pluginConfig = JSON.parse(args['config'] || '{}');

if (!pluginDir || !port || !rustPort || !botId) {
  console.error('[plugin-bridge] Missing required args: --plugin-dir, --port, --rust-port, --bot-id');
  process.exit(1);
}

console.log(`[plugin-bridge] Starting: plugin-dir=${pluginDir} port=${port} rust-port=${rustPort} bot-id=${botId}`);

let capturedPlugin: CapturedPlugin | null = null;
let pluginName = 'unknown';
let gatewayError: string | null = null;

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

  // Build OpenClaw-format config from our flat pluginConfig
  // QQBot expects: cfg.channels.qqbot.appId, cfg.channels.qqbot.clientSecret, etc.
  const openclawCfg: Record<string, unknown> = {
    channels: {
      [capturedPlugin.id]: {
        enabled: true,
        ...pluginConfig,
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

  console.log(`[plugin-bridge] Resolved account:`, JSON.stringify(account));

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

  // For QQ Bot specifically, try to get an access token to validate credentials early
  const appId = String(account.appId || '');
  const clientSecret = String(account.clientSecret || '');
  if (appId && clientSecret) {
    try {
      console.log(`[plugin-bridge] Validating credentials (appId=${appId})...`);
      const resp = await fetch('https://bots.qq.com/app/getAppAccessToken', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId, clientSecret }),
      });
      const data = await resp.json() as { access_token?: string; message?: string };
      if (!resp.ok || !data.access_token) {
        const errMsg = `Credential validation failed: ${data.message || `HTTP ${resp.status}`}`;
        console.error(`[plugin-bridge] ${errMsg}`);
        gatewayError = errMsg;
        return; // Don't start gateway with bad credentials
      }
      console.log(`[plugin-bridge] Credentials validated successfully`);
    } catch (err) {
      console.warn(`[plugin-bridge] Credential validation network error (will try gateway anyway):`, err);
      // Don't block gateway start on network errors — gateway has its own retry logic
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
    (startAccount as (ctx: Record<string, unknown>) => Promise<void>)(ctx)
      .then(() => console.log(`[plugin-bridge] Plugin gateway started`))
      .catch((err: unknown) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[plugin-bridge] Gateway error:`, errMsg);
        gatewayError = errMsg;
      });

    // Store abort controller for graceful shutdown
    (globalThis as Record<string, unknown>).__bridgeAbort = abortController;
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
        ready: !!capturedPlugin && !gatewayError,
        error: gatewayError || undefined,
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
      const body = await req.json() as Record<string, unknown>;
      const appId = String(body.appId || '');
      const clientSecret = String(body.clientSecret || '');

      if (!appId || !clientSecret) {
        return Response.json({ ok: false, error: 'Missing appId or clientSecret' }, { status: 400 });
      }

      try {
        // Try to get an access token from QQ Bot API to validate credentials
        const resp = await fetch('https://bots.qq.com/app/getAppAccessToken', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ appId, clientSecret }),
        });

        const data = await resp.json() as { access_token?: string; expires_in?: number; code?: number; message?: string };

        if (resp.ok && data.access_token) {
          return Response.json({ ok: true, message: 'Credentials valid' });
        } else {
          const errMsg = data.message || `HTTP ${resp.status}`;
          return Response.json({ ok: false, error: `QQ Bot API: ${errMsg}` });
        }
      } catch (err) {
        return Response.json({ ok: false, error: `Network error: ${err instanceof Error ? err.message : String(err)}` }, { status: 500 });
      }
    }

    if (path === '/stop' && req.method === 'POST') {
      console.log('[plugin-bridge] Received stop signal');
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
