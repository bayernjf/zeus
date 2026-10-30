// TracePort v1 §5 (D-5): cross-intent trace query as a pure projection over
// the exported trees — filters (traceId / agent / time window / cost band /
// limit), the aggregate summary (total latency / total cost / error count)
// and the D-4 payload bounds on every served free-text field.

import { describe, expect, it } from 'vitest';
import { buildTraceTree } from '../src/observability/trace.js';
import type { DecisionTrace } from '../src/decision/types.js';
import type { TraceTree } from '../src/observability/trace.js';
import { DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT, queryTraceTrees, summarizeTree } from '../src/observability/trace-query.js';

function decisionTrace(input: { runId: string; latencyMs?: number; cents?: number; decidedAt?: string; error?: DecisionTrace['error'] }): DecisionTrace {
  return {
    runId: input.runId,
    backend: 'hub',
    model: 'm1',
    request: { kind: 'noul', question: 'q', stateKeys: [] },
    latencyMs: input.latencyMs ?? 100,
    ...(input.cents !== undefined ? { cost: { inputTokens: 10, outputTokens: 5, cents: input.cents } } : {}),
    ...(input.error !== undefined ? { error: input.error } : {}),
    decidedAt: input.decidedAt ?? '2026-10-30T00:00:01.000Z',
  };
}

function treeFor(traceId: string, vassal: string, traces: DecisionTrace[], at = '2026-10-30T00:00:00.000Z'): TraceTree {
  return buildTraceTree({
    audit: [],
    progress: [
      { type: 'branch-started', intentId: `intent-${traceId}`, runId: traceId, vassal, skill: 'research', at },
      { type: 'branch-ended', intentId: `intent-${traceId}`, runId: traceId, vassal, outcome: 'completed', at: '2026-10-30T00:00:05.000Z' },
    ],
    traces,
  });
}

describe('summarizeTree (D-5 summary)', () => {
  it('totals measured latency and cost over the model spans', () => {
    const tree = treeFor('t1', 'a1', [
      decisionTrace({ runId: 't1', latencyMs: 100, cents: 0.1 }),
      decisionTrace({ runId: 't1', latencyMs: 50, cents: 0.2, decidedAt: '2026-10-30T00:00:02.000Z' }),
    ]);
    expect(summarizeTree(tree)).toEqual({ totalLatencyMs: 150, totalCostMicros: 3000, errorCount: 0 });
  });

  it('counts errored calls and skips unpriced cost', () => {
    const tree = treeFor('t1', 'a1', [
      decisionTrace({ runId: 't1', error: { code: 'timeout', message: 'backend timed out' } }),
      decisionTrace({ runId: 't1', latencyMs: 30, cents: 0.05, decidedAt: '2026-10-30T00:00:02.000Z' }),
    ]);
    expect(summarizeTree(tree)).toEqual({ totalLatencyMs: 130, totalCostMicros: 500, errorCount: 1 });
  });
});

describe('queryTraceTrees (D-5 query)', () => {
  const a = treeFor('t1', 'a1', [decisionTrace({ runId: 't1', cents: 0.1 })]);
  const b = treeFor('t2', 'a2', [decisionTrace({ runId: 't2', cents: 0.3 })]);
  const older = treeFor('t3', 'a3', [decisionTrace({ runId: 't3', cents: 0.1 })], '2026-10-29T00:00:00.000Z');

  it('filters by trace_id', () => {
    const res = queryTraceTrees([a, b], { traceId: 't2' });
    expect(res.traces.map((t) => t.traceId)).toEqual(['t2']);
    expect(res.summary.count).toBe(1);
  });

  it('filters by agent seen on any span', () => {
    expect(queryTraceTrees([a, b], { agent: 'a1' }).traces.map((t) => t.traceId)).toEqual(['t1']);
    expect(queryTraceTrees([a, b], { agent: 'nobody' }).traces).toHaveLength(0);
  });

  it('filters by the time window on the tree start', () => {
    expect(queryTraceTrees([a, older], { from: '2026-10-30T00:00:00.000Z' }).traces.map((t) => t.traceId)).toEqual(['t1']);
    expect(queryTraceTrees([a, older], { to: '2026-10-29T12:00:00.000Z' }).traces.map((t) => t.traceId)).toEqual(['t3']);
    expect(queryTraceTrees([a, older], { from: '2026-10-29T00:00:00.000Z', to: '2026-10-30T00:00:00.000Z' }).traces).toHaveLength(2);
  });

  it('filters by the cost band over the tree totals', () => {
    // t1/t3 total 1000 micros each, t2 totals 3000 micros.
    expect(queryTraceTrees([a, b, older], { minCostMicros: 500, maxCostMicros: 1500 }).traces.map((t) => t.traceId)).toEqual(['t1', 't3']);
    expect(queryTraceTrees([a, b, older], { minCostMicros: 2000 }).traces.map((t) => t.traceId)).toEqual(['t2']);
    expect(queryTraceTrees([a, b], { maxCostMicros: 500 }).traces).toHaveLength(0);
  });

  it('applies the limit and sums the summary over the returned set', () => {
    const res = queryTraceTrees([a, b, older], { limit: 2 });
    expect(res.traces.map((t) => t.traceId)).toEqual(['t1', 't2']);
    expect(res.summary).toEqual({ totalLatencyMs: 200, totalCostMicros: 4000, errorCount: 0, count: 2 });
  });

  it('defaults to and caps the limit without dropping the summary shape', () => {
    expect(DEFAULT_QUERY_LIMIT).toBe(50);
    expect(MAX_QUERY_LIMIT).toBe(200);
    const res = queryTraceTrees([a], {});
    expect(res.summary).toEqual({ totalLatencyMs: 100, totalCostMicros: 1000, errorCount: 0, count: 1 });
  });

  it('redacts and bounds every served free-text field (D-4)', () => {
    const long = 'x'.repeat(3000);
    const tree = buildTraceTree({
      audit: [
        { ts: '2026-10-30T00:00:01.000Z', vassal: '(kernel)', decision: 'tool-selected', detail: `Bearer sk-live-secret tool=x ${long}` },
      ],
      progress: [
        { type: 'branch-started', intentId: 'intent-1', runId: 't9', vassal: 'a1', skill: 'research', at: '2026-10-30T00:00:00.000Z' },
      ],
      traces: [decisionTrace({ runId: 't9', error: { code: 'auth', message: 'Bearer sk-live-secret rejected' } })],
    });
    const res = queryTraceTrees([tree], {});
    const tool = res.traces[0]!.spans.find((s) => s.kind === 'tool')!;
    expect(tool.summary).not.toContain('sk-live-secret');
    expect(tool.summary).toContain('Bearer [REDACTED]');
    expect(tool.summary!.includes('(truncated,')).toBe(true);
    const model = res.traces[0]!.spans.find((s) => s.kind === 'model')!;
    expect(model.call!.error).not.toContain('sk-live-secret');
    expect(model.call!.error).toContain('Bearer [REDACTED]');
  });
});
