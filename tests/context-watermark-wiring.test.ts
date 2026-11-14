import { describe, expect, it } from 'vitest';
import { Orchestrator, type OrchestratorOptions } from '../src/orchestrator/orchestrator.js';
import type { DispatchPort, FanOutRequest } from '../src/orchestrator/types.js';
import type { AuditEntry } from '../src/dispatch/dispatcher.js';
import type { RecallHit } from '../src/memory/types.js';

// D3-2: the watermark is folded from per-intent assembly events and emitted
// once at settle. This pins the wiring (not just the pure fold): a run that
// assembled context must produce exactly one `context-watermark` audit row.

function hit(): RecallHit {
  return {
    fact: {
      factId: 'fact-1',
      dataDomainId: 'personal',
      subject: 'smoke',
      predicate: 'exists',
      object: true,
      status: 'active',
      provenance: [],
      confidence: 0.9,
      version: 1,
      updatedAt: '2026-11-14T00:00:00.000Z',
    },
    score: 0.9,
    lexical: 0.9,
    semantic: 0,
  };
}

function okTask(id: string) {
  return { kind: 'task' as const, id, contextId: id, status: { state: 'completed' as const }, artifacts: [] };
}

describe('run-level context watermark wiring (D3-2)', () => {
  it('emits exactly one context-watermark row per settled run that assembled context', async () => {
    const audits: AuditEntry[] = [];
    const port: DispatchPort = {
      dispatch: async req => ({ ok: true, task: okTask(req.runId ?? 'run-1'), events: [], injectedHits: [] }),
      cancel: async () => undefined,
    };
    const store = { searchRecall: async () => [hit()] } as unknown as NonNullable<OrchestratorOptions['memoryStore']>;
    const orchestrator = new Orchestrator(
      { findBySkill: () => [{ name: 'A' }], statusOf: () => 'active' },
      port,
      {
        now: () => new Date('2026-11-14T06:00:00Z'),
        newIntentId: () => 'intent-1',
        newRunId: () => 'run-1',
        memoryStore: store,
        audit: entry => audits.push(entry),
      },
    );

    const request: FanOutRequest = {
      intentId: 'intent-1',
      skill: 'research',
      params: {},
      dataDomain: 'personal',
      dataDomainId: 'personal',
    };
    const result = await orchestrator.fanOut(request);

    const rows = audits.filter(a => a.decision === 'context-watermark');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.runId).toBe(result.runId);
    expect(rows[0]!.detail).toContain('1 context entries assembled');
    expect(rows[0]!.detail).toContain('across 1 branch(es)');
  });
});
