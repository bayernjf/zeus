import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createHttpServer } from '../src/http/server.js';
import { ExecutorRegistry } from '../src/registry/registry.js';
import { Ed25519MemorySigner } from '../src/registry/signing.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { FsDataDomainStore } from '../src/dataDomain/store.js';
import { DomainGrantRegistry } from '../src/dataDomain/authorization.js';
import type { DataDomainAuditEntry } from '../src/dataDomain/source.js';
import type { DispatchPort, TargetLookup } from '../src/orchestrator/types.js';
import type { DispatchRequest, DispatchResult } from '../src/dispatch/dispatcher.js';
import type { Task, TaskState } from '../src/a2a/types.js';

const TOKEN = 'operator-secret';
const AUTH = { authorization: `Bearer ${TOKEN}` };
const NOW = new Date('2026-09-25T00:00:00.000Z');

function okResult(): DispatchResult {
  const task: Task = { kind: 'task', id: 'task-1', contextId: 'ctx', status: { state: 'completed' satisfies TaskState }, artifacts: [] };
  return { ok: true, task, events: [], injectedHits: [] };
}

function spyPort(): DispatchPort {
  return { async dispatch(_request: DispatchRequest) { return okResult(); }, async cancel() {} };
}

const lookup: TargetLookup = { findBySkill: () => [{ name: 'loom' }] };

async function harness() {
  const sandbox = mkdtempSync(join(tmpdir(), 'zeus-http-dataDomains-'));
  const mount = (name: string, content: string) => {
    const root = join(sandbox, name);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'doc.md'), content);
    return root;
  };
  const store = new FsDataDomainStore();
  const grants = new DomainGrantRegistry(() => NOW);
  const audit: DataDomainAuditEntry[] = [];
  const engDataDomainId = (await store.connect(mount('eng', 'compiler design\n'), 'enterprise', { tenant: 'acme/eng' })).dataDomainId;
  const personalDataDomainId = (await store.connect(mount('me', 'private diary\n'), 'personal')).dataDomainId;
  const app: FastifyInstance = await createHttpServer({
    registry: new ExecutorRegistry(),
    signer: new Ed25519MemorySigner('k'),
    internalToken: TOKEN,
    orchestrator: new Orchestrator(lookup, spyPort(), { now: () => NOW }),
    now: () => NOW,
    dataDomainStore: store,
    domainGrants: grants,
    dataDomainAudit: (entry: DataDomainAuditEntry) => void audit.push(entry),
  });
  return { app, sandbox, store, grants, audit, engDataDomainId, personalDataDomainId };
}

describe('HTTP deferred #17 — dataDomain boundary mutations', () => {
  let h: Awaited<ReturnType<typeof harness>>;

  beforeEach(async () => {
    h = await harness();
  });

  afterEach(async () => {
    await h.app.close();
    rmSync(h.sandbox, { recursive: true, force: true });
  });

  it('disconnects a mounted dataDomain and drops it from /api/domains', async () => {
    const before = await h.app.inject({ method: 'GET', url: '/api/domains', headers: AUTH });
    expect((before.json() as { dataDomains: Array<{ dataDomainId: string }> }).dataDomains.some(r => r.dataDomainId === h.engDataDomainId)).toBe(true);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/dataDomains/${h.engDataDomainId}/disconnect`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ dataDomainId: h.engDataDomainId, disconnected: true });

    const after = await h.app.inject({ method: 'GET', url: '/api/domains', headers: AUTH });
    expect((after.json() as { dataDomains: Array<{ dataDomainId: string }> }).dataDomains.some(r => r.dataDomainId === h.engDataDomainId)).toBe(false);

    expect(h.audit.some(e => e.decision === 'dataDomain-disconnected')).toBe(true);
  });

  it('404s when disconnecting an unknown dataDomain', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/dataDomains/dataDomain-unknown/disconnect',
      headers: AUTH,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'not_found' });
  });

  it('requires a bearer token (401 without auth)', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/dataDomains/${h.engDataDomainId}/disconnect`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('re-scopes an enterprise dataDomain tenant and reflects it in /api/domains', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/dataDomains/${h.engDataDomainId}/retarget-tenant`,
      headers: AUTH,
      payload: { from: 'acme/eng', to: 'acme' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ dataDomainId: h.engDataDomainId, tenant: { org: 'acme' } });

    const domains = await h.app.inject({ method: 'GET', url: '/api/domains', headers: AUTH });
    expect((domains.json() as { dataDomains: Array<{ dataDomainId: string; tenant?: unknown }> }).dataDomains.find(r => r.dataDomainId === h.engDataDomainId)?.tenant).toEqual({ org: 'acme' });

    expect(h.audit.some(e => e.decision === 'dataDomain-tenant-retargeted')).toBe(true);
  });

  it('refuses a retarget whose "from" does not match the live tenant (drift guard) with 409', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/dataDomains/${h.engDataDomainId}/retarget-tenant`,
      headers: AUTH,
      payload: { from: 'acme', to: 'acme/mkt' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'conflict' });
    // Still the original tenant afterwards.
    const domains = await h.app.inject({ method: 'GET', url: '/api/domains', headers: AUTH });
    expect((domains.json() as { dataDomains: Array<{ dataDomainId: string; tenant?: unknown }> }).dataDomains.find(r => r.dataDomainId === h.engDataDomainId)?.tenant).toEqual({ org: 'acme', department: 'eng' });
  });

  it('400s when retargeting a personal dataDomain (no tenant to move)', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/dataDomains/${h.personalDataDomainId}/retarget-tenant`,
      headers: AUTH,
      payload: { from: 'acme', to: 'acme/eng' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_request' });
  });

  it('400s when from/to are missing', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/dataDomains/${h.engDataDomainId}/retarget-tenant`,
      headers: AUTH,
      payload: { from: 'acme/eng' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_request' });
  });
});
