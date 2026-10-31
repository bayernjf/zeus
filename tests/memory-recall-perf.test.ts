import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/memory/memory-store.js';
import { LocalHashingEmbedder, RecallIndex } from '../src/memory/recall.js';
import type { Embedder, FactRecord, MemoryEvent } from '../src/memory/types.js';

/**
 * W2-1a (review P2-1 follow-up): incremental RecallIndex sync and the bounded
 * embed pool. The regression this pins down: searchRecall used to pay a full
 * clear-and-rebuild on every call, so a cold cache turned one recall into N
 * serial hub round trips on the decision path. These tests count embed calls
 * to prove only changed facts embed, unchanged and resurrected facts reuse
 * their vector, the pool bounds in-flight embeds, one failing embed does not
 * abort a sync, and a dimension switch still rebuilds from scratch.
 */

const REALM = 'personal';

function claimEvent(overrides: Partial<MemoryEvent> = {}): MemoryEvent {
  return {
    eventId: `evt-${Math.random().toString(36).slice(2, 10)}`,
    realmId: REALM,
    runId: 'run-1',
    source: { agentId: 'tester' },
    kind: 'claim',
    content: { subject: '退款政策', predicate: 'window', object: '7 days' },
    refs: [],
    confidence: 0.9,
    occurredAt: '2026-10-30T00:00:00.000Z',
    ...overrides,
  };
}

