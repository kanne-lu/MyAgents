// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/agent-harness.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/agent-harness.' + fn + '() not implemented in Bridge mode'); }
}

export const OPENCLAW_VERSION = undefined;
export function formatErrorMessage() { _w('formatErrorMessage'); return ""; }
export function embeddedAgentLog() { _w('embeddedAgentLog'); return undefined; }
export function resolveEmbeddedAgentRuntime() { _w('resolveEmbeddedAgentRuntime'); return undefined; }
export function resolveUserPath() { _w('resolveUserPath'); return undefined; }
export function callGatewayTool() { _w('callGatewayTool'); return undefined; }
export function isMessagingTool() { _w('isMessagingTool'); return false; }
export function isMessagingToolSendAction() { _w('isMessagingToolSendAction'); return false; }
export function extractToolResultMediaArtifact() { _w('extractToolResultMediaArtifact'); return undefined; }
export function filterToolResultMediaUrls() { _w('filterToolResultMediaUrls'); return undefined; }
export function normalizeUsage() { _w('normalizeUsage'); return ""; }
export function resolveOpenClawAgentDir() { _w('resolveOpenClawAgentDir'); return undefined; }
export function resolveSessionAgentIds() { _w('resolveSessionAgentIds'); return undefined; }
export function resolveModelAuthMode() { _w('resolveModelAuthMode'); return undefined; }
export function supportsModelTools() { _w('supportsModelTools'); return false; }
export function resolveAttemptSpawnWorkspaceDir() { _w('resolveAttemptSpawnWorkspaceDir'); return undefined; }
export function buildEmbeddedAttemptToolRunContext() { _w('buildEmbeddedAttemptToolRunContext'); return undefined; }
export function abortAgentHarnessRun() { _w('abortAgentHarnessRun'); return undefined; }
export function clearActiveEmbeddedRun() { _w('clearActiveEmbeddedRun'); return undefined; }
export function queueAgentHarnessMessage() { _w('queueAgentHarnessMessage'); return undefined; }
export function setActiveEmbeddedRun() { _w('setActiveEmbeddedRun'); return undefined; }
export function disposeRegisteredAgentHarnesses() { _w('disposeRegisteredAgentHarnesses'); return undefined; }
export function normalizeProviderToolSchemas() { _w('normalizeProviderToolSchemas'); return ""; }
export function createOpenClawCodingTools() { _w('createOpenClawCodingTools'); return undefined; }
export function resolveSandboxContext() { _w('resolveSandboxContext'); return undefined; }
export function isSubagentSessionKey() { _w('isSubagentSessionKey'); return false; }
export function acquireSessionWriteLock() { _w('acquireSessionWriteLock'); return undefined; }
export function emitSessionTranscriptUpdate() { _w('emitSessionTranscriptUpdate'); return undefined; }
