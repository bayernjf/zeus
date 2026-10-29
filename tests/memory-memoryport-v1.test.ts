import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/memory/memory-store.js';
import {
  HubEmbeddingEmbedder,
  createMemoryEmbedder,
} from '../src/memory/hub-embedder.js';
import { LocalHashingEmbedder } from '../src/memory/recall.js';
import type { Embedder, MemoryEvent } from '../src/memory/types.js';

/**
 * MemoryPort contract v1 (bayjf docs/tier0/zeus-core-MemoryPort契约v1.md):
 * hub-backed embedding (ruling D-1), importance/decay (§5), category flow
 * through consolidation (§2), and the dimension-rebuild guarantee (§4).
 */

const REALM = 'personal';

function hubResponse(dim: number) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: [{ embedding: new Array<number>(dim).fill(0.5) }] }),
  } as unknown as Response;
}

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

describe('createMemoryEmbedder', () => {
  it('pins the local hashing embedder when the kill switch is off', () => {
    const embedder = createMemoryEmbedder({
      enabled: false,
      resolveEndpoint: () => null,
    });
    expect(embedder).toBeInstanceOf(LocalHashingEmbedder);
    expect(embedder.dimension).toBe(256);
  });
});

describe('HubEmbeddingEmbedder', () => {
  it('embeds through the hub, reports the hub dimension, and caches by content', async () => {
    let calls = 0;
    const audits: Array<{ hash: string; ok: boolean }> = [];
    const embedder = new HubEmbeddingEmbedder({
      resolveEndpoint: () => ({ baseUrl: 'https://hub.test', apiKey: 'k', model: 'embed-m' }),
      fetchImpl: (async () => {
        calls += 1;
        return hubResponse(2048);
      }) as typeof fetch,
      onExternalCall: entry => audits.push(entry),
    });

    const first = await embedder.embed('hello world');
    const second = await embedder.embed('hello world');
    expect(first).toHaveLength(2048);
    expect(second).toBe(first); // cache hit returns the same vector
    expect(calls).toBe(1);
    expect(embedder.dimension).toBe(2048);
    expect(audits).toEqual([{ hash: expect.any(String), ok: true, latencyMs: expect.any(Number) }]);
    expect(audits[0]!.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('degrades to the local space on hub failure and retries after the cooldown', async () => {
    let clock = 1_000_000;
    let calls = 0;
    let healthy = false;
    const embedder = new HubEmbeddingEmbedder({
      resolveEndpoint: () => ({ baseUrl: 'https://hub.test', apiKey: 'k', model: 'embed-m' }),
      fetchImpl: (async () => {
        calls += 1;
        if (!healthy) throw new Error('connection refused');
        return hubResponse(2048);
      }) as typeof fetch,
      retryMinutes: 5,
      now: () => clock,
    });

    const failed = await embedder.embed('text one');
    expect(failed).toHaveLength(256); // local fallback dimension
    expect(embedder.dimension).toBe(256);
    expect(calls).toBe(1);

    // Inside the cooldown window: no further hub attempt.
    clock += 60_000;
    await embedder.embed('text two');
    expect(calls).toBe(1);

    // After the cooldown the hub is retried; still down, still local.
    clock += 10 * 60_000;
    await embedder.embed('text three');
    expect(calls).toBe(2);
    expect(embedder.dimension).toBe(256);

    // Hub recovers: the embedder flips back to the hub vector space.
    healthy = true;
    clock += 10 * 60_000;
    const recovered = await embedder.embed('text four');
    expect(recovered).toHaveLength(2048);
    expect(embedder.dimension).toBe(2048);
  });

  it('refuses a provider-side dimension drift instead of poisoning the space', async () => {
    let dim = 2048;
    const embedder = new HubEmbeddingEmbedder({
      resolveEndpoint: () => ({ baseUrl: 'https://hub.test', apiKey: 'k', model: 'embed-m' }),
      fetchImpl: (async () => hubResponse(dim)) as typeof fetch,
    });
    await embedder.embed('first');
    expect(embedder.dimension).toBe(2048);

    dim = 3000;
    const drifted = await embedder.embed('second');
    expect(drifted).toHaveLength(256); // refused the drifted vector, fell back
    expect(embedder.dimension).toBe(256);
  });
});

describe('MemoryPort v1 importance / category / decay', () => {
  it('carries claim category and importance baseline onto the fact', async () => {
    const store = new MemoryStore(undefined, () => new Date('2026-10-30T00:00:00.000Z'));
    store.append(claimEvent({ eventId: 'e1', content: { subject: 'S', predicate: 'p', object: 'o', category: 'decision' } }));
    store.append(claimEvent({ eventId: 'e2', content: { subject: 'S2', predicate: 'p', object: 'o2', category: 'episodic' } }));
    await store.consolidateRealm(REALM);
    const facts = store.facts(REALM, REALM);
    const decision = facts.find(f => f.subject === 'S');
    const episodic = facts.find(f => f.subject === 'S2');
    expect(decision?.kind).toBe('decision');
    expect(decision?.importance).toBe(0.9);
    expect(episodic?.kind).toBe('episodic');
    expect(episodic?.importance).toBe(0.3);
  });

  it('ranks a decision-category fact above an episodic one for the same query', async () => {
    const store = new MemoryStore(undefined, () => new Date('2026-10-30T00:00:00.000Z'));
    store.append(claimEvent({ eventId: 'd1', content: { subject: '定价', predicate: 'policy', object: '订阅制优先', category: 'decision' } }));
    store.append(claimEvent({ eventId: 'p1', content: { subject: '定价', predicate: 'note', object: '有人问过订阅制', category: 'episodic' } }));
    await store.consolidateRealm(REALM);
    const hits = await store.searchRecall(REALM, REALM, '定价 订阅制');
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits[0]!.fact.kind).toBe('decision');
  });

  it('touches lastAccessAt on recall and evicts stale episodic facts after three half-lives', async () => {
    let now = new Date('2026-10-30T00:00:00.000Z');
    const store = new MemoryStore(undefined, () => now);
    store.append(claimEvent({ eventId: 'old1', content: { subject: '流水', predicate: 'event', object: '很老的一次操作', category: 'episodic' } }));
    store.append(claimEvent({ eventId: 'new1', content: { subject: '偏好', predicate: 'style', object: '喜欢简洁回复', category: 'preference' } }));
    // Consolidation must stamp fact timestamps from the same injected clock as
    // the decay pass below; the default (global Date.now) silently desyncs
    // them under the wall-clock gate.
    await store.consolidateRealm(REALM, { now: () => now });

    now = new Date('2027-01-15T00:00:00.000Z'); // ~77 days later
    const decay = store.decayRealm(REALM);
    expect(decay.evicted).toHaveLength(1);
    const index = await store.buildRecall(REALM);
    const hits = await index.search('很老的一次操作');
    expect(hits.find(h => h.fact.subject === '流水')).toBeUndefined();
    // preference facts never decay
    const kept = await index.search('喜欢简洁回复');
    expect(kept.length).toBe(1);

    // A fresh recall hit touches lastAccessAt (the decay clock).
    now = new Date('2026-10-30T01:00:00.000Z');
    const fresh = new MemoryStore(undefined, () => now);
    fresh.append(claimEvent({ eventId: 't1', content: { subject: '口味', predicate: 'pref', object: '清淡', category: 'preference' } }));
    await fresh.consolidateRealm(REALM, { now: () => now });
    now = new Date('2026-10-30T02:00:00.000Z');
    await fresh.searchRecall(REALM, REALM, '清淡');
    const fact = fresh.facts(REALM, REALM)[0]!;
    expect(fact.lastAccessAt).toBe('2026-10-30T02:00:00.000Z');
  });
});

describe('MemoryStore dimension rebuild', () => {
  it('rebuilds the recall index when the embedder switches vector space', async () => {
    const calls = { embed: 0 };
    const embedder: Embedder = {
      dimension: 4,
      async embed() {
        calls.embed += 1;
        return [1, 0, 0, 0];
      },
    };
    const store = new MemoryStore(undefined, () => new Date(), { embedder });
    store.append(claimEvent({ eventId: 'r1' }));
    await store.consolidateRealm(REALM);
    await store.searchRecall(REALM, REALM, '退款');
    const afterFirst = calls.embed;

    (embedder as { dimension: number }).dimension = 8;
    await store.searchRecall(REALM, REALM, '退款');
    // Rebuild re-embeds the fact corpus in the new space.
    expect(calls.embed).toBeGreaterThan(afterFirst);
    const index = await store.buildRecall(REALM);
    expect(index.dimension).toBe(8);
  });
});
