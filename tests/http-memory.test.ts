import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHttpServer } from '../src/http/server.js';
import { ExecutorRegistry } from '../src/registry/registry.js';
import { Ed25519MemorySigner } from '../src/registry/signing.js';
import { MemoryStore } from '../src/memory/memory-store.js';
import type { FactRecord, MemoryEvent } from '../src/memory/types.js';

const TOKEN = 'operator-secret';
const AUTH = { authorization: `Bearer ${TOKEN}` };
const DATA_DOMAIN = 'dataDomain-personal';

function claim(
  eventId: string,
  subject: string,
  predicate: string,
  object: unknown,
  agentId: string,
): MemoryEvent {
  return {
    eventId,
    dataDomainId: DATA_DOMAIN,
    runId: `run-${eventId}`,
    source: { agentId },
    kind: 'claim',
    content: { subject, predicate, object },
    refs: [],
    confidence: 0.7,
    occurredAt: '2026-09-24T09:00:00.000Z',
  };
}

async function setup(): Promise<{ app: FastifyInstance; store: MemoryStore; facts: FactRecord[] }> {
  const store = new MemoryStore();
  store.append(claim('evt-1', 'pr-helper', 'language', 'typescript', 'agent-a'));
  store.append(claim('evt-2', 'loom', 'language', 'python', 'agent-b'));
  await store.consolidateDataDomain(DATA_DOMAIN);
  const app = await createHttpServer({
    registry: new ExecutorRegistry(),
    signer: new Ed25519MemorySigner('zeus-rsk-test'),
    internalToken: TOKEN,
    memoryStore: store,
  });
  return { app, store, facts: store.facts(DATA_DOMAIN, DATA_DOMAIN) };
}

describe('memory HTTP read face', () => {
  it('lists the dataDomain events and requires a dataDomainId', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: `/api/memory/events?dataDomainId=${DATA_DOMAIN}`, headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect((await res.json()).events.map((e: MemoryEvent) => e.eventId)).toEqual(['evt-1', 'evt-2']);

    const missing = await app.inject({ method: 'GET', url: '/api/memory/events', headers: AUTH });
    expect(missing.statusCode).toBe(400);
  });

  it('lists consolidated facts and returns none for an unknown dataDomain', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: `/api/memory/facts?dataDomainId=${DATA_DOMAIN}`, headers: AUTH });
    const { facts } = await res.json();
    expect(facts).toHaveLength(2);
    expect(facts.every((f: FactRecord) => f.status === 'active')).toBe(true);

    const empty = await app.inject({ method: 'GET', url: '/api/memory/facts?dataDomainId=dataDomain-other', headers: AUTH });
    expect((await empty.json()).facts).toEqual([]);
  });

  it('recalls facts by hybrid search with limit and rejects bad options', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'GET', url: `/api/memory/recall?dataDomainId=${DATA_DOMAIN}&q=typescript&limit=1`, headers: AUTH,
    });
    const { hits } = await res.json();
    expect(hits).toHaveLength(1);
    expect(hits[0].fact.subject).toBe('pr-helper');
    expect(hits[0].score).toBeGreaterThan(0);

    const noQuery = await app.inject({ method: 'GET', url: `/api/memory/recall?dataDomainId=${DATA_DOMAIN}`, headers: AUTH });
    expect(noQuery.statusCode).toBe(400);
    const badLimit = await app.inject({
      method: 'GET', url: `/api/memory/recall?dataDomainId=${DATA_DOMAIN}&q=x&limit=0`, headers: AUTH,
    });
    expect(badLimit.statusCode).toBe(400);
    const badAlpha = await app.inject({
      method: 'GET', url: `/api/memory/recall?dataDomainId=${DATA_DOMAIN}&q=x&alpha=1.5`, headers: AUTH,
    });
    expect(badAlpha.statusCode).toBe(400);
  });

  it('reports fact-source integrity', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: '/api/memory/integrity', headers: AUTH });
    expect(await res.json()).toEqual({ ok: true, violations: [] });
  });

  it('replays one run: its events plus the facts whose provenance cites them', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'GET', url: `/api/memory/replay?dataDomainId=${DATA_DOMAIN}&runId=run-evt-1`, headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const body = await res.json();
    expect(body.events.map((e: MemoryEvent) => e.eventId)).toEqual(['evt-1']);
    // the fact drew on evt-1, so it belongs to this run's replay
    expect(body.facts.map((f: FactRecord) => f.subject)).toEqual(['pr-helper']);

    const missingRun = await app.inject({
      method: 'GET', url: `/api/memory/replay?dataDomainId=${DATA_DOMAIN}&runId=run-zzz`, headers: AUTH,
    });
    expect(await missingRun.json()).toEqual({ events: [], facts: [] });

    const noRun = await app.inject({ method: 'GET', url: `/api/memory/replay?dataDomainId=${DATA_DOMAIN}`, headers: AUTH });
    expect(noRun.statusCode).toBe(400);
  });
});

