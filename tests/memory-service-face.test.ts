import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHttpServer } from '../src/http/server.js';
import { VassalRegistry } from '../src/registry/registry.js';
import { Ed25519MemorySigner } from '../src/registry/signing.js';
import { MemoryStore } from '../src/memory/memory-store.js';
import { factId } from '../src/memory/consolidate.js';
import { sha256Hex } from '../src/util/crypto.js';
import type { ClaimContent, MemoryEvent } from '../src/memory/types.js';

// MemoryPort v1 §7 (D-6): the cross-agent consumer face. Mounted only behind
// ZEUS_MEMORY_SERVICE_TOKENS ("namespace:token,..."), and each token binds to
// exactly one namespace: the binding overrides whatever namespace the caller
// claims in the body, so a consumer can never touch another realm's memory.
const INTERNAL_TOKEN = 'driver-secret';
const NS_A = 'job-agent';
const NS_B = 'loom';
const TOKEN_A = 'tok-a';
const TOKEN_B = 'tok-b';
const SERVICE_TOKENS: Record<string, string> = { [NS_A]: TOKEN_A, [NS_B]: TOKEN_B };
const INTERNAL_AUTH = { authorization: `Bearer ${INTERNAL_TOKEN}` };
const AUTH_A = { authorization: `Bearer ${TOKEN_A}` };
const AUTH_B = { authorization: `Bearer ${TOKEN_B}` };

type AuditLine = { decision: string; detail: string };

