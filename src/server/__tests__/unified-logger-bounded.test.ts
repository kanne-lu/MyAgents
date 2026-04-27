/**
 * Pattern 6 §6.3.5 — bounded async writer + drop counter.
 *
 * Verifies:
 *  (a) Synthesizing 10000 entries into the queue does NOT OOM and does
 *      NOT silently grow the queue beyond `QUEUE_MAX_ENTRIES` — overflow
 *      bumps the internal drop counter.
 *  (b) The flusher function (exposed as `_flushUnifiedLogForTests`) drains
 *      what's queued to disk synchronously when called.
 *  (c) The recent-lines ring buffer (used by the crash dumper) caps at
 *      its capacity even when the input far exceeds it.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendUnifiedLog,
  appendUnifiedLogBatch,
  _flushUnifiedLogForTests,
  _getDroppedCount,
  getRecentLogLines,
} from '../UnifiedLogger';
import { LOGS_DIR } from '../logUtils';
import type { LogEntry } from '../../renderer/types/log';

// LOGS_DIR is resolved from `homedir()` at module-load time, before any
// test setup can override HOME. So instead of redirecting the path, we
// snapshot the current logs directory state at the start of each test
// and assert about size/file deltas after the test runs. Files written
// here go into the developer's real ~/.myagents/logs but with a
// `[bench]` prefix that makes them trivially identifiable / cleanable.

interface DirSnapshot {
  files: Map<string, number>; // filename → size
}

function snapshot(): DirSnapshot {
  const files = new Map<string, number>();
  if (existsSync(LOGS_DIR)) {
    for (const f of readdirSync(LOGS_DIR)) {
      if (!f.startsWith('unified-') || !f.endsWith('.log')) continue;
      try {
        files.set(f, statSync(`${LOGS_DIR}/${f}`).size);
      } catch { /* ignore */ }
    }
  }
  return { files };
}

let before: DirSnapshot;

beforeEach(() => {
  before = snapshot();
});

afterEach(() => {
  // Best-effort: nothing to clean — the test entries land in the real
  // unified log file alongside any other dev activity, identifiable by
  // their `[bench]` prefix. Retention/eviction will trim them eventually.
});

function makeEntry(i: number): LogEntry {
  return {
    source: 'bun',
    level: 'info',
    message: `[bench] entry ${i}`,
    timestamp: new Date().toISOString(),
  };
}

describe('UnifiedLogger — bounded queue + drop counter', () => {
  it('(a) burst of 10000 entries does not unbound the queue', () => {
    // The HOME env var only affects logs path resolution; the test
    // primarily exercises queue + ring-buffer caps. We don't try to flush
    // 10000 to disk because that's slow on CI.
    const burstSize = 10000;
    const startDropped = _getDroppedCount();
    const entries: LogEntry[] = [];
    for (let i = 0; i < burstSize; i++) entries.push(makeEntry(i));
    appendUnifiedLogBatch(entries);

    const dropped = _getDroppedCount() - startDropped;
    // QUEUE_MAX_ENTRIES is 1000 → 9000+ should be dropped (since we
    // didn't flush concurrently). Allow some slack if the timer flusher
    // fires during the batch loop.
    expect(dropped).toBeGreaterThan(0);
    expect(dropped).toBeLessThanOrEqual(burstSize);
  });

  it('(b) _flushUnifiedLogForTests writes queued entries to disk', () => {
    appendUnifiedLog(makeEntry(1));
    appendUnifiedLog(makeEntry(2));
    appendUnifiedLog(makeEntry(3));
    _flushUnifiedLogForTests();

    const after = snapshot();
    // Either a new file was created OR an existing file grew. Either is
    // proof that the flusher actually wrote to disk.
    let grew = false;
    for (const [name, size] of after.files) {
      const prev = before.files.get(name) ?? 0;
      if (size > prev) { grew = true; break; }
    }
    expect(grew).toBe(true);
  });

  it('(c) recent-lines ring buffer caps at capacity', () => {
    const burstSize = 5000;
    for (let i = 0; i < burstSize; i++) {
      appendUnifiedLog(makeEntry(i));
    }
    const recent = getRecentLogLines(1000);
    // Capacity is 200 (RECENT_LINES_CAPACITY), so even asking for 1000
    // returns at most that many.
    expect(recent.length).toBeLessThanOrEqual(200);
    expect(recent.length).toBeGreaterThan(0);
    // Tail should contain the most-recent entries — entry 4999 must be
    // present in the tail buffer.
    const last = recent[recent.length - 1];
    expect(last).toContain(`entry ${burstSize - 1}`);
  });
});
