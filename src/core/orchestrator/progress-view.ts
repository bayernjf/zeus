// design-streaming §3.3 (tech map S15 V3): project a per-intent ProgressHub
// event log onto the immutable StreamView so a polling face (the terminal
// deck, which has no SSE client) can render the same thinking-state contract
// as the SSE-driven supervisor: waiting → thinking (preview + frame count)
// → settled / blocked. Preview content stays a preview — this projection is
// read-only and never feeds aggregation, memory or any decision path.

import type { ProgressEvent } from './progress.js';
import { appendStreamFrame, emptyStreamView, type StreamView } from './stream-merge.js';

/**
 * Fold retained progress events into a StreamView. Lifecycle/delta events map
 * 1:1 onto stream frames; intent-level markers (intent-finished /
 * intent-partial / branch-diverted) are counts or routing facts the view
 * already derives, so they do not enter the fold. `branch-ended` outcomes use
 * the hub vocabulary ('completed'), translated to the stream vocabulary
 * ('ok'); the other three outcomes share the same names.
 */
export function streamViewFromProgress(events: readonly ProgressEvent[]): StreamView {
  let view = emptyStreamView();
  for (const event of events) {
    if (event.type === 'branch-started') {
      view = appendStreamFrame(view, {
        type: 'branch-started',
        runId: event.runId,
        vassal: event.vassal,
        skill: event.skill,
        at: event.at,
      });
    } else if (event.type === 'branch-delta') {
      view = appendStreamFrame(view, {
        type: 'branch-delta',
        runId: event.runId,
        seq: event.seq,
        preview: event.preview,
        at: event.at,
      });
    } else if (event.type === 'branch-ended') {
      view = appendStreamFrame(view, {
        type: 'branch-settled',
        runId: event.runId,
        outcome: event.outcome === 'completed' ? 'ok' : event.outcome,
        at: event.at,
      });
    }
  }
  return view;
}

/** N of M branches that have reached a settled outcome. */
export function settledCounts(view: StreamView): { settled: number; total: number } {
  const branches = Object.values(view.branches);
  return { settled: branches.filter(b => b.settled).length, total: branches.length };
}
