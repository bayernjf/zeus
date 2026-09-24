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

type Seen = { requests: DispatchRequest[] };

/** A port that records what actually reached dispatch — the only way to prove
 *  the kernel-injected hits, not the caller's claim, are what a vassal saw. */
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

async function harness(options: { withRealmStore?: boolean } = {}) {
  const sandbox = mkdtempSync(join(tmpdir(), 'zeus-http-domains-'));
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
  const mktRealmId = (await store.connect(mount('mkt', 'ad spend\n'), 'enterprise', { tenant: 'acme/mkt' })).realmId;
  const personalRealmId = (await store.connect(mount('me', 'private diary\n'), 'personal')).realmId;

  const seen: Seen = { requests: [] };
  const app = await createHttpServer({
    registry: new VassalRegistry(),
    signer: new Ed25519MemorySigner('k'),
    internalToken: TOKEN,
    orchestrator: new Orchestrator(lookup, spyPort(seen), { now: () => NOW }),
    now: () => NOW,
    ...(options.withRealmStore === false
      ? {}
      : { realmStore: store, domainGrants: grants, realmAudit: (entry: RealmAuditEntry) => void audit.push(entry) }),
  });
  return { app, sandbox, store, grants, audit, seen, engRealmId, mktRealmId, personalRealmId };
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

  it('lists mounted realms with their tenant, and never a path', async () => {
    const h = await harness();
    close = () => h.app.close();
    cleanup = () => rmSync(h.sandbox, { recursive: true, force: true });

    const res = await h.app.inject({ method: 'GET', url: '/api/domains', headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { realms: Array<Record<string, unknown>>; grants: unknown[] };
    expect(body.realms.map(realm => realm.type).sort()).toEqual(['enterprise', 'enterprise', 'personal']);
    expect(body.realms.find(realm => realm.realmId === h.engRealmId)).toMatchObject({
      tenant: { org: 'acme', department: 'eng' },
      readOnly: false,
      itemCount: 1,
    });
    expect(body.grants).toEqual([]);
    // design-realm invariant 3: the absolute root stays in-process.
    expect(res.body).not.toContain(h.sandbox);
  });

  it('is not mounted at all without a bearer token, and 401s without a header', async () => {
    const h = await harness();
    close = () => h.app.close();
    cleanup = () => rmSync(h.sandbox, { recursive: true, force: true });

    // No internalToken configured: the whole driver face stays unmounted.
    const open = await createHttpServer({
      registry: new VassalRegistry(),
      signer: new Ed25519MemorySigner('k'),
      realmStore: h.store,
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
      payload: { subject: 'jev', realmId: h.engRealmId, access: 'read', grantedBy: 'driver', reason: 'review', nonce: 'n1' },
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
    expect((await post({ subject: 'jev', realmId: h.personalRealmId, access: 'read', grantedBy: 'driver' })).statusCode).toBe(400);
    expect((await post({ subject: 'jev', realmId: 'realm-nope', access: 'read', grantedBy: 'driver' })).statusCode).toBe(404);
    expect((await post({ subject: 'jev', realmId: h.engRealmId, grantedBy: 'driver' })).statusCode).toBe(400);
    expect((await post({ subject: 'jev', realmId: h.engRealmId, access: 'delete', grantedBy: 'driver' })).statusCode).toBe(400);
    expect((await post({ subject: 'jev', realmId: h.engRealmId, access: 'read', grantedBy: 'driver', expiresAt: 'next tuesday' })).statusCode).toBe(400);

    const first = await post({ subject: 'jev', realmId: h.engRealmId, access: 'read', grantedBy: 'driver', nonce: 'same' });
    expect(first.statusCode).toBe(201);
    const replay = await post({ subject: 'jev', realmId: h.engRealmId, access: 'read', grantedBy: 'driver', nonce: 'same' });
    expect(replay.statusCode).toBe(409);

    const missing = await h.app.inject({ method: 'DELETE', url: '/api/domains/grants/nope', headers: AUTH });
    expect(missing.statusCode).toBe(404);
  });

  it('answers an access probe without reading realm content', async () => {
    const h = await harness();
    close = () => h.app.close();
    cleanup = () => rmSync(h.sandbox, { recursive: true, force: true });

    const probe = (query: string) => h.app.inject({ method: 'GET', url: `/api/domains/access?${query}`, headers: AUTH });

    const down = await probe(`realmId=${h.engRealmId}&subject=pr-helper&kind=vassal&tenant=acme`);
    expect(down.statusCode).toBe(200);
    expect(down.json()).toEqual({ ok: true, via: 'tenant-hierarchy' });

    const sideways = await probe(`realmId=${h.engRealmId}&subject=loom&kind=vassal&tenant=acme/mkt`);
    expect(sideways.json()).toMatchObject({ ok: false, reason: 'tenant-out-of-scope' });

    const toPersonal = await probe(`realmId=${h.personalRealmId}&subject=loom&kind=vassal&tenant=acme`);
    expect(toPersonal.json()).toMatchObject({ ok: false, reason: 'enterprise-to-personal' });

    expect((await probe(`realmId=${h.engRealmId}&subject=jev&kind=vassal`)).json()).toMatchObject({ ok: false, reason: 'no-grant' });
    expect((await probe(`realmId=${h.engRealmId}&subject=driver&kind=driver`)).json()).toEqual({ ok: true, via: 'same-domain' });

    expect((await probe('subject=jev&kind=vassal')).statusCode).toBe(400);
    expect((await probe(`realmId=${h.engRealmId}&subject=jev`)).statusCode).toBe(400);
    expect((await probe(`realmId=${h.engRealmId}&subject=jev&kind=vassal&access=delete`)).statusCode).toBe(400);
    expect((await probe(`realmId=realm-nope&subject=jev&kind=vassal`)).statusCode).toBe(404);
    expect((await probe(`realmId=${h.engRealmId}&subject=jev&kind=vassal&tenant=too/deep/here/now`)).statusCode).toBe(400);
    // Nothing was read while answering any of the above.
    expect(h.audit).toEqual([]);
  });
});

describe('HTTP E6.4 — intent dispatch with kernel-resolved realm content', () => {
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

  it('injects the hits it found itself, and records which realm they came from', async () => {
    const h = await harness();
    close = () => h.app.close();
    cleanup = () => rmSync(h.sandbox, { recursive: true, force: true });

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/intents',
      headers: AUTH,
      payload: { skill: 'review', realm: 'enterprise', params: {}, realmSource: { realmId: h.engRealmId, text: 'compiler' } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ realm: 'enterprise', realmId: h.engRealmId });

    const dispatched = h.seen.requests[0];
    expect(dispatched?.realmHits).toEqual([{ itemId: 'doc.md', snippet: 'compiler design' }]);
    expect(h.audit.map(entry => entry.decision)).toEqual(['domain-read']);
  });

  it('refuses a declared domain that does not match the realm pointed at', async () => {
    const h = await harness();
    close = () => h.app.close();
    cleanup = () => rmSync(h.sandbox, { recursive: true, force: true });

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/intents',
      headers: AUTH,
      payload: { skill: 'review', realm: 'personal', params: {}, realmSource: { realmId: h.engRealmId } },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'realm_source_refused' });
    expect(res.json().detail).toMatch(/realm-type-mismatch/);
    // The whole point: a refused crossing never reaches a vassal.
    expect(h.seen.requests).toEqual([]);
    expect(h.audit.map(entry => entry.decision)).toEqual(['domain-refused']);
  });

  it('gates a delegated read on the delegate boundary, not on the caller who holds the token', async () => {
    const h = await harness();
    close = () => h.app.close();
    cleanup = () => rmSync(h.sandbox, { recursive: true, force: true });

    const payload = (onBehalfOf: Record<string, unknown>) => ({
      skill: 'review',
      realm: 'enterprise',
      params: {},
      realmSource: { realmId: h.engRealmId, onBehalfOf },
    });

    const sideways = await h.app.inject({ method: 'POST', url: '/api/intents', headers: AUTH, payload: payload({ kind: 'vassal', id: 'loom', tenant: 'acme/mkt' }) });
    expect(sideways.statusCode).toBe(403);
    expect(sideways.json().detail).toMatch(/tenant-out-of-scope/);

    const granted = h.grants.issue({ subject: 'loom', realmId: h.engRealmId, access: 'read', grantedBy: 'driver', nonce: 'n2' });
    const stillBlocked = await h.app.inject({ method: 'POST', url: '/api/intents', headers: AUTH, payload: payload({ kind: 'vassal', id: 'loom', tenant: 'acme/mkt' }) });
    // A tenant breach is structural: the domain grant does not open it.
    expect(stillBlocked.statusCode).toBe(403);
    expect(stillBlocked.json().detail).toMatch(/tenant-out-of-scope/);
    h.grants.revoke(granted.grantId);

    const asDriver = await h.app.inject({ method: 'POST', url: '/api/intents', headers: AUTH, payload: payload({ kind: 'driver', id: 'driver' }) });
    expect(asDriver.statusCode).toBe(400);
    expect(asDriver.json().detail).toMatch(/must be "vassal" or "agent"/);
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
        realm: 'enterprise',
        params: {},
        realmHits: [{ itemId: 'x', snippet: 'claimed' }],
        realmSource: { realmId: h.engRealmId },
      },
    });
    expect(both.statusCode).toBe(400);
    expect(both.json().detail).toMatch(/not both/);

    const bad = await h.app.inject({
      method: 'POST',
      url: '/api/intents',
      headers: AUTH,
      payload: { skill: 'review', realm: 'enterprise', params: {}, realmSource: { realmId: h.engRealmId, limit: 0 } },
    });
    expect(bad.statusCode).toBe(400);

    const noText = await h.app.inject({
      method: 'POST',
      url: '/api/intents',
      headers: AUTH,
      payload: { skill: 'review', realm: 'enterprise', params: {}, realmSource: 'not-an-object' },
    });
    expect(noText.statusCode).toBe(400);
  });

  it('says so when no realm store is assembled', async () => {
    const h = await harness({ withRealmStore: false });
    close = () => h.app.close();
    cleanup = () => rmSync(h.sandbox, { recursive: true, force: true });

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/intents',
      headers: AUTH,
      payload: { skill: 'review', realm: 'enterprise', params: {}, realmSource: { realmId: 'whatever' } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toMatch(/realm store/);
  });
});