describe('memory HTTP right to be forgotten', () => {
  it('retracts a fact, drops it from recall and leaves a tombstone', async () => {
    const { app, facts } = await setup();
    const target = facts.find(f => f.subject === 'pr-helper')!;

    const res = await app.inject({
      method: 'POST', url: '/api/memory/retract', headers: AUTH,
      payload: { dataDomainId: DATA_DOMAIN, factIds: [target.factId], reason: 'gdpr request', requestedBy: 'operator' },
    });
    expect(res.statusCode).toBe(200);
    const { retractions } = await res.json();
    expect(retractions).toEqual([
      expect.objectContaining({ factId: target.factId, reason: 'gdpr request', requestedBy: 'operator' }),
    ]);

    const after = await app.inject({ method: 'GET', url: `/api/memory/facts?dataDomainId=${DATA_DOMAIN}`, headers: AUTH });
    const retracted = (await after.json()).facts.find((f: FactRecord) => f.factId === target.factId);
    expect(retracted.status).toBe('retracted');

    const recall = await app.inject({
      method: 'GET', url: `/api/memory/recall?dataDomainId=${DATA_DOMAIN}&q=typescript`, headers: AUTH,
    });
    expect((await recall.json()).hits.map((h: { fact: FactRecord }) => h.fact.factId)).not.toContain(target.factId);

    const tombstones = await app.inject({ method: 'GET', url: '/api/memory/retractions', headers: AUTH });
    expect((await tombstones.json()).retractions).toHaveLength(1);
  });

  it('is idempotent: retracting an already-retracted fact records nothing new', async () => {
    const { app, facts } = await setup();
    const target = facts[0]!;
    const payload = {
      dataDomainId: DATA_DOMAIN, factIds: [target.factId], reason: 'once', requestedBy: 'operator',
    };
    await app.inject({ method: 'POST', url: '/api/memory/retract', headers: AUTH, payload });
    const again = await app.inject({ method: 'POST', url: '/api/memory/retract', headers: AUTH, payload });
    expect((await again.json()).retractions).toEqual([]);

    const tombstones = await app.inject({ method: 'GET', url: '/api/memory/retractions', headers: AUTH });
    expect((await tombstones.json()).retractions).toHaveLength(1);
  });

  it('forgets every fact about a subject', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'POST', url: '/api/memory/forget-subject', headers: AUTH,
      payload: { dataDomainId: DATA_DOMAIN, subject: 'LOOM', reason: 'erasure', requestedBy: 'operator' },
    });
    const { retractions } = await res.json();
    expect(retractions).toHaveLength(1);
    expect(retractions[0].subject).toBe('loom');

    const facts = await app.inject({ method: 'GET', url: `/api/memory/facts?dataDomainId=${DATA_DOMAIN}`, headers: AUTH });
    const bySubject = new Map(
      (await facts.json()).facts.map((f: FactRecord) => [f.subject, f.status]),
    );
    expect(bySubject.get('loom')).toBe('retracted');
    expect(bySubject.get('pr-helper')).toBe('active');
  });

  it('flushes state immediately once a retraction actually lands, but not on a no-op', async () => {
    // The right to be forgotten must survive a crash: without an immediate
    // flush the fact stays retracted in memory only until the next periodic
    // save, and a kill in that window resurrects it on reboot.
    let flushes = 0;
    const store = new MemoryStore();
    store.append(claim('evt-1', 'pr-helper', 'language', 'typescript', 'agent-a'));
    await store.consolidateDataDomain(DATA_DOMAIN);
    const target = store.facts(DATA_DOMAIN, DATA_DOMAIN)[0]!;
    const app = await createHttpServer({
      registry: new ExecutorRegistry(),
      signer: new Ed25519MemorySigner('zeus-rsk-test'),
      internalToken: TOKEN,
      memoryStore: store,
      persistState: async () => { flushes += 1; },
    });
    const payload = {
      dataDomainId: DATA_DOMAIN, factIds: [target.factId], reason: 'gdpr request', requestedBy: 'operator',
    };
    const first = await app.inject({ method: 'POST', url: '/api/memory/retract', headers: AUTH, payload });
    expect(first.statusCode).toBe(200);
    expect(flushes).toBe(1);

    // Idempotent repeat changes nothing on disk either.
    const again = await app.inject({ method: 'POST', url: '/api/memory/retract', headers: AUTH, payload });
    expect(again.statusCode).toBe(200);
    expect(flushes).toBe(1);
  });

  it('flushes state immediately after forget-subject', async () => {
    let flushes = 0;
    const store = new MemoryStore();
    store.append(claim('evt-2', 'loom', 'language', 'python', 'agent-b'));
    await store.consolidateDataDomain(DATA_DOMAIN);
    const hooked = await createHttpServer({
      registry: new ExecutorRegistry(),
      signer: new Ed25519MemorySigner('zeus-rsk-test'),
      internalToken: TOKEN,
      memoryStore: store,
      persistState: async () => { flushes += 1; },
    });
    const res = await hooked.inject({
      method: 'POST', url: '/api/memory/forget-subject', headers: AUTH,
      payload: { dataDomainId: DATA_DOMAIN, subject: 'LOOM', reason: 'erasure', requestedBy: 'operator' },
    });
    expect(res.statusCode).toBe(200);
    expect(flushes).toBe(1);
  });

  it('reports 500 when the retraction is in memory but the durability flush failed', async () => {
    const store = new MemoryStore();
    store.append(claim('evt-1', 'pr-helper', 'language', 'typescript', 'agent-a'));
    await store.consolidateDataDomain(DATA_DOMAIN);
    const target = store.facts(DATA_DOMAIN, DATA_DOMAIN)[0]!;
    const app = await createHttpServer({
      registry: new ExecutorRegistry(),
      signer: new Ed25519MemorySigner('zeus-rsk-test'),
      internalToken: TOKEN,
      memoryStore: store,
      persistState: async () => { throw new Error('disk on fire'); },
    });
    const res = await app.inject({
      method: 'POST', url: '/api/memory/retract', headers: AUTH,
      payload: { dataDomainId: DATA_DOMAIN, factIds: [target.factId], reason: 'gdpr request', requestedBy: 'operator' },
    });
    expect(res.statusCode).toBe(500);
    expect((await res.json()).error).toBe('state_not_persisted');
    // The mutation itself landed in memory; the failure is about durability.
    expect(store.facts(DATA_DOMAIN, DATA_DOMAIN)[0]!.status).toBe('retracted');
  });

  it('rejects a retraction without fact ids, reason or requester', async () => {
    const { app } = await setup();
    const noFacts = await app.inject({
      method: 'POST', url: '/api/memory/retract', headers: AUTH,
      payload: { dataDomainId: DATA_DOMAIN, factIds: [], reason: 'x', requestedBy: 'operator' },
    });
    expect(noFacts.statusCode).toBe(400);

    const noReason = await app.inject({
      method: 'POST', url: '/api/memory/retract', headers: AUTH,
      payload: { dataDomainId: DATA_DOMAIN, factIds: ['f1'], requestedBy: 'operator' },
    });
    expect(noReason.statusCode).toBe(400);

    const noSubject = await app.inject({
      method: 'POST', url: '/api/memory/forget-subject', headers: AUTH,
      payload: { dataDomainId: DATA_DOMAIN, reason: 'x', requestedBy: 'operator' },
    });
    expect(noSubject.statusCode).toBe(400);
  });
});

