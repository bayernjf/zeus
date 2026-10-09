// design-observability (tech map S6) V1: buildTraceTree pure projection.
// Acceptance (design-observability §5): one tree per span/event class
// (single branch, fan-out, re-pointing, resume, interruption, DAG, decide);
// the same input assembles byte-identical output; resume/re-pointing parentage
// is asserted; missing events never fabricate spans; zero runtime behaviour
// change (V1 is pure functions only).

import { describe, expect, it } from 'vitest';
import { buildTraceTree } from '../src/observability/trace.js';
import type { AuditEntry } from '../src/dispatch/dispatcher.js';
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
    expect(tree.spans).toHaveLength(1);
    expect(tree.spans[0]).toMatchObject({ spanId: 'r1', kind: 'branch', vassal: 'a1', skill: 'research', startedAt: 't0', endedAt: 't1', outcome: 'completed' });
  });

  it('assembles a fan-out tree with multiple branches under one root', () => {
    const progress: ProgressEvent[] = [
      branchStarted('intent-1', 'r1', 'a1', 'research', 't0'),
      branchStarted('intent-1', 'r2', 'a2', 'research', 't0'),
      branchStarted('intent-1', 'r3', 'a3', 'research', 't0'),
    ];
    const tree = buildTraceTree({ audit: [], progress });
    expect(tree.spans).toHaveLength(3);
    for (const s of tree.spans) expect(s.parentSpanId).toBe('intent-1');
    expect(tree.spans.map((s) => s.spanId).sort()).toEqual(['r1', 'r2', 'r3']);
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
    expect(tree.spans).toHaveLength(2);
    for (const s of tree.spans) {
      expect(s.kind).toBe('dag-node');
      expect(s.parentSpanId).toBe('dag-7');
    }
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
});
