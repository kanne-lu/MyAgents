// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/gateway-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/gateway-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export function GatewayClient() { _w('GatewayClient'); return undefined; }
export function createOperatorApprovalsGatewayClient() { _w('createOperatorApprovalsGatewayClient'); return undefined; }
export function withOperatorApprovalsGatewayClient() { _w('withOperatorApprovalsGatewayClient'); return undefined; }
export function createConnectedChannelStatusPatch() { _w('createConnectedChannelStatusPatch'); return undefined; }
