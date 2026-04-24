// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/account-helpers.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/account-helpers.' + fn + '() not implemented in Bridge mode'); }
}

export function createAccountListHelpers() { _w('createAccountListHelpers'); return undefined; }
export function describeAccountSnapshot() { _w('describeAccountSnapshot'); return undefined; }
export function describeWebhookAccountSnapshot() { _w('describeWebhookAccountSnapshot'); return undefined; }
export const mergeAccountConfig = undefined;
export const resolveMergedAccountConfig = undefined;
export function createAccountActionGate() { _w('createAccountActionGate'); return undefined; }
