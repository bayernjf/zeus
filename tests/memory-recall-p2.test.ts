import { describe, expect, it } from 'vitest';
import { MemoryStore, type MemoryAuditEntry, type MemoryEvent } from '../src/index.js';

function claim(
  id: string,
  subject: string,
  predicate: string,
  object: unknown,
  agent = 'agent-a',
  occurredAt = '2026-09-22T08:00:00.000Z',
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
    occurredAt,
  };
}

function settledStore(events: MemoryEvent[]): MemoryStore {
  const store = new MemoryStore();
  for (const event of events) store.append(event);
  store.consolidateRealm('personal');
  return store;
}

describe('Memory P2 hybrid recall', () => {
  it('keyword query recalls the matching fact first', () => {
    const store = settledStore([
      claim('e1', 'user', 'language', 'typescript'),
      claim('e2', 'user', 'language', 'rust'),
    ]);
    const hits = store.searchRecall('personal', 'personal', 'typescript');
    expect(hits[0].fact.object).toBe('typescript');
    expect(hits[0].lexical).toBeGreaterThan(0);
    expect(hits[0].semantic).toBeGreaterThan(0);
  });

  it('tokenises and recalls Chinese text', () => {
    const store = settledStore([
      claim('e1', 'user', 'prefers', '手冲咖啡'),
      claim('e2', 'user', 'prefers', '大麦茶'),
    ]);
    const hits = store.searchRecall('personal', 'personal', '咖啡');
    expect(hits[0].fact.object).toBe('手冲咖啡');
  });

  it('disputed facts stay recallable and are flagged', () => {
    const store = settledStore([
      claim('e1', 'user', 'city', 'Berlin', 'agent-a'),
      claim('e2', 'user', 'city', 'Munich', 'agent-b'),
    ]);
    const cities = store.searchRecall('personal', 'personal', 'city Berlin Munich');
    expect(cities).toHaveLength(2);
    expect(cities.every(h => h.fact.status === 'disputed')).toBe(true);
  });

  it('rare lexical term wins under BM25 and alpha adjusts the mix', () => {
    const store = settledStore([
      claim('e1', 'doc', 'topic', 'common common common xylophone'),
      claim('e2', 'doc', 'topic', 'common xylophone'),
    ]);
    const lexical = store.searchRecall('personal', 'personal', 'xylophone', { alpha: 0 });
    // The shorter document gets the higher BM25 term-frequency saturation.
    expect(lexical[0].fact.object).toBe('common xylophone');
    expect(lexical[0].semantic).toBe(0);
  });

  it('consolidation refreshes a materialised index automatically', () => {
    const store = settledStore([claim('e1', 'user', 'language', 'rust')]);
    store.buildRecall('personal');
    store.append(claim('e2', 'user', 'editor', 'zed'));
    store.consolidateRealm('personal');
    expect(store.searchRecall('personal', 'personal', 'zed')).toHaveLength(1);
  });

  it('rejects cross-realm recall and audits it', () => {
    const audits: MemoryAuditEntry[] = [];
    const store = new MemoryStore(entry => audits.push(entry));
    expect(() => store.searchRecall('work', 'personal', 'rust')).toThrowError();
    expect(audits[0].reason).toBe('cross-realm-read');
  });

  it('accepts an injected embedder through the port', () => {
    const embedder = {
      dimension: 2,
      embed: (text: string) => (text.includes('zzz') ? [1, 0] : [0, 1]),
    };
    const store = new MemoryStore(() => {}, () => new Date(), { embedder });
    store.append(claim('e1', 'a', 'tag', 'zzz'));
    store.append(claim('e2', 'a', 'tag', 'qqq'));
    store.consolidateRealm('personal');
    const hits = store.searchRecall('personal', 'personal', 'zzz', { alpha: 1 });
    expect(hits[0].fact.object).toBe('zzz');
    expect(hits[0].semantic).toBe(1);
  });
});

describe('Memory P2 right to be forgotten', () => {
  it('retraction drops the fact from facts and from recall immediately', () => {
    const store = settledStore([
      claim('e1', 'user', 'language', 'typescript'),
      claim('e2', 'user', 'editor', 'zed'),
    ]);
    const [factId] = store.facts('personal', 'personal')
      .filter(f => f.object === 'typescript')
      .map(f => f.factId);

    const records = store.retractFacts('personal', [factId], {
      reason: 'user request',
      requestedBy: 'driver',
    });
    expect(records).toHaveLength(1);
    expect(records[0].subject).toBe('user');
    expect(store.searchRecall('personal', 'personal', 'typescript')).toEqual([]);
    expect(store.searchRecall('personal', 'personal', 'zed')).toHaveLength(1);
    expect(
      store.facts('personal', 'personal').find(f => f.factId === factId)?.status,
    ).toBe('retracted');
  });

  it('forgetting a subject retracts every fact about it and keeps others', () => {
    const store = settledStore([
      claim('e1', 'alice', 'phone', 'secret'),
      claim('e2', 'alice', 'city', 'Berlin'),
      claim('e3', 'bob', 'city', 'Munich'),
    ]);
    const records = store.forgetSubject('personal', 'Alice', {
      reason: 'right to erasure',
      requestedBy: 'driver',
    });
    expect(records).toHaveLength(2);
    expect(store.listRetractions().map(r => r.factId).sort()).toEqual(
      records.map(r => r.factId).sort(),
    );
    expect(store.searchRecall('personal', 'personal', 'secret Berlin')).toEqual([]);
    expect(store.searchRecall('personal', 'personal', 'Munich')).toHaveLength(1);
    // The append-only event log is retained for governance replay.
    expect(store.read('personal', 'personal')).toHaveLength(3);
  });

  it('retraction is a no-op for unknown or already-retracted facts', () => {
    const store = settledStore([claim('e1', 'user', 'language', 'rust')]);
    expect(store.retractFacts('personal', ['nope'], { reason: 'x', requestedBy: 'd' })).toEqual([]);
    const [factId] = store.facts('personal', 'personal').map(f => f.factId);
    store.retractFacts('personal', [factId], { reason: 'x', requestedBy: 'd' });
    store.retractFacts('personal', [factId], { reason: 'x', requestedBy: 'd' });
    expect(store.listRetractions()).toHaveLength(1);
  });

  it('tombstones persist and the index rebuilds from the fact source', () => {
    const store = settledStore([
      claim('e1', 'alice', 'phone', 'secret'),
      claim('e2', 'bob', 'city', 'Munich'),
    ]);
    const [factId] = store.facts('personal', 'personal')
      .filter(f => f.subject === 'alice')
      .map(f => f.factId);
    store.retractFacts('personal', [factId], { reason: 'gdpr', requestedBy: 'driver' });

    const restored = MemoryStore.fromState(store.exportState());
    expect(restored.listRetractions()[0]).toMatchObject({ factId, reason: 'gdpr' });
    expect(restored.searchRecall('personal', 'personal', 'secret')).toEqual([]);
    expect(restored.searchRecall('personal', 'personal', 'Munich')).toHaveLength(1);
  });
});
