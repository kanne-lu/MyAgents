// IM Pipeline v2 — Pattern C/D: ImRequestRegistry
//
// Tracks every in-flight IM user message by requestId. Holds:
//   - AbortController for explicit user cancel (Pattern D /api/im/cancel)
//   - sessionId for cross-request filtering (multiple sessions in theory share
//     a single Sidecar, though current architecture is 1:1)
//   - Status / timestamps for diagnostics + stale entry pruning
//
// The registry is the structural counterpart to the legacy "single
// imStreamCallback" — instead of one ambient ref, we track N concurrent
// requests by ID. The registry is what makes mid-turn injection truly
// concurrent without losing attribution: each yielded user message has its
// own slot, its own AbortController, its own log trail.
//
// Sidecar is per-session, so this module-level singleton is implicitly
// session-scoped. If we ever multiplex sessions inside one Sidecar, this
// becomes a per-session map and the API gains a sessionId parameter.

import type { CancelReason } from './cancellation';

export type ImRequestStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface ImRequestEntry {
  requestId: string;
  /** Session that owns this request — informational; not used for routing yet. */
  sessionId: string | null;
  /** Optional source descriptor (e.g. "feishu_private:chat-123") for log/diag. */
  source: string | null;
  abortController: AbortController;
  status: ImRequestStatus;
  createdAt: number;
  /** Updated on transitions; useful for staleness pruning. */
  updatedAt: number;
}

const MAX_REGISTRY_SIZE = 200; // soft cap — stale entries get pruned proactively
const STALE_MS = 6 * 60 * 60 * 1000; // 6h — buffered messages might wait this long

class ImRequestRegistryImpl {
  private entries = new Map<string, ImRequestEntry>();

  /** Register a new request. Idempotent: re-registering the same requestId
   *  returns the existing entry (preserves AbortController so callers get
   *  the same cancellation surface). */
  register(requestId: string, sessionId: string | null, source: string | null = null): ImRequestEntry {
    const existing = this.entries.get(requestId);
    if (existing) return existing;
    const entry: ImRequestEntry = {
      requestId,
      sessionId,
      source,
      abortController: new AbortController(),
      status: 'queued',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.entries.set(requestId, entry);
    if (this.entries.size > MAX_REGISTRY_SIZE) this.pruneStale(STALE_MS);
    return entry;
  }

  get(requestId: string): ImRequestEntry | undefined {
    return this.entries.get(requestId);
  }

  /** Update status; safe no-op if the entry is gone (e.g. session reset). */
  setStatus(requestId: string, status: ImRequestStatus): void {
    const entry = this.entries.get(requestId);
    if (!entry) return;
    entry.status = status;
    entry.updatedAt = Date.now();
  }

  /** Trigger AbortController.abort(reason). Returns true if the entry existed
   *  and was previously not-aborted. Pattern D /api/im/cancel uses this. */
  abort(requestId: string, reason: CancelReason | string): boolean {
    const entry = this.entries.get(requestId);
    if (!entry) return false;
    if (entry.abortController.signal.aborted) return false;
    entry.abortController.abort(reason);
    entry.status = 'cancelled';
    entry.updatedAt = Date.now();
    return true;
  }

  /** Drop a finished entry. Caller invokes after turn completes / fails so
   *  long-lived sessions don't leak. */
  unregister(requestId: string): void {
    this.entries.delete(requestId);
  }

  /** Diagnostic. */
  size(): number {
    return this.entries.size;
  }

  /** Drop entries older than maxAgeMs (default STALE_MS). Returns count pruned. */
  pruneStale(maxAgeMs: number = STALE_MS): number {
    const now = Date.now();
    let pruned = 0;
    for (const [id, entry] of this.entries) {
      if (now - entry.updatedAt > maxAgeMs) {
        this.entries.delete(id);
        pruned++;
      }
    }
    return pruned;
  }

  /** Wipe all entries. Called on session reset to release in-flight aborts. */
  clear(): void {
    for (const entry of this.entries.values()) {
      if (!entry.abortController.signal.aborted) {
        try { entry.abortController.abort('session-reset'); } catch { /* ignore */ }
      }
    }
    this.entries.clear();
  }
}

export const imRequestRegistry = new ImRequestRegistryImpl();
