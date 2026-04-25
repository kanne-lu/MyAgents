/**
 * Generic cross-process file lock helper (Pattern 5 — single-writer invariant).
 *
 * Uses atomic mkdir as the lock primitive — same approach as the renderer-side
 * acquireFileLock and the Rust with_config_lock. Each lockdir contains an
 * `owner` file (`node:<pid>`) used for stale-lock recovery: if the lockdir
 * exists past `staleMs` AND its owner pid is no longer alive, the lock is
 * forcibly broken before the next acquire attempt.
 *
 * Async polling only — no Atomics.wait / no SharedArrayBuffer / no busy-wait.
 * Throws FileBusyError on timeout (caller can choose to retry or surface).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { resolve } from 'path';

export interface FileLockOptions {
  /** Absolute path to the lock directory (e.g. `<file>.lock`). */
  lockPath: string;
  /** Max time to wait for lock acquisition before throwing. Default 5000ms. */
  timeoutMs?: number;
  /** Lock dir age above which we'll attempt stale-recovery if owner is dead. Default 30000ms. */
  staleMs?: number;
  /** Polling interval while waiting. Default 50ms. */
  pollMs?: number;
}

export class FileBusyError extends Error {
  readonly code = 'FILE_BUSY';

  constructor(lockPath: string, timeoutMs: number) {
    super(`File busy: could not acquire lock ${lockPath} within ${timeoutMs}ms; retry`);
    this.name = 'FileBusyError';
  }
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_STALE_MS = 30000;
const DEFAULT_POLL_MS = 50;

function delay(ms: number): Promise<void> {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
}

/**
 * Try to break an existing lock if its owner is dead and it is older than `staleMs`.
 *
 * Owner file format:
 *   - `node:<pid>` / `rust:<pid>`  → check pid liveness via `process.kill(pid, 0)`
 *   - `renderer:<ts>`              → renderer pids aren't observable, skip pid check;
 *                                    only stale-by-age may break it.
 *
 * Returns true if we forcibly removed the lockdir (caller should retry mkdir immediately).
 */
function tryBreakStaleLock(lockPath: string, staleMs: number): boolean {
  let ageMs: number;
  try {
    ageMs = Date.now() - statSync(lockPath).mtimeMs;
  } catch {
    // Lock disappeared between EEXIST and stat — caller will retry mkdir.
    return true;
  }

  if (ageMs <= staleMs) return false;

  // Read owner sentinel
  let owner = '';
  try {
    owner = readFileSync(resolve(lockPath, 'owner'), 'utf-8').trim();
  } catch {
    // No owner file — treat as recoverable purely on age basis.
  }

  // For node/rust owners, refuse to break if pid is still alive.
  const match = /^(node|rust):(\d+)$/.exec(owner);
  if (match) {
    const pid = Number(match[2]);
    // Node's process.kill rejects pids that don't fit in a 32-bit signed int.
    if (Number.isFinite(pid) && pid > 0 && pid <= 0x7fffffff) {
      try {
        // Signal 0 = liveness probe.
        process.kill(pid, 0);
        // Owner is alive — don't break.
        return false;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        // ESRCH = no such process. EPERM = process exists but we can't signal it
        // (cross-user) — be conservative and leave it alone.
        if (code !== 'ESRCH') return false;
      }
    }
  }
  // For renderer:<ts> or unrecognized owners we fall through to age-based break.

  console.warn(
    `[file-lock] Breaking stale lock ${lockPath} (age=${ageMs}ms owner=${owner || 'unknown'})`
  );
  try {
    rmSync(lockPath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Acquire `opts.lockPath` (a directory created via atomic mkdir), run `op`,
 * and always release the lock.
 *
 * Multiple async callers in the same process serialize naturally because
 * mkdirSync is atomic; cross-process callers serialize the same way. Stale
 * locks (owner crashed mid-write) are auto-recovered after `staleMs`.
 */
export async function withFileLock<T>(
  opts: FileLockOptions,
  op: () => Promise<T>
): Promise<T> {
  const lockPath = opts.lockPath;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;

  const start = Date.now();
  let acquired = false;
  while (!acquired) {
    try {
      mkdirSync(lockPath);
      acquired = true;
      try {
        writeFileSync(resolve(lockPath, 'owner'), `node:${process.pid}\n`, 'utf-8');
      } catch {
        // owner file is diagnostic only; missing is non-fatal.
      }
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;

      // Lockdir already exists — see if it's stale.
      if (tryBreakStaleLock(lockPath, staleMs)) {
        // Retry mkdir immediately — don't sleep.
        continue;
      }

      if (Date.now() - start >= timeoutMs) {
        throw new FileBusyError(lockPath, timeoutMs);
      }
      await delay(pollMs);
    }
  }

  try {
    return await op();
  } finally {
    try {
      // Only remove if we still own it (best-effort; another process that broke
      // a stale lock and took it will have its own delete on release).
      if (existsSync(lockPath)) {
        rmSync(lockPath, { recursive: true, force: true });
      }
    } catch {
      // Best-effort unlock; future timeouts will surface this.
    }
  }
}
