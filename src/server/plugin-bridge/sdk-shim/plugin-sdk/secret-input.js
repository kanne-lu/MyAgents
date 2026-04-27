// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/secret-input.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/secret-input.' + fn + '() not implemented in Bridge mode'); }
}

export function buildOptionalSecretInputSchema() { _w('buildOptionalSecretInputSchema'); return undefined; }
export function buildSecretInputArraySchema() { _w('buildSecretInputArraySchema'); return undefined; }
export const buildSecretInputSchema = undefined;
export function hasConfiguredSecretInput() { _w('hasConfiguredSecretInput'); return false; }
export function isSecretRef() { _w('isSecretRef'); return false; }
export function resolveSecretInputString() { _w('resolveSecretInputString'); return undefined; }
export function normalizeResolvedSecretInputString() { _w('normalizeResolvedSecretInputString'); return ""; }
export function normalizeSecretInput() { _w('normalizeSecretInput'); return ""; }
export function normalizeSecretInputString() { _w('normalizeSecretInputString'); return ""; }
