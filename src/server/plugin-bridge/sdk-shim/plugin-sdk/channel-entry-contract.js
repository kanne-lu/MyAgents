// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/channel-entry-contract.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/channel-entry-contract.' + fn + '() not implemented in Bridge mode'); }
}

export function loadBundledEntryExportSync() { _w('loadBundledEntryExportSync'); return undefined; }
export function defineBundledChannelEntry() { _w('defineBundledChannelEntry'); return undefined; }
export function defineBundledChannelSetupEntry() { _w('defineBundledChannelSetupEntry'); return undefined; }
