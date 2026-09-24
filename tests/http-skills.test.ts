import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHttpServer } from '../src/http/server.js';
import { VassalRegistry } from '../src/registry/registry.js';
import { Ed25519MemorySigner } from '../src/registry/signing.js';
import { SkillRegistry } from '../src/skills/registry.js';
import { MentorshipLedger } from '../src/skills/mentor.js';
import type { SkillSpec, TeamResolution } from '../src/skills/types.js';
import type { MentorshipRecord } from '../src/skills/mentor.js';

const TOKEN = 'driver-secret';
const AUTH = { authorization: `Bearer ${TOKEN}` };
const NOW = () => new Date('2026-09-24T00:00:00.000Z');

const REVIEW_SPEC = {
  id: 'code-review',
  name: 'Code review',
  description: 'review a pull request',
  version: '1.0.0',
  domain: 'code',
  tags: ['review'],
  permissions: ['realm', 'execute'],
  providedBy: ['mentor-a'],
};

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function server(): Promise<{ app: FastifyInstance; skills: SkillRegistry }> {
  const skills = new SkillRegistry(NOW);
  const mentorships = new MentorshipLedger(skills, NOW);
  app = await createHttpServer({
    registry: new VassalRegistry(),
    signer: new Ed25519MemorySigner('zeus-rsk-test'),
    internalToken: TOKEN,
    skillRegistry: skills,
    mentorshipLedger: mentorships,
    now: NOW,
  });
  return { app, skills };
}

async function register(a: FastifyInstance, spec: Record<string, unknown> = REVIEW_SPEC) {
  return a.inject({ method: 'POST', url: '/api/skills', headers: AUTH, payload: spec });
}

async function team(a: FastifyInstance, ids: string[]): Promise<TeamResolution> {
  const res = await a.inject({ method: 'POST', url: '/api/skills/team', headers: AUTH, payload: { skills: ids } });
  return res.json() as Promise<TeamResolution>;
}

describe('E2.1/E2.2 skill catalogue HTTP', () => {
  it('registers a spec, then lists and reads it back', async () => {
    const { app: a } = await server();
    const created = await register(a);
    expect(created.statusCode).toBe(201);
    expect(await created.json()).toMatchObject({
      id: 'code-review', version: '1.0.0', status: 'active', providedBy: ['mentor-a'],
    });

    const list = await a.inject({ method: 'GET', url: '/api/skills', headers: AUTH });
    expect((await list.json()).skills).toHaveLength(1);

    const byDomain = await a.inject({ method: 'GET', url: '/api/skills?domain=code', headers: AUTH });
    expect((await byDomain.json()).skills).toHaveLength(1);
    const byOtherDomain = await a.inject({ method: 'GET', url: '/api/skills?domain=research', headers: AUTH });
    expect((await byOtherDomain.json()).skills).toHaveLength(0);

    const one = await a.inject({ method: 'GET', url: '/api/skills/code-review', headers: AUTH });
    expect((await one.json()).name).toBe('Code review');
    const versions = await a.inject({ method: 'GET', url: '/api/skills/code-review/versions', headers: AUTH });
    expect((await versions.json()).versions.map((s: SkillSpec) => s.version)).toEqual(['1.0.0']);
  });

  it('rejects an invalid spec, a duplicate version and an unknown skill', async () => {
    const { app: a } = await server();
    const bad = await register(a, { id: 'code-review', version: 'v1', description: 'x' });
    expect(bad.statusCode).toBe(400);
    expect((await bad.json()).detail).toContain('name is required');

    await register(a);
    const dup = await register(a);
    expect(dup.statusCode).toBe(409);

    const missing = await a.inject({ method: 'GET', url: '/api/skills/nope', headers: AUTH });
    expect(missing.statusCode).toBe(404);
    const missingVersions = await a.inject({ method: 'GET', url: '/api/skills/nope/versions', headers: AUTH });
    expect(missingVersions.statusCode).toBe(404);
  });

  it('drops smuggled keys instead of persisting them', async () => {
    const { app: a } = await server();
    const created = await register(a, { ...REVIEW_SPEC, injected: 'nope', registeredAt: '1999-01-01T00:00:00.000Z' });
    expect(created.statusCode).toBe(201);
    const spec = await created.json();
    expect(spec.injected).toBeUndefined();
    expect(spec.registeredAt).toBe('2026-09-24T00:00:00.000Z');
  });
});

