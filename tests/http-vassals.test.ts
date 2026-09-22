import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createHttpServer } from '../src/http/server.js';
import { VassalRegistry, type FetchLike } from '../src/registry/registry.js';
import { Ed25519MemorySigner } from '../src/registry/signing.js';
import { bootKernel } from '../src/state/boot.js';
import type { AgentCard } from '../src/a2a/types.js';

const TOKEN = 'driver-secret';
const AUTH = { authorization: `Bearer ${TOKEN}` };
const CARD_URL = 'https://vassal.example/api/a2a/agent-card';

function card(overrides: Partial<AgentCard> = {}): AgentCard {
  return {
    name: 'vassal-1',
    url: 'https://vassal.example',
    skills: [{ id: 'research', name: 'Research', description: 'research', tags: [] }],
    'x-zeus-fealty': {
      version: '1',
      swornTo: 'zeus',
      domain: 'work',
      dataRealms: ['personal'],
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
  const registry = new VassalRegistry(fetchImpl);
  const signer = new Ed25519MemorySigner('zeus-rsk-test');
  return createHttpServer({ registry, signer, internalToken: TOKEN });
}

describe('G1 vassal onboarding HTTP', () => {
  it('registers a vassal from its card URL and it appears on the internal roster', async () => {
    const app = await server(fetchFor({ [CARD_URL]: card() }));
    const res = await app.inject({ method: 'POST', url: '/api/vassals', headers: AUTH, payload: { cardUrl: CARD_URL } });
    expect(res.statusCode).toBe(201);
    expect((await res.json()).card.name).toBe('vassal-1');

    const roster = await app.inject({ method: 'GET', url: '/api/roster', headers: AUTH });
    expect((await roster.json()).entries.map((v: { name: string }) => v.name)).toContain('vassal-1');
  });

  it('requires bearer auth', async () => {
    const app = await server(fetchFor({ [CARD_URL]: card() }));
    const res = await app.inject({ method: 'POST', url: '/api/vassals', payload: { cardUrl: CARD_URL } });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a missing cardUrl', async () => {
    const app = await server(fetchFor({}));
    const res = await app.inject({ method: 'POST', url: '/api/vassals', headers: AUTH, payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('returns 502 when the card URL is unreachable', async () => {
    const app = await server(fetchFor({ [CARD_URL]: 500 }));
    const res = await app.inject({ method: 'POST', url: '/api/vassals', headers: AUTH, payload: { cardUrl: CARD_URL } });
    expect(res.statusCode).toBe(502);
  });

  it('rejects a card without fealty', async () => {
    const guest = card();
    delete guest['x-zeus-fealty'];
    const app = await server(fetchFor({ [CARD_URL]: guest }));
    const res = await app.inject({ method: 'POST', url: '/api/vassals', headers: AUTH, payload: { cardUrl: CARD_URL } });
    expect(res.statusCode).toBe(400);
    expect((await res.json()).detail).toMatch(/fealty/);
  });

  it('revokes a registered vassal and then 404s a second revoke', async () => {
    const app = await server(fetchFor({ [CARD_URL]: card() }));
    await app.inject({ method: 'POST', url: '/api/vassals', headers: AUTH, payload: { cardUrl: CARD_URL } });

    const revoke = await app.inject({ method: 'DELETE', url: '/api/vassals/vassal-1', headers: AUTH });
    expect(revoke.statusCode).toBe(200);

    const roster = await app.inject({ method: 'GET', url: '/api/roster', headers: AUTH });
    const body = await roster.json();
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].status).toBe('revoked');

    const again = await app.inject({ method: 'DELETE', url: '/api/vassals/vassal-1', headers: AUTH });
    expect(again.statusCode).toBe(404);
  });
});

describe('G1 boot vassal seeds', () => {
  it('auto-registers seed card URLs on boot, dedupes repeats, and skips URLs restored from snapshot', async () => {
    const stateFile = join(tmpdir(), `zeus-seed-${crypto.randomUUID()}.json`);
    const fetchImpl = fetchFor({ [CARD_URL]: card() });

    const first = await bootKernel({ vassalSeeds: [CARD_URL, CARD_URL], fetchImpl, stateFile });
    expect(first.registry.list().map(v => v.card.name)).toEqual(['vassal-1']);
    await first.saveState();

    // Second boot restores the snapshot; the seed URL is already known and must
    // not be refetched (this fetch always 500s, so a refetch would throw).
    const again = await bootKernel({
      vassalSeeds: [CARD_URL],
      stateFile,
      fetchImpl: async () => new Response('x', { status: 500 }),
    });
    expect(again.registry.list().map(v => v.card.name)).toEqual(['vassal-1']);
  });
});
