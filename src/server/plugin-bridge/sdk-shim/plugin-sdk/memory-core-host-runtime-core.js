// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/memory-core-host-runtime-core.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/memory-core-host-runtime-core.' + fn + '() not implemented in Bridge mode'); }
}

export function listMemoryCorpusSupplements() { _w('listMemoryCorpusSupplements'); return []; }
export function resolveCronStyleNow() { _w('resolveCronStyleNow'); return undefined; }
export const DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR = undefined;
export function resolveDefaultAgentId() { _w('resolveDefaultAgentId'); return undefined; }
export function resolveSessionAgentId() { _w('resolveSessionAgentId'); return undefined; }
export const resolveMemorySearchConfig = undefined;
export function jsonResult() { _w('jsonResult'); return undefined; }
export function readNumberParam() { _w('readNumberParam'); return undefined; }
export function readStringParam() { _w('readStringParam'); return undefined; }
export const SILENT_REPLY_TOKEN = undefined;
export function parseNonNegativeByteSize() { _w('parseNonNegativeByteSize'); return undefined; }
export const loadConfig = undefined;
export function resolveStateDir() { _w('resolveStateDir'); return undefined; }
export function resolveSessionTranscriptsDirForAgent() { _w('resolveSessionTranscriptsDirForAgent'); return undefined; }
export const emptyPluginConfigSchema = undefined;
export function buildActiveMemoryPromptSection() { _w('buildActiveMemoryPromptSection'); return undefined; }
export function listActiveMemoryPublicArtifacts() { _w('listActiveMemoryPublicArtifacts'); return []; }
export function parseAgentSessionKey() { _w('parseAgentSessionKey'); return undefined; }
