import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHttpServer } from '../src/http/server.js';
import { VassalRegistry } from '../src/registry/registry.js';
import { Ed25519MemorySigner } from '../src/registry/signing.js';
import { MemoryStore } from '../src/memory/memory-store.js';
import { factId } from '../src/memory/consolidate.js';
import type { ClaimContent, MemoryEvent } from '../src/memory/types.js';

// MemoryPort v1 §7 (D-6): the cross-agent consumer face. Mounted only behind
// ZEUS_MEMORY_SERVICE_TOKEN, namespace maps 1:1 to a realm.
const INTERNAL_TOKEN = 'driver-secret';
const SERVICE_TOKEN = 'memory-service-secret';
const INTERNAL_AUTH = { authorization: `Bearer ${INTERNAL_TOKEN}` };
const SERVICE_AUTH = { authorization: `Bearer ${SERVICE_TOKEN}` };
const REALM = 'realm-personal';

function claim(
  eventId: string,
  subject: string,
  predicate: string,
  object: unknown,
  options: { agentId?: string; category?: ClaimContent['category'] } = {},
): MemoryEvent {
  return {
    eventId,
    realmId: REALM,
    runId: `run-${eventId}`,
    source: { agentId: options.agentId ?? 'agent-a' },
    kind: 'claim',
    content: {
      subject,
      predicate,
      object,
      ...(options.category ? { category: options.category } : {}),
    },
    refs: [],
    confidence: 0.8,
    occurredAt: '2026-10-30T09:00:00.000Z',
  };
}

async function setup(): Promise<{ app: FastifyInstance; store: MemoryStore }> {
  const store = new MemoryStore();
  store.append(claim('evt-1', 'pr-helper', 'language', 'typescript'));
  store.append(claim('evt-2', 'loom', 'language', 'python', { agentId: 'agent-b' }));
  store.append(claim('evt-3', 'driver', 'prefers', 'dark-mode', { category: 'preference' }));
  await store.consolidateRealm(REALM);
  const app = await createHttpServer({
    registry: new VassalRegistry(),
    signer: new Ed25519MemorySigner('zeus-rsk-test'),
    internalToken: INTERNAL_TOKEN,
    memoryStore: store,
    memoryServiceToken: SERVICE_TOKEN,
  });
  return { app, store };
}

async function recall(
  app: FastifyInstance,
  body: Record<string, unknown>,
): Promise<{ statusCode: number; hits: Array<Record<string, unknown>> }> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/memory/recall', headers: SERVICE_AUTH, payload: body });
  return { statusCode: res.statusCode, hits: (await res.json()).hits ?? [] };
}

describe('v1 memory face mounting and auth', () => {
  it('is not mounted at all when no memory-service token is configured', async () => {
    // Fail-closed: without the token the four consumer routes must not exist,
    // not even behind the driver's internal token.
    const app = await createHttpServer({
      registry: new VassalRegistry(),
      signer: new Ed25519MemorySigner('zeus-rsk-test'),
      internalToken: INTERNAL_TOKEN,
      memoryStore: new MemoryStore(),
    });
    for (const route of [
      { method: 'POST', url: '/api/v1/memory/recall', payload: { namespace: REALM, query: 'x' } },
      { method: 'POST', url: '/api/v1/memory/remember', payload: { namespace: REALM, subject: 's', predicate: 'p', object: 'o' } },
      { method: 'POST', url: '/api/v1/memory/forget', payload: { namespace: REALM, subject: 's', reason: 'r' } },
      { method: 'GET', url: `/api/v1/memory/counts?namespace=${REALM}` },
    ]) {
      const res = await app.inject({ ...route, headers: INTERNAL_AUTH } as never);
      expect(res.statusCode, `${route.method} ${route.url}`).toBe(404);
    }
  });

  it('rejects a missing or wrong bearer with 401 and a Bearer challenge', async () => {
    const { app } = await setup();
    const body = { namespace: REALM, query: 'typescript' };
    const missing = await app.inject({ method: 'POST', url: '/api/v1/memory/recall', payload: body });
    expect(missing.statusCode).toBe(401);
    expect(missing.headers['www-authenticate']).toBe('Bearer');

    const wrong = await app.inject({
      method: 'POST', url: '/api/v1/memory/recall',
      headers: { authorization: `Bearer not-${SERVICE_TOKEN}` }, payload: body,
    });
    expect(wrong.statusCode).toBe(401);
    expect(await wrong.json()).toEqual({ error: 'unauthorized' });

    // The internal driver token does not cross over onto the service face.
    const internal = await app.inject({ method: 'POST', url: '/api/v1/memory/recall', headers: INTERNAL_AUTH, payload: body });
    expect(internal.statusCode).toBe(401);
  });
});

