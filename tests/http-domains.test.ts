import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

type Seen = { requests: DispatchRequest[] };

/** A port that records what actually reached dispatch — the only way to prove
 *  the runtime-injected hits, not the caller's claim, are what a executor saw. */
function spyPort(seen: Seen): DispatchPort {
  return {
    async dispatch(request) {
      seen.requests.push(request);
      return okResult();
    },
    async cancel() {},
  };
}

const lookup: TargetLookup = { findBySkill: () => [{ name: 'loom' }] };

async function harness(options: { withDataDomainStore?: boolean } = {}) {
  const sandbox = mkdtempSync(join(tmpdir(), 'zeus-http-domains-'));
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
  const mktDataDomainId = (await store.connect(mount('mkt', 'ad spend\n'), 'enterprise', { tenant: 'acme/mkt' })).dataDomainId;
  const personalDataDomainId = (await store.connect(mount('me', 'private diary\n'), 'personal')).dataDomainId;

  const seen: Seen = { requests: [] };
  const app = await createHttpServer({
    registry: new ExecutorRegistry(),
    signer: new Ed25519MemorySigner('k'),
    internalToken: TOKEN,
    orchestrator: new Orchestrator(lookup, spyPort(seen), { now: () => NOW }),
    now: () => NOW,
    ...(options.withDataDomainStore === false
      ? {}
      : { dataDomainStore: store, domainGrants: grants, dataDomainAudit: (entry: DataDomainAuditEntry) => void audit.push(entry) }),
  });
  return { app, sandbox, store, grants, audit, seen, engDataDomainId, mktDataDomainId, personalDataDomainId };
}

