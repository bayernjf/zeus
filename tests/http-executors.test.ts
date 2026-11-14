import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createHttpServer } from '../src/http/server.js';
import { ExecutorRegistry, type FetchLike } from '../src/registry/registry.js';
import { Ed25519MemorySigner } from '../src/registry/signing.js';
import { bootRuntime } from '../src/state/boot.js';
import type { AgentCard } from '../src/a2a/types.js';

const TOKEN = 'operator-secret';
const AUTH = { authorization: `Bearer ${TOKEN}` };
const CARD_URL = 'https://executor.example/api/a2a/agent-card';

function card(overrides: Partial<AgentCard> = {}): AgentCard {
  return {
    name: 'executor-1',
    url: 'https://executor.example',
    skills: [{ id: 'research', name: 'Research', description: 'research', tags: [] }],
    'x-zeus-handshake': {
      version: '1',
      swornTo: 'zeus',
      domain: 'work',
      dataDomains: ['personal'],
      dataPolicy: 'read-task-scope',
      reportBack: true,
      escalationPolicy: 'on-failure',
    },
    ...overrides,
  };
}

function fetchFor(cards: Record<string, AgentCard | number>): FetchLike {
  return async url => {
    const value = cards[url];
    if (value === undefined) return new Response('not found', { status: 404 });
    if (typeof value === 'number') return new Response('error', { status: value });
    return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

async function server(fetchImpl: FetchLike): Promise<FastifyInstance> {
  const registry = new ExecutorRegistry(fetchImpl);
  const signer = new Ed25519MemorySigner('zeus-rsk-test');
  return createHttpServer({ registry, signer, internalToken: TOKEN });
}

/** Same, but keeps the registry handle so a test can look at what was stored. */
async function serverWithRegistry(fetchImpl: FetchLike): Promise<{ app: FastifyInstance; registry: ExecutorRegistry }> {
  const registry = new ExecutorRegistry(fetchImpl);
  const signer = new Ed25519MemorySigner('zeus-rsk-test');
  return { registry, app: await createHttpServer({ registry, signer, internalToken: TOKEN }) };
}

const SECRET = 'outbound-credential-9c1f';

describe('G1 executor onboarding HTTP', () => {
  it('registers a executor from its card URL and it appears on the internal roster', async () => {
    const app = await server(fetchFor({ [CARD_URL]: card() }));
    const res = await app.inject({ method: 'POST', url: '/api/executors', headers: AUTH, payload: { cardUrl: CARD_URL } });
    expect(res.statusCode).toBe(201);
    expect((await res.json()).card.name).toBe('executor-1');

    const roster = await app.inject({ method: 'GET', url: '/api/roster', headers: AUTH });
    expect((await roster.json()).snapshot.entries.map((v: { name: string }) => v.name)).toContain('executor-1');
  });

  it('requires bearer auth', async () => {
    const app = await server(fetchFor({ [CARD_URL]: card() }));
    const res = await app.inject({ method: 'POST', url: '/api/executors', payload: { cardUrl: CARD_URL } });
    expect(res.statusCode).toBe(401);
  });

  // Runtime onboarding has to be able to carry a credential, or an agent behind a
  // bearer-protected endpoint can only be added by restarting with a seed - and
  // without this it would be dispatched to with no Authorization at all.
  it('stores an outbound credential without ever echoing it back', async () => {
    const { app, registry } = await serverWithRegistry(fetchFor({ [CARD_URL]: card() }));
    const res = await app.inject({ method: 'POST', url: '/api/executors', headers: AUTH, payload: { cardUrl: CARD_URL, token: SECRET } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).not.toHaveProperty('token');
    expect(res.body).not.toContain(SECRET);
    expect(registry.tokenFor('executor-1')).toBe(SECRET);

    const roster = await app.inject({ method: 'GET', url: '/api/roster', headers: AUTH });
    expect(roster.body).not.toContain(SECRET);
  });

  it('refuses an empty or non-string token instead of reading it as "no credential"', async () => {
    const { app, registry } = await serverWithRegistry(fetchFor({ [CARD_URL]: card() }));
    for (const token of ['', '   ', 42]) {
      const res = await app.inject({ method: 'POST', url: '/api/executors', headers: AUTH, payload: { cardUrl: CARD_URL, token } });
      expect(res.statusCode).toBe(400);
      expect(res.json().detail).toMatch(/body.token/);
    }
    expect(registry.tokenFor('executor-1')).toBeUndefined();
  });

  it('rejects a missing cardUrl', async () => {
    const app = await server(fetchFor({}));
    const res = await app.inject({ method: 'POST', url: '/api/executors', headers: AUTH, payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('returns 502 when the card URL is unreachable', async () => {
    const app = await server(fetchFor({ [CARD_URL]: 500 }));
    const res = await app.inject({ method: 'POST', url: '/api/executors', headers: AUTH, payload: { cardUrl: CARD_URL } });
    expect(res.statusCode).toBe(502);
  });

  // The branch every other case missed: the host never answers at all, so fetch
  // throws instead of returning a bad status. It is still a gateway failure, and
  // the detail has to name the URL because the underlying message does not.
  it('returns 502 naming the URL when the card host fails at the connection level', async () => {
    const unreachable = 'http://gone.internal/api/a2a/agent-card';
    const app = await server(async () => {
      throw new TypeError('fetch failed');
    });
    const res = await app.inject({ method: 'POST', url: '/api/executors', headers: AUTH, payload: { cardUrl: unreachable } });
    expect(res.statusCode).toBe(502);
    expect((await res.json()).error).toBe('bad_gateway');
    expect((await res.json()).detail).toContain(unreachable);
  });

  // A peer answering 200 with something that is not a card is the same class of
  // gateway failure as a 5xx: the caller's cardUrl was fine, the peer's answer
  // was not a card. It must not be reported as a malformed request.
  it('returns 502 when the card URL answers 200 with a body that is not JSON', async () => {
    const app = await server(
      async () => new Response('<html>maintenance</html>', { status: 200, headers: { 'content-type': 'text/html' } })
    );
    const res = await app.inject({ method: 'POST', url: '/api/executors', headers: AUTH, payload: { cardUrl: CARD_URL } });
    expect(res.statusCode).toBe(502);
    expect((await res.json()).error).toBe('bad_gateway');
  });

  it('rejects a card without handshake', async () => {
    const guest = card();
    delete guest['x-zeus-handshake'];
    const app = await server(fetchFor({ [CARD_URL]: guest }));
    const res = await app.inject({ method: 'POST', url: '/api/executors', headers: AUTH, payload: { cardUrl: CARD_URL } });
    expect(res.statusCode).toBe(400);
    expect((await res.json()).detail).toMatch(/handshake/);
  });

  it('revokes a registered executor and then 404s a second revoke', async () => {
    const app = await server(fetchFor({ [CARD_URL]: card() }));
    await app.inject({ method: 'POST', url: '/api/executors', headers: AUTH, payload: { cardUrl: CARD_URL } });

    const revoke = await app.inject({ method: 'DELETE', url: '/api/executors/executor-1', headers: AUTH });
    expect(revoke.statusCode).toBe(200);

    const roster = await app.inject({ method: 'GET', url: '/api/roster', headers: AUTH });
    const body = await roster.json();
    expect(body.snapshot.entries).toHaveLength(1);
    expect(body.snapshot.entries[0].status).toBe('revoked');

    const again = await app.inject({ method: 'DELETE', url: '/api/executors/executor-1', headers: AUTH });
    expect(again.statusCode).toBe(404);
  });

  // A-02: re-registering used to rebuild the entry with revoked:false, so one
  // POST undid a revocation and could re-point where dispatch went.
  it('refuses to re-register a revoked executor and restores it only via reinstate (A-02)', async () => {
    const { app, registry } = await serverWithRegistry(fetchFor({ [CARD_URL]: card() }));
    await app.inject({ method: 'POST', url: '/api/executors', headers: AUTH, payload: { cardUrl: CARD_URL } });
    await app.inject({ method: 'DELETE', url: '/api/executors/executor-1', headers: AUTH });

    const reRegister = await app.inject({ method: 'POST', url: '/api/executors', headers: AUTH, payload: { cardUrl: CARD_URL } });
    expect(reRegister.statusCode).toBe(409);
    expect((await reRegister.json()).error).toBe('conflict');
    expect(registry.get('executor-1')).toBeUndefined();

    const reinstate = await app.inject({ method: 'POST', url: '/api/executors/executor-1/reinstate', headers: AUTH });
    expect(reinstate.statusCode).toBe(200);
    expect((await reinstate.json()).revoked).toBe(false);
    expect(registry.get('executor-1')).toBeDefined();

    // an already-active (or unknown) name is not something to restore
    const again = await app.inject({ method: 'POST', url: '/api/executors/executor-1/reinstate', headers: AUTH });
    expect(again.statusCode).toBe(404);
  });

  // A-03: an active same-name registration used to overwrite the entry in
  // place, silently re-pointing dispatch and swapping its outbound bearer.
  it('refuses to overwrite an active same-name executor without an explicit force (A-03)', async () => {
    const { app, registry } = await serverWithRegistry(fetchFor({ [CARD_URL]: card() }));
    const first = await app.inject({ method: 'POST', url: '/api/executors', headers: AUTH, payload: { cardUrl: CARD_URL, token: SECRET } });
    expect(first.statusCode).toBe(201);

    const again = await app.inject({ method: 'POST', url: '/api/executors', headers: AUTH, payload: { cardUrl: CARD_URL, token: 'other-credential' } });
    expect(again.statusCode).toBe(409);
    expect((await again.json()).error).toBe('conflict');
    // The original entry is untouched: still active, still holding its token.
    expect(registry.get('executor-1')?.cardUrl).toBe(CARD_URL);
    expect(registry.tokenFor('executor-1')).toBe(SECRET);
  });

  it('overwrites an active same-name executor when force is passed explicitly (A-03)', async () => {
    const { app, registry } = await serverWithRegistry(fetchFor({ [CARD_URL]: card() }));
    const first = await app.inject({ method: 'POST', url: '/api/executors', headers: AUTH, payload: { cardUrl: CARD_URL, token: SECRET } });
    expect(first.statusCode).toBe(201);

    const forced = await app.inject({
      method: 'POST',
      url: '/api/executors?force=true',
      headers: AUTH,
      payload: { cardUrl: CARD_URL, token: 'replacement-credential', taskUrl: 'https://executor.example/api/a2a/tasks' },
    });
    expect(forced.statusCode).toBe(201);
    expect(registry.tokenFor('executor-1')).toBe('replacement-credential');
    expect(registry.get('executor-1')?.taskUrl).toBe('https://executor.example/api/a2a/tasks');
  });
});

describe('G1 boot executor seeds', () => {
  it('auto-registers seed card URLs on boot, dedupes repeats, and skips URLs restored from snapshot', async () => {
    const stateFile = join(tmpdir(), `zeus-seed-${crypto.randomUUID()}.json`);
    const fetchImpl = fetchFor({ [CARD_URL]: card() });

    const first = await bootRuntime({ executorSeeds: [CARD_URL, CARD_URL], fetchImpl, stateFile });
    expect(first.registry.list().map(v => v.card.name)).toEqual(['executor-1']);
    await first.saveState();

    // Second boot restores the snapshot; the seed URL is already known and must
    // not be refetched (this fetch always 500s, so a refetch would throw).
    const again = await bootRuntime({
      executorSeeds: [CARD_URL],
      stateFile,
      fetchImpl: async () => new Response('x', { status: 500 }),
    });
    expect(again.registry.list().map(v => v.card.name)).toEqual(['executor-1']);
  });
});
