// Full request translation: Anthropic → OpenAI

import type { AnthropicRequest } from '../types/anthropic';
import type { OpenAIRequest } from '../types/openai';
import type { BridgeConfig } from '../types/bridge';
import { translateMessages } from './messages';
import { translateToolDefinitions, translateToolChoice } from './tools';
import { budgetToReasoningEffort } from './usage';

export interface TranslateRequestOptions {
  modelMapping?: BridgeConfig['modelMapping'];
  /** Override model name (highest priority) */
  modelOverride?: string;
}

/** Translate Anthropic Messages API request → OpenAI Chat Completions request */
export function translateRequest(
  req: AnthropicRequest,
  options?: TranslateRequestOptions,
): OpenAIRequest {
  // 1. Model mapping
  let model = req.model;
  if (options?.modelOverride) {
    model = options.modelOverride;
  } else if (options?.modelMapping) {
    const mapping = options.modelMapping;
    if (typeof mapping === 'function') {
      model = mapping(req.model) ?? req.model;
    } else {
      model = mapping[req.model] ?? req.model;
    }
  }

  // 2. Messages (system extraction + role mapping + tool_result splitting)
  const thinkingEnabled = req.thinking?.type === 'enabled';
  const messages = translateMessages(req.system, req.messages, thinkingEnabled);

  // 3. Build request
  let maxTokens = req.max_tokens;

  // Token budget overflow protection: if thinking.budget_tokens >= max_tokens,
  // auto-increase max_tokens so the model has room for non-thinking output
  if (req.thinking?.type === 'enabled' && req.thinking.budget_tokens >= maxTokens) {
    maxTokens = req.thinking.budget_tokens + 4096;
  }

  const openaiReq: OpenAIRequest = {
    model,
    messages,
    max_tokens: maxTokens,
  };

  // 4. Optional parameters
  if (req.temperature !== undefined) openaiReq.temperature = req.temperature;
  if (req.top_p !== undefined) openaiReq.top_p = req.top_p;
  // top_k → discard (OpenAI doesn't support)

  if (req.stop_sequences) {
    openaiReq.stop = req.stop_sequences;
  }

  // 5. Tools
  if (req.tools && req.tools.length > 0) {
    openaiReq.tools = translateToolDefinitions(req.tools);
  }
  if (req.tool_choice) {
    openaiReq.tool_choice = translateToolChoice(req.tool_choice);
    // Map disable_parallel_tool_use → parallel_tool_calls
    if ('disable_parallel_tool_use' in req.tool_choice && req.tool_choice.disable_parallel_tool_use) {
      openaiReq.parallel_tool_calls = false;
    }
  }

  // 6. Stream
  if (req.stream) {
    openaiReq.stream = true;
    openaiReq.stream_options = { include_usage: true };
  }

  // 7. Thinking → reasoning_effort
  if (req.thinking?.type === 'enabled') {
    openaiReq.reasoning_effort = budgetToReasoningEffort(req.thinking.budget_tokens);
  }

  return openaiReq;
}
