import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/memory/memory-store.js';
import {
  MIN_WRITEWEIGHT_FACTOR,
  selectionWeightsFromWritebacks,
  WritebackLedger,
} from '../src/memory/writeback.js';
import { attributeFailures } from '../src/reflection/failure-attribution.js';
import { selectCandidates } from '../src/orchestrator/discovery.js';
import type { AuditEntry } from '../src/dispatch/dispatcher.js';
import type { WritebackRecord } from '../src/memory/types.js';

function entry(partial: Partial<AuditEntry> & { decision: AuditEntry['decision']; vassal: string }): AuditEntry {
  return { ts: '2026-10-07T00:00:00.000Z', ...partial };
}

const SLOW = 'slow-vassal';
const FAST = 'fast-vassal';

/** A stable `vassal-concentrated` failure pattern: 3 failures / 3 entries. */
function stablePatternEntries(): AuditEntry[] {
  return [
    entry({ vassal: SLOW, decision: 'dispatch-failed', detail: 'conn reset' }),
    entry({ vassal: SLOW, decision: 'dispatch-failed', detail: 'conn reset' }),
    entry({ vassal: SLOW, decision: 'dispatch-failed', detail: 'conn reset' }),
    entry({ vassal: FAST, decision: 'dispatched' }),
  ];
}

function selectionContext(weights?: Record<string, number>) {
  return {
    candidatePool: [SLOW, FAST],
    load: { inFlightOf: () => 0, capOf: () => Number.POSITIVE_INFINITY },
    tier: 'tier-0' as const,
    readOnlyTagged: true,
    capabilityGranted: true,
    ...(weights ? { weights } : {}),
  };
}

function providers(weights?: Record<string, number>): string[] {
  return selectCandidates('skill-x', selectionContext(weights)).map((c) => c.provider);
}

describe('write-back cards (经验卡): S2 mechanical face', () => {
  it('selectionWeightsFromWritebacks returns baseline {} when no active card', () => {
    expect(selectionWeightsFromWritebacks([])).toEqual({});
    const retracted: WritebackRecord = {
      id: 'w1',
      realmId: 'r',
      createdAt: '2026-10-07T00:00:00.000Z',
      source: { kind: 'vassal-concentrated', target: SLOW, confidence: 'stable' },
      param: 'selection-weight',
      target: SLOW,
      factor: 0.5,
      reason: 'r',
      status: 'retracted',
    };
    expect(selectionWeightsFromWritebacks([retracted])).toEqual({});
  });

  it('selectionWeightsFromWritebacks overrides by target and newest wins', () => {
    const out = selectionWeightsFromWritebacks([
      { id: 'a', realmId: 'r', createdAt: '2026-10-07T00:00:00.000Z', source: { kind: 'vassal-concentrated', target: SLOW, confidence: 'stable' }, param: 'selection-weight', target: SLOW, factor: 0.3, reason: 'x', status: 'active' },
      { id: 'b', realmId: 'r', createdAt: '2026-10-07T00:00:01.000Z', source: { kind: 'vassal-concentrated', target: SLOW, confidence: 'stable' }, param: 'selection-weight', target: SLOW, factor: 0.5, reason: 'y', status: 'active' },
    ]);
    expect(out).toEqual({ [SLOW]: 0.5 });
  });

  it('WritebackLedger clamps factor to (MIN, 1] and retract returns to baseline', () => {
    const ledger = new WritebackLedger(() => new Date('2026-10-07T00:00:00.000Z'));
    const card = ledger.record({
      realmId: 'r',
      source: { kind: 'vassal-concentrated', target: SLOW, confidence: 'stable' },
      param: 'selection-weight',
      target: SLOW,
      factor: 0.5,
      reason: 'stable failure cluster',
    });
    expect(ledger.selectionWeights('r')).toEqual({ [SLOW]: 0.5 });

    expect(() => ledger.record({ realmId: 'r', source: { kind: 'vassal-concentrated', target: SLOW, confidence: 'stable' }, param: 'selection-weight', target: SLOW, factor: 1.5, reason: 'too high' })).toThrow(RangeError);
    expect(() => ledger.record({ realmId: 'r', source: { kind: 'vassal-concentrated', target: SLOW, confidence: 'stable' }, param: 'selection-weight', target: SLOW, factor: MIN_WRITEWEIGHT_FACTOR - 0.01, reason: 'too low' })).toThrow(RangeError);

    const retracted = ledger.retract(card.id);
    expect(retracted?.status).toBe('retracted');
    expect(ledger.selectionWeights('r')).toEqual({});
    expect(ledger.retract(card.id)).toBeNull();
  });

  it('MemoryStore round-trips write-back cards through export/import', () => {
    const store = new MemoryStore(() => new Date('2026-10-07T00:00:00.000Z'));
    store.recordWriteback({
      realmId: 'r',
      source: { kind: 'vassal-concentrated', target: SLOW, confidence: 'stable' },
      param: 'selection-weight',
      target: SLOW,
      factor: 0.5,
      reason: 'stable failure cluster',
    });
    const restored = MemoryStore.fromState(store.exportState());
    expect(restored.selectionWeights('r')).toEqual({ [SLOW]: 0.5 });
    expect(restored.listWritebacks('r')).toHaveLength(1);
  });

  it('down-weights a failure-concentrated vassal in selection order, and retract reverts', () => {
    // Baseline: no weights -> pool order preserved.
    expect(providers()).toEqual([SLOW, FAST]);

    // Synthetic stable pattern -> record the recommendation -> weights applied.
    const attr = attributeFailures(stablePatternEntries());
    const stable = attr.patterns.find((p) => p.kind === 'vassal-concentrated' && p.target === SLOW && p.confidence === 'stable');
    expect(stable?.writebackCandidate).toBe(true);

    const store = new MemoryStore(() => new Date('2026-10-07T00:00:00.000Z'));
    store.recordWriteback({
      realmId: 'r',
      source: { kind: stable!.kind, target: stable!.target, confidence: stable!.confidence },
      param: 'selection-weight',
      target: stable!.target,
      factor: 0.5,
      reason: 'stable failure cluster',
    });

    // Applied: slow (0.5) sinks below fast (1) but stays reachable (fail-soft).
    expect(providers(store.selectionWeights('r'))).toEqual([FAST, SLOW]);

    // Retract -> weights back to baseline -> order restored, no other change.
    const [card] = store.listWritebacks('r');
    expect(card).toBeDefined();
    store.retractWriteback(card!.id);
    expect(providers(store.selectionWeights('r'))).toEqual([SLOW, FAST]);
  });

  it('a down-weighted target is still reachable when it is the only candidate (fail-soft)', () => {
    const ctx = selectionContext({ [SLOW]: 0.5 });
    const onlySlow = selectCandidates('skill-x', { ...ctx, candidatePool: [SLOW] }).map((c) => c.provider);
    expect(onlySlow).toEqual([SLOW]);
  });
});
