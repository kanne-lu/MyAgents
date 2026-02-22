// Bridge HTTP handler: receives Anthropic requests, translates to OpenAI, forwards, translates back

import type { BridgeConfig, UpstreamConfig } from './types/bridge';
import type { AnthropicRequest } from './types/anthropic';
import type { OpenAIResponse, OpenAIStreamChunk } from './types/openai';
import { translateRequest } from './translate/request';
import { translateResponse } from './translate/response';
import { StreamTranslator } from './translate/stream';
import { translateError } from './translate/errors';
import { SSEParser } from './utils/sse-parser';
import { formatSSE } from './utils/sse-writer';

const DEFAULT_TIMEOUT = 300_000; // 5 minutes

/** Detect proxy URL from environment (respects no_proxy for the target URL) */
export function getProxyForUrl(url: string): string | undefined {
  const proxy = process.env.https_proxy || process.env.HTTPS_PROXY
    || process.env.http_proxy || process.env.HTTP_PROXY
    || process.env.ALL_PROXY || process.env.all_proxy;
  if (!proxy) return undefined;

  // Check no_proxy
  const noProxy = process.env.no_proxy || process.env.NO_PROXY || '';
  if (noProxy === '*') return undefined;
  if (noProxy) {
    try {
      const host = new URL(url).hostname.toLowerCase();
      const excluded = noProxy.split(',').some(p => {
        const pattern = p.trim().toLowerCase();
        return host === pattern || host.endsWith(`.${pattern}`);
      });
      if (excluded) return undefined;
    } catch { /* invalid URL, skip no_proxy check */ }
  }

  return proxy;
}

/** Create a bridge handler that translates Anthropic → OpenAI → Anthropic */
export function createBridgeHandler(config: BridgeConfig): (request: Request) => Promise<Response> {
  const log = config.logger === null ? () => {} : (config.logger ?? console.log);
  const timeout = config.upstreamTimeout ?? DEFAULT_TIMEOUT;
  const translateReasoning = config.translateReasoning ?? true;

  return async (request: Request): Promise<Response> => {
    // 1. Extract API key from request headers
    const apiKey = request.headers.get('x-api-key') || request.headers.get('authorization')?.replace('Bearer ', '') || '';

    // 2. Parse Anthropic request body
    let anthropicReq: AnthropicRequest;
    try {
      anthropicReq = await request.json() as AnthropicRequest;
    } catch {
      return jsonError(400, 'invalid_request_error', 'Invalid JSON in request body');
    }

    // 3. Get upstream config
    let upstream: UpstreamConfig;
    try {
      upstream = await config.getUpstreamConfig(request);
    } catch (err) {
      log(`[bridge] Failed to get upstream config: ${err}`);
      return jsonError(500, 'api_error', 'Bridge configuration error');
    }

    const effectiveApiKey = upstream.apiKey || apiKey;
    const baseUrl = upstream.baseUrl.replace(/\/+$/, ''); // trim trailing slashes

    // 4. Translate request
    const openaiReq = translateRequest(anthropicReq, {
      modelMapping: config.modelMapping,
      modelOverride: upstream.model,
    });

    // 4b. Cap max_tokens if configured (CLI may send Claude-scale values like 128k)
    if (config.maxOutputTokens && openaiReq.max_tokens !== undefined && openaiReq.max_tokens > config.maxOutputTokens) {
      log(`[bridge] Capping max_tokens: ${openaiReq.max_tokens} → ${config.maxOutputTokens}`);
      openaiReq.max_tokens = config.maxOutputTokens;
    }

    log(`[bridge] ${anthropicReq.model} → ${openaiReq.model} stream=${!!anthropicReq.stream} tools=${anthropicReq.tools?.length ?? 0} max_tokens=${openaiReq.max_tokens ?? 'default'}`);

    // 5. Forward to upstream
    const upstreamUrl = `${baseUrl}/chat/completions`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    let upstreamResp: Response;
    try {
      // Detect proxy for upstream URL (reads from sidecar's process.env, respects no_proxy)
      const proxyUrl = getProxyForUrl(upstreamUrl);
      upstreamResp = await fetch(upstreamUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${effectiveApiKey}`,
        },
        body: JSON.stringify(openaiReq),
        signal: controller.signal,
        ...(proxyUrl ? { proxy: proxyUrl } : {}),
      } as RequestInit);
    } catch (err) {
      clearTimeout(timer);
      const isTimeout = err instanceof Error && err.name === 'AbortError';
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`[bridge] Upstream ${isTimeout ? 'timeout' : 'error'}: ${errMsg}`);
      return jsonError(
        isTimeout ? 408 : 502,
        'api_error',
        isTimeout ? 'Upstream request timed out' : `Upstream connection error: ${errMsg}`,
      );
    }

    // 6. Handle upstream errors
    if (!upstreamResp.ok) {
      clearTimeout(timer);
      const errBody = await upstreamResp.text();
      log(`[bridge] Upstream error ${upstreamResp.status}: ${errBody.slice(0, 300)}`);
      const { status, body } = translateError(upstreamResp.status, errBody);
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 7. Translate response
    if (anthropicReq.stream) {
      clearTimeout(timer);
      return handleStreamResponse(upstreamResp, anthropicReq.model, translateReasoning, log);
    } else {
      clearTimeout(timer);
      return handleNonStreamResponse(upstreamResp, anthropicReq.model, translateReasoning, log);
    }
  };
}

async function handleNonStreamResponse(
  upstreamResp: Response,
  requestModel: string,
  translateReasoning: boolean,
  log: (msg: string) => void,
): Promise<Response> {
  let openaiResp: OpenAIResponse;
  try {
    openaiResp = await upstreamResp.json() as OpenAIResponse;
  } catch {
    log('[bridge] Failed to parse upstream JSON response');
    return jsonError(502, 'api_error', 'Invalid upstream response');
  }

  const anthropicResp = translateResponse(openaiResp, requestModel, translateReasoning);
  return new Response(JSON.stringify(anthropicResp), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function handleStreamResponse(
  upstreamResp: Response,
  requestModel: string,
  translateReasoning: boolean,
  log: (msg: string) => void,
): Response {
  const translator = new StreamTranslator(requestModel, translateReasoning);
  const sseParser = new SSEParser();

  const stream = new ReadableStream({
    async start(controller) {
      const reader = upstreamResp.body?.getReader();
      if (!reader) {
        controller.close();
        return;
      }

      const encoder = new TextEncoder();
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const text = decoder.decode(value, { stream: true });
          const sseEvents = sseParser.feed(text);

          for (const sseEvent of sseEvents) {
            let chunk: OpenAIStreamChunk;
            try {
              chunk = JSON.parse(sseEvent.data) as OpenAIStreamChunk;
            } catch {
              continue; // Skip malformed chunks
            }

            const anthropicEvents = translator.feed(chunk);
            for (const event of anthropicEvents) {
              controller.enqueue(encoder.encode(formatSSE(event)));
            }
          }
        }
      } catch (err) {
        log(`[bridge] Stream error: ${err}`);
      } finally {
        // Emit closing events for incomplete streams (no-op if already finished)
        const finalEvents = translator.finalize();
        for (const event of finalEvents) {
          controller.enqueue(encoder.encode(formatSSE(event)));
        }
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

function jsonError(status: number, type: string, message: string): Response {
  return new Response(
    JSON.stringify({ type: 'error', error: { type, message } }),
    { status, headers: { 'Content-Type': 'application/json' } },
  );
}
