import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHttpServer } from '../src/http/server.js';
import { VassalRegistry } from '../src/registry/registry.js';
import { Ed25519MemorySigner } from '../src/registry/signing.js';
import { OrgRegistry } from '../src/org/registry.js';

const TOKEN = 'driver-secret';
const AUTH = { authorization: `Bearer ${TOKEN}` };

async function server(): Promise<FastifyInstance> {
  const registry = new VassalRegistry();
  const signer = new Ed25519MemorySigner('zeus-rsk-test');
  const orgRegistry = new OrgRegistry();
  return createHttpServer({ registry, signer, internalToken: TOKEN, orgRegistry });
}

describe('E9.3 org HTTP', () => {
  it('starts with an empty chart', async () => {
    const app = await server();
    const res = await app.inject({ method: 'GET', url: '/api/org/chart', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect((await res.json()).departments).toEqual([]);
  });

  it('establishes a department and it appears in the chart', async () => {
    const app = await server();
    const created = await app.inject({
      method: 'POST',
      url: '/api/org/departments',
      headers: AUTH,
      payload: { name: 'Engineering', mission: 'build' },
    });
    expect(created.statusCode).toBe(201);
    expect((await created.json()).departmentId).toBe('dept:engineering');

    const chart = await app.inject({ method: 'GET', url: '/api/org/chart', headers: AUTH });
    expect((await chart.json()).departments).toHaveLength(1);
  });

  it('rejects a duplicate department and missing fields', async () => {
    const app = await server();
    await app.inject({
      method: 'POST', url: '/api/org/departments', headers: AUTH,
      payload: { name: 'Engineering', mission: 'build' },
    });
    const dup = await app.inject({
      method: 'POST', url: '/api/org/departments', headers: AUTH,
      payload: { name: 'Engineering', mission: 'other' },
    });
    expect(dup.statusCode).toBe(409);

    const bad = await app.inject({
      method: 'POST', url: '/api/org/departments', headers: AUTH, payload: { name: 'X' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('assigns a lead and members and reflects them in the chart', async () => {
    const app = await server();
    await app.inject({
      method: 'POST', url: '/api/org/departments', headers: AUTH,
      payload: { name: 'Engineering', mission: 'build' },
    });
    const lead = await app.inject({
      method: 'POST', url: '/api/org/departments/dept:engineering/members', headers: AUTH,
      payload: { agentId: 'agent-b', role: 'lead', title: 'Head' },
    });
    expect(lead.statusCode).toBe(201);
    const member = await app.inject({
      method: 'POST', url: '/api/org/departments/dept:engineering/members', headers: AUTH,
      payload: { agentId: 'agent-a', skills: ['review'] },
    });
    expect(member.statusCode).toBe(201);

    const chart = await app.inject({ method: 'GET', url: '/api/org/chart', headers: AUTH });
    const dept = (await chart.json()).departments[0];
    expect(dept).toMatchObject({ headcount: 2, lead: 'agent-b' });
  });

  it('404s an unknown department and 409s a duplicate member', async () => {
    const app = await server();
    const missing = await app.inject({
      method: 'POST', url: '/api/org/departments/dept:nope/members', headers: AUTH,
      payload: { agentId: 'agent-a' },
    });
    expect(missing.statusCode).toBe(404);

    await app.inject({
      method: 'POST', url: '/api/org/departments', headers: AUTH,
      payload: { name: 'Engineering', mission: 'build' },
    });
    await app.inject({
      method: 'POST', url: '/api/org/departments/dept:engineering/members', headers: AUTH,
      payload: { agentId: 'agent-a' },
    });
    const dup = await app.inject({
      method: 'POST', url: '/api/org/departments/dept:engineering/members', headers: AUTH,
      payload: { agentId: 'agent-a' },
    });
    expect(dup.statusCode).toBe(409);
  });

  it('rejects a bad role and requires bearer auth', async () => {
    const app = await server();
    await app.inject({
      method: 'POST', url: '/api/org/departments', headers: AUTH,
      payload: { name: 'Engineering', mission: 'build' },
    });
    const badRole = await app.inject({
      method: 'POST', url: '/api/org/departments/dept:engineering/members', headers: AUTH,
      payload: { agentId: 'agent-a', role: 'boss' },
    });
    expect(badRole.statusCode).toBe(400);

    const noAuth = await app.inject({ method: 'GET', url: '/api/org/chart' });
    expect(noAuth.statusCode).toBe(401);
  });
});
