// Shared environment utilities for external runtime subprocesses (v0.1.60)

import { getShellEnv, getShellPath } from '../utils/shell';
import { which } from 'bun';

const isWindows = process.platform === 'win32';

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
 * Uses Bun.which() with the augmented PATH (from getShellPath()) on ALL platforms.
 *
 * Why this is needed everywhere (not just Windows):
 * - Windows: npm global installs create `.cmd` wrappers; Bun.spawn() via libuv
 *   doesn't resolve PATH extensions (.CMD/.BAT) → ENOENT. See: #70
 * - macOS/Linux: Bun.spawn() uses posix_spawnp which searches the CALLER's PATH,
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