function claim(
  eventId: string,
  subject: string,
  predicate: string,
  object: unknown,
  options: { agentId?: string; category?: ClaimContent['category']; realm?: string } = {},
): MemoryEvent {
  return {
    eventId,
    realmId: options.realm ?? NS_A,
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

async function setup(options: { persistState?: () => Promise<void> } = {}): Promise<{
  app: FastifyInstance;
  store: MemoryStore;
  audit: AuditLine[];
  persist: { calls: number };
}> {
  const store = new MemoryStore();
  store.append(claim('evt-1', 'pr-helper', 'language', 'typescript'));
  store.append(claim('evt-2', 'reviewer', 'language', 'python'));
  store.append(claim('evt-3', 'driver', 'prefers', 'dark-mode', { category: 'preference' }));
  // A second bound namespace with its own fact, for the isolation assertions.
  store.append(claim('evt-4', 'loom-agent', 'language', 'python', { agentId: 'agent-b', realm: NS_B }));
  await store.consolidateRealm(NS_A);
  await store.consolidateRealm(NS_B);
  const audit: AuditLine[] = [];
  const persist = { calls: 0 };
  const app = await createHttpServer({
    registry: new VassalRegistry(),
    signer: new Ed25519MemorySigner('zeus-rsk-test'),
    internalToken: INTERNAL_TOKEN,
    memoryStore: store,
    memoryServiceTokens: SERVICE_TOKENS,
    memoryServiceAudit: (decision, detail) => {
      audit.push({ decision, detail });
    },
    persistState: options.persistState ?? (async () => {
      persist.calls += 1;
    }),
  });
  return { app, store, audit, persist };
}

async function recall(
  app: FastifyInstance,
  body: Record<string, unknown>,
  auth: Record<string, string> = AUTH_A,
): Promise<{ statusCode: number; hits: Array<Record<string, unknown>> }> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/memory/recall', headers: auth, payload: body });
  return { statusCode: res.statusCode, hits: (await res.json()).hits ?? [] };
}

describe('v1 memory face mounting and auth', () => {
  it('is not mounted at all when no memory-service tokens are configured', async () => {
    // Fail-closed: without the tokens the four consumer routes must not exist,
    // not even behind the driver's internal token.
    const app = await createHttpServer({
      registry: new VassalRegistry(),
      signer: new Ed25519MemorySigner('zeus-rsk-test'),
      internalToken: INTERNAL_TOKEN,
      memoryStore: new MemoryStore(),
    });
    for (const route of [
      { method: 'POST', url: '/api/v1/memory/recall', payload: { namespace: NS_A, query: 'x' } },
      { method: 'POST', url: '/api/v1/memory/remember', payload: { namespace: NS_A, subject: 's', predicate: 'p', object: 'o' } },
      { method: 'POST', url: '/api/v1/memory/forget', payload: { namespace: NS_A, subject: 's', reason: 'r' } },
      { method: 'GET', url: '/api/v1/memory/counts' },
    ]) {
      const res = await app.inject({ ...route, headers: INTERNAL_AUTH } as never);
      expect(res.statusCode, `${route.method} ${route.url}`).toBe(404);
    }
  });

  it('rejects a missing or wrong bearer with 401 and a Bearer challenge', async () => {
    const { app } = await setup();
    const body = { query: 'typescript' };
    const missing = await app.inject({ method: 'POST', url: '/api/v1/memory/recall', payload: body });
    expect(missing.statusCode).toBe(401);
    expect(missing.headers['www-authenticate']).toBe('Bearer');

    const wrong = await app.inject({
      method: 'POST', url: '/api/v1/memory/recall',
      headers: { authorization: `Bearer not-${TOKEN_A}` }, payload: body,
    });
    expect(wrong.statusCode).toBe(401);
    expect(await wrong.json()).toEqual({ error: 'unauthorized' });

    // The internal driver token does not cross over onto the service face.
    const internal = await app.inject({ method: 'POST', url: '/api/v1/memory/recall', headers: INTERNAL_AUTH, payload: body });
    expect(internal.statusCode).toBe(401);
  });
});

describe('v1 memory namespace binding', () => {
  it('binds each token to its namespace and applies it when the body claims none', async () => {
    const { app } = await setup();
    // No body.namespace at all: the token-bound namespace is the namespace.
    const { statusCode, hits } = await recall(app, { query: 'python' });
    expect(statusCode).toBe(200);
    expect(hits.map(h => h.subject)).toEqual(['reviewer']);

    // An explicit matching namespace is accepted.
    const explicit = await recall(app, { namespace: NS_A, query: 'typescript' });
    expect(explicit.statusCode).toBe(200);
    expect(explicit.hits.map(h => h.subject)).toEqual(['pr-helper']);
  });

  it('rejects a body.namespace that does not match the token-bound namespace with 403', async () => {
    const { app } = await setup();
    const mismatch = { namespace: NS_B };
    for (const route of [
      { method: 'POST', url: '/api/v1/memory/recall', payload: { ...mismatch, query: 'python' } },
      { method: 'POST', url: '/api/v1/memory/remember', payload: { ...mismatch, subject: 's', predicate: 'p', object: 'o' } },
      { method: 'POST', url: '/api/v1/memory/forget', payload: { ...mismatch, subject: 'loom-agent', reason: 'erasure' } },
    ] as const) {
      const res = await app.inject({ ...route, headers: AUTH_A });
      expect(res.statusCode, route.url).toBe(403);
      expect(await res.json(), route.url).toEqual({
        error: 'forbidden',
        detail: 'body.namespace does not match the token-bound namespace',
      });
    }
  });

  it('keeps the two bound namespaces isolated', async () => {
    const { app } = await setup();
    // tok-b reads loom's memory, never job-agent's.
    const b = await recall(app, { query: 'python' }, AUTH_B);
    expect(b.hits.map(h => h.subject)).toEqual(['loom-agent']);
    const bForeign = await recall(app, { query: 'typescript' }, AUTH_B);
    expect(bForeign.hits).toHaveLength(0);

    // tok-a reads job-agent's memory, never loom's facts.
    const a = await recall(app, { query: 'python' });
    expect(a.hits.map(h => h.subject)).toEqual(['reviewer']);

    // Writes land in the bound namespace too: tok-b writes into loom only.
    const written = await app.inject({
      method: 'POST', url: '/api/v1/memory/remember', headers: AUTH_B,
      payload: { subject: 'loom-agent', predicate: 'framework', object: 'fastapi' },
    });
    expect(written.statusCode).toBe(200);
    const bAfter = await recall(app, { query: 'fastapi' }, AUTH_B);
    expect(bAfter.hits).toHaveLength(1);
    const aAfter = await recall(app, { query: 'fastapi' });
    expect(aAfter.hits).toHaveLength(0);
  });
});

describe('v1 memory recall', () => {
  it('returns projected hits with score and provenance', async () => {
    const { app } = await setup();
    const { statusCode, hits } = await recall(app, { query: 'typescript' });
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
    const limited = await recall(app, { query: 'language', k: 1 });
    expect(limited.hits).toHaveLength(1);

    const onlyPreference = await recall(app, { query: 'dark-mode', kinds: ['preference'] });
    expect(onlyPreference.hits).toHaveLength(1);
    expect(onlyPreference.hits[0]!.kind).toBe('preference');

    const noPreference = await recall(app, { query: 'language', kinds: ['preference'] });
    expect(noPreference.hits).toHaveLength(0);

    const both = await recall(app, { query: 'language' });
    expect(both.hits).toHaveLength(2);
  });

  it('rejects a bad query, k, or kinds shape', async () => {
    const { app } = await setup();
    const cases: Array<Record<string, unknown>> = [
      {},
      { query: 'x', k: 0 },
      { query: 'x', k: 1.5 },
      { query: 'x', kinds: 'preference' },
      { query: 'x', kinds: [42] },
    ];
    for (const payload of cases) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/memory/recall', headers: AUTH_A, payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });
});

describe('v1 memory remember', () => {
  it('lands the contract content shape as a note rooted at the bound namespace', async () => {
    const { app, store } = await setup();
    const payload = {
      kind: 'preference',
      content: 'wants release notes in the weekly digest',
      importance: 0.9,
      provenance: ['doc-1', 'doc-2'],
    };
    const res = await app.inject({ method: 'POST', url: '/api/v1/memory/remember', headers: AUTH_A, payload });
    expect(res.statusCode).toBe(200);
    const { factId: first, status } = await res.json();
    expect(status).toBe('remembered');
    // subject = the bound namespace, predicate = the note predicate.
    expect(first).toBe(factId(NS_A, NS_A, 'note', payload.content));

    // The written memory is recallable through the same face.
    const { hits } = await recall(app, { query: 'digest', kinds: ['preference'] });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.factId).toBe(first);
    expect(hits[0]!.subject).toBe(NS_A);
    expect(hits[0]!.predicate).toBe('note');

    // provenance travels onto the appended event's refs.
    const event = store.exportState().events.find(e => e.eventId.startsWith('mem-svc-'));
    expect(event?.refs).toEqual(['doc-1', 'doc-2']);
  });

  it('appends the SPO shape, consolidates, and returns the deterministic factId', async () => {
    const { app, store } = await setup();
    const payload = { subject: 'release', predicate: 'window', object: 'friday', kind: 'preference' };
    const res = await app.inject({ method: 'POST', url: '/api/v1/memory/remember', headers: AUTH_A, payload });
    expect(res.statusCode).toBe(200);
    const { factId: first, status } = await res.json();
    expect(status).toBe('remembered');
    expect(first).toBe(factId(NS_A, 'release', 'window', 'friday'));

    // The written memory is recallable through the same face.
    const { hits } = await recall(app, { query: 'release', kinds: ['preference'] });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.factId).toBe(first);
    expect(hits[0]!.subject).toBe('release');

    // Remembering the same content again resolves to the same fact identity:
    // consolidation merges the two claims, never a second fact.
    const again = await app.inject({ method: 'POST', url: '/api/v1/memory/remember', headers: AUTH_A, payload });
    expect((await again.json()).factId).toBe(first);
    expect(store.facts(NS_A, NS_A).filter(f => f.factId === first)).toHaveLength(1);
  });

  it('rejects a missing shape, an oversized object, or an unknown kind', async () => {
    const { app } = await setup();
    const oversized = 'x'.repeat(66_000);
    const cases: Array<Record<string, unknown>> = [
      // Neither the content shape nor the SPO shape is complete.
      { predicate: 'p', object: 'o' },
      { subject: 's', predicate: 'p' },
      // content must be a non-empty string.
      { content: '' },
      { content: 42 },
      // The 64KB object ceiling applies to both shapes.
      { subject: 's', predicate: 'p', object: oversized },
      { content: oversized },
      // kind and importance validation is unchanged.
      { subject: 's', predicate: 'p', object: 'o', kind: 'secret' },
      { subject: 's', predicate: 'p', object: 'o', importance: 1.5 },
      // provenance must be an array of strings.
      { subject: 's', predicate: 'p', object: 'o', provenance: 'doc-1' },
      { subject: 's', predicate: 'p', object: 'o', provenance: [42] },
    ];
    for (const payload of cases) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/memory/remember', headers: AUTH_A, payload });
      expect(res.statusCode, JSON.stringify(payload).slice(0, 80)).toBe(400);
    }
  });
});

