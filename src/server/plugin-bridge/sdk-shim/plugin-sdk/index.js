// OpenClaw plugin-sdk root shim for MyAgents Plugin Bridge
// Covers all runtime symbols imported by installed plugins from 'openclaw/plugin-sdk'

import crypto from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

// ===== Config helpers (used by QQBot + others) =====

export function emptyPluginConfigSchema() {
  return { type: 'object', properties: {}, additionalProperties: false };
}

export function applyAccountNameToChannelSection(config, section, name) {
  if (!config) config = {};
  if (!config[section]) config[section] = {};
  config[section].name = name;
  return config;
}

export function deleteAccountFromConfigSection(config, section) {
  if (config && config[section]) delete config[section];
  return config || {};
}

export function setAccountEnabledInConfigSection(config, section, enabled) {
  if (!config) config = {};
  if (!config[section]) config[section] = {};
  config[section].enabled = enabled;
  return config;
}

// ===== Account ID =====

export const DEFAULT_ACCOUNT_ID = 'default';

export function normalizeAccountId(id) {
  if (!id || id === 'default') return DEFAULT_ACCOUNT_ID;
  return String(id).trim().toLowerCase();
}

// ===== History =====

export const DEFAULT_GROUP_HISTORY_LIMIT = 50;

export function buildPendingHistoryContextFromMap(params) {
  return params.currentMessage;
}

export function clearHistoryEntriesIfEnabled(_params) {}

export function recordPendingHistoryEntryIfEnabled(_params) {
  return [];
}

// ===== Pairing =====

export const PAIRING_APPROVED_MESSAGE = 'Access approved. Send a message to start chatting.';

// ===== Reply / Typing =====

export function createReplyPrefixContext(_params) {
  const ctx = {};
  return {
    prefixContext: ctx,
    responsePrefix: undefined,
    enableSlackInteractiveReplies: undefined,
    responsePrefixContextProvider: () => ctx,
    onModelSelected: () => {},
  };
}

export function createTypingCallbacks(_params) {
  return { onReplyStart: async () => {}, onIdle: () => {}, onCleanup: () => {} };
}

export function logTypingFailure(_params) {}

// ===== Tokens =====

export const SILENT_REPLY_TOKEN = 'NO_REPLY';

// ===== Session / Routing =====

export function normalizeAgentId(value) {
  const t = (value ?? '').trim();
  return t ? t.toLowerCase() : 'main';
}

export function resolveThreadSessionKeys(params) {
  const threadId = (params.threadId ?? '').trim();
  if (!threadId) {
    return { sessionKey: params.baseSessionKey, parentSessionKey: undefined };
  }
  const normalized = (params.normalizeThreadId ?? ((v) => v.toLowerCase()))(threadId);
  const useSuffix = params.useSuffix ?? true;
  const sessionKey = useSuffix
    ? `${params.baseSessionKey}:thread:${normalized}`
    : params.baseSessionKey;
  return { sessionKey, parentSessionKey: params.parentSessionKey };
}

// ===== Allow-from / Authorization =====

export function isNormalizedSenderAllowed(params) {
  const normalizedAllow = (params.allowFrom ?? [])
    .map((e) => String(e).trim())
    .filter(Boolean)
    .map((e) => params.stripPrefixRe ? e.replace(params.stripPrefixRe, '') : e)
    .map((e) => e.toLowerCase());
  if (normalizedAllow.length === 0) return false;
  if (normalizedAllow.includes('*')) return true;
  const sender = String(params.senderId).trim().toLowerCase();
  return normalizedAllow.includes(sender);
}

export function formatAllowFromLowercase(params) {
  return (params.allowFrom ?? [])
    .map((e) => String(e).trim())
    .filter(Boolean)
    .map((e) => params.stripPrefixRe ? e.replace(params.stripPrefixRe, '') : e)
    .map((e) => e.toLowerCase());
}

export function addWildcardAllowFrom(allowFrom) {
  const next = (allowFrom ?? []).map((v) => String(v).trim()).filter(Boolean);
  if (!next.includes('*')) next.push('*');
  return next;
}

export function mergeAllowFromEntries(current, additions) {
  const merged = [...(current ?? []), ...additions].map((v) => String(v).trim()).filter(Boolean);
  return [...new Set(merged)];
}

export async function resolveSenderCommandAuthorization(params) {
  return {
    shouldComputeAuth: false,
    effectiveAllowFrom: params.configuredAllowFrom ?? [],
    effectiveGroupAllowFrom: params.configuredGroupAllowFrom ?? [],
    senderAllowedForCommands: true,
    commandAuthorized: undefined,
  };
}

// ===== Tool helpers =====

export function extractToolSend(args, expectedAction = 'sendMessage') {
  const action = typeof args.action === 'string' ? args.action.trim() : '';
  if (action !== expectedAction) return null;
  const to = typeof args.to === 'string' ? args.to : undefined;
  if (!to) return null;
  const accountId = typeof args.accountId === 'string' ? args.accountId.trim() : undefined;
  const threadIdRaw = typeof args.threadId === 'string'
    ? args.threadId.trim()
    : typeof args.threadId === 'number' ? String(args.threadId) : '';
  const threadId = threadIdRaw.length > 0 ? threadIdRaw : undefined;
  return { to, accountId, threadId };
}

export function jsonResult(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

function readParamRaw(params, key) {
  if (Object.hasOwn(params, key)) return params[key];
  const snake = key.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
  if (snake !== key && Object.hasOwn(params, snake)) return params[snake];
  return undefined;
}

export function readStringParam(params, key, options = {}) {
  const { required = false, trim = true, label = key, allowEmpty = false } = options;
  const raw = readParamRaw(params, key);
  if (typeof raw !== 'string') {
    if (required) throw new Error(`${label} required`);
    return undefined;
  }
  const value = trim ? raw.trim() : raw;
  if (!value && !allowEmpty) {
    if (required) throw new Error(`${label} required`);
    return undefined;
  }
  return value;
}

export function readReactionParams(params, options) {
  const emojiKey = options.emojiKey ?? 'emoji';
  const removeKey = options.removeKey ?? 'remove';
  const remove = typeof params[removeKey] === 'boolean' ? params[removeKey] : false;
  const emoji = readStringParam(params, emojiKey, { required: true, allowEmpty: true });
  if (remove && !emoji) throw new Error(options.removeErrorMessage);
  return { emoji, remove, isEmpty: !emoji };
}

// ===== Temp path =====

export function buildRandomTempFilePath(params) {
  const prefix = (params.prefix || 'tmp').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'tmp';
  let ext = '';
  if (params.extension) {
    const raw = params.extension.startsWith('.') ? params.extension : `.${params.extension}`;
    const token = (raw.match(/[a-zA-Z0-9._-]+$/)?.[0] ?? '').replace(/^[._-]+/, '');
    if (token) ext = `.${token}`;
  }
  const now = typeof params.now === 'number' && Number.isFinite(params.now) ? Math.trunc(params.now) : Date.now();
  const uuid = params.uuid?.trim() || crypto.randomUUID();
  const root = params.tmpDir ?? join(tmpdir(), 'myagents-bridge-media');
  mkdirSync(root, { recursive: true });
  return join(root, `${prefix}-${now}-${uuid}${ext}`);
}

// ===== Docs link =====

export function formatDocsLink(path, label) {
  const url = path.trim().startsWith('http')
    ? path.trim()
    : 'https://docs.openclaw.ai' + (path.startsWith('/') ? path : '/' + path);
  return label ?? url;
}
