import { describe, expect, it } from 'vitest';
import { settledCounts, streamViewFromProgress } from '../src/orchestrator/progress-view.js';
import type { ProgressEvent } from '../src/orchestrator/progress.js';

const at = '2026-10-12T00:00:00.000Z';

function started(runId = 'r1:pr-helper'): ProgressEvent {
  return { type: 'branch-started', intentId: 'i1', runId, vassal: 'pr-helper', skill: 'review', at };
}
function delta(seq: number, preview: string, runId = 'r1:pr-helper'): ProgressEvent {
  return { type: 'branch-delta', intentId: 'i1', runId, vassal: 'pr-helper', seq, preview, at };
}
function ended(outcome: 'completed' | 'failed' | 'timeout' | 'canceled', runId = 'r1:pr-helper'): ProgressEvent {
  return { type: 'branch-ended', intentId: 'i1', runId, vassal: 'pr-helper', outcome, at };
}

describe('streamViewFromProgress (design-streaming §3.3, S15 V3)', () => {
  it('folds started/delta/ended events onto the stream view', () => {
    const view = streamViewFromProgress([started(), delta(1, 'checking CI'), ended('completed')]);
    expect(view.order).toEqual(['r1:pr-helper']);
    const branch = view.branches['r1:pr-helper']!;
    expect(branch.started).toBe(true);
    expect(branch.settled).toBe(true);
    expect(branch.outcome?.outcome).toBe('ok');
    expect(branch.vassal).toBe('pr-helper');
    expect(branch.skill).toBe('review');
  });

  it('translates each branch-ended outcome to the stream vocabulary', () => {
    expect(streamViewFromProgress([ended('failed')]).branches['r1:pr-helper']!.outcome?.outcome).toBe('failed');
    expect(streamViewFromProgress([ended('timeout')]).branches['r1:pr-helper']!.outcome?.outcome).toBe('timeout');
    expect(streamViewFromProgress([ended('canceled')]).branches['r1:pr-helper']!.outcome?.outcome).toBe('canceled');
  });

  it('keeps the latest delta preview and frame position while thinking', () => {
    const view = streamViewFromProgress([started(), delta(1, 'first'), delta(2, 'second')]);
    const branch = view.branches['r1:pr-helper']!;
    expect(branch.settled).toBe(false);
    expect(branch.preview).toBe('second');
    expect(branch.lastSeq).toBe(2);
    expect(view.partiallyReady).toBe(true);
  });

  it('refuses an out-of-order delta rather than silently merging it', () => {
    const view = streamViewFromProgress([started(), delta(2, 'second'), delta(1, 'stale')]);
    expect(view.branches['r1:pr-helper']!.preview).toBe('second');
  });

  it('ignores intent-level markers (they are counts/routing, not branch frames)', () => {
    const events: ProgressEvent[] = [
      started(),
      { type: 'intent-partial', intentId: 'i1', runId: 'r1', settledCount: 1, totalCount: 2, at },
      { type: 'intent-finished', intentId: 'i1', runId: 'r1', status: 'completed', at },
      { type: 'branch-diverted', intentId: 'i1', runId: 'r1:x', from: 'a', to: 'b', skill: 'review', at },
    ];
    const view = streamViewFromProgress(events);
    expect(view.order).toEqual(['r1:pr-helper']);
  });

  it('settledCounts reports N of M across branches', () => {
    const events: ProgressEvent[] = [
      started('r1:a'),
      started('r1:b'),
      ended('completed', 'r1:a'),
    ];
    const view = streamViewFromProgress(events);
    expect(settledCounts(view)).toEqual({ settled: 1, total: 2 });
  });

  it('returns the empty view for no events', () => {
    const view = streamViewFromProgress([]);
    expect(view.order).toEqual([]);
    expect(view.partiallyReady).toBe(false);
    expect(settledCounts(view)).toEqual({ settled: 0, total: 0 });
  });
});
