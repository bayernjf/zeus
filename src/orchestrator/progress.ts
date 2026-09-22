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
    };

/** Per-intent pub/sub for the H3 SSE endpoint. One hub per kernel; subscribe
 *  returns an unsubscribe function. Events are not retained — a client that
 *  connects after completion reads the stored intent snapshot instead. */
export class ProgressHub {
  private listeners = new Map<string, Set<(event: ProgressEvent) => void>>();

  publish(event: ProgressEvent): void {
    const set = this.listeners.get(event.intentId);
    if (!set) return;
    for (const listener of set) listener(event);
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
}
