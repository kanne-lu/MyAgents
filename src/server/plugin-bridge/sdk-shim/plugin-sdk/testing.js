// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/testing.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/testing.' + fn + '() not implemented in Bridge mode'); }
}

export function removeAckReactionAfterReply() { _w('removeAckReactionAfterReply'); return undefined; }
export function shouldAckReaction() { _w('shouldAckReaction'); return false; }
export function expectChannelInboundContextContract() { _w('expectChannelInboundContextContract'); return undefined; }
export function primeChannelOutboundSendMock() { _w('primeChannelOutboundSendMock'); return undefined; }
export function buildDispatchInboundCaptureMock() { _w('buildDispatchInboundCaptureMock'); return undefined; }
export function createCliRuntimeCapture() { _w('createCliRuntimeCapture'); return undefined; }
export function firstWrittenJsonArg() { _w('firstWrittenJsonArg'); return undefined; }
export function spyRuntimeErrors() { _w('spyRuntimeErrors'); return undefined; }
export function spyRuntimeJson() { _w('spyRuntimeJson'); return undefined; }
export function spyRuntimeLogs() { _w('spyRuntimeLogs'); return undefined; }
export function setDefaultChannelPluginRegistryForTests() { _w('setDefaultChannelPluginRegistryForTests'); return undefined; }
export function callGateway() { _w('callGateway'); return undefined; }
export function createEmptyPluginRegistry() { _w('createEmptyPluginRegistry'); return undefined; }
export function getActivePluginRegistry() { _w('getActivePluginRegistry'); return undefined; }
export function resetPluginRuntimeStateForTest() { _w('resetPluginRuntimeStateForTest'); return undefined; }
export function setActivePluginRegistry() { _w('setActivePluginRegistry'); return undefined; }
export function capturePluginRegistration() { _w('capturePluginRegistration'); return undefined; }
export function resolveProviderPluginChoice() { _w('resolveProviderPluginChoice'); return undefined; }
export function createAuthCaptureJsonFetch() { _w('createAuthCaptureJsonFetch'); return undefined; }
export function createRequestCaptureJsonFetch() { _w('createRequestCaptureJsonFetch'); return undefined; }
export function installPinnedHostnameTestHooks() { _w('installPinnedHostnameTestHooks'); return undefined; }
export function isLiveTestEnabled() { _w('isLiveTestEnabled'); return false; }
export function createSandboxTestContext() { _w('createSandboxTestContext'); return undefined; }
export function writeSkill() { _w('writeSkill'); return undefined; }
export function __testing() { _w('__testing'); return undefined; }
export function acpManagerTesting() { _w('acpManagerTesting'); return undefined; }
export function runAcpRuntimeAdapterContract() { _w('runAcpRuntimeAdapterContract'); return undefined; }
export function handleAcpCommand() { _w('handleAcpCommand'); return undefined; }
export function buildCommandTestParams() { _w('buildCommandTestParams'); return undefined; }
export function peekSystemEvents() { _w('peekSystemEvents'); return undefined; }
export function resetSystemEventsForTest() { _w('resetSystemEventsForTest'); return undefined; }
export function jsonResponse() { _w('jsonResponse'); return undefined; }
export function requestBodyText() { _w('requestBodyText'); return undefined; }
export function requestUrl() { _w('requestUrl'); return undefined; }
export function mockPinnedHostnameResolution() { _w('mockPinnedHostnameResolution'); return undefined; }
export function createWindowsCmdShimFixture() { _w('createWindowsCmdShimFixture'); return undefined; }
export function installCommonResolveTargetErrorCases() { _w('installCommonResolveTargetErrorCases'); return undefined; }
export function sanitizeTerminalText() { _w('sanitizeTerminalText'); return ""; }
export function withStateDirEnv() { _w('withStateDirEnv'); return undefined; }
export function countLines() { _w('countLines'); return undefined; }
export function hasBalancedFences() { _w('hasBalancedFences'); return false; }
export function loadBundledPluginPublicSurfaceSync() { _w('loadBundledPluginPublicSurfaceSync'); return undefined; }
export function loadBundledPluginTestApiSync() { _w('loadBundledPluginTestApiSync'); return undefined; }
export function resolveRelativeBundledPluginPublicModuleId() { _w('resolveRelativeBundledPluginPublicModuleId'); return undefined; }
export function expectGeneratedTokenPersistedToGatewayAuth() { _w('expectGeneratedTokenPersistedToGatewayAuth'); return undefined; }
export function captureEnv() { _w('captureEnv'); return undefined; }
export function withEnv() { _w('withEnv'); return undefined; }
export function withEnvAsync() { _w('withEnvAsync'); return undefined; }
export function withFetchPreconnect() { _w('withFetchPreconnect'); return undefined; }
export function createTempHomeEnv() { _w('createTempHomeEnv'); return undefined; }
