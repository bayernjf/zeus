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

  it('allocates claim ids when the caller omits them', async () => {
    const app = await server(await dir());
    await app.inject({ method: 'POST', url: '/api/v1/meetings', headers: AUTH, payload: { topic: 'id 分配', maxRounds: 2, id: 'm-ids' } });
    const posted = JSON.parse((await app.inject({
      method: 'POST',
      url: '/api/v1/meetings/m-ids/utterances',
      headers: AUTH,
      payload: { speakerId: 'a', stance: 'propose', claims: [{ text: '第一条' }, { text: '第二条' }] },
    })).body) as { utterances: Array<{ claims: Array<{ id: string }> }> };
    expect(posted.utterances[0]?.claims.map(claim => claim.id)).toEqual(['c1', 'c2']);
  });

  it('serves the meeting as markdown minutes', async () => {
    const app = await server(await dir());
    await app.inject({ method: 'POST', url: '/api/v1/meetings', headers: AUTH, payload: { topic: '纪要导出', maxRounds: 1, id: 'm-md' } });
    await app.inject({
      method: 'POST',
      url: '/api/v1/meetings/m-md/utterances',
      headers: AUTH,
      payload: { speakerId: 'a', stance: 'propose', claims: [{ text: '方案甲' }] },
    });
    const response = await app.inject({ method: 'GET', url: '/api/v1/meetings/m-md/markdown', headers: AUTH });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/markdown');
    expect(response.headers['content-disposition']).toContain('m-md.md');
    expect(response.body).toContain('# 纪要导出');
    expect(response.body).toContain('## 决策');
  });

  it('returns 404 for markdown of an unknown meeting', async () => {
    const app = await server(await dir());
    const response = await app.inject({ method: 'GET', url: '/api/v1/meetings/m-nope/markdown', headers: AUTH });
    expect(response.statusCode).toBe(404);
  });

  it('convenes round 1 from a batch of drafts', async () => {
    const app = await server(await dir());
    await app.inject({ method: 'POST', url: '/api/v1/meetings', headers: AUTH, payload: { topic: '自动提案', maxRounds: 2, id: 'm-convene' } });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/meetings/m-convene/proposals',
      headers: AUTH,
      payload: {
        drafts: [
          { speakerId: 'planner-a', claims: [{ text: '先做回放', evidence: [{ kind: 'reference', ref: 'design-meeting.md', note: '' }] }] },
          { speakerId: 'planner-b', claims: [{ text: '先做自动提案', evidence: [] }] },
        ],
      },
    });
    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body) as {
      recorded: Array<{ speakerId: string; claimIds: string[] }>;
      meeting: { utterances: Array<{ speakerId: string; claims: Array<{ id: string }> }> };
    };
    expect(body.recorded.map(entry => entry.claimIds)).toEqual([['c1'], ['c2']]);
    expect(body.meeting.utterances.map(utterance => utterance.speakerId)).toEqual(['planner-a', 'planner-b']);
  });

  it('refuses an empty draft batch', async () => {
    const app = await server(await dir());
    await app.inject({ method: 'POST', url: '/api/v1/meetings', headers: AUTH, payload: { topic: '空提案', maxRounds: 1, id: 'm-empty' } });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/meetings/m-empty/proposals',
      headers: AUTH,
      payload: { drafts: [] },
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses to convene a meeting that already left round 1', async () => {
    const app = await server(await dir());
    await app.inject({ method: 'POST', url: '/api/v1/meetings', headers: AUTH, payload: { topic: '已推进', maxRounds: 2, id: 'm-late' } });
    await app.inject({
      method: 'POST',
      url: '/api/v1/meetings/m-late/utterances',
      headers: AUTH,
      payload: { speakerId: 'a', stance: 'propose', claims: [{ text: '先做 A' }] },
    });
    await app.inject({ method: 'POST', url: '/api/v1/meetings/m-late/advance', headers: AUTH, payload: {} });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/meetings/m-late/proposals',
      headers: AUTH,
      payload: { drafts: [{ speakerId: 'b', claims: [{ text: '补一条' }] }] },
    });
    expect(response.statusCode).toBe(409);
    expect(response.body).toContain('cannot convene a challenging meeting');
  });
});