describe('memory HTTP mounting and auth', () => {
  it('requires a bearer token', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: `/api/memory/facts?dataDomainId=${DATA_DOMAIN}` });
    expect(res.statusCode).toBe(401);
  });

  it('is not mounted at all without an internal token', async () => {
    const app = await createHttpServer({
      registry: new ExecutorRegistry(),
      signer: new Ed25519MemorySigner('zeus-rsk-test'),
      memoryStore: new MemoryStore(),
    });
    const res = await app.inject({ method: 'GET', url: `/api/memory/facts?dataDomainId=${DATA_DOMAIN}` });
    expect(res.statusCode).toBe(404);
  });

  it('is not mounted when no memory store is wired', async () => {
    const app = await createHttpServer({
      registry: new ExecutorRegistry(),
      signer: new Ed25519MemorySigner('zeus-rsk-test'),
      internalToken: TOKEN,
    });
    const res = await app.inject({ method: 'GET', url: `/api/memory/facts?dataDomainId=${DATA_DOMAIN}`, headers: AUTH });
    expect(res.statusCode).toBe(404);
  });
});

describe('E8.5 memory drift reconciliation HTTP', () => {
  it('hands out a snapshot the operator can diff against later', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: '/api/memory/snapshot', headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = await res.json() as { capturedAt: string; state: { events: unknown[]; facts: unknown[] } };
    expect(typeof body.capturedAt).toBe('string');
    expect(body.state.events).toHaveLength(2);
    expect(Array.isArray(body.state.facts)).toBe(true);
  });

  it('reports what was appended and consolidated since the supplied baseline', async () => {
    const { app, store } = await setup();
    const snap = await app.inject({ method: 'GET', url: '/api/memory/snapshot', headers: AUTH });
    const previous = (await snap.json()).state;

    store.append(claim('evt-3', 'atlas', 'language', 'golang', 'agent-c'));
    await store.consolidateDataDomain(DATA_DOMAIN);

    const res = await app.inject({ method: 'POST', url: '/api/memory/reconcile', headers: AUTH, payload: { previous } });
    expect(res.statusCode).toBe(200);
    const report = await res.json() as { hasDrift: boolean; eventsAppended: number; factsAdded: string[] };
    expect(report.hasDrift).toBe(true);
    expect(report.eventsAppended).toBe(1);
    expect(report.factsAdded.length).toBeGreaterThan(0);
  });

  it('says nothing drifted when it is nothing drifted', async () => {
    // The clean-baseline half of the check: a diff that always reports drift is
    // as useless as one that cannot be reached at all.
    const { app } = await setup();
    const snap = await app.inject({ method: 'GET', url: '/api/memory/snapshot', headers: AUTH });
    const previous = (await snap.json()).state;
    const report = await (await app.inject({
      method: 'POST', url: '/api/memory/reconcile', headers: AUTH, payload: { previous },
    })).json();
    expect(report.hasDrift).toBe(false);
    expect(report.eventsAppended).toBe(0);
    expect(report.factsChanged).toEqual([]);
  });

  it('names the field that broke shape instead of a bare invalid body', async () => {
    const { app } = await setup();
    const missing = await app.inject({ method: 'POST', url: '/api/memory/reconcile', headers: AUTH, payload: { previous: {} } });
    expect(missing.statusCode).toBe(400);
    expect((await missing.json()).detail).toMatch(/body\.previous\.events/);

    const badPair = await app.inject({
      method: 'POST', url: '/api/memory/reconcile', headers: AUTH,
      payload: { previous: { events: [], facts: [['dataDomain-personal', null]] } },
    });
    expect(badPair.statusCode).toBe(400);
    expect((await badPair.json()).detail).toMatch(/facts\[0\]/);
  });

  it('does not import the snapshot it is handed', async () => {
    // Reconciling against a doctored baseline must not change the live store:
    // the route is a question about the past, not a write.
    const { app, store } = await setup();
    const before = store.counts();
    await app.inject({
      method: 'POST', url: '/api/memory/reconcile', headers: AUTH,
      payload: { previous: { events: [], facts: [] }, current: { events: [], facts: [] } },
    });
    expect(store.counts()).toEqual(before);
  });

  it('requires bearer and stays unmounted without a memory store', async () => {
    const { app } = await setup();
    expect((await app.inject({ method: 'GET', url: '/api/memory/snapshot' })).statusCode).toBe(401);
    const bare = await createHttpServer({
      registry: new ExecutorRegistry(),
      signer: new Ed25519MemorySigner('zeus-rsk-test'),
      internalToken: TOKEN,
    });
    expect((await bare.inject({ method: 'GET', url: '/api/memory/snapshot', headers: AUTH })).statusCode).toBe(404);
    expect((await bare.inject({
      method: 'POST', url: '/api/memory/reconcile', headers: AUTH, payload: { previous: { events: [], facts: [] } },
    })).statusCode).toBe(404);
  });
});
