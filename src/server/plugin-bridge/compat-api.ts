/**
 * OpenClaw Plugin API Compatibility Shim
 *
 * Provides the `OpenClawPluginApi` interface that plugins call during registration.
 * Captures the registered channel plugin for the bridge to use.
 */

export interface CapturedPlugin {
  id: string;
  name: string;
  gateway: Record<string, unknown>;
  sendText?: (chatId: string, text: string) => Promise<{ messageId?: string } | void>;
  editMessage?: (chatId: string, messageId: string, text: string) => Promise<void>;
  deleteMessage?: (chatId: string, messageId: string) => Promise<void>;
  sendMedia?: (params: Record<string, unknown>) => Promise<{ messageId?: string } | void>;
}

/**
 * Create an OpenClaw-compatible API object for plugin registration.
 */
export function createCompatApi(config: Record<string, unknown>) {
  let capturedPlugin: CapturedPlugin | null = null;

  const api = {
    /**
     * Called by the plugin to register a channel.
     * This is the primary capture point — we extract the plugin's gateway and handlers.
     */
    registerChannel(plugin: Record<string, unknown>) {
      const id = String(plugin.id || 'unknown');
      const name = String(plugin.name || plugin.id || 'Unknown Plugin');
      const gateway = (plugin.gateway || {}) as Record<string, unknown>;
      const sendText = typeof plugin.sendText === 'function'
        ? (plugin.sendText as CapturedPlugin['sendText']) : undefined;
      const editMessage = typeof plugin.editMessage === 'function'
        ? (plugin.editMessage as CapturedPlugin['editMessage']) : undefined;
      const deleteMessage = typeof plugin.deleteMessage === 'function'
        ? (plugin.deleteMessage as CapturedPlugin['deleteMessage']) : undefined;
      const sendMedia = typeof plugin.sendMedia === 'function'
        ? (plugin.sendMedia as CapturedPlugin['sendMedia']) : undefined;

      capturedPlugin = { id, name, gateway, sendText, editMessage, deleteMessage, sendMedia };
      console.log(`[compat-api] Channel registered: ${capturedPlugin.id}`);
    },

    /**
     * Plugin config — pass through from MyAgents config.
     */
    config,

    /**
     * Logger — map to console.
     */
    logger: {
      info: (...args: unknown[]) => console.log('[plugin]', ...args),
      warn: (...args: unknown[]) => console.warn('[plugin]', ...args),
      error: (...args: unknown[]) => console.error('[plugin]', ...args),
      debug: (...args: unknown[]) => console.debug('[plugin]', ...args),
    },

    // Other OpenClaw API methods — no-op stubs
    registerTool() {},
    registerAgent() {},
    registerSkill() {},

    /**
     * Get the captured plugin after registration.
     */
    getCapturedPlugin(): CapturedPlugin | null {
      return capturedPlugin;
    },
  };

  return api;
}
