// Tool definition, call, result, and tool_choice translation

import type { AnthropicToolDefinition, AnthropicToolChoice } from '../types/anthropic';
import type { OpenAIToolDefinition, OpenAIToolChoice, OpenAIToolCall } from '../types/openai';
import { generateToolUseId } from '../utils/id';

/** Anthropic tool definitions → OpenAI function tools */
export function translateToolDefinitions(tools: AnthropicToolDefinition[]): OpenAIToolDefinition[] {
  return tools.map(tool => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }));
}

/** Anthropic tool_choice → OpenAI tool_choice */
export function translateToolChoice(choice: AnthropicToolChoice): OpenAIToolChoice {
  switch (choice.type) {
    case 'auto':
      return 'auto';
    case 'any':
      return 'required';
    case 'none':
      return 'none';
    case 'tool':
      return { type: 'function', function: { name: choice.name } };
  }
}

/** OpenAI tool_calls → Anthropic tool_use content blocks */
export function translateToolCalls(toolCalls: OpenAIToolCall[]): {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}[] {
  return toolCalls.map(tc => ({
    type: 'tool_use' as const,
    id: tc.id || generateToolUseId(),
    name: tc.function.name,
    input: safeParseJson(tc.function.arguments),
  }));
}

function safeParseJson(str: string): Record<string, unknown> {
  try {
    return JSON.parse(str);
  } catch {
    console.warn('[bridge] Failed to parse tool arguments:', str.slice(0, 200));
    return {};
  }
}
