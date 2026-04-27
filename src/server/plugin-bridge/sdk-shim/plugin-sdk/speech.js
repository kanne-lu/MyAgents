// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: npm run generate:sdk-shims
// Source: openclaw/src/plugin-sdk/speech.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/speech.' + fn + '() not implemented in Bridge mode'); }
}

export function requireInRange() { _w('requireInRange'); return undefined; }
export function normalizeLanguageCode() { _w('normalizeLanguageCode'); return ""; }
export function normalizeApplyTextNormalization() { _w('normalizeApplyTextNormalization'); return ""; }
export function normalizeSeed() { _w('normalizeSeed'); return ""; }
export function scheduleCleanup() { _w('scheduleCleanup'); return undefined; }
export function parseTtsDirectives() { _w('parseTtsDirectives'); return undefined; }
export function canonicalizeSpeechProviderId() { _w('canonicalizeSpeechProviderId'); return undefined; }
export function getSpeechProvider() { _w('getSpeechProvider'); return undefined; }
export function listSpeechProviders() { _w('listSpeechProviders'); return []; }
export function normalizeSpeechProviderId() { _w('normalizeSpeechProviderId'); return ""; }
export function normalizeTtsAutoMode() { _w('normalizeTtsAutoMode'); return ""; }
export const TTS_AUTO_MODES = undefined;
export function asBoolean() { _w('asBoolean'); return undefined; }
export function asFiniteNumber() { _w('asFiniteNumber'); return undefined; }
export function asObject() { _w('asObject'); return undefined; }
export function readResponseTextLimited() { _w('readResponseTextLimited'); return undefined; }
export function trimToUndefined() { _w('trimToUndefined'); return undefined; }
export function truncateErrorDetail() { _w('truncateErrorDetail'); return undefined; }
