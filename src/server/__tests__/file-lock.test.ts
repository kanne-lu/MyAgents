/**
 * Pattern 5 — file-lock helper unit tests.
 *
 * Covers:
 *  (a) basic withFileLock serializes two concurrent ops in the same process
 *  (b) stale-lock recovery breaks a lockdir whose owner pid is dead
 *  (c) timeout returns FileBusyError when owner is alive past timeoutMs
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { withFileLock, FileBusyError } from '../utils/file-lock';

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'myagents-file-lock-'));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('withFileLock', () => {
  it('serializes two concurrent ops on the same lockPath', async () => {
    const lockPath = join(scratch, 'demo.lock');
    const trace: string[] = [];

    const op = (label: string, holdMs: number) =>
      withFileLock({ lockPath, timeoutMs: 2000, pollMs: 10 }, async () => {
        trace.push(`${label}-enter`);
        await new Promise(r => setTimeout(r, holdMs));
        trace.push(`${label}-exit`);
      });

    await Promise.all([op('A', 80), op('B', 20)]);

    // Strict ordering: whichever entered first must exit before the other enters.
    const enterIdx = (label: string) => trace.indexOf(`${label}-enter`);
    const exitIdx = (label: string) => trace.indexOf(`${label}-exit`);
    const first = enterIdx('A') < enterIdx('B') ? 'A' : 'B';
    const second = first === 'A' ? 'B' : 'A';
    expect(exitIdx(first)).toBeLessThan(enterIdx(second));
  });

  it('breaks a stale lock whose owner pid is dead and is older than staleMs', async () => {
    const lockPath = join(scratch, 'stale.lock');
    mkdirSync(lockPath);
    // Use a high but representable pid — process.kill(pid, 0) returns ESRCH
    // because no such process exists. (Don't use 0xFFFFFFFF — Node rejects it
    // with ERR_INVALID_ARG_TYPE before the syscall.)
    writeFileSync(join(lockPath, 'owner'), 'node:999999\n', 'utf-8');

    let ran = false;
    await withFileLock(
      { lockPath, timeoutMs: 2000, staleMs: 0, pollMs: 10 }, // staleMs=0 → any age is "old"
      async () => {
        ran = true;
      }
    );
    expect(ran).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('throws FileBusyError when lock is held by an alive owner past timeoutMs', async () => {
    const lockPath = join(scratch, 'held.lock');
    // Hold the lock with a slow op for >300ms, then try to acquire with timeoutMs=100.
    let holderResolve: () => void;
    const holderDone = new Promise<void>(r => { holderResolve = r; });

    const holder = withFileLock({ lockPath, timeoutMs: 2000, pollMs: 10 }, async () => {
      await holderDone;
    });

    // Give the holder a tick to acquire.
    await new Promise(r => setTimeout(r, 30));

    let busy: unknown = null;
    try {
      await withFileLock(
        { lockPath, timeoutMs: 100, staleMs: 60_000, pollMs: 20 },
        async () => { /* unreachable */ }
      );
    } catch (err) {
      busy = err;
    }

    expect(busy).toBeInstanceOf(FileBusyError);
    expect((busy as FileBusyError).code).toBe('FILE_BUSY');

    // Release holder so its promise resolves cleanly.
    holderResolve!();
    await holder;
  });
});
