// Shared environment utilities for external runtime subprocesses (v0.1.60)

import { getShellEnv } from '../utils/shell';

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