function fact(overrides: Partial<FactRecord> & Pick<FactRecord, 'factId'>): FactRecord {
  return {
    realmId: REALM,
    subject: 'user',
    predicate: 'city',
    object: 'Berlin',
    status: 'active',
    provenance: [],
    confidence: 0.9,
    version: 1,
    updatedAt: '2026-10-30T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * Embedder that records every text it is asked to embed, for call counting,
 * and answers with the real local hashing vector so lexical/semantic
 * assertions behave like the production fallback path. The vector follows the
 * (mutable) `dimension` field, so a test can flip the reported vector space
 * the way the hub embedder does on a dimension switch.
 */
function countingEmbedder(dimension = 256): Embedder & { calls: string[]; dimension: number } {
  const calls: string[] = [];
  const locals = new Map<number, LocalHashingEmbedder>();
  const embedder: Embedder & { calls: string[]; dimension: number } = {
    calls,
    dimension,
    embed: async (text: string) => {
      calls.push(text);
      let local = locals.get(embedder.dimension);
      if (!local) {
        local = new LocalHashingEmbedder(embedder.dimension);
        locals.set(embedder.dimension, local);
      }
      return local.embed(text);
    },
  };
  return embedder;
}

describe('RecallIndex incremental sync (W2-1a)', () => {
  it('re-embeds only the changed fact on a re-sync', async () => {
    const embedder = countingEmbedder();
    const index = new RecallIndex(embedder, REALM);
    const a = fact({ factId: 'a', object: 'Berlin' });
    const b = fact({ factId: 'b', object: 'Munich' });

    await index.sync([a, b]);
    expect(embedder.calls).toHaveLength(2);

    // Same content, new fact objects (consolidation rebuilds them every run):
    // zero embed calls, the vectors are reused.
    await index.sync([{ ...a }, { ...b }]);
    expect(embedder.calls).toHaveLength(2);

    // One changed fact: exactly one new embed.
    const moved = { ...a, object: 'Paris' };
    await index.sync([moved, b]);
    expect(embedder.calls).toHaveLength(3);

    const hits = await index.search('Paris');
    expect(hits[0]!.fact.object).toBe('Paris');
    expect(hits.find(h => h.fact.object === 'Berlin')).toBeUndefined();
  });

  it('drops a fact whose status left INDEXABLE_STATUSES even though its text hash is unchanged', async () => {
    const embedder = countingEmbedder();
    const index = new RecallIndex(embedder, REALM);
    const a = fact({ factId: 'a', object: 'Berlin' });
    const b = fact({ factId: 'b', object: 'Munich' });
    await index.sync([a, b]);
    expect(index.size).toBe(2);

    a.status = 'superseded';
    await index.sync([a, b]);
    expect(index.size).toBe(1);
    // Removal cost no embed calls; the search below embeds only its query.
    expect(embedder.calls).toHaveLength(2);
    expect(await index.search('Berlin')).toEqual([]);

    // active <-> disputed stays indexed (both are recallable) for free.
    b.status = 'disputed';
    await index.sync([a, b]);
    expect(embedder.calls).toHaveLength(3); // still just the one query embed
    expect(index.size).toBe(1);
    const hits = await index.search('Munich');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.fact.factId).toBe('b');
    expect(embedder.calls).toHaveLength(4);
  });

  it('keeps recall working when one fact fails to embed, and heals on the next sync', async () => {
    let healthy = false;
    const attempted: string[] = [];
    const local = new LocalHashingEmbedder(64);
    const embedder: Embedder = {
      dimension: 64,
      embed: async (text: string) => {
        attempted.push(text);
        if (text.includes('boom') && !healthy) throw new Error('embedder down');
        return local.embed(text);
      },
    };
    const index = new RecallIndex(embedder, REALM);

    await index.sync([
      fact({ factId: 'ok1', object: 'coffee' }),
      fact({ factId: 'boom', object: 'boom secret' }),
      fact({ factId: 'ok2', object: 'tea' }),
    ]);
    // The failing fact is contained: the sync completed with the other two.
    expect(index.size).toBe(2);
    expect(attempted.filter(t => t.includes('boom'))).toHaveLength(1);
    const nonBoomAttempts = attempted.filter(t => !t.includes('boom')).length;
    expect(nonBoomAttempts).toBe(2);
    expect(await index.search('coffee')).toHaveLength(1);
    expect(await index.search('tea')).toHaveLength(1);

    // Healing re-embeds exactly the fact that failed; the successful two are
    // never attempted again.
    healthy = true;
    const boomBeforeHeal = attempted.filter(t => t.includes('boom')).length;
    const totalBeforeHeal = attempted.length;
    await index.sync([
      fact({ factId: 'ok1', object: 'coffee' }),
      fact({ factId: 'boom', object: 'boom secret' }),
      fact({ factId: 'ok2', object: 'tea' }),
    ]);
    expect(index.size).toBe(3);
    expect(attempted.filter(t => t.includes('boom'))).toHaveLength(boomBeforeHeal + 1);
    expect(attempted.length).toBe(totalBeforeHeal + 1); // only the healed fact
    const healed = await index.search('boom secret');
    expect(healed[0]!.fact.factId).toBe('boom');
  });
});

describe('bounded embed pool (W2-1a)', () => {
  it('caps concurrent embeds at four and still indexes every fact', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const embedder: Embedder = {
      dimension: 8,
      embed: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise(resolve => setTimeout(resolve, 2));
        inFlight -= 1;
        return new Array<number>(8).fill(0.5);
      },
    };
    const index = new RecallIndex(embedder, REALM);
    const facts = Array.from({ length: 40 }, (_, i) =>
      fact({ factId: `f${i}`, object: `topic-${i}` }),
    );
    await index.sync(facts);

    // Exactly the pool width ran in parallel, never more.
    expect(maxInFlight).toBe(4);
    expect(index.size).toBe(40);
    const hits = await index.search('topic-7');
    expect(hits[0]!.fact.factId).toBe('f7');
  });
});

