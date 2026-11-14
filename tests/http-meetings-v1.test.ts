import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHttpServer } from '../src/http/server.js';
import { ExecutorRegistry } from '../src/registry/registry.js';
import { Ed25519MemorySigner } from '../src/registry/signing.js';
import { MeetingStore } from '../src/meeting/store.js';
import type { Meeting } from '../src/meeting/types.js';

const TOKEN = 'operator-secret';
const AUTH = { authorization: `Bearer ${TOKEN}` };
const dirs: string[] = [];

async function dir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'zeus-meetings-api-'));
  dirs.push(path);
  return path;
}

async function server(path: string): Promise<FastifyInstance> {
  return createHttpServer({
    registry: new ExecutorRegistry(),
    signer: new Ed25519MemorySigner('zeus-rsk-test'),
    internalToken: TOKEN,
    meetingsStore: new MeetingStore(path),
  });
}

const at = '2026-11-15T00:00:00.000Z';

afterEach(async () => {
  while (dirs.length > 0) {
    const path = dirs.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe('Meeting API v1', () => {
  it('requires a bearer token', async () => {
    const app = await server(await dir());
    const res = await app.inject({ method: 'GET', url: '/api/v1/meetings' });
    expect(res.statusCode).toBe(401);
  });

  it('opens a meeting, lists it, and reads it back', async () => {
    const app = await server(await dir());
    const opened = await app.inject({
      method: 'POST', url: '/api/v1/meetings', headers: AUTH,
      payload: { id: 'm1', topic: '先做质疑还是先做 UI', maxRounds: 2, now: at },
    });
    expect(opened.statusCode).toBe(201);

    const list = await app.inject({ method: 'GET', url: '/api/v1/meetings', headers: AUTH });
    expect(list.json<{ meetings: Array<{ id: string }> }>().meetings.map(m => m.id)).toEqual(['m1']);

    const one = await app.inject({ method: 'GET', url: '/api/v1/meetings/m1', headers: AUTH });
    expect(one.json<Meeting>().status).toBe('open');
  });

  it('refuses a missing topic and returns 404 for an unknown meeting', async () => {
    const app = await server(await dir());
    const noTopic = await app.inject({ method: 'POST', url: '/api/v1/meetings', headers: AUTH, payload: {} });
    expect(noTopic.statusCode).toBe(400);
    const missing = await app.inject({ method: 'GET', url: '/api/v1/meetings/nope', headers: AUTH });
    expect(missing.statusCode).toBe(404);
  });

  it('enforces the protocol on the write path', async () => {
    const app = await server(await dir());
    await app.inject({
      method: 'POST', url: '/api/v1/meetings', headers: AUTH,
      payload: { id: 'm2', topic: '轮次守卫', maxRounds: 2, now: at },
    });

    const proposal = await app.inject({
      method: 'POST', url: '/api/v1/meetings/m2/utterances', headers: AUTH,
      payload: { speakerId: 'a', stance: 'propose', claims: [{ id: 'c1', text: '先做质疑', evidence: [] }], now: at },
    });
    expect(proposal.statusCode).toBe(201);

    // Round 1 is proposal-only, even once the meeting is proposing.
    const earlyChallenge = await app.inject({
      method: 'POST', url: '/api/v1/meetings/m2/utterances', headers: AUTH,
      payload: { speakerId: 'c', stance: 'challenge', rebuts: ['c1'], claims: [{ id: 'c2', text: 'x', evidence: [{ kind: 'fact', ref: 'r', note: '' }] }], now: at },
    });
    expect(earlyChallenge.statusCode).toBe(409);
    // The protocol reports round 1 as invalid-state with a proposal-only message
    // (round-2 positions cannot exist yet, so this is not a round mismatch).
    expect(earlyChallenge.json<{ code: string; message: string }>().code).toBe('invalid-state');
    expect(earlyChallenge.json<{ message: string }>().message).toContain('proposal-only');

    const advanced = await app.inject({ method: 'POST', url: '/api/v1/meetings/m2/advance', headers: AUTH });
    expect(advanced.json<Meeting>().status).toBe('challenging');

    // A challenge without evidence is refused by the protocol, not the transport.
    const noEvidence = await app.inject({
      method: 'POST', url: '/api/v1/meetings/m2/utterances', headers: AUTH,
      payload: { speakerId: 'c', stance: 'challenge', rebuts: ['c1'], claims: [{ id: 'c2', text: '空口反驳', evidence: [] }], now: at },
    });
    expect(noEvidence.statusCode).toBe(400);
    expect(noEvidence.json<{ code: string }>().code).toBe('evidence-required');
  });

  it('records the operator decision and refuses one without a rationale', async () => {
    const app = await server(await dir());
    await app.inject({
      method: 'POST', url: '/api/v1/meetings', headers: AUTH,
      payload: { id: 'm3', topic: '决策守卫', maxRounds: 1, now: at },
    });
    await app.inject({
      method: 'POST', url: '/api/v1/meetings/m3/utterances', headers: AUTH,
      payload: { speakerId: 'a', stance: 'propose', claims: [{ id: 'c1', text: '方案甲', evidence: [] }], now: at },
    });
    await app.inject({ method: 'POST', url: '/api/v1/meetings/m3/advance', headers: AUTH });
    await app.inject({ method: 'POST', url: '/api/v1/meetings/m3/advance', headers: AUTH });

    const unnamed = await app.inject({
      method: 'POST', url: '/api/v1/meetings/m3/decision', headers: AUTH,
      payload: { by: '', chosenClaimIds: ['c1'], rejectedClaimIds: [], rationale: '理由', now: at },
    });
    expect(unnamed.statusCode).toBe(400);
    expect(unnamed.json<{ code: string }>().code).toBe('human-decision-required');

    const empty = await app.inject({
      method: 'POST', url: '/api/v1/meetings/m3/decision', headers: AUTH,
      payload: { by: 'owner', chosenClaimIds: [], rejectedClaimIds: [], rationale: '理由', now: at },
    });
    expect(empty.json<{ code: string }>().code).toBe('empty-decision');

    const decided = await app.inject({
      method: 'POST', url: '/api/v1/meetings/m3/decision', headers: AUTH,
      payload: { by: 'owner', chosenClaimIds: ['c1'], rejectedClaimIds: [], rationale: '先做主张图', now: at },
    });
    expect(decided.statusCode).toBe(201);
    expect(decided.json<Meeting>().status).toBe('decided');
  });
});