describe('v1 memory recall', () => {
  it('returns projected hits with score and provenance', async () => {
    const { app } = await setup();
    const { statusCode, hits } = await recall(app, { namespace: REALM, query: 'typescript' });
    expect(statusCode).toBe(200);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      kind: 'fact',
      subject: 'pr-helper',
      predicate: 'language',
      object: 'typescript',
    });
    expect(typeof hits[0]!.factId).toBe('string');
    expect((hits[0]!.score as number)).toBeGreaterThan(0);
    expect(Array.isArray(hits[0]!.provenance)).toBe(true);
    expect(typeof hits[0]!.confidence).toBe('number');
  });

  it('honours the k limit and the kinds filter', async () => {
    const { app } = await setup();
    // 'language' matches the two plain facts; 'prefers' the preference fact.
    const limited = await recall(app, { namespace: REALM, query: 'language', k: 1 });
    expect(limited.hits).toHaveLength(1);

    const onlyPreference = await recall(app, { namespace: REALM, query: 'dark-mode', kinds: ['preference'] });
    expect(onlyPreference.hits).toHaveLength(1);
    expect(onlyPreference.hits[0]!.kind).toBe('preference');

    const noPreference = await recall(app, { namespace: REALM, query: 'language', kinds: ['preference'] });
    expect(noPreference.hits).toHaveLength(0);

    const both = await recall(app, { namespace: REALM, query: 'language' });
    expect(both.hits).toHaveLength(2);
  });

  it('rejects a bad namespace, query, k, or kinds shape', async () => {
    const { app } = await setup();
    const cases: Array<Record<string, unknown>> = [
      { query: 'x' },
      { namespace: REALM },
      { namespace: REALM, query: 'x', k: 0 },
      { namespace: REALM, query: 'x', k: 1.5 },
      { namespace: REALM, query: 'x', kinds: 'preference' },
      { namespace: REALM, query: 'x', kinds: [42] },
    ];
    for (const payload of cases) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/memory/recall', headers: SERVICE_AUTH, payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });
});

