// IM Pipeline v2 — Pattern B: ImEventBus
//
// Replaces the legacy module-level `imStreamCallback` singleton with a
// per-session pub/sub bus. Every SDK event tagged with the requestId of the
// user message currently being processed; subscribers filter by requestId
// to deliver events to the right reply slot.
//
// Architectural win: the legacy `imCallbackNulledDuringTurn` flag and all
// the "callback replaced / stale event leak" defensive code go away —
// stale events from a finished turn carry the old requestId; new
// subscribers filter them out. Wrong-routing becomes structurally
// impossible, not "guarded against".
//
// Sidecar is per-session (one Sidecar serves one logical session), so the
// module-level singleton bus instance maps 1:1 to "events for this session".
// In Pattern C, /api/im/events long-poll consumes from this same bus with
// `since=<lastSeq>` for crash-recovery semantics.

export type ImEventType =
  | 'delta'              // streaming text fragment
  | 'block-end'          // a complete text block boundary
  | 'complete'           // turn finished (success)
  | 'error'              // turn failed / aborted
  | 'permission-request' // SDK asks user permission
  | 'activity'           // non-text content_block_start (thinking / tool_use)
  | 'cancelled'          // explicit user cancel (Pattern D)
  | 'gap';               // ring buffer overflow — some events were dropped

export interface ImEvent {
  /** Monotonically increasing sequence per bus instance. Subscribers can
   *  resume after disconnect using `subscribe(lastSeq, cb)`. */
  seq: number;
  /** The user message this event belongs to. `null` = session-level
   *  (e.g. system init, gap announcement) — broadcast to all subscribers. */
  requestId: string | null;
  type: ImEventType;
  /** Event payload. Type depends on `type`:
   *    - 'delta' / 'block-end' / 'complete' / 'error' / 'cancelled': string
   *    - 'permission-request': JSON string with { requestId, toolName, input }
   *    - 'activity': string (content block type)
   *    - 'gap': { droppedSeqs: [from, to] } */
  data?: unknown;
  ts: number;
}

export type ImEventSubscriber = (event: ImEvent) => void;

const MAX_BUFFER = 1000;

class ImEventBusImpl {
  private buffer: ImEvent[] = [];
  private nextSeq = 1;
  private subscribers = new Set<ImEventSubscriber>();
  /** Singleton "you missed events" marker. Held outside the buffer so it
   *  never competes for ring-buffer slots; emit-side eviction extends this
   *  gap's range, subscribe-side replay synthesizes it before live events. */
  private gap: ImEvent | null = null;

  /** Emit an event. Stamps it with the next sequence number, appends to the
   *  buffer (capped at MAX_BUFFER, oldest-first eviction). Eviction extends
   *  the singleton `gap` marker so resuming subscribers see the data loss.
   *  Subscriber exceptions are logged but do not block other subscribers. */
  emit(requestId: string | null, type: ImEventType, data?: unknown): void {
    const seq = this.nextSeq++;
    const event: ImEvent = { seq, requestId, type, data, ts: Date.now() };

    this.buffer.push(event);
    while (this.buffer.length > MAX_BUFFER) {
      const dropped = this.buffer.shift()!;
      if (this.gap) {
        // Extend existing gap to cover the new dropped seq.
        const range = (this.gap.data as { droppedSeqs: [number, number] }).droppedSeqs;
        range[1] = Math.max(range[1], dropped.seq);
      } else {
        this.gap = {
          seq: dropped.seq,
          requestId: null,
          type: 'gap',
          data: { droppedSeqs: [dropped.seq, dropped.seq] as [number, number] },
          ts: Date.now(),
        };
      }
    }

    for (const sub of this.subscribers) {
      try { sub(event); } catch (e) { console.error('[im-bus] subscriber threw', e); }
    }
  }

  /** Seq at which the current generation started (post-`clear()` reset).
   *  Subscribers resuming with sinceSeq < generationStartSeq belong to a prior
   *  generation and need a full re-sync. */
  private generationStartSeq = 1;

