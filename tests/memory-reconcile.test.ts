import { describe, expect, it } from 'vitest';
import {
  MemoryStore,
  reconcileMemoryStates,
  verifyMemoryState,
  type FactRecord,
  type MemoryEvent,
  type MemoryState,
} from '../src/index.js';

function claim(
  id: string,
  subject: string,
  predicate: string,
  object: unknown,
  agent = 'agent-a',
): MemoryEvent {
  return {
    eventId: id,
    realmId: 'personal',
    runId: 'run-1',
    source: { agentId: agent },
    kind: 'claim',
    content: { subject, predicate, object },
    refs: [],
    confidence: 0.9,
    occurredAt: '2026-09-22T08:00:00.000Z',
  };
}

async function settledState(events: MemoryEvent[]): Promise<MemoryState> {
  const store = new MemoryStore();
  for (const event of events) store.append(event);
  await store.consolidateRealm('personal');
  return store.exportState();
}

describe('Memory drift reconciliation', () => {
  it('reports no drift for identical snapshots', async () => {
    const state = await settledState([claim('e1', 'user', 'language', 'rust')]);
    expect(reconcileMemoryStates(state, structuredClone(state)).hasDrift).toBe(false);
  });

  it('reports appended events and added facts between two points', async () => {
    const before = await settledState([claim('e1', 'user', 'language', 'rust')]);
    const after = await settledState([
      claim('e1', 'user', 'language', 'rust'),
      claim('e2', 'user', 'editor', 'zed'),
    ]);
    const report = reconcileMemoryStates(before, after);
    expect(report.hasDrift).toBe(true);
    expect(report.eventsAppended).toBe(1);
    expect(report.factsAdded).toHaveLength(1);
    expect(report.eventsRemoved).toBe(0);
  });

  it('detects a fact field change and its specific field', async () => {
    const store = new MemoryStore();
    store.append(claim('e1', 'user', 'city', 'Berlin', 'agent-a'));
    await store.consolidateRealm('personal');
    const before = store.exportState();

    store.append(claim('e2', 'user', 'city', 'Munich', 'agent-b'));
    await store.consolidateRealm('personal');
    const report = reconcileMemoryStates(before, store.exportState());

    const changed = report.factsChanged.find(d => d.changes?.some(c => c.field === 'status'));
    expect(changed).toBeDefined();
    expect(changed!.changes!.find(c => c.field === 'status')?.after).toBe('disputed');
  });

  it('reports retractions and removed events', async () => {
    const store = new MemoryStore();
    store.append(claim('e1', 'alice', 'phone', 'secret'));
    await store.consolidateRealm('personal');
    const before = store.exportState();

    const factId = before.facts[0]![1][0]!.factId;
    store.retractFacts('personal', [factId], { reason: 'gdpr', requestedBy: 'operator' });
    const after = store.exportState();
    const report = reconcileMemoryStates(before, after);
    expect(report.retractionsAdded).toBe(1);
    expect(report.factsChanged.some(
      d => d.changes?.some(c => c.field === 'status' && c.after === 'retracted'),
    )).toBe(true);

    const truncated: MemoryState = { ...structuredClone(after), events: [] };
    expect(reconcileMemoryStates(after, truncated).eventsRemoved).toBe(1);
  });
});

describe('Memory invariant verification', () => {
  it('accepts a healthy consolidated state', async () => {
    const state = await settledState([
      claim('e1', 'user', 'language', 'rust'),
      claim('e2', 'user', 'editor', 'zed'),
    ]);
    expect(verifyMemoryState(state)).toEqual([]);
  });

  it('flags a fact whose id does not rebuild (tampered content)', async () => {
    const state = await settledState([claim('e1', 'user', 'language', 'rust')]);
    const fact = state.facts[0]![1][0]!;
    fact.object = 'python'; // id no longer matches
    const violations = verifyMemoryState(state);
    expect(violations.some(v => v.code === 'bad-fact-id')).toBe(true);
  });

  it('flags provenance that points at a missing or cross-realm event', async () => {
    const state = await settledState([claim('e1', 'user', 'language', 'rust')]);

    const missing = structuredClone(state);
    missing.facts[0]![1][0]!.provenance = ['ghost'];
    expect(verifyMemoryState(missing).some(v => v.code === 'unresolved-provenance')).toBe(true);

    const crossRealm = structuredClone(state);
    crossRealm.events.push({ ...claim('e2', 'x', 'y', 'z') });
    crossRealm.events[1]!.realmId = 'work';
    crossRealm.facts[0]![1][0]!.provenance.push('e2');
    expect(verifyMemoryState(crossRealm).some(v => v.code === 'provenance-realm-mismatch')).toBe(true);
  });

  it('flags a retracted fact without a tombstone and vice versa', async () => {
    const state = await settledState([
      claim('e1', 'alice', 'phone', 'secret'),
      claim('e2', 'bob', 'city', 'Munich'),
    ]);
    const facts = state.facts[0]![1];
    const alice: FactRecord = facts.find(f => f.subject === 'alice')!;
    const bob: FactRecord = facts.find(f => f.subject === 'bob')!;

    alice.status = 'retracted';
    expect(verifyMemoryState(state).some(v => v.code === 'retracted-without-tombstone')).toBe(true);

    state.retractions = [
      { factId: alice.factId, realmId: 'personal', subject: 'alice', reason: 'gdpr', requestedBy: 'operator', at: '2026-09-22T09:00:00.000Z' },
      { factId: bob.factId, realmId: 'personal', subject: 'bob', reason: 'gdpr', requestedBy: 'operator', at: '2026-09-22T09:00:00.000Z' },
    ];
    // alice now paired; bob has a tombstone but is not retracted.
    expect(verifyMemoryState(state).some(v => v.code === 'tombstone-without-retraction')).toBe(true);
    expect(verifyMemoryState(state).some(v => v.code === 'retracted-without-tombstone')).toBe(false);
  });

  it('MemoryStore.verifyIntegrity reports clean for normal operation', async () => {
    const store = new MemoryStore();
    store.append(claim('e1', 'user', 'language', 'rust'));
    await store.consolidateRealm('personal');
    expect(store.verifyIntegrity()).toEqual([]);
  });
});