describe('MemoryStore hot recall path (W2-1a)', () => {
  it('a repeated searchRecall embeds the query only, never the facts', async () => {
    const embedder = countingEmbedder();
    const store = new MemoryStore(undefined, () => new Date(), { embedder });
    for (const id of ['e1', 'e2', 'e3']) {
      store.append(claimEvent({
        eventId: id,
        content: { subject: `user-${id}`, predicate: 'language', object: 'typescript' },
      }));
    }
    await store.consolidateRealm(REALM);
    expect(embedder.calls).toHaveLength(0); // no index materialised yet

    await store.buildRecall(REALM);
    expect(embedder.calls).toHaveLength(3); // cold cache: one embed per fact

    await store.searchRecall(REALM, REALM, '退款政策 typescript');
    const afterFirstQuery = embedder.calls.length;
    expect(afterFirstQuery).toBe(4); // +1: the query text only

    await store.searchRecall(REALM, REALM, '退款政策 typescript');
    expect(embedder.calls).toHaveLength(afterFirstQuery + 1); // still query-only

    // A new fact via consolidation embeds exactly that fact.
    store.append(claimEvent({ eventId: 'e4', content: { subject: 'user-e4', predicate: 'editor', object: 'zed' } }));
    await store.consolidateRealm(REALM);
    expect(embedder.calls).toHaveLength(afterFirstQuery + 2);
    expect(embedder.calls.at(-1)).toContain('zed');

    await store.searchRecall(REALM, REALM, 'zed');
    expect(embedder.calls).toHaveLength(afterFirstQuery + 3);
  });

  it('re-embeds the whole corpus exactly once when the embedder switches vector space', async () => {
    const embedder = countingEmbedder(4);
    const store = new MemoryStore(undefined, () => new Date(), { embedder });
    store.append(claimEvent({ eventId: 'd1' }));
    store.append(claimEvent({
      eventId: 'd2',
      content: { subject: '发票', predicate: 'policy', object: '月结 30 天' },
    }));
    await store.consolidateRealm(REALM);

    await store.searchRecall(REALM, REALM, '退款');
    const afterFirst = embedder.calls.length; // 2 facts + 1 query
    expect(afterFirst).toBe(3);

    (embedder as { dimension: number }).dimension = 8;
    await store.searchRecall(REALM, REALM, '退款');
    // Dimension rebuild: every fact re-embeds in the new space, plus the query.
    expect(embedder.calls.length).toBe(afterFirst + 3);
    const index = await store.buildRecall(REALM);
    expect(index.dimension).toBe(8);

    // The rebuilt index then serves further recalls without fact embeds.
    const before = embedder.calls.length;
    await store.searchRecall(REALM, REALM, '退款');
    expect(embedder.calls.length).toBe(before + 1);
  });

  it('a decay-evicted episodic fact resurrects from the vector cache without re-embedding', async () => {
    let now = new Date('2026-06-01T00:00:00.000Z');
    const embedder = countingEmbedder();
    const store = new MemoryStore(undefined, () => now, { embedder });
    store.append(claimEvent({
      eventId: 'old1',
      content: { subject: '流水', predicate: 'event', object: '很老的一次操作', category: 'episodic' },
    }));
    store.append(claimEvent({
      eventId: 'keep1',
      content: { subject: '偏好', predicate: 'style', object: '喜欢简洁回复', category: 'preference' },
    }));
    // Consolidation and the decay pass must read the same injected clock.
    await store.consolidateRealm(REALM, { now: () => now });

    now = new Date('2026-10-30T00:00:00.000Z'); // ~151 days later
    const first = await store.searchRecall(REALM, REALM, '很老的一次操作');
    expect(first.find(h => h.fact.subject === '流水')).toBeUndefined(); // evicted
    const afterFirst = embedder.calls.length; // 2 facts + 1 query
    expect(afterFirst).toBe(3);

    // The next recall re-syncs the evicted fact into the index and decay
    // evicts it again — from the cached vector, with zero embed calls.
    const second = await store.searchRecall(REALM, REALM, '很老的一次操作');
    expect(second.find(h => h.fact.subject === '流水')).toBeUndefined();
    expect(embedder.calls.length).toBe(afterFirst + 1);

    // Non-decaying facts keep recallable, also without re-embedding.
    const kept = await store.searchRecall(REALM, REALM, '喜欢简洁回复');
    expect(kept).toHaveLength(1);
    expect(embedder.calls.length).toBe(afterFirst + 2);
  });
});
