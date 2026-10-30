// design-observability (tech map S6) V1: buildTraceTree pure projection.
// Acceptance (design-observability §5): one tree per span/event class
// (single branch, fan-out, re-pointing, resume, interruption, DAG, decide);
// the same input assembles byte-identical output; resume/re-pointing parentage
// is asserted; missing events never fabricate spans; zero runtime behaviour
// change (V1 is pure functions only).

import { describe, expect, it } from 'vitest';
import { buildTraceTree, createDecisionTraceBuffer } from '../src/observability/trace.js';
import type { AuditEntry } from '../src/dispatch/dispatcher.js';
import type { DecisionTrace } from '../src/decision/types.js';
import type { ProgressEvent } from '../src/orchestrator/progress.js';

function audit(overrides: Partial<AuditEntry>): AuditEntry {
  return { ts: 't0', vassal: 'a1', decision: 'dispatched', ...overrides };
}

function auditEntry(decision: AuditEntry['decision'], runId: string, ts = 't1', detail?: string): AuditEntry {
  return audit({ decision, runId, ts, ...(detail === undefined ? {} : { detail }) });
}

function branchStarted(intentId: string, runId: string, vassal: string, skill: string, at: string): ProgressEvent {
  return { type: 'branch-started', intentId, runId, vassal, skill, at };
}

function branchEnded(intentId: string, runId: string, vassal: string, outcome: string, at: string): ProgressEvent {
  return { type: 'branch-ended', intentId, runId, vassal, outcome: outcome as never, at };
}

function intentFinished(intentId: string, runId: string, at: string): ProgressEvent {
  return { type: 'intent-finished', intentId, runId, status: 'completed', at };
}

