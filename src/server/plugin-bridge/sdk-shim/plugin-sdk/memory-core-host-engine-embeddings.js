// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/memory-core-host-engine-embeddings.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/memory-core-host-engine-embeddings.' + fn + '() not implemented in Bridge mode'); }
}

export function getMemoryEmbeddingProvider() { _w('getMemoryEmbeddingProvider'); return undefined; }
export function listRegisteredMemoryEmbeddingProviders() { _w('listRegisteredMemoryEmbeddingProviders'); return []; }
export function listMemoryEmbeddingProviders() { _w('listMemoryEmbeddingProviders'); return []; }
export function listRegisteredMemoryEmbeddingProviderAdapters() { _w('listRegisteredMemoryEmbeddingProviderAdapters'); return []; }
export function createLocalEmbeddingProvider() { _w('createLocalEmbeddingProvider'); return undefined; }
export const DEFAULT_LOCAL_MODEL = undefined;
export function createGeminiEmbeddingProvider() { _w('createGeminiEmbeddingProvider'); return undefined; }
export const DEFAULT_GEMINI_EMBEDDING_MODEL = undefined;
export function buildGeminiEmbeddingRequest() { _w('buildGeminiEmbeddingRequest'); return undefined; }
export function createLmstudioEmbeddingProvider() { _w('createLmstudioEmbeddingProvider'); return undefined; }
export const DEFAULT_LMSTUDIO_EMBEDDING_MODEL = undefined;
export function createMistralEmbeddingProvider() { _w('createMistralEmbeddingProvider'); return undefined; }
export const DEFAULT_MISTRAL_EMBEDDING_MODEL = undefined;
export function createGitHubCopilotEmbeddingProvider() { _w('createGitHubCopilotEmbeddingProvider'); return undefined; }
export function createOllamaEmbeddingProvider() { _w('createOllamaEmbeddingProvider'); return undefined; }
export const DEFAULT_OLLAMA_EMBEDDING_MODEL = undefined;
export function createOpenAiEmbeddingProvider() { _w('createOpenAiEmbeddingProvider'); return undefined; }
export const DEFAULT_OPENAI_EMBEDDING_MODEL = undefined;
export function createVoyageEmbeddingProvider() { _w('createVoyageEmbeddingProvider'); return undefined; }
export const DEFAULT_VOYAGE_EMBEDDING_MODEL = undefined;
export function runGeminiEmbeddingBatches() { _w('runGeminiEmbeddingBatches'); return undefined; }
export const OPENAI_BATCH_ENDPOINT = undefined;
export function runOpenAiEmbeddingBatches() { _w('runOpenAiEmbeddingBatches'); return undefined; }
export function runVoyageEmbeddingBatches() { _w('runVoyageEmbeddingBatches'); return undefined; }
export function enforceEmbeddingMaxInputTokens() { _w('enforceEmbeddingMaxInputTokens'); return undefined; }
export function estimateStructuredEmbeddingInputBytes() { _w('estimateStructuredEmbeddingInputBytes'); return undefined; }
export function estimateUtf8Bytes() { _w('estimateUtf8Bytes'); return undefined; }
export function hasNonTextEmbeddingParts() { _w('hasNonTextEmbeddingParts'); return false; }
export function buildCaseInsensitiveExtensionGlob() { _w('buildCaseInsensitiveExtensionGlob'); return undefined; }
export function classifyMemoryMultimodalPath() { _w('classifyMemoryMultimodalPath'); return undefined; }
export function getMemoryMultimodalExtensions() { _w('getMemoryMultimodalExtensions'); return undefined; }
