// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/provider-auth-runtime.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/provider-auth-runtime.' + fn + '() not implemented in Bridge mode'); }
}

export async function resolveApiKeyForProvider() { _w('resolveApiKeyForProvider'); return undefined; }
export async function getRuntimeAuthForModel() { _w('getRuntimeAuthForModel'); return undefined; }
export function resolveEnvApiKey() { _w('resolveEnvApiKey'); return undefined; }
export const NON_ENV_SECRETREF_MARKER = undefined;
export function requireApiKey() { _w('requireApiKey'); return undefined; }
export function resolveAwsSdkEnvVarName() { _w('resolveAwsSdkEnvVarName'); return undefined; }
