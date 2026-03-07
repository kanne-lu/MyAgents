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

async function loadPlugin() {
  // Create compat API for plugin registration
  const compatApi = createCompatApi(pluginConfig);

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

  // The plugin's default export should be a function that takes the API
  const registerFn = pluginModule.default || pluginModule;
  if (typeof registerFn === 'function') {
    await registerFn(compatApi);
  } else if (typeof registerFn === 'object' && registerFn.default) {
    await registerFn.default(compatApi);
  }

  capturedPlugin = compatApi.getCapturedPlugin();

  if (!capturedPlugin) {
    throw new Error('Plugin did not register a channel via registerChannel()');
  }

  console.log(`[plugin-bridge] Plugin registered: ${capturedPlugin.id} (${capturedPlugin.name})`);

  // Create compat runtime and start the plugin's gateway
  const runtime = createCompatRuntime(rustPort, botId, capturedPlugin.id);

  const startAccount = capturedPlugin.gateway?.startAccount;
  if (typeof startAccount === 'function') {
    const ctx = {
      config: pluginConfig,
      runtime,
      logger: console,
    };
    await (startAccount as (ctx: Record<string, unknown>) => Promise<void>)(ctx);
    console.log(`[plugin-bridge] Plugin gateway started`);
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
        ok: true,
        pluginName,
        pluginId: capturedPlugin?.id || 'unknown',
        ready: !!capturedPlugin,
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

    if (path === '/stop' && req.method === 'POST') {
      console.log('[plugin-bridge] Received stop signal');
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