describe('buildTraceTree (S6 V1)', () => {
  it('assembles a single-branch tree with lifecycle facts', () => {
    const progress: ProgressEvent[] = [
      branchStarted('intent-1', 'r1', 'a1', 'research', 't0'),
      branchEnded('intent-1', 'r1', 'a1', 'completed', 't1'),
      intentFinished('intent-1', 'r1', 't2'),
    ];
    const tree = buildTraceTree({ audit: [], progress });
    expect(tree.traceId).toBe('r1');
    expect(tree.root.spanId).toBe('intent-1');
    expect(tree.root.kind).toBe('intent');
    expect(tree.spans).toHaveLength(3);
    const [branch, aggregate, fanout] = tree.spans;
    expect(branch).toMatchObject({ spanId: 'r1', kind: 'branch', vassal: 'a1', skill: 'research', startedAt: 't0', endedAt: 't1', outcome: 'completed' });
    // TracePort v1 §2: the fanout step frames the window from intent start to
    // the last branch start; the aggregate step frames the window from the
    // last branch end to intent finish.
    expect(fanout).toMatchObject({ spanId: 'step:fanout', kind: 'decision-step', parentSpanId: 'intent-1', startedAt: 't0', endedAt: 't0', step: { name: 'fanout', vassals: ['a1'] } });
    expect(aggregate).toMatchObject({ spanId: 'step:aggregate', kind: 'decision-step', parentSpanId: 'intent-1', startedAt: 't1', endedAt: 't2', step: { name: 'aggregate', vassals: ['a1'] } });
  });

  it('assembles a fan-out tree with multiple branches under one root', () => {
    const progress: ProgressEvent[] = [
      branchStarted('intent-1', 'r1', 'a1', 'research', 't0'),
      branchStarted('intent-1', 'r2', 'a2', 'research', 't0'),
      branchStarted('intent-1', 'r3', 'a3', 'research', 't0'),
    ];
    const tree = buildTraceTree({ audit: [], progress });
    expect(tree.spans).toHaveLength(4);
    for (const s of tree.spans) expect(s.parentSpanId).toBe('intent-1');
    expect(tree.spans.map((s) => s.spanId).sort()).toEqual(['r1', 'r2', 'r3', 'step:fanout']);
  });

  it('records a re-pointing from progress as an intent-level event', () => {
    const progress: ProgressEvent[] = [
      branchStarted('intent-1', 'r1', 'a1', 'research', 't0'),
      { type: 'branch-diverted', intentId: 'intent-1', runId: 'r1', from: 'a1', to: 'a2', skill: 'research', at: 't1' },
    ];
    const tree = buildTraceTree({ audit: [], progress });
    expect(tree.root.events).toContainEqual({ kind: 'target-switch', at: 't1', detail: 'a1 -> a2' });
  });

  it('records a resume as its own span pointing back at the parent branch', () => {
    const progress: ProgressEvent[] = [branchStarted('intent-1', 'r1', 'a1', 'research', 't0')];
    const entries: AuditEntry[] = [auditEntry('chain-retried', 'r1:resume1', 't1', 'retry after timeout')];
    const tree = buildTraceTree({ audit: entries, progress });
    const resume = tree.spans.find((s) => s.spanId === 'r1:resume1');
    expect(resume).toBeDefined();
    expect(resume!.parentSpanId).toBe('r1');
    expect(resume!.events).toContainEqual(expect.objectContaining({ kind: 'resume', at: 't1' }));
    // The parent branch also carries the resume event.
    const parent = tree.spans.find((s) => s.spanId === 'r1');
    expect(parent!.events).toContainEqual(expect.objectContaining({ kind: 'resume', at: 't1' }));
  });

  it('records an interruption on the interrupted branch', () => {
    const progress: ProgressEvent[] = [branchStarted('intent-1', 'r1', 'a1', 'research', 't0')];
    const entries: AuditEntry[] = [auditEntry('interrupt-level-1', 'r1', 't1')];
    const tree = buildTraceTree({ audit: entries, progress });
    expect(tree.spans[0]!.events).toContainEqual({ kind: 'interrupt', at: 't1', detail: 'interrupt-level-1' });
  });

  it('records a context budget trim on its branch', () => {
    const progress: ProgressEvent[] = [branchStarted('intent-1', 'r1', 'a1', 'research', 't0')];
    const entries: AuditEntry[] = [auditEntry('context-trimmed', 'r1', 't1', '3 entries dropped')];
    const tree = buildTraceTree({ audit: entries, progress });
    expect(tree.spans[0]!.events).toContainEqual({ kind: 'context-budget', at: 't1', detail: '3 entries dropped' });
  });

  it('assembles a DAG tree from node intents under the dag root', () => {
    const progress: ProgressEvent[] = [
      branchStarted('dag-7::n1', 'd1', 'a1', 'research', 't0'),
      branchStarted('dag-7::n2', 'd2', 'a2', 'writeup', 't0'),
    ];
    const tree = buildTraceTree({ audit: [], progress });
    expect(tree.root.spanId).toBe('dag-7');
    expect(tree.spans).toHaveLength(3);
    const nodeSpans = tree.spans.filter((s) => s.kind === 'dag-node');
    expect(nodeSpans.map((s) => s.spanId).sort()).toEqual(['d1', 'd2']);
    for (const s of nodeSpans) {
      expect(s.kind).toBe('dag-node');
      expect(s.parentSpanId).toBe('dag-7');
    }
    // The fan-out step spans the DAG root, not an individual node.
    const fanout = tree.spans.find((s) => s.spanId === 'step:fanout');
    expect(fanout).toMatchObject({ parentSpanId: 'dag-7', startedAt: 't0', endedAt: 't0', step: { name: 'fanout', vassals: ['a1', 'a2'] } });
  });

  it('assembles a decide span when the operator wrote back a decision', () => {
    const progress: ProgressEvent[] = [branchStarted('intent-1', 'r1', 'a1', 'research', 't0')];
    const entries: AuditEntry[] = [auditEntry('driver-grant-issued', 'r1', 't1')];
    const tree = buildTraceTree({ audit: entries, progress });
    const decide = tree.spans.find((s) => s.kind === 'decide');
    expect(decide).toBeDefined();
    expect(decide!.parentSpanId).toBe('intent-1');
    expect(decide!.spanId).toBe('decide:r1');
  });

  it('honours an explicit trace id', () => {
    const progress: ProgressEvent[] = [branchStarted('intent-1', 'r1', 'a1', 'research', 't0')];
    const tree = buildTraceTree({ audit: [], progress, traceId: 'op-trace-9' });
    expect(tree.traceId).toBe('op-trace-9');
    expect(tree.root.traceId).toBe('op-trace-9');
  });

  it('is byte-deterministic for the same input', () => {
    const progress: ProgressEvent[] = [
      branchStarted('intent-1', 'r1', 'a1', 'research', 't0'),
      branchStarted('intent-1', 'r2', 'a2', 'research', 't0'),
      { type: 'branch-diverted', intentId: 'intent-1', runId: 'r1', from: 'a1', to: 'a2', skill: 'research', at: 't1' },
    ];
    const entries: AuditEntry[] = [auditEntry('chain-retried', 'r1:resume1', 't2'), auditEntry('interrupt-level-1', 'r2', 't2')];
    const a = buildTraceTree({ audit: entries, progress });
    const b = buildTraceTree({ audit: entries, progress });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('never fabricates spans from missing events', () => {
    const tree = buildTraceTree({ audit: [], progress: [] });
    expect(tree.root.spanId).toBe('trace-root');
    expect(tree.spans).toHaveLength(0);
  });

  it('assembles a tree from audit facts alone (no progress)', () => {
    const entries: AuditEntry[] = [auditEntry('chain-retried', 'r1:resume1', 't1')];
    const tree = buildTraceTree({ audit: entries, progress: [] });
    expect(tree.root.kind).toBe('intent');
    expect(tree.spans.some((s) => s.spanId === 'r1:resume1')).toBe(true);
  });

  it('assembles tool spans from kernel-level audit facts (no runId)', () => {
    const progress: ProgressEvent[] = [branchStarted('intent-1', 'r1', 'a1', 'research', 't0')];
    const entries: AuditEntry[] = [
      audit({ ts: 't2', vassal: '(kernel)', decision: 'tool-selected', detail: 'tool=web.search' }),
      audit({ ts: 't1', vassal: '(kernel)', decision: 'tool-failed', detail: 'tool=fs.read error=enoent' }),
    ];
    const tree = buildTraceTree({ audit: entries, progress });
    const toolSpans = tree.spans.filter((s) => s.kind === 'tool');
    expect(toolSpans).toHaveLength(2);
    // Numbering follows the (ts, decision, detail) order, not input order.
    expect(toolSpans[0]!.spanId).toBe('tool:0');
    expect(toolSpans[0]).toMatchObject({ parentSpanId: 'intent-1', startedAt: 't1', outcome: 'tool-failed', summary: 'tool=fs.read error=enoent' });
    expect(toolSpans[1]!.spanId).toBe('tool:1');
    expect(toolSpans[1]).toMatchObject({ parentSpanId: 'intent-1', startedAt: 't2', outcome: 'tool-selected', summary: 'tool=web.search' });

    // A runId-bearing tool line stays a branch event, never a tool span.
    const withRunId = buildTraceTree({ audit: [auditEntry('tool-selected', 'r1', 't3', 'tool=x')], progress });
    expect(withRunId.spans.filter((s) => s.kind === 'tool')).toHaveLength(0);
    expect(withRunId.spans.find((s) => s.spanId === 'r1')!.events).toContainEqual({ kind: 'target-switch', at: 't3', detail: 'tool=x' });
  });

  it('assembles model spans from decision traces under their branch (and the root for off-branch calls)', () => {
    const progress: ProgressEvent[] = [
      branchStarted('intent-1', 'r1', 'a1', 'research', 't0'),
      branchEnded('intent-1', 'r1', 'a1', 'completed', 't5'),
      intentFinished('intent-1', 'r1', 't6'),
    ];
    const traces: DecisionTrace[] = [
      {
        runId: 'r1',
        backend: 'hub',
        model: 'doubao-seed-1.6',
        request: { kind: 'choice', question: 'route?', stateKeys: [] },
        latencyMs: 1200,
        usage: { inputTokens: 100, outputTokens: 30, reasoningTokens: 12, cacheReadTokens: 40 },
        cost: { inputTokens: 100, outputTokens: 30, cents: 0.5 },
        decidedAt: '2026-10-30T00:00:01.200Z',
      },
      {
        // No usage/cost/error/result: the ledger-only call stays a ledger fact.
        runId: 'r1',
        backend: 'hub',
        model: 'doubao-seed-1.6',
        request: { kind: 'noul', question: 'true?', stateKeys: [] },
        latencyMs: 300,
        decidedAt: '2026-10-30T00:00:00.300Z',
      },
      {
        // An arbitration-level call whose runId owns no branch hangs off the root.
        runId: 'arbitration-run',
        backend: 'llm',
        model: 'judge-model',
        request: { kind: 'score', question: 'rank?', stateKeys: [] },
        latencyMs: 250,
        cost: { inputTokens: 10, outputTokens: 5, cents: 0.02 },
        decidedAt: '2026-10-30T00:00:03.000Z',
      },
    ];
    const tree = buildTraceTree({ audit: [], progress, traces });
    const modelSpans = tree.spans.filter((s) => s.kind === 'model');
    expect(modelSpans).toHaveLength(2);
    expect(modelSpans[0]!.spanId).toBe('model:0');
    expect(modelSpans[0]!.parentSpanId).toBe('r1');
    expect(modelSpans[0]!.vassal).toBe('a1');
    // startedAt is derived from decidedAt - latencyMs (kernel clocks only).
    expect(modelSpans[0]!.startedAt).toBe('2026-10-30T00:00:00.000Z');
    expect(modelSpans[0]!.endedAt).toBe('2026-10-30T00:00:01.200Z');
    expect(modelSpans[0]!.call).toEqual({
      backend: 'hub',
      model: 'doubao-seed-1.6',
      kind: 'choice',
      tokensIn: 100,
      tokensOut: 30,
      reasoningTokens: 12,
      cacheReadTokens: 40,
      costMicros: 5000,
      latencyMs: 1200,
    });
    expect(modelSpans[1]!.spanId).toBe('model:1');
    expect(modelSpans[1]!.parentSpanId).toBe('intent-1');
    expect(modelSpans[1]!.call).toEqual({
      backend: 'llm',
      model: 'judge-model',
      kind: 'score',
      tokensIn: 10,
      tokensOut: 5,
      costMicros: 200,
      latencyMs: 250,
    });
  });

  it('assembles arbitration and judge decision-step spans from decision facts', () => {
    const progress: ProgressEvent[] = [
      branchStarted('intent-1', 'r1', 'a1', 'research', 't0'),
      branchEnded('intent-1', 'r1', 'a1', 'completed', 't1'),
      intentFinished('intent-1', 'r1', 't2'),
    ];
    const tree = buildTraceTree({
      audit: [],
      progress,
      steps: {
        arbitration: {
          concluded: true,
          conclusion: 'vassal a1 wins',
          backend: 'hub',
          latencyMs: 400,
          decidedAt: '2026-10-30T00:00:00.400Z',
        },
        judge: {
          judged: false,
          reason: 'single-stance',
          backend: 'hub',
          latencyMs: 0,
          decidedAt: '2026-10-30T00:00:00.500Z',
        },
        conclusion: 'aggregated: a1',
      },
    });
    const arbitration = tree.spans.find((s) => s.spanId === 'step:arbitration');
    expect(arbitration).toBeDefined();
    expect(arbitration).toMatchObject({
      kind: 'decision-step',
      parentSpanId: 'intent-1',
      // startedAt is decidedAt - latencyMs; the record carries the end only.
      startedAt: '2026-10-30T00:00:00.000Z',
      endedAt: '2026-10-30T00:00:00.400Z',
      outcome: 'concluded',
    });
    expect(arbitration!.step).toEqual({ name: 'arbitration', conclusion: 'vassal a1 wins', latencyMs: 400 });

    const judge = tree.spans.find((s) => s.spanId === 'step:judge');
    expect(judge).toBeDefined();
    expect(judge).toMatchObject({ kind: 'decision-step', parentSpanId: 'intent-1', startedAt: '2026-10-30T00:00:00.500Z', endedAt: '2026-10-30T00:00:00.500Z', outcome: 'skipped:single-stance' });
    expect(judge!.step).toEqual({ name: 'judge', conclusion: 'single-stance', latencyMs: 0 });

    // The aggregation conclusion rides the aggregate step.
    const aggregate = tree.spans.find((s) => s.spanId === 'step:aggregate');
    expect(aggregate!.step).toEqual({ name: 'aggregate', vassals: ['a1'], conclusion: 'aggregated: a1' });
  });

  it('buffers decision traces per run and evicts the oldest run at the cap', () => {
    const buffer = createDecisionTraceBuffer(2);
    const trace = (runId: string): DecisionTrace => ({
      runId,
      backend: 'hub',
      model: 'm',
      request: { kind: 'noul', question: 'q', stateKeys: [] },
      latencyMs: 1,
      decidedAt: '2026-10-30T00:00:00.000Z',
    });
    buffer.add(trace('a'));
    buffer.add(trace('a'));
    buffer.add(trace('b'));
    expect(buffer.forRuns(['a'])).toHaveLength(2);
    // Cap reached: the oldest run ('a') is dropped, not the newest call.
    buffer.add(trace('c'));
    expect(buffer.forRuns(['a'])).toHaveLength(0);
    expect(buffer.forRuns(['b', 'c'])).toHaveLength(2);
    expect(buffer.forRuns([])).toHaveLength(0);
  });

  it('is byte-deterministic with model spans regardless of trace input order', () => {
    const progress: ProgressEvent[] = [
      branchStarted('intent-1', 'r1', 'a1', 'research', 't0'),
      branchEnded('intent-1', 'r1', 'a1', 'completed', 't5'),
      intentFinished('intent-1', 'r1', 't6'),
    ];
    const traces: DecisionTrace[] = [
      { runId: 'r1', backend: 'hub', model: 'm1', request: { kind: 'noul', question: 'q', stateKeys: [] }, latencyMs: 100, cost: { inputTokens: 5, outputTokens: 2, cents: 0.01 }, decidedAt: '2026-10-30T00:00:02.000Z' },
      { runId: 'r1', backend: 'llm', model: 'm0', request: { kind: 'choice', question: 'q', stateKeys: [] }, latencyMs: 50, cost: { inputTokens: 1, outputTokens: 1, cents: 0.02 }, decidedAt: '2026-10-30T00:00:01.000Z' },
    ];
    const steps = { conclusion: 'done' };
    const a = buildTraceTree({ audit: [], progress, traces, steps });
    const b = buildTraceTree({ audit: [], progress, traces: [...traces].reverse(), steps });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