describe('E2.3 skill lifecycle HTTP', () => {
  it('uninstall removes the provider from team resolution and install restores it', async () => {
    const { app: a } = await server();
    await register(a);
    expect((await team(a, ['code-review'])).complete).toBe(true);

    const off = await a.inject({ method: 'POST', url: '/api/skills/code-review/uninstall', headers: AUTH, payload: {} });
    expect(off.statusCode).toBe(200);
    expect((await off.json()).status).toBe('uninstalled');
    const afterOff = await team(a, ['code-review']);
    expect(afterOff.complete).toBe(false);
    expect(afterOff.missingSkills).toEqual(['code-review']);

    const on = await a.inject({ method: 'POST', url: '/api/skills/code-review/install', headers: AUTH, payload: {} });
    expect((await on.json()).status).toBe('active');
    expect((await team(a, ['code-review'])).complete).toBe(true);
  });

  it('hardening only narrows permissions', async () => {
    const { app: a } = await server();
    await register(a);

    const narrowed = await a.inject({
      method: 'POST', url: '/api/skills/code-review/harden', headers: AUTH,
      payload: { permissions: ['realm:read'], constraints: { maxRuntimeMs: 5000 } },
    });
    expect(narrowed.statusCode).toBe(200);
    expect((await narrowed.json()).hardening).toMatchObject({
      permissions: ['realm:read'], constraints: { maxRuntimeMs: 5000 },
    });

    const escalated = await a.inject({
      method: 'POST', url: '/api/skills/code-review/harden', headers: AUTH,
      payload: { permissions: ['credential'] },
    });
    expect(escalated.statusCode).toBe(400);
    expect((await escalated.json()).detail).toContain('hardening cannot grant credential');
  });

  it('deprecates a version, hides it from the default list and refuses reinstall', async () => {
    const { app: a } = await server();
    await register(a);

    const deprecated = await a.inject({
      method: 'POST', url: '/api/skills/code-review/deprecate', headers: AUTH, payload: {},
    });
    expect((await deprecated.json()).status).toBe('deprecated');

    const active = await a.inject({ method: 'GET', url: '/api/skills', headers: AUTH });
    expect((await active.json()).skills).toHaveLength(0);
    const all = await a.inject({ method: 'GET', url: '/api/skills?status=deprecated', headers: AUTH });
    expect((await all.json()).skills).toHaveLength(1);

    const reinstall = await a.inject({
      method: 'POST', url: '/api/skills/code-review/install', headers: AUTH, payload: {},
    });
    expect(reinstall.statusCode).toBe(409);
  });

  it('reports an ambiguous slot instead of picking a provider', async () => {
    const { app: a } = await server();
    await register(a, { ...REVIEW_SPEC, providedBy: ['mentor-a', 'atlas'] });
    const resolution = await team(a, ['code-review']);
    expect(resolution.complete).toBe(false);
    expect(resolution.ambiguousSkills).toEqual(['code-review']);
    expect(resolution.slots[0].providers).toEqual(['atlas', 'mentor-a']);
  });

  it('rejects a bad status filter, a bad team payload and no auth', async () => {
    const { app: a } = await server();
    const badStatus = await a.inject({ method: 'GET', url: '/api/skills?status=live', headers: AUTH });
    expect(badStatus.statusCode).toBe(400);

    const badTeam = await a.inject({ method: 'POST', url: '/api/skills/team', headers: AUTH, payload: { skills: [] } });
    expect(badTeam.statusCode).toBe(400);

    const noAuth = await a.inject({ method: 'GET', url: '/api/skills' });
    expect(noAuth.statusCode).toBe(401);
  });
});

