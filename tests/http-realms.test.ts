import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createHttpServer } from '../src/http/server.js';
import { VassalRegistry } from '../src/registry/registry.js';
import { Ed25519MemorySigner } from '../src/registry/signing.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { FsRealmStore } from '../src/realm/store.js';
import { DomainGrantRegistry } from '../src/realm/authorization.js';
import type { RealmAuditEntry } from '../src/realm/source.js';
import type { DispatchPort, TargetLookup } from '../src/orchestrator/types.js';
import type { DispatchRequest, DispatchResult } from '../src/dispatch/dispatcher.js';
import type { Task, TaskState } from '../src/a2a/types.js';

const TOKEN = 'driver-secret';
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
  const sandbox = mkdtempSync(join(tmpdir(), 'zeus-http-realms-'));
  const mount = (name: string, content: string) => {
    const root = join(sandbox, name);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'doc.md'), content);
    return root;
  };
  const store = new FsRealmStore();
  const grants = new DomainGrantRegistry(() => NOW);
  const audit: RealmAuditEntry[] = [];
  const engRealmId = (await store.connect(mount('eng', 'compiler design\n'), 'enterprise', { tenant: 'acme/eng' })).realmId;
  const personalRealmId = (await store.connect(mount('me', 'private diary\n'), 'personal')).realmId;
  const app: FastifyInstance = await createHttpServer({
    registry: new VassalRegistry(),
    signer: new Ed25519MemorySigner('k'),
    internalToken: TOKEN,
    orchestrator: new Orchestrator(lookup, spyPort(), { now: () => NOW }),
    now: () => NOW,
    realmStore: store,
    domainGrants: grants,
    realmAudit: (entry: RealmAuditEntry) => void audit.push(entry),
  });
  return { app, sandbox, store, grants, audit, engRealmId, personalRealmId };
}

describe('HTTP deferred #17 — realm boundary mutations', () => {
  let h: Awaited<ReturnType<typeof harness>>;

  beforeEach(async () => {
    h = await harness();
  });

  afterEach(async () => {
    await h.app.close();
    rmSync(h.sandbox, { recursive: true, force: true });
  });

  it('disconnects a mounted realm and drops it from /api/domains', async () => {
    const before = await h.app.inject({ method: 'GET', url: '/api/domains', headers: AUTH });
    expect((before.json() as { realms: Array<{ realmId: string }> }).realms.some(r => r.realmId === h.engRealmId)).toBe(true);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/realms/${h.engRealmId}/disconnect`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ realmId: h.engRealmId, disconnected: true });

    const after = await h.app.inject({ method: 'GET', url: '/api/domains', headers: AUTH });
    expect((after.json() as { realms: Array<{ realmId: string }> }).realms.some(r => r.realmId === h.engRealmId)).toBe(false);

    expect(h.audit.some(e => e.decision === 'realm-disconnected')).toBe(true);
  });

  it('404s when disconnecting an unknown realm', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/realms/realm-unknown/disconnect',
      headers: AUTH,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'not_found' });
  });

  it('requires a bearer token (401 without auth)', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/realms/${h.engRealmId}/disconnect`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('re-scopes an enterprise realm tenant and reflects it in /api/domains', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/realms/${h.engRealmId}/retarget-tenant`,
      headers: AUTH,
      payload: { from: 'acme/eng', to: 'acme' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ realmId: h.engRealmId, tenant: { org: 'acme' } });

    const domains = await h.app.inject({ method: 'GET', url: '/api/domains', headers: AUTH });
    expect((domains.json() as { realms: Array<{ realmId: string; tenant?: unknown }> }).realms.find(r => r.realmId === h.engRealmId)?.tenant).toEqual({ org: 'acme' });

    expect(h.audit.some(e => e.decision === 'realm-tenant-retargeted')).toBe(true);
  });

  it('refuses a retarget whose "from" does not match the live tenant (drift guard) with 409', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/realms/${h.engRealmId}/retarget-tenant`,
      headers: AUTH,
      payload: { from: 'acme', to: 'acme/mkt' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'conflict' });
    // Still the original tenant afterwards.
    const domains = await h.app.inject({ method: 'GET', url: '/api/domains', headers: AUTH });
    expect((domains.json() as { realms: Array<{ realmId: string; tenant?: unknown }> }).realms.find(r => r.realmId === h.engRealmId)?.tenant).toEqual({ org: 'acme', department: 'eng' });
  });

  it('400s when retargeting a personal realm (no tenant to move)', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/realms/${h.personalRealmId}/retarget-tenant`,
      headers: AUTH,
      payload: { from: 'acme', to: 'acme/eng' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_request' });
  });

  it('400s when from/to are missing', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/realms/${h.engRealmId}/retarget-tenant`,
      headers: AUTH,
      payload: { from: 'acme/eng' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_request' });
  });
});