  /** Subscribe to events with seq > sinceSeq.
   *  - To get only future events: pass `bus.currentSeq()` as sinceSeq.
   *  - To replay from start (e.g. crash recovery): pass 0.
   *  - Returns an unsubscribe function — caller MUST call it to avoid leaks.
   *
   *  Gap synthesis: if events were evicted (this.gap is set) and the requested
   *  sinceSeq is below the dropped range, synthesize a gap event before live
   *  replay so the subscriber knows data was lost. Cross-generation resume
   *  (sinceSeq predating a `clear()`) also triggers a synthetic gap so the
   *  Rust consumer knows to re-sync rather than silently miss new events
   *  (Codex W3 fix). */
  subscribe(sinceSeq: number, cb: ImEventSubscriber): () => void {
    // Cross-generation: subscriber's `since` is older than our last reset.
    // Independent from the in-generation eviction gap below — both can apply
    // (a subscriber that resumed across a reset AND inside an eviction range
    // needs both markers, hence sequential `if`s instead of `else if`).
    if (sinceSeq > 0 && sinceSeq < this.generationStartSeq) {
      try {
        cb({
          seq: this.generationStartSeq - 1,
          requestId: null,
          type: 'gap',
          data: {
            droppedSeqs: [sinceSeq + 1, this.generationStartSeq - 1] as [number, number],
            reason: 'session-reset',
          },
          ts: Date.now(),
        });
      } catch (e) { console.error('[im-bus] subscriber threw on generation-gap', e); }
    }
    // In-generation eviction gap — fire whenever the subscriber's `sinceSeq`
    // is below the END of the dropped range, not just below its start.
    // Codex W3 fix: the previous `sinceSeq < this.gap.seq` (where `seq`
    // tracks the FIRST dropped event) silently lost events for any
    // subscriber that resumed inside a dropped range.
    if (this.gap) {
      const range = (this.gap.data as { droppedSeqs: [number, number] }).droppedSeqs;
      if (sinceSeq < range[1]) {
        try { cb(this.gap); } catch (e) { console.error('[im-bus] subscriber threw on gap', e); }
      }
    }

    for (const event of this.buffer) {
      if (event.seq > sinceSeq) {
        try { cb(event); } catch (e) { console.error('[im-bus] subscriber threw on replay', e); }
      }
    }
    this.subscribers.add(cb);
    return () => { this.subscribers.delete(cb); };
  }

  /** Latest assigned sequence (i.e. the seq of the most recently emitted
   *  event). New subscribers should pass this to receive only future events. */
  currentSeq(): number {
    return this.nextSeq - 1;
  }

  /** Number of events currently held in the ring buffer. Diagnostic only. */
  size(): number {
    return this.buffer.length;
  }

  /** Number of active subscribers. Diagnostic only. */
  subscriberCount(): number {
    return this.subscribers.size;
  }

  /** Reset bus state. Called on session reset / sidecar shutdown.
   *
   *  Subscriber semantics (Codex M3 fix): on shutdown the caller wants the
   *  bus to stop forwarding — long-poll consumers / SSE bridges / Pattern C
   *  ImEventConsumer tasks have no way to reach back and `unsubscribe()`.
   *  Pre-fix the subscriber set survived `clear()` and stale registrants
   *  kept receiving events from the next generation, retaining each one's
   *  closure (and any per-subscriber buffer it captured) until process
   *  exit. We now drop them: a subscriber that survives across a session
   *  reset has to re-`subscribe()`, which is the right contract.
   *
   *  We do NOT reset `nextSeq` (Codex W3): a Rust consumer that reconnects
   *  with `since=<old high seq>` against a freshly-reset bus would otherwise
   *  ask "give me events newer than 999" while we've reset to seq=1, missing
   *  hundreds of new events. Keeping nextSeq monotonic + bumping
   *  generationStartSeq lets `subscribe()` detect cross-generation requests
   *  and synthesize a session-reset gap. */
  clear(): void {
    this.buffer.length = 0;
    this.gap = null;
    this.generationStartSeq = this.nextSeq; // future events live in new generation
    this.subscribers.clear();
    // nextSeq is intentionally NOT reset.
  }
}

/** Per-sidecar singleton. Sidecar is 1:1 with session, so this implicitly
 *  scopes to one session. */
export const imEventBus = new ImEventBusImpl();
