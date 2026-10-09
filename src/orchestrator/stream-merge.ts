// design-streaming (tech map S15): the incremental stream view over a
// fan-out. Frames arrive as branches start, emit deltas and settle; the view
// is an immutable projection — every append returns a new view, previews are
// replaceable but never referenced by identity. V1 is the pure-view layer
// only (design-streaming §5): no transport, no live subscription, and no new
// audit values by default.

import type { FanOutResult } from './types.js';

/** One observable stream event (design-streaming §2.1). */
export type StreamFrame =
  | { type: 'branch-started'; runId: string; vassal: string; skill: string; at: string }
  | { type: 'branch-delta'; runId: string; seq: number; preview: string; at: string }
  | { type: 'branch-settled'; runId: string; outcome: 'ok' | 'failed' | 'canceled' | 'timeout'; at: string };

/** The per-branch live state inside a view. `preview` is the latest delta
 *  preview — replaceable by the next delta, never carried by reference. */
export type StreamBranchState = {
  runId: string;
  vassal?: string;
  skill?: string;
  started: boolean;
  settled: boolean;
  outcome?: StreamFrame & { type: 'branch-settled' };
  lastSeq?: number;
  preview: string;
};

/** An immutable snapshot of the stream so far (design-streaming §2.2).
 *  `order` is the first-appearance order of branch runIds. `partiallyReady`
 *  is true while at least one started branch is not yet settled. */
export type StreamView = {
  order: string[];
  branches: Record<string, StreamBranchState>;
  partiallyReady: boolean;
};

/** The empty view. */
export function emptyStreamView(): StreamView {
  return { order: [], branches: {}, partiallyReady: false };
}

/** Append one frame, returning a new view (never mutating the input). Deltas
 *  overwrite the preview in place; a delta whose seq is not strictly greater
 *  than the branch's lastSeq is rejected (V1 guard against out-of-order
 *  feeds). */
export function appendStreamFrame(view: StreamView, frame: StreamFrame): StreamView {
  const branches: Record<string, StreamBranchState> = {};
  for (const [id, branch] of Object.entries(view.branches)) {
    branches[id] = { ...branch };
  }
  const order = [...view.order];
  const branchesFor = (runId: string): StreamBranchState => {
    let branch = branches[runId];
    if (branch === undefined) {
      branch = { runId, started: false, settled: false, preview: '' };
      branches[runId] = branch;
      order.push(runId);
    }
    return branch;
  };

  switch (frame.type) {
    case 'branch-started': {
      const branch = branchesFor(frame.runId);
      branch.started = true;
      branch.vassal = frame.vassal;
      branch.skill = frame.skill;
      break;
    }
    case 'branch-delta': {
      const branch = branchesFor(frame.runId);
      if (branch.lastSeq !== undefined && frame.seq <= branch.lastSeq) {
        // Out-of-order delta: keep the view consistent by refusing the frame
        // (a feed bug must be visible, not silently merged).
        return view;
      }
      branch.lastSeq = frame.seq;
      branch.preview = frame.preview; // replaceable by design
      break;
    }
    case 'branch-settled': {
      const branch = branchesFor(frame.runId);
      branch.started = true;
      branch.settled = true;
      branch.outcome = frame;
      branch.lastSeq = branch.lastSeq ?? 0;
      break;
    }
  }

  const partiallyReady = Object.values(branches).some((b) => b.started && !b.settled);
  return { order, branches, partiallyReady };
}

/** Convergence assertion (design-streaming §2.3): the stream view has
 *  observed the same branch set and the same outcomes as the settled merge
 *  result. Both must agree on runIds and on the ok/failed verdict; otherwise
 *  the stream and the merge disagree. */
export function settledViewMatchesMerge(view: StreamView, merge: FanOutResult): boolean {
  const settledIds = Object.keys(view.branches).filter((id) => view.branches[id]!.settled);
  if (settledIds.length !== merge.branches.length) return false;
  const mergeById = new Map(merge.branches.map((b) => [b.runId, b]));
  for (const id of settledIds) {
    const outcome = view.branches[id]!.outcome;
    const merged = mergeById.get(id);
    if (outcome === undefined || merged === undefined) return false;
    // The merge side carries ok + a TaskState; the stream side carries
    // outcome. A stream-side `timeout` has no V1 merge-side equivalent
    // (TaskState has no timeout member), so convergence over timeouts is
    // defined by the failed mapping until the merge exposes one.
    const expected = merged.ok ? 'ok' : merged.state === 'canceled' ? 'canceled' : 'failed';
    if (outcome.outcome !== expected) return false;
  }
  return true;
}
