import type { BranchOutcomeKind } from './metrics.js';

/**
 * H3 real-time progress events (PRD E5.5): coarse branch lifecycle signals plus
 * an intent-finished marker. Branch internal events are not streamed
 * incrementally (the dispatcher resolves a branch with its full event list), so
 * the finest live granularity is branch start / branch end.
 */
export type ProgressEvent =
  | {
      type: 'branch-started';
      intentId: string;
      runId: string;
      vassal: string;
      skill: string;
      at: string;
    }
  | {
      type: 'branch-ended';
      intentId: string;
      runId: string;
      vassal: string;
      outcome: BranchOutcomeKind;
      state?: string;
      at: string;
    }
  | {
      type: 'intent-finished';
      intentId: string;
      runId: string;
      status: string;
      /** Present when the intent named a connected realm; drives auto-consolidation. */
      realmId?: string;
      at: string;
    }
  | {
      type: 'branch-diverted';
      intentId: string;
      runId: string;
      /** The originally-selected (saturated/eligible-lacking) target. */
      from: string;
      /** The same-skill provider the branch was re-pointed to. */
      to: string;
      skill: string;
      at: string;
    }
  | {
      /**
       * S15 V2 (design-streaming §5): one incremental working-frame payload
       * from an execution agent. Preview content is replaceable and never a
       * conclusion — aggregation, memory and any decision path consume only
       * the final task; the trace projection ignores this event type.
       */
      type: 'branch-delta';
      intentId: string;
      runId: string;
      vassal: string;
      seq: number;
      preview: string;
      at: string;
    }
  | {
      /**
       * S15 V2 (design-streaming §5): the intent is still partially ready —
       * N of M branches have settled formal outcomes. A count fact, not a
       * content carrier; emitted when a branch settles.
       */
      type: 'intent-partial';
      intentId: string;
      runId: string;
      settledCount: number;
      totalCount: number;
      at: string;
    };

/** Per-intent pub/sub for the H3 SSE endpoint. One hub per kernel; subscribe
 *  returns an unsubscribe function. Published events are additionally retained
 *  in a bounded per-intent buffer (S6 V2: the trace endpoint rebuilds the span
 *  tree from audit + progress without re-dispatched state; S15 V2: the stream
 *  view reads the same buffer). Retention is FIFO and capped so a long-lived
 *  kernel cannot grow the buffer without bound; a client that connects after
 *  completion reads the stored intent snapshot instead. */
export class ProgressHub {
  private listeners = new Map<string, Set<(event: ProgressEvent) => void>>();
  private retained = new Map<string, ProgressEvent[]>();

  /** Upper bound on retained events per intent (a DAG intent can emit many
   *  branch lifecycle events; beyond this the oldest are dropped, matching the
   *  metrics rolling-window philosophy). */
  static readonly MAX_EVENTS_PER_INTENT = 1000;
  /** Upper bound on distinct intents retained; the oldest intent is evicted
   *  first so the buffer stays O(active + recent window). */
  static readonly MAX_RETAINED_INTENTS = 500;

  publish(event: ProgressEvent): void {
    const set = this.listeners.get(event.intentId);
    if (set) for (const listener of set) listener(event);

    let events = this.retained.get(event.intentId);
    if (events === undefined) {
      if (this.retained.size >= ProgressHub.MAX_RETAINED_INTENTS) {
        const oldest = this.retained.keys().next().value;
        if (oldest !== undefined) this.retained.delete(oldest);
      }
      events = [];
      this.retained.set(event.intentId, events);
    }
    events.push(event);
    if (events.length > ProgressHub.MAX_EVENTS_PER_INTENT) {
      events.splice(0, events.length - ProgressHub.MAX_EVENTS_PER_INTENT);
    }
  }

  subscribe(intentId: string, listener: (event: ProgressEvent) => void): () => void {
    let set = this.listeners.get(intentId);
    if (!set) {
      set = new Set();
      this.listeners.set(intentId, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.listeners.delete(intentId);
    };
  }

  /** Retained events for one intent, in publish order. Absent intents (never
   *  published, or evicted past the retention window) return an empty array. */
  eventsOf(intentId: string): ProgressEvent[] {
    return this.retained.get(intentId) ?? [];
  }

  /** Drop the retained buffer for one intent (S15 V2: the in-memory stream
   *  view is cleaned up when the intent settles). Live listeners are kept. */
  release(intentId: string): void {
    this.retained.delete(intentId);
  }
}
