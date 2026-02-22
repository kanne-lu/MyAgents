// Error format translation: OpenAI → Anthropic

import type { AnthropicErrorResponse } from '../types/anthropic';

/** Map HTTP status code to Anthropic error type */
function statusToErrorType(status: number): string {
  switch (status) {
    case 400: return 'invalid_request_error';
    case 401: return 'authentication_error';
    case 403: return 'permission_error';
    case 404: return 'not_found_error';
    case 429: return 'rate_limit_error';
    case 500:
    case 502:
    case 503:
    case 529:
      return 'api_error';
    default:
      return status >= 500 ? 'api_error' : 'invalid_request_error';
  }
}

/** Translate an upstream error to Anthropic error format */
export function translateError(status: number, body: string): { status: number; body: AnthropicErrorResponse } {
  let message = `Upstream error (${status})`;

  try {
    const parsed = JSON.parse(body);
    // OpenAI format: { error: { message, type, code } }
    if (parsed?.error?.message) {
      message = parsed.error.message;
    } else if (typeof parsed?.message === 'string') {
      message = parsed.message;
    }
  } catch {
    if (body) message = body.slice(0, 500);
  }

  // Map OpenAI status codes to Anthropic equivalents
  const anthropicStatus = status === 402 ? 400 : status;

  return {
    status: anthropicStatus,
    body: {
      type: 'error',
      error: {
        type: statusToErrorType(status),
        message,
      },
    },
  };
}
