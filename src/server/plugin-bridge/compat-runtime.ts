/**
 * OpenClaw Channel Runtime Compatibility Shim
 *
 * Mocks the `pluginRuntime.channel` APIs that QQ Bot (and other) plugins use.
 * The key interception point is `reply.dispatchReplyWithBufferedBlockDispatcher`:
 * instead of calling the plugin's deliver callback, we POST the inbound message
 * to Rust's management API for AI processing.
 */

/**
 * Create a compat channel runtime that routes inbound messages to Rust.
 */
export function createCompatRuntime(rustPort: number, botId: string, pluginId: string) {
  const rustBaseUrl = `http://127.0.0.1:${rustPort}`;

  const runtime = {
    channel: {
      routing: {
        /**
         * Resolve which agent should handle this message.
         * MyAgents is single-agent, so always return a default route.
         */
        resolveAgentRoute(_ctx: Record<string, unknown>) {
          return { agentId: 'default', route: 'default' };
        },
      },

      reply: {
        /**
         * Resolve formatting options for the envelope.
         */
        resolveEnvelopeFormatOptions(_ctx: Record<string, unknown>) {
          return {};
        },

        /**
         * Format the inbound message body.
         * Returns the body field directly (AI sees the full content).
         */
        formatInboundEnvelope(ctx: Record<string, unknown>) {
          return String(ctx.Body || ctx.body || '');
        },

        /**
         * Finalize the inbound context before dispatch.
         * Passthrough — the plugin builds ctx, we just let it through.
         */
        finalizeInboundContext(ctx: Record<string, unknown>) {
          return ctx;
        },

        /**
         * Resolve effective message configuration.
         */
        resolveEffectiveMessagesConfig(_ctx: Record<string, unknown>) {
          return {};
        },

        /**
         * Core interception point: instead of calling `deliver()`, we POST
         * the user's message to Rust's management API.
         *
         * OpenClaw model: framework calls deliver(payload) → plugin sends to IM.
         * MyAgents model: we intercept here → POST to Rust → Rust does AI →
         *                 Rust calls Bridge /send-text → plugin sends to IM.
         */
        async dispatchReplyWithBufferedBlockDispatcher(params: {
          ctx: Record<string, unknown>;
          cfg?: Record<string, unknown>;
          dispatcherOptions?: Record<string, unknown>;
        }) {
          const { ctx } = params;

          // Extract key fields from the plugin's context object
          const text = String(ctx.BodyForAgent || ctx.Body || ctx.body || ctx.RawBody || '');
          const senderId = String(ctx.SenderId || ctx.senderId || '');
          const senderName = String(ctx.SenderName || ctx.senderName || '');
          const chatId = String(ctx.From || ctx.from || ctx.ChatId || ctx.chatId || '');
          const chatType = String(ctx.ChatType || ctx.chatType || 'direct');
          const messageId = String(ctx.MessageSid || ctx.messageSid || ctx.MessageId || '');
          const groupId = String(ctx.QQGroupOpenid || ctx.GroupId || ctx.groupId || '');
          const isMention = ctx.IsMention ?? ctx.isMention ?? true;

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
                pluginId,
                senderId,
                senderName: senderName || undefined,
                text,
                chatType: chatType === 'group' ? 'group' : 'direct',
                chatId,
                messageId: messageId || undefined,
                groupId: groupId || undefined,
                isMention,
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
    },
  };

  return runtime;
}