describe('E2.5 mentorship HTTP', () => {
  async function commission(a: FastifyInstance, learnerId = 'learner-b') {
    await register(a);
    return a.inject({
      method: 'POST', url: '/api/mentorships', headers: AUTH,
      payload: { skillId: 'code-review', mentorId: 'mentor-a', learnerId },
    });
  }

  it('refuses a mentor who does not hold the skill', async () => {
    const { app: a } = await server();
    await register(a);
    const res = await a.inject({
      method: 'POST', url: '/api/mentorships', headers: AUTH,
      payload: { skillId: 'code-review', mentorId: 'stranger', learnerId: 'learner-b' },
    });
    expect(res.statusCode).toBe(409);
    expect((await res.json()).detail).toContain('not an active provider');
  });

  it('certifies a learner who passes, adding them to the provider set', async () => {
    const { app: a } = await server();
    const commissioned = await commission(a);
    expect(commissioned.statusCode).toBe(201);
    const record = (await commissioned.json()) as MentorshipRecord;
    expect(record.status).toBe('teaching');

    const taught = await a.inject({
      method: 'POST', url: `/api/mentorships/${record.id}/lessons`, headers: AUTH,
      payload: { lessons: [{ topic: 'reading a diff' }, { topic: 'risk triage', ref: 'evt-9' }] },
    });
    expect(taught.statusCode).toBe(200);
    expect((await taught.json()).lessons.map((l: { topic: string }) => l.topic))
      .toEqual(['reading a diff', 'risk triage']);

    const assessed = await a.inject({
      method: 'POST', url: `/api/mentorships/${record.id}/assess`, headers: AUTH,
      payload: { checks: [{ criterion: 'triage', required: true, passed: true, score: 0.9 }] },
    });
    expect((await assessed.json())).toMatchObject({ status: 'certified', score: 0.9 });

    const resolution = await team(a, ['code-review']);
    expect(resolution.slots[0].providers).toEqual(['learner-b', 'mentor-a']);

    const listed = await a.inject({ method: 'GET', url: '/api/mentorships?status=certified', headers: AUTH });
    expect((await listed.json()).mentorships).toHaveLength(1);
  });

  it('leaves the provider set untouched when the assessment fails', async () => {
    const { app: a } = await server();
    const record = (await (await commission(a)).json()) as MentorshipRecord;

    const assessed = await a.inject({
      method: 'POST', url: `/api/mentorships/${record.id}/assess`, headers: AUTH,
      payload: { checks: [{ criterion: 'triage', passed: true, score: 0.4 }] },
    });
    const body = await assessed.json();
    expect(body.status).toBe('failed');
    expect(body.failureReason).toContain('below threshold 0.8');

    const resolution = await team(a, ['code-review']);
    expect(resolution.slots[0].providers).toEqual(['mentor-a']);
  });

  it('dismisses an open mentorship and refuses to act on a closed one', async () => {
    const { app: a } = await server();
    const record = (await (await commission(a)).json()) as MentorshipRecord;

    const dismissed = await a.inject({
      method: 'POST', url: `/api/mentorships/${record.id}/dismiss`, headers: AUTH,
      payload: { reason: 'learner rotated off the team' },
    });
    expect((await dismissed.json()).status).toBe('dismissed');

    const teachAgain = await a.inject({
      method: 'POST', url: `/api/mentorships/${record.id}/lessons`, headers: AUTH,
      payload: { lessons: [{ topic: 'too late' }] },
    });
    expect(teachAgain.statusCode).toBe(409);
  });

  it('404s an unknown mentorship and 400s malformed input', async () => {
    const { app: a } = await server();
    const missing = await a.inject({
      method: 'POST', url: '/api/mentorships/mentor-nope/dismiss', headers: AUTH,
      payload: { reason: 'x' },
    });
    expect(missing.statusCode).toBe(404);

    await register(a);
    const noReason = await a.inject({
      method: 'POST', url: '/api/mentorships', headers: AUTH,
      payload: { skillId: 'code-review', mentorId: 'mentor-a' },
    });
    expect(noReason.statusCode).toBe(400);

    const selfTeach = await a.inject({
      method: 'POST', url: '/api/mentorships', headers: AUTH,
      payload: { skillId: 'code-review', mentorId: 'mentor-a', learnerId: 'mentor-a' },
    });
    expect(selfTeach.statusCode).toBe(400);

    const badChecks = await a.inject({
      method: 'POST', url: '/api/mentorships/x/assess', headers: AUTH,
      payload: { checks: [{ criterion: 'c', passed: 'yes', score: 0.9 }] },
    });
    expect(badChecks.statusCode).toBe(400);

    const badStatus = await a.inject({ method: 'GET', url: '/api/mentorships?status=open', headers: AUTH });
    expect(badStatus.statusCode).toBe(400);
  });

  it('is not mounted when no ledger is wired', async () => {
    const skills = new SkillRegistry(NOW);
    app = await createHttpServer({
      registry: new VassalRegistry(),
      signer: new Ed25519MemorySigner('zeus-rsk-test'),
      internalToken: TOKEN,
      skillRegistry: skills,
    });
    const res = await app.inject({ method: 'GET', url: '/api/mentorships', headers: AUTH });
    expect(res.statusCode).toBe(404);
    const catalogue = await app.inject({ method: 'GET', url: '/api/skills', headers: AUTH });
    expect(catalogue.statusCode).toBe(200);
  });
});
