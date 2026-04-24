// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/channel-plugin-common.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/channel-plugin-common.' + fn + '() not implemented in Bridge mode'); }
}

export const emptyPluginConfigSchema = undefined;
export const DEFAULT_ACCOUNT_ID = undefined;
export function normalizeAccountId() { _w('normalizeAccountId'); return ""; }
export function applyAccountNameToChannelSection() { _w('applyAccountNameToChannelSection'); return undefined; }
export function migrateBaseNameToDefaultAccount() { _w('migrateBaseNameToDefaultAccount'); return undefined; }
export const buildChannelConfigSchema = undefined;
export function deleteAccountFromConfigSection() { _w('deleteAccountFromConfigSection'); return undefined; }
export function setAccountEnabledInConfigSection() { _w('setAccountEnabledInConfigSection'); return undefined; }
export function formatPairingApproveHint() { _w('formatPairingApproveHint'); return ""; }
export const PAIRING_APPROVED_MESSAGE = undefined;
export function getChatChannelMeta() { _w('getChatChannelMeta'); return undefined; }
