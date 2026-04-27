// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/channel-core.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/channel-core.' + fn + '() not implemented in Bridge mode'); }
}

export const createChannelPluginBase = undefined;
export const buildChannelConfigSchema = undefined;
export function buildChannelOutboundSessionRoute() { _w('buildChannelOutboundSessionRoute'); return undefined; }
export function clearAccountEntryFields() { _w('clearAccountEntryFields'); return undefined; }
export function createChatChannelPlugin() { _w('createChatChannelPlugin'); return undefined; }
export function defineChannelPluginEntry() { _w('defineChannelPluginEntry'); return undefined; }
export function defineSetupPluginEntry() { _w('defineSetupPluginEntry'); return undefined; }
export function parseOptionalDelimitedEntries() { _w('parseOptionalDelimitedEntries'); return undefined; }
export function stripChannelTargetPrefix() { _w('stripChannelTargetPrefix'); return ""; }
export function stripTargetKindPrefix() { _w('stripTargetKindPrefix'); return ""; }
export function tryReadSecretFileSync() { _w('tryReadSecretFileSync'); return undefined; }