describe('HTTP E6.4 — the domains face', () => {
  let close: (() => Promise<void>) | undefined;
  let cleanup = (): void => {};

  beforeEach(() => {
    close = undefined;
    cleanup = () => {};
  });

  afterEach(async () => {
    await close?.();
    cleanup();
  });

  it('lists mounted dataDomains with their tenant, and never a path', async () => {
    const h = await harness();
    close = () => h.app.close();
    cleanup = () => rmSync(h.sandbox, { recursive: true, force: true });

    const res = await h.app.inject({ method: 'GET', url: '/api/domains', headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { dataDomains: Array<Record<string, unknown>>; grants: unknown[] };
    expect(body.dataDomains.map(dataDomain => dataDomain.type).sort()).toEqual(['enterprise', 'enterprise', 'personal']);
    expect(body.dataDomains.find(dataDomain => dataDomain.dataDomainId === h.engDataDomainId)).toMatchObject({
      tenant: { org: 'acme', department: 'eng' },
      readOnly: false,
      itemCount: 1,
    });
    expect(body.grants).toEqual([]);
    // design-dataDomain invariant 3: the absolute root stays in-process.
    expect(res.body).not.toContain(h.sandbox);
  });

  it('is not mounted at all without a bearer token, and 401s without a header', async () => {
    const h = await harness();
    close = () => h.app.close();
    cleanup = () => rmSync(h.sandbox, { recursive: true, force: true });

    // No internalToken configured: the whole operator face stays unmounted.
    const open = await createHttpServer({
      registry: new ExecutorRegistry(),
      signer: new Ed25519MemorySigner('k'),
      dataDomainStore: h.store,
      domainGrants: h.grants,
    });
    const unmounted = await open.inject({ method: 'GET', url: '/api/domains' });
    await open.close();
    expect(unmounted.statusCode).toBe(404);

    const noHeader = await h.app.inject({ method: 'GET', url: '/api/domains' });
    expect(noHeader.statusCode).toBe(401);
  });

  it('issues, lists and revokes a cross-domain grant', async () => {
    const h = await harness();
    close = () => h.app.close();
    cleanup = () => rmSync(h.sandbox, { recursive: true, force: true });

    const created = await h.app.inject({
      method: 'POST',
      url: '/api/domains/grants',
      headers: AUTH,
      payload: { subject: 'jev', dataDomainId: h.engDataDomainId, access: 'read', grantedBy: 'operator', reason: 'review', nonce: 'n1' },
    });
    expect(created.statusCode).toBe(201);
    const grant = created.json() as { grantId: string; subject: string; reason?: string };
    expect(grant).toMatchObject({ subject: 'jev', reason: 'review' });

    const listed = await h.app.inject({ method: 'GET', url: '/api/domains', headers: AUTH });
    expect((listed.json() as { grants: unknown[] }).grants).toHaveLength(1);

    const revoked = await h.app.inject({ method: 'DELETE', url: `/api/domains/grants/${grant.grantId}`, headers: AUTH });
    expect(revoked.statusCode).toBe(200);
    expect((revoked.json() as { grantId: string }).grantId).toBe(grant.grantId);
    expect((await h.app.inject({ method: 'GET', url: '/api/domains', headers: AUTH })).json()).toMatchObject({ grants: [] });
  });

  it('refuses the grant shapes that would mean nothing', async () => {
    const h = await harness();
    close = () => h.app.close();
    cleanup = () => rmSync(h.sandbox, { recursive: true, force: true });

    const post = (payload: Record<string, unknown>) =>
      h.app.inject({ method: 'POST', url: '/api/domains/grants', headers: AUTH, payload });

    // A grant only ever opens personal -> enterprise; the reverse is not for sale.
    expect((await post({ subject: 'jev', dataDomainId: h.personalDataDomainId, access: 'read', grantedBy: 'operator' })).statusCode).toBe(400);
    expect((await post({ subject: 'jev', dataDomainId: 'dataDomain-nope', access: 'read', grantedBy: 'operator' })).statusCode).toBe(404);
    expect((await post({ subject: 'jev', dataDomainId: h.engDataDomainId, grantedBy: 'operator' })).statusCode).toBe(400);
    expect((await post({ subject: 'jev', dataDomainId: h.engDataDomainId, access: 'delete', grantedBy: 'operator' })).statusCode).toBe(400);
    expect((await post({ subject: 'jev', dataDomainId: h.engDataDomainId, access: 'read', grantedBy: 'operator', expiresAt: 'next tuesday' })).statusCode).toBe(400);

    const first = await post({ subject: 'jev', dataDomainId: h.engDataDomainId, access: 'read', grantedBy: 'operator', nonce: 'same' });
    expect(first.statusCode).toBe(201);
    const replay = await post({ subject: 'jev', dataDomainId: h.engDataDomainId, access: 'read', grantedBy: 'operator', nonce: 'same' });
    expect(replay.statusCode).toBe(409);

    const missing = await h.app.inject({ method: 'DELETE', url: '/api/domains/grants/nope', headers: AUTH });
    expect(missing.statusCode).toBe(404);
  });

  it('answers an access probe without reading dataDomain content', async () => {
    const h = await harness();
    close = () => h.app.close();
    cleanup = () => rmSync(h.sandbox, { recursive: true, force: true });

    const probe = (query: string) => h.app.inject({ method: 'GET', url: `/api/domains/access?${query}`, headers: AUTH });

    const down = await probe(`dataDomainId=${h.engDataDomainId}&subject=pr-helper&kind=executor&tenant=acme`);
    expect(down.statusCode).toBe(200);
    expect(down.json()).toEqual({ ok: true, via: 'tenant-hierarchy' });

    const sideways = await probe(`dataDomainId=${h.engDataDomainId}&subject=loom&kind=executor&tenant=acme/mkt`);
    expect(sideways.json()).toMatchObject({ ok: false, reason: 'tenant-out-of-scope' });

    const toPersonal = await probe(`dataDomainId=${h.personalDataDomainId}&subject=loom&kind=executor&tenant=acme`);
    expect(toPersonal.json()).toMatchObject({ ok: false, reason: 'enterprise-to-personal' });

    expect((await probe(`dataDomainId=${h.engDataDomainId}&subject=jev&kind=executor`)).json()).toMatchObject({ ok: false, reason: 'no-grant' });
    expect((await probe(`dataDomainId=${h.engDataDomainId}&subject=operator&kind=operator`)).json()).toEqual({ ok: true, via: 'same-domain' });

    expect((await probe('subject=jev&kind=executor')).statusCode).toBe(400);
    expect((await probe(`dataDomainId=${h.engDataDomainId}&subject=jev`)).statusCode).toBe(400);
    expect((await probe(`dataDomainId=${h.engDataDomainId}&subject=jev&kind=executor&access=delete`)).statusCode).toBe(400);
    expect((await probe(`dataDomainId=dataDomain-nope&subject=jev&kind=executor`)).statusCode).toBe(404);
    expect((await probe(`dataDomainId=${h.engDataDomainId}&subject=jev&kind=executor&tenant=too/deep/here/now`)).statusCode).toBe(400);
    // Nothing was read while answering any of the above.
    expect(h.audit).toEqual([]);
  });
});

describe('HTTP E6.4 — intent dispatch with runtime-resolved dataDomain content', () => {
  let cleanup = (): void => {};
  let close: (() => Promise<void>) | undefined;

  beforeEach(() => {
    cleanup = () => {};
    close = undefined;
  });

  afterEach(async () => {
    await close?.();
    cleanup();
  });

  it('injects the hits it found itself, and records which dataDomain they came from', async () => {
    const h = await harness();
    close = () => h.app.close();
    cleanup = () => rmSync(h.sandbox, { recursive: true, force: true });

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/intents',
      headers: AUTH,
      payload: { skill: 'review', dataDomain: 'enterprise', params: {}, dataDomainSource: { dataDomainId: h.engDataDomainId, text: 'compiler' } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ dataDomain: 'enterprise', dataDomainId: h.engDataDomainId });

    const dispatched = h.seen.requests[0];
    // The full hit shape travels (design-dataDomain §3.1: the field set does not vary
    // by policy), and the origin tag survives the assembly layer so the dispatch
    // gate can distinguish runtime-resolved from caller-asserted content.
    expect(dispatched?.dataDomainHitsOrigin).toBe('runtime-resolved');
    expect(dispatched?.dataDomainHits).toHaveLength(1);
    expect(dispatched?.dataDomainHits?.[0]).toMatchObject({ itemId: 'doc.md', snippet: 'compiler design' });
    expect(h.audit.map(entry => entry.decision)).toEqual(['domain-read']);
  });

  it('refuses a declared domain that does not match the dataDomain pointed at', async () => {
    const h = await harness();
    close = () => h.app.close();
    cleanup = () => rmSync(h.sandbox, { recursive: true, force: true });

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/intents',
      headers: AUTH,
      payload: { skill: 'review', dataDomain: 'personal', params: {}, dataDomainSource: { dataDomainId: h.engDataDomainId } },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'dataDomain_source_refused' });
    expect(res.json().detail).toMatch(/dataDomain-type-mismatch/);
    // The whole point: a refused crossing never reaches a executor.
    expect(h.seen.requests).toEqual([]);
    expect(h.audit.map(entry => entry.decision)).toEqual(['domain-refused']);
  });

  it('gates a delegated read on the delegate boundary, not on the caller who holds the token', async () => {
    const h = await harness();
    close = () => h.app.close();
    cleanup = () => rmSync(h.sandbox, { recursive: true, force: true });

    const payload = (onBehalfOf: Record<string, unknown>) => ({
      skill: 'review',
      dataDomain: 'enterprise',
      params: {},
      dataDomainSource: { dataDomainId: h.engDataDomainId, onBehalfOf },
    });

    const sideways = await h.app.inject({ method: 'POST', url: '/api/intents', headers: AUTH, payload: payload({ kind: 'executor', id: 'loom', tenant: 'acme/mkt' }) });
    expect(sideways.statusCode).toBe(403);
    expect(sideways.json().detail).toMatch(/tenant-out-of-scope/);

    const granted = h.grants.issue({ subject: 'loom', dataDomainId: h.engDataDomainId, access: 'read', grantedBy: 'operator', nonce: 'n2' });
    const stillBlocked = await h.app.inject({ method: 'POST', url: '/api/intents', headers: AUTH, payload: payload({ kind: 'executor', id: 'loom', tenant: 'acme/mkt' }) });
    // A tenant breach is structural: the domain grant does not open it.
    expect(stillBlocked.statusCode).toBe(403);
    expect(stillBlocked.json().detail).toMatch(/tenant-out-of-scope/);
    h.grants.revoke(granted.grantId);

    const asOperator = await h.app.inject({ method: 'POST', url: '/api/intents', headers: AUTH, payload: payload({ kind: 'operator', id: 'operator' }) });
    expect(asOperator.statusCode).toBe(400);
    expect(asOperator.json().detail).toMatch(/must be "executor" or "agent"/);
  });

  it('takes one provenance, not two', async () => {
    const h = await harness();
    close = () => h.app.close();
    cleanup = () => rmSync(h.sandbox, { recursive: true, force: true });

    const both = await h.app.inject({
      method: 'POST',
      url: '/api/intents',
      headers: AUTH,
      payload: {
        skill: 'review',
        dataDomain: 'enterprise',
        params: {},
        dataDomainHits: [{ itemId: 'x', snippet: 'claimed' }],
        dataDomainSource: { dataDomainId: h.engDataDomainId },
      },
    });
    expect(both.statusCode).toBe(400);
    expect(both.json().detail).toMatch(/not both/);

    const bad = await h.app.inject({
      method: 'POST',
      url: '/api/intents',
      headers: AUTH,
      payload: { skill: 'review', dataDomain: 'enterprise', params: {}, dataDomainSource: { dataDomainId: h.engDataDomainId, limit: 0 } },
    });
    expect(bad.statusCode).toBe(400);

    const noText = await h.app.inject({
      method: 'POST',
      url: '/api/intents',
      headers: AUTH,
      payload: { skill: 'review', dataDomain: 'enterprise', params: {}, dataDomainSource: 'not-an-object' },
    });
    expect(noText.statusCode).toBe(400);
  });

  it('says so when no dataDomain store is assembled', async () => {
    const h = await harness({ withDataDomainStore: false });
    close = () => h.app.close();
    cleanup = () => rmSync(h.sandbox, { recursive: true, force: true });

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/intents',
      headers: AUTH,
      payload: { skill: 'review', dataDomain: 'enterprise', params: {}, dataDomainSource: { dataDomainId: 'whatever' } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toMatch(/dataDomain store/);
  });
});
