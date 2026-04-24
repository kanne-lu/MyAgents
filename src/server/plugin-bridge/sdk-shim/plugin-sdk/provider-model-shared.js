// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/provider-model-shared.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/provider-model-shared.' + fn + '() not implemented in Bridge mode'); }
}

export function getModelProviderHint() { _w('getModelProviderHint'); return undefined; }
export function isProxyReasoningUnsupportedModelHint() { _w('isProxyReasoningUnsupportedModelHint'); return false; }
export function buildProviderReplayFamilyHooks() { _w('buildProviderReplayFamilyHooks'); return undefined; }
export const OPENAI_COMPATIBLE_REPLAY_HOOKS = undefined;
export const ANTHROPIC_BY_MODEL_REPLAY_HOOKS = undefined;
export const NATIVE_ANTHROPIC_REPLAY_HOOKS = undefined;
export const PASSTHROUGH_GEMINI_REPLAY_HOOKS = undefined;
export const DEFAULT_CONTEXT_TOKENS = undefined;
export function resolveProviderEndpoint() { _w('resolveProviderEndpoint'); return undefined; }
export function applyModelCompatPatch() { _w('applyModelCompatPatch'); return undefined; }
export function hasToolSchemaProfile() { _w('hasToolSchemaProfile'); return false; }
export function hasNativeWebSearchTool() { _w('hasNativeWebSearchTool'); return false; }
export function normalizeModelCompat() { _w('normalizeModelCompat'); return ""; }
export function resolveUnsupportedToolSchemaKeywords() { _w('resolveUnsupportedToolSchemaKeywords'); return undefined; }
export function resolveToolCallArgumentsEncoding() { _w('resolveToolCallArgumentsEncoding'); return undefined; }
export function normalizeProviderId() { _w('normalizeProviderId'); return ""; }
export function buildAnthropicReplayPolicyForModel() { _w('buildAnthropicReplayPolicyForModel'); return undefined; }
export function buildGoogleGeminiReplayPolicy() { _w('buildGoogleGeminiReplayPolicy'); return undefined; }
export function buildHybridAnthropicOrOpenAIReplayPolicy() { _w('buildHybridAnthropicOrOpenAIReplayPolicy'); return undefined; }
export function buildNativeAnthropicReplayPolicyForModel() { _w('buildNativeAnthropicReplayPolicyForModel'); return undefined; }
export function buildOpenAICompatibleReplayPolicy() { _w('buildOpenAICompatibleReplayPolicy'); return undefined; }
export function buildPassthroughGeminiSanitizingReplayPolicy() { _w('buildPassthroughGeminiSanitizingReplayPolicy'); return undefined; }
export function resolveTaggedReasoningOutputMode() { _w('resolveTaggedReasoningOutputMode'); return undefined; }
export function sanitizeGoogleGeminiReplayHistory() { _w('sanitizeGoogleGeminiReplayHistory'); return ""; }
export function buildStrictAnthropicReplayPolicy() { _w('buildStrictAnthropicReplayPolicy'); return undefined; }
export function createMoonshotThinkingWrapper() { _w('createMoonshotThinkingWrapper'); return undefined; }
export function resolveMoonshotThinkingType() { _w('resolveMoonshotThinkingType'); return undefined; }
export function cloneFirstTemplateModel() { _w('cloneFirstTemplateModel'); return undefined; }
export function matchesExactOrPrefix() { _w('matchesExactOrPrefix'); return undefined; }
export function normalizeAntigravityPreviewModelId() { _w('normalizeAntigravityPreviewModelId'); return ""; }
export function normalizeGooglePreviewModelId() { _w('normalizeGooglePreviewModelId'); return ""; }
export function normalizeNativeXaiModelId() { _w('normalizeNativeXaiModelId'); return ""; }
