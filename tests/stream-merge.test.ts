// design-streaming (tech map S15) V1: emptyStreamView / appendStreamFrame /
// settledViewMatchesMerge pure functions. Acceptance (design-streaming §5):
// frames of all three kinds fold into one view; previews are replaceable and
// never referenced; order is first-appearance; partiallyReady flips; the
// convergence assertion holds on matching stream+merge and fails on any
// mismatch; out-of-order deltas are refused; immutability — the input view is
// never mutated; zero runtime behaviour change (V1 is pure functions only).

import { describe, expect, it } from 'vitest';
import { appendStreamFrame, emptyStreamView, settledViewMatchesMerge } from '../src/orchestrator/stream-merge.js';
import type { FanOutResult } from '../src/orchestrator/types.js';

const start = (runId: string, vassal = 'a1', skill = 'research') =>
  ({ type: 'branch-started', runId, vassal, skill, at: 't0' }) as const;
const delta = (runId: string, seq: number, preview: string) =>
  ({ type: 'branch-delta', runId, seq, preview, at: 't1' }) as const;
const settled = (runId: string, outcome: 'ok' | 'failed' | 'canceled' | 'timeout') =>
  ({ type: 'branch-settled', runId, outcome, at: 't2' }) as const;

describe('appendStreamFrame (S15 V1)', () => {
  it('starts with an empty view', () => {
    const v = emptyStreamView();
    expect(v.order).toEqual([]);
    expect(v.branches).toEqual({});
    expect(v.partiallyReady).toBe(false);
  });

  it('folds a started + delta + settled sequence for one branch', () => {
    let v = emptyStreamView();
    v = appendStreamFrame(v, start('r1'));
    v = appendStreamFrame(v, delta('r1', 1, 'first cut'));
    v = appendStreamFrame(v, delta('r1', 2, 'revised cut'));
    v = appendStreamFrame(v, settled('r1', 'ok'));
    expect(v.order).toEqual(['r1']);
    expect(v.branches['r1']).toMatchObject({ started: true, settled: true, lastSeq: 2, preview: 'revised cut' });
    expect(v.partiallyReady).toBe(false);
  });

  it('keeps first-appearance order across interleaved branches', () => {
    let v = emptyStreamView();
    v = appendStreamFrame(v, start('r2'));
    v = appendStreamFrame(v, start('r1'));
    v = appendStreamFrame(v, delta('r2', 1, 'b'));
    expect(v.order).toEqual(['r2', 'r1']);
  });

  it('flips partiallyReady while any branch is unsettled', () => {
    let v = emptyStreamView();
    v = appendStreamFrame(v, start('r1'));
    v = appendStreamFrame(v, settled('r1', 'ok'));
    v = appendStreamFrame(v, start('r2'));
    expect(v.partiallyReady).toBe(true);
    v = appendStreamFrame(v, settled('r2', 'failed'));
    expect(v.partiallyReady).toBe(false);
  });

  it('replaces the preview on the next delta (replaceable, not referenced)', () => {
    let v = emptyStreamView();
    v = appendStreamFrame(v, start('r1'));
    v = appendStreamFrame(v, delta('r1', 1, 'draft-a'));
    const first = v.branches['r1']!.preview;
    v = appendStreamFrame(v, delta('r1', 2, 'draft-b'));
    expect(first).toBe('draft-a');
    expect(v.branches['r1']!.preview).toBe('draft-b');
  });

  it('refuses an out-of-order delta (seq must be strictly increasing)', () => {
    let v = emptyStreamView();
    v = appendStreamFrame(v, start('r1'));
    v = appendStreamFrame(v, delta('r1', 2, 'second'));
    const before = v;
    v = appendStreamFrame(v, delta('r1', 1, 'stale'));
    expect(v).toBe(before);
  });

  it('never mutates the input view', () => {
    const v0 = emptyStreamView();
    const v1 = appendStreamFrame(v0, start('r1'));
    expect(v0.order).toEqual([]);
    expect(v1.order).toEqual(['r1']);
  });
});

describe('settledViewMatchesMerge (S15 V1)', () => {
  function merge(branches: FanOutResult['branches']): FanOutResult {
    return {
      intentId: 'intent-1', runId: 'r0', skill: 'research', realm: 'personal', branches, stream: [], positions: [],
      decision: { rule: 'unanimous', conclusion: null, positions: [], reason: '' }, conflicts: [], status: 'completed', createdAt: 't0',
    };
  }

  it('agrees when the view and the merge observe the same settled branch set', () => {
    let v = emptyStreamView();
    v = appendStreamFrame(v, start('r1'));
    v = appendStreamFrame(v, settled('r1', 'ok'));
    v = appendStreamFrame(v, start('r2'));
    v = appendStreamFrame(v, settled('r2', 'failed'));
    const m = merge([
      { vassal: 'a1', runId: 'r1', ok: true, events: [] },
      { vassal: 'a2', runId: 'r2', ok: false, events: [] },
    ]);
    expect(settledViewMatchesMerge(v, m)).toBe(true);
  });

  it('fails when the merge has a branch the view never settled', () => {
    let v = emptyStreamView();
    v = appendStreamFrame(v, start('r1'));
    v = appendStreamFrame(v, settled('r1', 'ok'));
    const m = merge([
      { vassal: 'a1', runId: 'r1', ok: true, events: [] },
      { vassal: 'a2', runId: 'r2', ok: true, events: [] },
    ]);
    expect(settledViewMatchesMerge(v, m)).toBe(false);
  });

  it('fails on an outcome mismatch (view ok, merge failed)', () => {
    let v = emptyStreamView();
    v = appendStreamFrame(v, start('r1'));
    v = appendStreamFrame(v, settled('r1', 'ok'));
    const m = merge([{ vassal: 'a1', runId: 'r1', ok: false, events: [] }]);
    expect(settledViewMatchesMerge(v, m)).toBe(false);
  });

  it('maps canceled merge states to their settled outcomes', () => {
    let v = emptyStreamView();
    v = appendStreamFrame(v, start('r1'));
    v = appendStreamFrame(v, settled('r1', 'canceled'));
    v = appendStreamFrame(v, start('r2'));
    v = appendStreamFrame(v, settled('r2', 'failed'));
    const m = merge([
      { vassal: 'a1', runId: 'r1', ok: false, state: 'canceled', events: [] },
      { vassal: 'a2', runId: 'r2', ok: false, state: 'failed', events: [] },
    ]);
    expect(settledViewMatchesMerge(v, m)).toBe(true);
  });

  it('fails when the view has a settled branch the merge never ran', () => {
    let v = emptyStreamView();
    v = appendStreamFrame(v, start('r9'));
    v = appendStreamFrame(v, settled('r9', 'ok'));
    const m = merge([{ vassal: 'a1', runId: 'r1', ok: true, events: [] }]);
    expect(settledViewMatchesMerge(v, m)).toBe(false);
  });
});
