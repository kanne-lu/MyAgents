/**
 * Server-side Analytics
 *
 * Lightweight event tracker for the Bun Sidecar.
 * Reads config from ~/.myagents/analytics_config.json (written by frontend at startup).
 * Sends events directly via fetch() — no CORS restrictions in Bun.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const CONFIG_PATH = join(homedir(), '.myagents', 'analytics_config.json');

interface AnalyticsConfig {
  enabled: boolean;
  apiKey: string;
  endpoint: string;
  deviceId: string;
  platform: string;
  appVersion: string;
}

interface ServerTrackEvent {
  event: string;
  device_id: string;
  platform: string;
  app_version: string;
  params: Record<string, string | number | boolean | null | undefined>;
  client_timestamp: string;
}

// Lazy-loaded config (null = not yet loaded, false = disabled/failed)
let config: AnalyticsConfig | false | null = null;

// Simple batch queue
const queue: ServerTrackEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_DELAY_MS = 3000;
const MAX_QUEUE_SIZE = 30;

function loadConfig(): AnalyticsConfig | false {
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as AnalyticsConfig;
    if (!parsed.enabled || !parsed.apiKey) return false;
    return parsed;
  } catch {
    return false;
  }
}

function getConfig(): AnalyticsConfig | false {
  if (config === null) {
    config = loadConfig();
  }
  return config;
}

async function flushQueue(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  const cfg = getConfig();
  if (!cfg || queue.length === 0) {
    queue.length = 0;
    return;
  }

  const events = queue.splice(0, MAX_QUEUE_SIZE);

  try {
    await fetch(cfg.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': cfg.apiKey,
      },
      body: JSON.stringify({ events }),
    });
  } catch {
    // Silent failure — analytics must never affect the main flow
  }

  // If there are remaining events, schedule another flush
  if (queue.length > 0) {
    flushTimer = setTimeout(() => void flushQueue(), FLUSH_DELAY_MS);
  }
}

/**
 * Track a server-side event.
 * Silent no-op if analytics is disabled or config is missing.
 */
export function trackServer(
  event: string,
  params: Record<string, string | number | boolean | null | undefined> = {},
): void {
  const cfg = getConfig();
  if (!cfg) return;

  queue.push({
    event,
    device_id: cfg.deviceId,
    platform: cfg.platform,
    app_version: cfg.appVersion,
    params,
    client_timestamp: new Date().toISOString(),
  });

  if (queue.length >= MAX_QUEUE_SIZE) {
    void flushQueue();
  } else {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => void flushQueue(), FLUSH_DELAY_MS);
  }
}
