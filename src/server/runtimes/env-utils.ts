// Shared environment utilities for external runtime subprocesses (v0.1.60)

import { statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import { getShellEnv, getShellPath } from '../utils/shell';

/**
 * Lightweight PATH-based command lookup, used by external-runtime adapters.
 *
 * On Windows, honours PATHEXT (.EXE, .CMD, .BAT, etc.) so .cmd shims from
 * npm-global installs are found. Absolute paths bypass PATH and are verified
 * via `statSync` directly.
 */
function which(command: string, opts?: { PATH?: string }): string | null {
  const pathStr = opts?.PATH ?? process.env.PATH ?? '';
  if (!pathStr) return null;
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').map((e) => e.toLowerCase())
    : [''];
  // Absolute path bypass: if caller passed an absolute executable, just verify it.
  if (command.includes('/') || (process.platform === 'win32' && command.includes('\\'))) {
    try {
      if (statSync(command).isFile()) return command;
    } catch { /* not found */ }
    return null;
  }
  for (const dir of pathStr.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, command + ext);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch { /* skip */ }
    }
  }
  return null;
}



/**
 * Build an augmented env for spawning external CLI runtimes (claude, codex).
 *
 * Delegates to getShellEnv() which already handles:
 * - Windows: system PATH + npm global (%APPDATA%\npm), Git, Bun, Node.js
 * - macOS: shell -l PATH detection + homebrew, NVM, pnpm, Bun
 * - PATH key normalization (Windows Path vs Unix PATH)
 *
 * Previously this function had its own hardcoded Unix-only PATH augmentation,
 * which missed Windows paths like %APPDATA%\npm → "Executable not found". See: #70
 *
 * NOTE: The Sidecar process already has NO_PROXY injected by Rust's
 * proxy_config::apply_to_subprocess(). getShellEnv() spreads process.env,
 * so external CLI subprocesses spawned here are also protected.
 */
export function augmentedProcessEnv(): Record<string, string | undefined> {
  return getShellEnv();
}

/**
 * Resolve an external CLI command to its full executable path.
 *
 * Uses our local `which()` with the augmented PATH (from `getShellPath()`)
 * on ALL platforms.
 *
 * Why this is needed everywhere (not just Windows):
 * - Windows: npm global installs create `.cmd` wrappers; `spawn()` via libuv
 *   doesn't resolve PATH extensions (.CMD/.BAT) → ENOENT. See: #70
 * - macOS/Linux: `spawn()` uses posix_spawnp which searches the CALLER's PATH,
 *   not the env passed to the child. GUI apps (Tauri/Finder) have minimal PATH
 *   that lacks NVM/fnm/volta/asdf paths. Even though augmentedProcessEnv() builds
 *   a correct PATH, the bare command name won't be found by posix_spawnp.
 *   Pre-resolving to a full path bypasses PATH lookup entirely.
 */
export function resolveCommand(command: string): string {
  const resolved = which(command, { PATH: getShellPath() });
  if (resolved) return resolved;
  // Fallback: return as-is and let spawn fail with a clear error
  return command;
}

// eslint-disable-next-line no-control-regex -- Intentional ANSI escape code stripping for log output
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/**
 * Strip ANSI terminal escape codes (color/style) from a string.
 * External CLI tools (codex, claude) emit colored stderr — raw ANSI codes
 * appear as garbage like `[2m`, `[31m` in unified log files.
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}
