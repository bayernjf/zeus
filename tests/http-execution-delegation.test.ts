import { describe, expect, it } from 'vitest';
import { createHttpServer } from '../src/http/server.js';
import { VassalRegistry } from '../src/registry/registry.js';
import { Ed25519MemorySigner } from '../src/registry/signing.js';
import type { ExecutionDelegationAuditEntry } from '../src/delegation/execution-delegation.js';

const TOKEN = 'driver-secret';
const AUTH = { authorization: `Bearer ${TOKEN}` };
const NOW = new Date('2026-10-03T00:00:00.000Z');

async function harness() {
  const audit: ExecutionDelegationAuditEntry[] = [];
  const app = await createHttpServer({
    registry: new VassalRegistry(),
    signer: new Ed25519MemorySigner('k'),
    internalToken: TOKEN,
    now: () => NOW,
    executionDelegationAudit: entry => void audit.push(entry),
  });
  return { app, audit };
}

describe('HTTP deferred #33 — the execution-delegation issue endpoint', () => {
  it('issues a signed delegation and emits the audit entry', async () => {
    const h = await harness();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/execution-delegations',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: {
        grantedBy: 'operator@example',
        skill: 'release',
        capabilities: ['github:pull-request:merge'],
        vassal: 'pr-helper',
        reason: 'release 1.0',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { delegation: Record<string, unknown> };
    expect(body.delegation).toMatchObject({
      kind: 'zeus-execution-delegation',
      version: 1,
      grantedBy: 'operator@example',
      skill: 'release',
      vassal: 'pr-helper',
      capabilities: ['github:pull-request:merge'],
      reason: 'release 1.0',
      keyId: 'k',
    });
    expect(typeof body.delegation.nonce).toBe('string');
    expect(typeof body.delegation.sig).toBe('string');
    expect(body.delegation.sig).not.toBe('');

    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({
      decision: 'execution-delegation-issued',
      grantedBy: 'operator@example',
      skill: 'release',
      vassal: 'pr-helper',
      capabilities: ['github:pull-request:merge'],
      keyId: 'k',
    });
    await h.app.close();
  });

  it('normalises capabilities (dedupe and sort)', async () => {
    const h = await harness();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/execution-delegations',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: { grantedBy: 'op', skill: 's', capabilities: ['b', 'a', 'a'] },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { delegation: { capabilities: string[] } };
    expect(body.delegation.capabilities).toEqual(['a', 'b']);
    await h.app.close();
  });

  it('400s when grantedBy is missing', async () => {
    const h = await harness();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/execution-delegations',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: { skill: 's', capabilities: ['a'] },
    });
    expect(res.statusCode).toBe(400);
    await h.app.close();
  });

  it('400s when skill is missing', async () => {
    const h = await harness();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/execution-delegations',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: { grantedBy: 'op', capabilities: ['a'] },
    });
    expect(res.statusCode).toBe(400);
    await h.app.close();
  });

  it('400s when capabilities is empty or not a string array', async () => {
    const h = await harness();
    for (const capabilities of [[], ['a', 1], 'a']) {
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/execution-delegations',
        headers: { ...AUTH, 'content-type': 'application/json' },
        payload: { grantedBy: 'op', skill: 's', capabilities },
      });
      expect(res.statusCode).toBe(400);
    }
    await h.app.close();
  });

  it('400s when ttlSeconds is not positive', async () => {
    const h = await harness();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/execution-delegations',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: { grantedBy: 'op', skill: 's', capabilities: ['a'], ttlSeconds: 0 },
    });
    expect(res.statusCode).toBe(400);
    await h.app.close();
  });

  it('400s when the ttl exceeds the ceiling', async () => {
    const h = await harness();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/execution-delegations',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: { grantedBy: 'op', skill: 's', capabilities: ['a'], ttlSeconds: 7200 },
    });
    expect(res.statusCode).toBe(400);
    await h.app.close();
  });

  it('401s without a bearer token', async () => {
    const h = await harness();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/execution-delegations',
      headers: { 'content-type': 'application/json' },
      payload: { grantedBy: 'op', skill: 's', capabilities: ['a'] },
    });
    expect(res.statusCode).toBe(401);
    await h.app.close();
  });

  it('is not mounted without a signer (404)', async () => {
    const app = await createHttpServer({
      registry: new VassalRegistry(),
      internalToken: TOKEN,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/execution-delegations',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: { grantedBy: 'op', skill: 's', capabilities: ['a'] },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
