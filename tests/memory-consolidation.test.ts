import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore, type MemoryAuditEntry } from '../src/memory/memory-store.js';
import {
  aggregateConfidence,
  consolidate,
  MemoryConsolidationError,
} from '../src/memory/consolidate.js';
import type { MemoryEvent } from '../src/memory/types.js';

const REALM = 'realm-personal-1';
const OTHER = 'realm-personal-2';

let counter = 0;
beforeEach(() => {
  counter = 0;
});
function event(partial: Partial<MemoryEvent> & Pick<MemoryEvent, 'content' | 'kind'>): MemoryEvent {
  counter += 1;
  return {
    eventId: `evt-${counter}`,
    realmId: REALM,
    runId: 'run-1',
    source: { agentId: 'agent-a' },
    refs: [],
    confidence: 0.8,
    occurredAt: '2026-09-22T10:00:00.000Z',
    ...partial,
  };
}

const claim = (subject: string, predicate: string, object: unknown, extra: Partial<MemoryEvent> = {}) =>
  event({ kind: 'claim', content: { subject, predicate, object }, ...extra });

describe('memory consolidation P0', () => {
  it('acceptance 1/2: facts are produced only by consolidation and carry provenance', () => {
    const store = new MemoryStore();
    store.append(claim('Zeus', 'runs-on', 'node', { confidence: 0.9 }));
    expect(store.facts(REALM, REALM)).toEqual([]);

    const result = store.consolidateRealm(REALM, { now: () => new Date('2026-09-22T10:05:00Z') });
    const facts = store.facts(REALM, REALM);
    expect(facts).toHaveLength(1);
    expect(facts[0].provenance).toEqual(['evt-1']);
    expect(facts[0].status).toBe('active');
    expect(result.added).toHaveLength(1);
  });

  it('ingests non-claim events but they create no facts', () => {
    const store = new MemoryStore();
    store.append(event({ kind: 'observation', content: { note: 'saw something' } }));
    store.append(event({ kind: 'action', content: { did: 'thing' } }));
    const result = store.consolidateRealm(REALM);
    expect(result.ingested).toHaveLength(2);
    expect(store.facts(REALM, REALM)).toEqual([]);
  });

  it('acceptance 3: repeated observations of the same fact yield one fact with accumulated provenance', () => {
    const store = new MemoryStore();
    store.append(claim('Zeus', 'runs-on', 'node', { source: { agentId: 'agent-a' }, confidence: 0.8 }));
    store.consolidateRealm(REALM);

    store.append(claim('Zeus', 'runs-on', 'node', {
      eventId: 'evt-x', source: { agentId: 'agent-b' }, confidence: 0.6,
      occurredAt: '2026-09-22T10:10:00Z',
    }));
    const result = store.consolidateRealm(REALM, { now: () => new Date('2026-09-22T10:15:00Z') });

    const facts = store.facts(REALM, REALM);
    expect(facts).toHaveLength(1);
    expect(facts[0].provenance).toEqual(['evt-1', 'evt-x']);
    expect(facts[0].version).toBe(2);
    expect(result.merged).toEqual([{ factId: facts[0].factId, with: ['evt-x'] }]);
  });

  it('acceptance 4: conflicting claims default to disputed + escalation, never overwrite', () => {
    const store = new MemoryStore();
    store.append(claim('Zeus', 'runs-on', 'node', { source: { agentId: 'agent-a' } }));
    store.append(claim('Zeus', 'runs-on', 'bun', {
      eventId: 'evt-2', source: { agentId: 'agent-b' },
      occurredAt: '2026-09-22T10:10:00Z',
    }));
    const result = store.consolidateRealm(REALM);

    const facts = store.facts(REALM, REALM);
    expect(facts).toHaveLength(2);
    expect(facts.every(f => f.status === 'disputed')).toBe(true);
    expect(result.disputes).toHaveLength(1);
    expect(result.escalations).toHaveLength(1);
    expect(result.superseded).toEqual([]);
  });

  it('resolves a conflict when the later claim comes from a strictly more reliable agent', () => {
    const store = new MemoryStore();
    store.append(claim('Zeus', 'runs-on', 'node', {
      source: { agentId: 'rookie' }, confidence: 0.9, occurredAt: '2026-09-22T09:00:00Z',
    }));
    store.append(claim('Zeus', 'runs-on', 'bun', {
      eventId: 'evt-2', source: { agentId: 'expert' }, confidence: 0.7,
      occurredAt: '2026-09-22T11:00:00Z',
    }));
    const result = store.consolidateRealm(REALM, {
      reliability: { rookie: 0.4, expert: 0.95 },
    });

    const active = store.facts(REALM, REALM).filter(f => f.status === 'active');
    const superseded = store.facts(REALM, REALM).filter(f => f.status === 'superseded');
    expect(active).toHaveLength(1);
    expect(active[0].object).toBe('bun');
    expect(superseded).toHaveLength(1);
    expect(result.disputes).toEqual([]);
  });

  it('acceptance 5: a store rebuilt from exported state exposes identical facts and replays', () => {
    const store = new MemoryStore();
    store.append(claim('Zeus', 'runs-on', 'node'));
    store.consolidateRealm(REALM);

    const rebuilt = MemoryStore.fromState(store.exportState());
    expect(rebuilt.facts(REALM, REALM)).toEqual(store.facts(REALM, REALM));
    expect(rebuilt.replay(REALM, 'run-1').events).toHaveLength(1);
  });

  it('acceptance 6: confidence is weighted by historical reliability, not self-report alone', () => {
    const events = [
      claim('x', 'p', 'v', { source: { agentId: 'modest-expert' }, confidence: 0.4 }),
      claim('x', 'p', 'v', {
        eventId: 'evt-2', source: { agentId: 'loud-rookie' }, confidence: 1,
        occurredAt: '2026-09-22T10:01:00Z',
      }),
    ];

    const weighted = aggregateConfidence(events, {
      reliability: { 'modest-expert': 0.95, 'loud-rookie': 0.2 },
    });
    // Weighted base = (0.95*0.4 + 0.2*1) / 1.15 ≈ 0.504; +0.05 corroboration.
    expect(weighted).toBeCloseTo(0.554, 2);

    const repeatedSameAgent = aggregateConfidence(
      [
        ...events,
        claim('x', 'p', 'v', { eventId: 'evt-3', source: { agentId: 'loud-rookie' }, confidence: 1 }),
      ],
      { reliability: { 'modest-expert': 0.95, 'loud-rookie': 0.2 } },
    );
    // Same-author repeats add no boost: result is unchanged.
    expect(repeatedSameAgent).toBeCloseTo(weighted, 10);
  });

  it('acceptance 7: cross-realm reads and appends are refused and audited', () => {
    const audits: MemoryAuditEntry[] = [];
    const store = new MemoryStore(entry => audits.push(entry));
    store.append(claim('Zeus', 'runs-on', 'node'));

    expect(() => store.read(OTHER, REALM)).toThrowError(MemoryBoundaryMessage(OTHER, REALM));
    expect(() => store.facts(OTHER, REALM)).toThrow();
    expect(() =>
      store.appendFromRealm(OTHER, claim('Zeus', 'runs-on', 'node')),
    ).toThrow();
    expect(audits.map(a => a.reason)).toEqual(['cross-realm-read', 'cross-realm-read', 'cross-realm-append']);
  });

  it('acceptance 8: replay along a runId returns events and the facts they produced', () => {
    const store = new MemoryStore();
    store.append(claim('Zeus', 'runs-on', 'node', { runId: 'run-A' }));
    store.append(claim('Zeus', 'owned-by', 'user', {
      eventId: 'evt-2', runId: 'run-B', occurredAt: '2026-09-22T10:05:00Z',
    }));
    store.consolidateRealm(REALM);

    const replay = store.replay(REALM, 'run-A');
    expect(replay.events.map(e => e.runId)).toEqual(['run-A']);
    expect(replay.facts).toHaveLength(1);
    expect(replay.facts[0].provenance).toEqual(['evt-1']);
  });

  it('refuses consolidation mixing multiple realms', () => {
    const events = [
      claim('a', 'p', 'v'),
      claim('b', 'p', 'v', { eventId: 'evt-2', realmId: OTHER }),
    ];
    expect(() => consolidate(events)).toThrowError(MemoryConsolidationError);
  });

  it('rejects out-of-range reliability values', () => {
    expect(() =>
      consolidate([claim('a', 'p', 'v')], [], { reliability: { 'agent-a': 1.5 } }),
    ).toThrowError(/out of range/);
  });
});

function MemoryBoundaryMessage(reader: string, target: string): string {
  return `realm ${reader} cannot read memory of realm ${target}`;
}
