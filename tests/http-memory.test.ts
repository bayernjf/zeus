import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHttpServer } from '../src/http/server.js';
import { VassalRegistry } from '../src/registry/registry.js';
import { Ed25519MemorySigner } from '../src/registry/signing.js';
import { MemoryStore } from '../src/memory/memory-store.js';
import type { FactRecord, MemoryEvent } from '../src/memory/types.js';

const TOKEN = 'driver-secret';
const AUTH = { authorization: `Bearer ${TOKEN}` };
const REALM = 'realm-personal';

function claim(
  eventId: string,
  subject: string,
  predicate: string,
  object: unknown,
  agentId: string,
): MemoryEvent {
  return {
    eventId,
    realmId: REALM,
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
  store.consolidateRealm(REALM);
  const app = await createHttpServer({
    registry: new VassalRegistry(),
    signer: new Ed25519MemorySigner('zeus-rsk-test'),
    internalToken: TOKEN,
    memoryStore: store,
  });
  return { app, store, facts: store.facts(REALM, REALM) };
}

describe('memory HTTP read face', () => {
  it('lists the realm events and requires a realmId', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: `/api/memory/events?realmId=${REALM}`, headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect((await res.json()).events.map((e: MemoryEvent) => e.eventId)).toEqual(['evt-1', 'evt-2']);

    const missing = await app.inject({ method: 'GET', url: '/api/memory/events', headers: AUTH });
    expect(missing.statusCode).toBe(400);
  });

  it('lists consolidated facts and returns none for an unknown realm', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: `/api/memory/facts?realmId=${REALM}`, headers: AUTH });
    const { facts } = await res.json();
    expect(facts).toHaveLength(2);
    expect(facts.every((f: FactRecord) => f.status === 'active')).toBe(true);

    const empty = await app.inject({ method: 'GET', url: '/api/memory/facts?realmId=realm-other', headers: AUTH });
    expect((await empty.json()).facts).toEqual([]);
  });

  it('recalls facts by hybrid search with limit and rejects bad options', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'GET', url: `/api/memory/recall?realmId=${REALM}&q=typescript&limit=1`, headers: AUTH,
    });
    const { hits } = await res.json();
    expect(hits).toHaveLength(1);
    expect(hits[0].fact.subject).toBe('pr-helper');
    expect(hits[0].score).toBeGreaterThan(0);

    const noQuery = await app.inject({ method: 'GET', url: `/api/memory/recall?realmId=${REALM}`, headers: AUTH });
    expect(noQuery.statusCode).toBe(400);
    const badLimit = await app.inject({
      method: 'GET', url: `/api/memory/recall?realmId=${REALM}&q=x&limit=0`, headers: AUTH,
    });
    expect(badLimit.statusCode).toBe(400);
    const badAlpha = await app.inject({
      method: 'GET', url: `/api/memory/recall?realmId=${REALM}&q=x&alpha=1.5`, headers: AUTH,
    });
    expect(badAlpha.statusCode).toBe(400);
  });

  it('reports fact-source integrity', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: '/api/memory/integrity', headers: AUTH });
    expect(await res.json()).toEqual({ ok: true, violations: [] });
  });
});

describe('memory HTTP right to be forgotten', () => {
  it('retracts a fact, drops it from recall and leaves a tombstone', async () => {
    const { app, facts } = await setup();
    const target = facts.find(f => f.subject === 'pr-helper')!;

    const res = await app.inject({
      method: 'POST', url: '/api/memory/retract', headers: AUTH,
      payload: { realmId: REALM, factIds: [target.factId], reason: 'gdpr request', requestedBy: 'driver' },
    });
    expect(res.statusCode).toBe(200);
    const { retractions } = await res.json();
    expect(retractions).toEqual([
      expect.objectContaining({ factId: target.factId, reason: 'gdpr request', requestedBy: 'driver' }),
    ]);

    const after = await app.inject({ method: 'GET', url: `/api/memory/facts?realmId=${REALM}`, headers: AUTH });
    const retracted = (await after.json()).facts.find((f: FactRecord) => f.factId === target.factId);
    expect(retracted.status).toBe('retracted');

    const recall = await app.inject({
      method: 'GET', url: `/api/memory/recall?realmId=${REALM}&q=typescript`, headers: AUTH,
    });
    expect((await recall.json()).hits.map((h: { fact: FactRecord }) => h.fact.factId)).not.toContain(target.factId);

    const tombstones = await app.inject({ method: 'GET', url: '/api/memory/retractions', headers: AUTH });
    expect((await tombstones.json()).retractions).toHaveLength(1);
  });

  it('is idempotent: retracting an already-retracted fact records nothing new', async () => {
    const { app, facts } = await setup();
    const target = facts[0];
    const payload = {
      realmId: REALM, factIds: [target.factId], reason: 'once', requestedBy: 'driver',
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
      payload: { realmId: REALM, subject: 'LOOM', reason: 'erasure', requestedBy: 'driver' },
    });
    const { retractions } = await res.json();
    expect(retractions).toHaveLength(1);
    expect(retractions[0].subject).toBe('loom');

    const facts = await app.inject({ method: 'GET', url: `/api/memory/facts?realmId=${REALM}`, headers: AUTH });
    const bySubject = new Map(
      (await facts.json()).facts.map((f: FactRecord) => [f.subject, f.status]),
    );
    expect(bySubject.get('loom')).toBe('retracted');
    expect(bySubject.get('pr-helper')).toBe('active');
  });

  it('rejects a retraction without fact ids, reason or requester', async () => {
    const { app } = await setup();
    const noFacts = await app.inject({
      method: 'POST', url: '/api/memory/retract', headers: AUTH,
      payload: { realmId: REALM, factIds: [], reason: 'x', requestedBy: 'driver' },
    });
    expect(noFacts.statusCode).toBe(400);

    const noReason = await app.inject({
      method: 'POST', url: '/api/memory/retract', headers: AUTH,
      payload: { realmId: REALM, factIds: ['f1'], requestedBy: 'driver' },
    });
    expect(noReason.statusCode).toBe(400);

    const noSubject = await app.inject({
      method: 'POST', url: '/api/memory/forget-subject', headers: AUTH,
      payload: { realmId: REALM, reason: 'x', requestedBy: 'driver' },
    });
    expect(noSubject.statusCode).toBe(400);
  });
});

describe('memory HTTP mounting and auth', () => {
  it('requires a bearer token', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: `/api/memory/facts?realmId=${REALM}` });
    expect(res.statusCode).toBe(401);
  });

  it('is not mounted at all without an internal token', async () => {
    const app = await createHttpServer({
      registry: new VassalRegistry(),
      signer: new Ed25519MemorySigner('zeus-rsk-test'),
      memoryStore: new MemoryStore(),
    });
    const res = await app.inject({ method: 'GET', url: `/api/memory/facts?realmId=${REALM}` });
    expect(res.statusCode).toBe(404);
  });

  it('is not mounted when no memory store is wired', async () => {
    const app = await createHttpServer({
      registry: new VassalRegistry(),
      signer: new Ed25519MemorySigner('zeus-rsk-test'),
      internalToken: TOKEN,
    });
    const res = await app.inject({ method: 'GET', url: `/api/memory/facts?realmId=${REALM}`, headers: AUTH });
    expect(res.statusCode).toBe(404);
  });
});
