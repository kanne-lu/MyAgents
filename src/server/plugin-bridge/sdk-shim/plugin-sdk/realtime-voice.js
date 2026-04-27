// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/realtime-voice.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/realtime-voice.' + fn + '() not implemented in Bridge mode'); }
}

export function canonicalizeRealtimeVoiceProviderId() { _w('canonicalizeRealtimeVoiceProviderId'); return undefined; }
export function getRealtimeVoiceProvider() { _w('getRealtimeVoiceProvider'); return undefined; }
export function listRealtimeVoiceProviders() { _w('listRealtimeVoiceProviders'); return []; }
export function normalizeRealtimeVoiceProviderId() { _w('normalizeRealtimeVoiceProviderId'); return ""; }
