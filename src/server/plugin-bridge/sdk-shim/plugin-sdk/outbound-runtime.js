// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/outbound-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/outbound-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export function createRuntimeOutboundDelegates() { _w('createRuntimeOutboundDelegates'); return undefined; }
export function resolveOutboundSendDep() { _w('resolveOutboundSendDep'); return undefined; }
export function resolveAgentOutboundIdentity() { _w('resolveAgentOutboundIdentity'); return undefined; }
export function sanitizeForPlainText() { _w('sanitizeForPlainText'); return ""; }
