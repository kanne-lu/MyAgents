/**
 * Agent-browser anti-detection defaults & profile persistence.
 *
 * Generates ~/.myagents/agent-browser.json with headed mode, realistic UA,
 * persistent profile directory, and anti-detection Chrome flags.
 * The config is pointed to by AGENT_BROWSER_CONFIG env var in buildClaudeSessionEnv().
 *
 * User override: remove the `_managed_by` field from the JSON file — MyAgents
 * will stop overwriting it. Or set AGENT_BROWSER_CONFIG env var to a custom path.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { getHomeDirOrNull } from './platform';

// ---- Cached values (computed once per process) ----

let _cachedChromeVersion: string | null = null;
let _cachedUA: string | null = null;
let _cachedLocale: string | null = null;

// ---- Internal helpers ----

/**
 * Detect installed Chrome version. Falls back to a recent stable version.
 */
function detectChromeVersion(): string {
  if (_cachedChromeVersion) return _cachedChromeVersion;

  const FALLBACK = '131.0.0.0';
  const execOpts = { encoding: 'utf-8' as const, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'] };

  try {
    if (process.platform === 'darwin') {
      const ver = execSync(
        "defaults read '/Applications/Google Chrome.app/Contents/Info' CFBundleShortVersionString",
        execOpts,
      ).trim();
      if (/^\d+\.\d+/.test(ver)) {
        _cachedChromeVersion = ver;
        return ver;
      }
    } else if (process.platform === 'win32') {
      // Try HKLM first, then HKCU
      for (const root of ['HKLM', 'HKCU']) {
        try {
          const out = execSync(
            `reg query "${root}\\SOFTWARE\\Google\\Chrome\\BLBeacon" /v version`,
            execOpts,
          );
          const m = out.match(/REG_SZ\s+([\d.]+)/);
          if (m) {
            _cachedChromeVersion = m[1];
            return m[1];
          }
        } catch { /* try next */ }
      }
    } else {
      // Linux
      const out = execSync('google-chrome --version', execOpts).trim();
      const m = out.match(/([\d.]+)/);
      if (m) {
        _cachedChromeVersion = m[1];
        return m[1];
      }
    }
  } catch { /* ignore */ }

  _cachedChromeVersion = FALLBACK;
  return FALLBACK;
}

/**
 * Build a realistic Chrome user-agent string matching the current platform.
 */
function buildRealisticUserAgent(): string {
  if (_cachedUA) return _cachedUA;

  const ver = detectChromeVersion();

  const osStr =
    process.platform === 'darwin'
      ? 'Macintosh; Intel Mac OS X 10_15_7'
      : process.platform === 'win32'
        ? 'Windows NT 10.0; Win64; x64'
        : 'X11; Linux x86_64';

  _cachedUA = `Mozilla/5.0 (${osStr}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ver} Safari/537.36`;
  return _cachedUA;
}

/**
 * Detect system locale (e.g. "zh-CN", "en-US"). Defaults to "zh-CN".
 */
function detectSystemLocale(): string {
  if (_cachedLocale) return _cachedLocale;

  // Try LANG / LC_ALL env var (works on macOS, Linux, Git Bash on Windows)
  const lang = process.env.LANG || process.env.LC_ALL || '';
  if (lang) {
    // "zh_CN.UTF-8" → "zh-CN"
    const code = lang.split('.')[0].replace('_', '-');
    if (code && code !== 'C' && code !== 'POSIX') {
      _cachedLocale = code;
      return code;
    }
  }

  // macOS fallback: read AppleLanguages
  if (process.platform === 'darwin') {
    try {
      const out = execSync(
        'defaults read NSGlobalDomain AppleLanguages',
        { encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'] },
      );
      // Output: (\n    "zh-Hans-CN",\n    "en-CN"\n)
      const m = out.match(/"([^"]+)"/);
      if (m) {
        // "zh-Hans-CN" → "zh-CN"
        const simplified = m[1].replace(/-Hans|-Hant/, '');
        _cachedLocale = simplified;
        return simplified;
      }
    } catch { /* ignore */ }
  }

  // Default: zh-CN (MyAgents 初期用户主要为中文用户)
  _cachedLocale = 'zh-CN';
  return 'zh-CN';
}

// ---- Public API ----

/**
 * Ensure ~/.myagents/agent-browser.json exists with anti-detection defaults.
 *
 * Called on every Sidecar startup. Regenerates the file when `_managed_by`
 * is "myagents" (keeps UA/locale fresh). Skips if the user removed the marker.
 */
export function ensureBrowserStealthConfig(): void {
  const homeDir = getHomeDirOrNull();
  if (!homeDir) return;

  const configPath = join(homeDir, '.myagents', 'agent-browser.json');

  // Check if user has taken ownership
  if (existsSync(configPath)) {
    try {
      const existing = JSON.parse(readFileSync(configPath, 'utf-8'));
      if (existing._managed_by !== 'myagents') {
        console.log('[agent-browser] Stealth config is user-managed, skipping');
        return;
      }
    } catch { /* corrupt file, overwrite */ }
  }

  const profileDir = join(homeDir, '.myagents', 'browser-profile');
  const config = {
    _managed_by: 'myagents',
    headed: true,
    profile: profileDir,
    userAgent: buildRealisticUserAgent(),
    args: [
      '--disable-blink-features=AutomationControlled',
      `--lang=${detectSystemLocale()}`,
    ],
  };

  try {
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
    console.log(`[agent-browser] Stealth config written: ${configPath}`);
  } catch (err) {
    console.warn('[agent-browser] Failed to write stealth config:', err);
  }
}

/**
 * Return path to agent-browser.json if it exists, otherwise null.
 * Used by buildClaudeSessionEnv() to set AGENT_BROWSER_CONFIG.
 */
export function getAgentBrowserConfigPath(): string | null {
  const homeDir = getHomeDirOrNull();
  if (!homeDir) return null;
  const configPath = join(homeDir, '.myagents', 'agent-browser.json');
  return existsSync(configPath) ? configPath : null;
}
