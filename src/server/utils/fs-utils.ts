/**
 * Filesystem utilities — centralizes patterns that have platform-specific quirks.
 *
 * This file belongs to the "pit of success" family (alongside local_http / process_cmd /
 * proxy_config in Rust): call sites default to the correct behavior without each author
 * needing to remember the underlying trap.
 */

import { mkdirSync } from 'fs';
import { mkdir } from 'fs/promises';

/**
 * Ensure a directory exists, creating parents as needed. Safe to call when the directory
 * already exists — works uniformly across platform/runtime combinations.
 *
 * Replaces the bare `mkdirSync(dir, { recursive: true })` pattern. Three concerns unified:
 *
 * 1. **Node.js semantics**: `{ recursive: true }` is documented as idempotent — silent
 *    no-op when the target already exists. Most hot paths depend on this.
 * 2. **Bun on Windows quirk**: Bun's `mkdirSync({ recursive: true })` on Windows throws
 *    `EEXIST` when the directory already exists, contrary to Node.js semantics. This
 *    broke `syncProjectUserConfig()` (and hence every Agent Channel / Telegram bot
 *    message on Windows) until the helper swallows it. Any recursive mkdir in code
 *    hit by an active Bun-Windows session is liable to the same crash — hence the
 *    centralized fix.
 *    See PR #91 / issue report; tracked upstream in oven-sh/bun.
 * 3. **Real errors propagate**: only `EEXIST` is swallowed. `EACCES`, `EPERM`, `ENOSPC`,
 *    missing grandparent, read-only filesystem etc. all throw as expected — callers
 *    keep their normal failure signaling.
 *
 * ⚠️ Do NOT use as a lock-directory primitive (mkdir-as-mutex pattern). Lock dirs
 * WANT `EEXIST` to throw so the caller knows another process holds the lock. For
 * those, call `mkdirSync(path, { mode: 0o700 })` directly (no `recursive` flag).
 */
export function ensureDirSync(path: string): void {
    try {
        mkdirSync(path, { recursive: true });
    } catch (err) {
        // Only EEXIST is a Bun-Windows false alarm. Everything else is a real failure
        // (permissions, disk full, invalid path) and must not be swallowed.
        if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') return;
        throw err;
    }
}

/**
 * Async equivalent of {@link ensureDirSync}. Uses `fs/promises.mkdir` under the hood.
 * Same EEXIST-swallowing semantics — safe against the same Bun-on-Windows quirk that
 * afflicts the sync variant.
 */
export async function ensureDir(path: string): Promise<void> {
    try {
        await mkdir(path, { recursive: true });
    } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') return;
        throw err;
    }
}
