/**
 * OpenClaw Channel Runtime Compatibility Shim
 *
 * Mocks the `pluginRuntime.channel` APIs that channel plugins use.
 * The key interception point is `reply.dispatchReplyWithBufferedBlockDispatcher`:
 * instead of calling the plugin's deliver callback, we POST the inbound message
 * to Rust's management API for AI processing.
 *
 * This shim covers the FULL PluginRuntime.channel surface so that any OpenClaw
 * channel plugin can load without TypeError crashes, not just QQ Bot.
 */

import { tmpdir } from 'os';
import { join } from 'path';
import { writeFile, mkdir } from 'fs/promises';

// ===== Text chunking utilities =====
// Simple implementations matching OpenClaw's text.* API surface.

function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= limit) { chunks.push(remaining); break; }
    let splitAt = remaining.lastIndexOf('\n', limit);
    if (splitAt <= 0 || splitAt < limit * 0.5) splitAt = remaining.lastIndexOf(' ', limit);
    if (splitAt <= 0 || splitAt < limit * 0.5) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}

function chunkByNewline(text: string, limit: number): string[] {
  const lines = text.split('\n');
  const chunks: string[] = [];
  let current = '';
  for (const line of lines) {
    if (current.length + line.length + 1 > limit && current) {
      chunks.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Create a compat channel runtime that routes inbound messages to Rust.
 */
export function createCompatRuntime(rustPort: number, botId: string, pluginId: string) {
  const rustBaseUrl = `http://127.0.0.1:${rustPort}`;

  // Mutable — updated after plugin registration when actual ID is known
  let currentPluginId = pluginId;

  // Parse the plugin config once (passed via env var by Bridge spawner)
  const bridgePluginConfig = JSON.parse(process.env.BRIDGE_PLUGIN_CONFIG || '{}');

  const runtime = {
    /** Update the plugin ID after registration */
    setPluginId(id: string) { currentPluginId = id; },

    // ===== Config =====
    // LarkClient.runtime.config.loadConfig() is called during message handling
    config: {
      loadConfig() {
        // Return an OpenClaw-format config with the plugin's channel settings
        // Use currentPluginId as channel key (not hardcoded 'feishu') so any plugin
        // can resolve its own config via cfg.channels[pluginId]
        // Force dmPolicy/groupPolicy=open — MyAgents handles access control at Rust layer
        return {
          channels: {
            [currentPluginId]: {
              enabled: true,
              ...bridgePluginConfig,
              dmPolicy: 'open',
              groupPolicy: 'open',
            },
          },
        };
      },
      async writeConfigFile(_cfg: unknown) {
        // No-op — Bridge doesn't write config files
      },
    },

    // ===== Logging =====
    // LarkClient.runtime.logging.getChildLogger() is called for plugin logging
    logging: {
      getChildLogger(opts: Record<string, unknown>) {
        const prefix = opts?.name ? `[${opts.name}]` : '[plugin]';
        return {
          info: (...args: unknown[]) => console.log(prefix, ...args),
          warn: (...args: unknown[]) => console.warn(prefix, ...args),
          error: (...args: unknown[]) => console.error(prefix, ...args),
          debug: (...args: unknown[]) => console.debug(prefix, ...args),
        };
      },
    },

    channel: {
      // ===== Activity tracking =====
      // No-op — MyAgents doesn't need OpenClaw activity tracking.
      activity: {
        record(_event: Record<string, unknown>) {},
        get(_params: Record<string, unknown>) { return []; },
      },

      // ===== Routing =====
      routing: {
        resolveAgentRoute(_ctx: Record<string, unknown>) {
          return { agentId: 'default', route: 'default' };
        },
      },

      // ===== Reply / dispatch =====
      reply: {
        resolveEnvelopeFormatOptions(_ctx: Record<string, unknown>) {
          return {};
        },

        formatInboundEnvelope(ctx: Record<string, unknown>) {
          return String(ctx.Body || ctx.body || '');
        },

        formatAgentEnvelope(ctx: Record<string, unknown>) {
          return String(ctx.BodyForAgent || ctx.Body || ctx.body || '');
        },

        finalizeInboundContext(ctx: Record<string, unknown>) {
          return ctx;
        },

        resolveEffectiveMessagesConfig(_ctx: Record<string, unknown>) {
          return {};
        },

        resolveHumanDelayConfig(_ctx: Record<string, unknown>) {
          return { enabled: false, minMs: 0, maxMs: 0 };
        },

        createReplyDispatcherWithTyping(_params: Record<string, unknown>) {
          return { dispatch: async () => {} };
        },

        /**
         * Feishu plugin calls dispatchReplyFromConfig() which is a higher-level
         * API than dispatchReplyWithBufferedBlockDispatcher(). Route it through
         * the same interception point so messages reach Rust.
         */
        async dispatchReplyFromConfig(params: Record<string, unknown>) {
          const ctx = (params.ctx || params) as Record<string, unknown>;
          return runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({ ctx, cfg: params.cfg as Record<string, unknown> });
        },

        /**
         * Feishu plugin wraps dispatch calls in withReplyDispatcher({ run }).
         * Execute the run function which will call dispatchReplyFromConfig,
         * which now correctly routes to our interception point.
         */
        async withReplyDispatcher(params: Record<string, unknown>) {
          const run = params.run as (() => Promise<unknown>) | undefined;
          if (typeof run === 'function') {
            await run();
          }
        },

        /**
         * Core interception point: instead of calling `deliver()`, we POST
         * the user's message to Rust's management API.
         */
        async dispatchReplyWithBufferedBlockDispatcher(params: {
          ctx: Record<string, unknown>;
          cfg?: Record<string, unknown>;
          dispatcherOptions?: Record<string, unknown>;
        }) {
          const { ctx } = params;

          const text = String(ctx.BodyForAgent || ctx.Body || ctx.body || ctx.RawBody || '');
          const senderId = String(ctx.SenderId || ctx.senderId || '');
          const senderName = String(ctx.SenderName || ctx.senderName || '');
          const chatId = String(ctx.From || ctx.from || ctx.ChatId || ctx.chatId || '');
          const chatType = String(ctx.ChatType || ctx.chatType || 'direct');
          const messageId = String(ctx.MessageSid || ctx.messageSid || ctx.MessageId || '');
          const groupId = String(ctx.QQGroupOpenid || ctx.GroupId || ctx.groupId || '');
          const isMention = ctx.IsMention ?? ctx.WasMentioned ?? ctx.isMention ?? true;

          // Extract attachment-related fields (for Feishu file/image forwarding, threaded replies, etc.)
          const attachments = (ctx.Attachments || ctx.attachments || undefined) as Record<string, unknown>[] | undefined;
          const replyToMessageId = String(ctx.ReplyToMessageId || ctx.replyToMessageId || '') || undefined;

          if (!text.trim()) {
            console.log('[compat-runtime] Empty message, skipping');
            return;
          }

          console.log(`[compat-runtime] Dispatching message to Rust: sender=${senderId} chat=${chatId} len=${text.length}`);

          try {
            const resp = await fetch(`${rustBaseUrl}/api/im-bridge/message`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                botId,
                pluginId: currentPluginId,
                senderId,
                senderName: senderName || undefined,
                text,
                chatType: chatType === 'group' ? 'group' : 'direct',
                chatId,
                messageId: messageId || undefined,
                groupId: groupId || undefined,
                isMention,
                attachments: attachments || undefined,
                replyToMessageId: replyToMessageId || undefined,
              }),
            });

            if (!resp.ok) {
              const body = await resp.text();
              console.error(`[compat-runtime] Rust returned ${resp.status}: ${body}`);
            }
          } catch (err) {
            console.error('[compat-runtime] Failed to POST to Rust:', err);
          }

          // Do NOT call the deliver callback — AI reply comes back via /send-text
        },
      },

      // ===== Text utilities =====
      text: {
        chunkText,
        chunkByNewline,
        chunkMarkdownText: chunkText,
        chunkMarkdownTextWithMode: (text: string, limit: number) => chunkText(text, limit),
        chunkTextWithMode: (text: string, limit: number) => chunkText(text, limit),
        resolveChunkMode: () => 'markdown' as const,
        resolveTextChunkLimit: () => 2000,
        hasControlCommand: () => false,
        resolveMarkdownTableMode: () => 'preserve' as const,
        convertMarkdownTables: (text: string) => text,
      },

      // ===== Session management =====
      // No-op — Rust layer manages sessions via PeerLock + SessionRouter.
      session: {
        resolveStorePath: () => tmpdir(),
        readSessionUpdatedAt: () => null,
        recordSessionMetaFromInbound: () => {},
        recordInboundSession: () => {},
        updateLastRoute: () => {},
      },

      // ===== Media handling =====
      media: {
        async fetchRemoteMedia(url: string) {
          try {
            const resp = await fetch(url);
            if (!resp.ok) return null;
            const buf = Buffer.from(await resp.arrayBuffer());
            return { buffer: buf, contentType: resp.headers.get('content-type') || 'application/octet-stream' };
          } catch {
            return null;
          }
        },
        async saveMediaBuffer(buffer: Buffer | Uint8Array, opts?: { ext?: string }) {
          const dir = join(tmpdir(), 'myagents-media');
          await mkdir(dir, { recursive: true });
          const filename = `media-${Date.now()}${opts?.ext || ''}`;
          const filepath = join(dir, filename);
          await writeFile(filepath, buffer);
          return filepath;
        },
      },

      // ===== Pairing (device binding) =====
      // No-op — MyAgents uses its own allowedUsers mechanism.
      pairing: {
        buildPairingReply: () => '',
        readAllowFromStore: async () => [],
        upsertPairingRequest: async () => ({}),
      },

      // ===== Mention handling =====
      mentions: {
        buildMentionRegexes: () => [],
        matchesMentionPatterns: () => false,
        matchesMentionWithExplicit: () => ({ matched: false }),
      },

      // ===== Reactions =====
      reactions: {
        shouldAckReaction: () => false,
        removeAckReactionAfterReply: () => {},
      },

      // ===== Group policies =====
      groups: {
        resolveGroupPolicy: () => ({}),
        resolveRequireMention: () => false,
      },

      // ===== Inbound debounce =====
      debounce: {
        createInboundDebouncer: () => ({
          debounce: (fn: () => unknown) => fn(),
          cancel: () => {},
        }),
        resolveInboundDebounceMs: () => 0,
      },

      // ===== Commands =====
      commands: {
        resolveCommandAuthorizedFromAuthorizers: () => true,
        isControlCommandMessage: () => false,
        shouldComputeCommandAuthorized: () => false,
        shouldHandleTextCommands: () => false,
      },
    },
  };

  return runtime;
}