describe('v1 memory remember', () => {
  it('appends, consolidates, and returns the deterministic factId', async () => {
    const { app, store } = await setup();
    const payload = { namespace: REALM, subject: 'release', predicate: 'window', object: 'friday', kind: 'preference' };
    const res = await app.inject({ method: 'POST', url: '/api/v1/memory/remember', headers: SERVICE_AUTH, payload });
    expect(res.statusCode).toBe(200);
    const { factId: first, status } = await res.json();
    expect(status).toBe('remembered');
    expect(first).toBe(factId(REALM, 'release', 'window', 'friday'));

    // The written memory is recallable through the same face.
    const { hits } = await recall(app, { namespace: REALM, query: 'release', kinds: ['preference'] });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.factId).toBe(first);
    expect(hits[0]!.subject).toBe('release');

    // Remembering the same content again resolves to the same fact identity:
    // consolidation merges the two claims, never a second fact.
    const again = await app.inject({ method: 'POST', url: '/api/v1/memory/remember', headers: SERVICE_AUTH, payload });
    expect((await again.json()).factId).toBe(first);
    expect(store.facts(REALM, REALM).filter(f => f.factId === first)).toHaveLength(1);
  });

  it('rejects a missing subject, object, or an unknown kind', async () => {
    const { app } = await setup();
    const cases: Array<Record<string, unknown>> = [
      { namespace: REALM, predicate: 'p', object: 'o' },
      { namespace: REALM, subject: 's', predicate: 'p' },
      { namespace: REALM, subject: 's', predicate: 'p', object: 'o', kind: 'secret' },
      { namespace: REALM, subject: 's', predicate: 'p', object: 'o', importance: 1.5 },
    ];
    for (const payload of cases) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/memory/remember', headers: SERVICE_AUTH, payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });
});

describe('v1 memory forget', () => {
  it('retracts by factIds and recall stops returning them', async () => {
    const { app } = await setup();
    const target = factId(REALM, 'pr-helper', 'language', 'typescript');
    const res = await app.inject({
      method: 'POST', url: '/api/v1/memory/forget', headers: SERVICE_AUTH,
      payload: { namespace: REALM, factIds: [target], reason: 'gdpr erasure' },
    });
    expect(res.statusCode).toBe(200);
    const { retracted, records } = await res.json();
    expect(retracted).toBe(1);
    // Attribution is fixed to the service on behalf of the calling agent.
    expect(records).toEqual([expect.objectContaining({ factId: target, reason: 'gdpr erasure', requestedBy: 'memory-service' })]);

    const after = await recall(app, { namespace: REALM, query: 'typescript' });
    expect(after.hits.map(h => h.factId)).not.toContain(target);
    // Unrelated facts stay recallable.
    const rest = await recall(app, { namespace: REALM, query: 'python' });
    expect(rest.hits.map(h => h.subject)).toEqual(['loom']);
  });

  it('retracts every fact about a subject', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'POST', url: '/api/v1/memory/forget', headers: SERVICE_AUTH,
      payload: { namespace: REALM, subject: 'pr-helper', reason: 'erasure' },
    });
    expect(res.statusCode).toBe(200);
    const { retracted } = await res.json();
    expect(retracted).toBe(1);

    const after = await recall(app, { namespace: REALM, query: 'typescript' });
    expect(after.hits).toHaveLength(0);
    const rest = await recall(app, { namespace: REALM, query: 'python' });
    expect(rest.hits).toHaveLength(1);
  });

  it('requires factIds or a subject, plus a reason', async () => {
    const { app } = await setup();
    const cases: Array<Record<string, unknown>> = [
      { namespace: REALM },
      { namespace: REALM, reason: 'r' },
      { namespace: REALM, factIds: [], reason: 'r' },
      { namespace: REALM, factIds: ['f1'] },
    ];
    for (const payload of cases) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/memory/forget', headers: SERVICE_AUTH, payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });
});

describe('v1 memory counts', () => {
  it('breaks facts down by kind and keeps namespaces isolated', async () => {
    const { app, store } = await setup();
    store.append(claim('evt-4', 'deploy', 'target', 'staging', { agentId: 'agent-c' }));
    store.append(claim('evt-5', 'deploy', 'settled-decision', 'ship', { agentId: 'zeus-kernel', category: 'decision' }));
    await store.consolidateRealm(REALM);

    const res = await app.inject({ method: 'GET', url: `/api/v1/memory/counts?namespace=${REALM}`, headers: SERVICE_AUTH });
    expect(res.statusCode).toBe(200);
    expect(await res.json()).toEqual({
      namespace: REALM,
      facts: 5,
      byKind: { fact: 3, preference: 1, decision: 1 },
    });

    // A namespace is a realm: another namespace sees none of this.
    const other = await app.inject({ method: 'GET', url: '/api/v1/memory/counts?namespace=realm-other', headers: SERVICE_AUTH });
    expect(await other.json()).toEqual({ namespace: 'realm-other', facts: 0, byKind: {} });
  });

  it('requires a namespace', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: '/api/v1/memory/counts', headers: SERVICE_AUTH });
    expect(res.statusCode).toBe(400);
  });
});
