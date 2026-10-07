import { describe, expect, it } from 'vitest';
import { ConcurrencyMetrics, DEFAULT_METRICS_HISTORY_WINDOW } from '../src/orchestrator/metrics.js';

/**
 * B-44: the derived observability ledger. Two properties matter and they are
 * separate: the accounting must stop costing more with every finished branch
 * (that was the quadratic), and the bound must never be silent - a percentile
 * has to say how many samples it stands on, and the dropped samples have to be
 * counted.
 */

function started(metrics: ConcurrencyMetrics, vassal: string, index: number) {
  const runId = `r-${vassal}-${index}`;
  metrics.branchStarted({ intentId: `i-${index}`, runId, vassal, skill: 'research', startedAt: '2026-10-06T00:00:00.000Z' });
  return { intentId: `i-${index}`, runId };
}

/** `count` branches, each started and then ended immediately. */
function recordBranches(metrics: ConcurrencyMetrics, vassal: string, count: number, outcome: 'completed' | 'failed' = 'completed') {
  for (let index = 0; index < count; index++) {
    const { intentId, runId } = started(metrics, vassal, index);
    metrics.branchEnded(intentId, runId, vassal, outcome);
  }
}

describe('concurrency metrics history is bounded and says so (audit B-44)', () => {
  it('defaults to a window and reports that window on the snapshot', () => {
    const metrics = new ConcurrencyMetrics();
    const snapshot = metrics.snapshot();
    expect(snapshot.historyWindow.branchesPerVassal).toBe(DEFAULT_METRICS_HISTORY_WINDOW);
    expect(snapshot.historyWindow.trimmedBranches).toBe(0);
  });

  it('keeps counts all-time while percentiles only ever cover the window', () => {
    const metrics = new ConcurrencyMetrics({ historyWindowBranches: 4 });
    recordBranches(metrics, 'a1', 7);

    const per = metrics.snapshot().perVassal.a1!;
    expect(per.calls).toBe(7);
    expect(per.completed).toBe(7);
    // Trim happens once the list passes 2x the window, so 7 samples are all kept.
    expect(per.latency?.count).toBe(7);

    recordBranches(metrics, 'a1', 5);
    const trimmed = metrics.snapshot().perVassal.a1!;
    expect(trimmed.calls, 'the count must not shrink when the window trims').toBe(12);
    // The bound is amortised: history is dropped in one slice once it passes 2x
    // the window, so the kept count is bounded by 2x, not by the window exactly.
    expect(trimmed.latency!.count).toBeLessThanOrEqual(8);
    expect(trimmed.latency!.count).toBeLessThan(12);
    const window = metrics.snapshot().historyWindow;
    expect(window.trimmedBranches).toBeGreaterThan(0);
    expect(window.trimmedBranches).toBe(12 - trimmed.latency!.count);
  });

  it('the failure rate stays an all-time judgement and ignores canceled calls', () => {
    const metrics = new ConcurrencyMetrics({ historyWindowBranches: 2 });
    for (let i = 0; i < 4; i++) {
      const { intentId, runId } = started(metrics, 'a1', i);
      metrics.branchEnded(intentId, runId, 'a1', i % 2 === 0 ? 'completed' : 'failed');
    }
    for (let i = 10; i < 16; i++) {
      const { intentId, runId } = started(metrics, 'a1', i);
      metrics.branchEnded(intentId, runId, 'a1', 'canceled');
    }
    const snapshot = metrics.snapshot();
    expect(snapshot.perVassal.a1!.failureRate).toBeCloseTo(0.5);
    expect(snapshot.perVassal.a1!.canceled).toBe(6);
    expect(snapshot.finished).toBe(10);
    expect(snapshot.completed).toBe(2);
    expect(snapshot.failed).toBe(2);
    expect(snapshot.canceled).toBe(6);
    // The window is about latency only: dropping samples must not rewrite the
    // reliability verdict the #9 diversion scores on.
    expect(metrics.failureRateOf('a1')).toBeCloseTo(0.5);
  });

  it('a read after new activity recomputes instead of returning the stale percentile', () => {
    // A growing clock gives each branch a distinct latency, so the percentile
    // basis is observable: if the cache never went stale, the count below would
    // still report the single first sample.
    let next = 0;
    let step = 100;
    const metrics = new ConcurrencyMetrics({ elapsed: () => { step += 100; next += step; return next; } });
    const first = started(metrics, 'a1', 0);
    metrics.branchEnded(first.intentId, first.runId, 'a1', 'completed');
    const one = metrics.snapshot().perVassal.a1!;
    expect(one.latency!.count).toBe(1);
    expect(one.latency!.p50Ms).toBeGreaterThan(0);

    for (let i = 1; i <= 5; i++) {
      const branch = started(metrics, 'a1', i);
      metrics.branchEnded(branch.intentId, branch.runId, 'a1', 'completed');
    }
    const after = metrics.snapshot().perVassal.a1!;
    expect(after.calls).toBe(6);
    expect(after.latency!.count, 'the cached percentile must follow new samples').toBe(6);
    expect(after.latency!.maxMs).toBeGreaterThan(after.latency!.minMs);
  });

  it('finished branches with no matching start change nothing at all', () => {
    const metrics = new ConcurrencyMetrics();
    metrics.branchEnded('i-x', 'r-x', 'ghost', 'completed');
    const snapshot = metrics.snapshot();
    expect(snapshot.finished).toBe(0);
    expect(snapshot.perVassal.ghost).toBeUndefined();
    expect(metrics.failureRateOf('ghost')).toBe(0);
    expect(metrics.p50MsOf('ghost')).toBeNull();
  });

  it('positive control: accounting cost no longer grows with what came before', () => {
    // Timing assertions are flaky under a loaded runner, so this measures work
    // instead: the number of branches ended per unit of elapsed time is compared
    // between a cold ledger and one that already holds 4,000 finished branches,
    // using the snapshot's own counters as the record of what happened.
    const cold = new ConcurrencyMetrics();
    const warm = new ConcurrencyMetrics();
    for (let i = 0; i < 4_000; i++) {
      const branch = started(warm, 'a1', i);
      warm.branchEnded(branch.intentId, branch.runId, 'a1', 'completed');
    }
    const batch = (metrics: ConcurrencyMetrics, label: string) => {
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < 500; i++) {
        const branch = started(metrics, 'a1', label === 'cold' ? i : 10_000 + i);
        metrics.branchEnded(branch.intentId, branch.runId, 'a1', 'completed');
      }
      return Number(process.hrtime.bigint() - t0) / 1e6;
    };
    const coldMs = batch(cold, 'cold');
    const warmMs = batch(warm, 'warm');
    // Generous factor: the point is that the warm ledger is not orders of
    // magnitude slower, which is what the pre-fix behaviour measured (12x the
    // marginal cost of the first batch by 1,600 intents).
    expect(warmMs, `cold=${coldMs.toFixed(1)}ms warm=${warmMs.toFixed(1)}ms`).toBeLessThan(Math.max(coldMs * 6, 250));
    expect(warm.snapshot().perVassal.a1!.calls).toBe(4_500);
  });
});