describe('v1 memory forget', () => {
  it('retracts by factIds, attributes the bound namespace, and flushes the state', async () => {
    const { app, persist } = await setup();
    const target = factId(NS_A, 'pr-helper', 'language', 'typescript');
    const res = await app.inject({
      method: 'POST', url: '/api/v1/memory/forget', headers: AUTH_A,
      payload: { factIds: [target], reason: 'gdpr erasure' },
    });
    expect(res.statusCode).toBe(200);
    const { retracted, records } = await res.json();
    expect(retracted).toBe(1);
    // Attribution is the bound namespace on whose memory the service acted.
    expect(records).toEqual([expect.objectContaining({ factId: target, reason: 'gdpr erasure', requestedBy: NS_A })]);
    // A real erasure is awaited to durability before the answer.
    expect(persist.calls).toBe(1);

    const after = await recall(app, { query: 'typescript' });
    expect(after.hits.map(h => h.factId)).not.toContain(target);
    // Unrelated facts stay recallable.
    const rest = await recall(app, { query: 'python' });
    expect(rest.hits.map(h => h.subject)).toEqual(['reviewer']);
  });

  it('retracts every fact about a subject', async () => {
    const { app, persist } = await setup();
    const res = await app.inject({
      method: 'POST', url: '/api/v1/memory/forget', headers: AUTH_A,
      payload: { subject: 'pr-helper', reason: 'erasure' },
    });
    expect(res.statusCode).toBe(200);
    const { retracted } = await res.json();
    expect(retracted).toBe(1);
    expect(persist.calls).toBe(1);

    const after = await recall(app, { query: 'typescript' });
    expect(after.hits).toHaveLength(0);
    const rest = await recall(app, { query: 'python' });
    expect(rest.hits).toHaveLength(1);
  });

  it('returns 500 state_not_persisted when the flush fails after a real retraction', async () => {
    const { app } = await setup({
      persistState: async () => {
        throw new Error('disk full');
      },
    });
    const target = factId(NS_A, 'pr-helper', 'language', 'typescript');
    const res = await app.inject({
      method: 'POST', url: '/api/v1/memory/forget', headers: AUTH_A,
      payload: { factIds: [target], reason: 'gdpr erasure' },
    });
    expect(res.statusCode).toBe(500);
    // The retraction itself was applied; only the flush failed.
    expect(await res.json()).toMatchObject({
      error: 'state_not_persisted',
      detail: expect.stringContaining('persistence failed: disk full'),
    });
    const after = await recall(app, { query: 'typescript' });
    expect(after.hits).toHaveLength(0);
  });

  it('does not flush on a no-op retraction', async () => {
    const { app, persist } = await setup();
    const res = await app.inject({
      method: 'POST', url: '/api/v1/memory/forget', headers: AUTH_A,
      payload: { factIds: ['unknown-fact-id'], reason: 'gdpr erasure' },
    });
    expect(res.statusCode).toBe(200);
    expect((await res.json()).retracted).toBe(0);
    expect(persist.calls).toBe(0);
  });

  it('requires factIds or a subject, plus a reason', async () => {
    const { app } = await setup();
    const cases: Array<Record<string, unknown>> = [
      {},
      { reason: 'r' },
      { factIds: [], reason: 'r' },
      { factIds: ['f1'] },
    ];
    for (const payload of cases) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/memory/forget', headers: AUTH_A, payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });
});

describe('v1 memory counts', () => {
  it('breaks facts down by kind under the token-bound namespace', async () => {
    const { app, store } = await setup();
    store.append(claim('evt-5', 'deploy', 'target', 'staging'));
    store.append(claim('evt-6', 'deploy', 'settled-decision', 'ship', { agentId: 'zeus-kernel', category: 'decision' }));
    await store.consolidateRealm(NS_A);

    const res = await app.inject({ method: 'GET', url: '/api/v1/memory/counts', headers: AUTH_A });
    expect(res.statusCode).toBe(200);
    expect(await res.json()).toEqual({
      namespace: NS_A,
      facts: 5,
      byKind: { fact: 3, preference: 1, decision: 1 },
    });

    // The other bound token counts only its own namespace.
    const other = await app.inject({ method: 'GET', url: '/api/v1/memory/counts', headers: AUTH_B });
    expect(await other.json()).toEqual({ namespace: NS_B, facts: 1, byKind: { fact: 1 } });
  });

  it('excludes retracted tombstones from the counts', async () => {
    const { app } = await setup();
    const target = factId(NS_A, 'pr-helper', 'language', 'typescript');
    const forget = await app.inject({
      method: 'POST', url: '/api/v1/memory/forget', headers: AUTH_A,
      payload: { factIds: [target], reason: 'gdpr erasure' },
    });
    expect(forget.statusCode).toBe(200);

    const res = await app.inject({ method: 'GET', url: '/api/v1/memory/counts', headers: AUTH_A });
    expect(await res.json()).toEqual({
      namespace: NS_A,
      facts: 2,
      byKind: { fact: 1, preference: 1 },
    });
  });
});

describe('v1 memory service audit', () => {
  it('writes one hash-only memory-service-call line per call', async () => {
    const { app, audit } = await setup();

    await recall(app, { query: 'typescript' });
    expect(audit).toEqual([
      {
        decision: 'memory-service-call',
        detail: `namespace=${NS_A} action=recall queryHash=${sha256Hex('typescript').slice(0, 16)} hits=1`,
      },
    ]);

    await app.inject({
      method: 'POST', url: '/api/v1/memory/remember', headers: AUTH_A,
      payload: { subject: 'release', predicate: 'window', object: 'friday' },
    });
    expect(audit[1]).toEqual({
      decision: 'memory-service-call',
      detail: `namespace=${NS_A} action=remember factId=${factId(NS_A, 'release', 'window', 'friday')}`,
    });

    await app.inject({
      method: 'POST', url: '/api/v1/memory/forget', headers: AUTH_A,
      payload: { subject: 'release', reason: 'erasure' },
    });
    expect(audit[2]).toEqual({
      decision: 'memory-service-call',
      detail: `namespace=${NS_A} action=forget retracted=1`,
    });

    await app.inject({ method: 'GET', url: '/api/v1/memory/counts', headers: AUTH_A });
    expect(audit[3]).toEqual({
      decision: 'memory-service-call',
      detail: `namespace=${NS_A} action=counts facts=3`,
    });

    // The audit spine is hash-only: no query or memory text ever leaves.
    for (const line of audit) {
      expect(line.decision).toBe('memory-service-call');
      expect(line.detail).not.toContain('typescript');
      expect(line.detail).not.toContain('friday');
    }
  });
});
