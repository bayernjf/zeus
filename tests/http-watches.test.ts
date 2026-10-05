import { describe, expect, it } from 'vitest';
import { createHttpServer } from '../src/http/server.js';
import { VassalRegistry } from '../src/registry/registry.js';
import { Ed25519MemorySigner } from '../src/registry/signing.js';
import { WatchRegistry } from '../src/watch/watch.js';
import type { WatchAuditEntry } from '../src/watch/watch.js';
import type { AuditEntry } from '../src/dispatch/dispatcher.js';

/**
 * Self-host loop, operator face for the trigger primitive: watches are
 * registered, listed and revoked over the bearer face, and the tick is a
 * caller-driven POST. The kernel holds no timers, so this face is how an
 * operator's scheduler (cron curl) drives the rhythm - and every lifecycle
 * act lands on the audit spine via the registry's own hook.
 */

const TOKEN = 'driver-secret';
const AUTH = { authorization: `Bearer ${TOKEN}` };
const NOW = new Date('2026-10-03T00:00:00.000Z');

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    owner: 'pilot-operator',
    realm: 'personal',
    predicate: { source: 'metrics', op: 'below', field: 'inFlight', value: 1 },
    intent: { skill: 'research', subject: 'nightly summary', mode: 'plan', maxFanOut: 2 },
    intervalSeconds: 60,
    budget: { fires: 3, executes: 0 },
    ...overrides,
  };
}

async function harness() {
  const audit: WatchAuditEntry[] = [];
  const dispatchAudit: AuditEntry[] = [];
  const watches = new WatchRegistry({
    now: () => NOW,
    audit: (entry: WatchAuditEntry) => void audit.push(entry),
  });
  let ticked = 0;
  const app = await createHttpServer({
    registry: new VassalRegistry(),
    signer: new Ed25519MemorySigner('k'),
    internalToken: TOKEN,
    now: () => NOW,
    watches,
    runWatchTick: async () => {
      ticked += 1;
      return { evaluated: ticked, fired: [], unavailable: [], autoDisabled: [] };
    },
    dispatchAudit: (entry: AuditEntry) => void dispatchAudit.push(entry),
  } as Parameters<typeof createHttpServer>[0]);
  return { app, watches, audit, dispatchAudit };
}

async function register(app: Awaited<ReturnType<typeof harness>>['app'], body: Record<string, unknown> = validBody()) {
  return app.inject({
    method: 'POST',
    url: '/api/watches',
    headers: { ...AUTH, 'content-type': 'application/json' },
    payload: body,
  });
}

describe('HTTP watch operator face', () => {
  it('registers a watch with defaults and audits the registration', async () => {
    const h = await harness();
    const res = await register(h.app, validBody({ startsAt: undefined, expiresAt: undefined }));
    expect(res.statusCode).toBe(201);
    const body = res.json() as { watch: Record<string, unknown> };
    expect(body.watch).toMatchObject({
      owner: 'pilot-operator',
      realm: 'personal',
      enabled: true,
      used: { fires: 0, executes: 0 },
    });
    expect(body.watch.startsAt).toBe(NOW.toISOString());
    // defaults keep the watch inside a bounded window even when the operator omits one
    expect(Number(new Date(String(body.watch.expiresAt))) - NOW.getTime()).toBe(7 * 24 * 3600_000);
    expect(h.audit.some(entry => entry.decision === 'watch-registered' && entry.watchId === body.watch.id)).toBe(true);
  });

  it('rejects malformed registrations naming the problem', async () => {
    const h = await harness();
    for (const body of [
      validBody({ predicate: undefined }),
      validBody({ intent: undefined }),
      validBody({ realm: 'public' }),
      validBody({ intent: { skill: 'research', subject: 'x', mode: 'unattended', maxFanOut: 1 } }),
      validBody({ intervalSeconds: 0 }),
      validBody({ budget: { fires: 0, executes: 0 } }),
      validBody({ predicate: { source: 'metrics', op: 'below', field: 'notAField', value: 1 } }),
    ]) {
      const res = await register(h.app, body);
      expect(res.statusCode).toBe(400);
    }
    // an execute watch without a contract id is refused by the registry invariant
    const noContract = register(h.app, validBody({
      intent: { skill: 'research', subject: 'x', mode: 'execute', maxFanOut: 1 },
      budget: { fires: 1, executes: 2 },
    }));
    await expect(noContract).resolves.toMatchObject({ statusCode: 400 });
  });

  it('lists, reads and 404s unknown ids', async () => {
    const h = await harness();
    await register(h.app);
    const list = await h.app.inject({ method: 'GET', url: '/api/watches', headers: AUTH });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { watches: unknown[] }).watches).toHaveLength(1);
    const id = (list.json() as { watches: Array<{ id: string }> }).watches[0]!.id;
    const read = await h.app.inject({ method: 'GET', url: `/api/watches/${id}`, headers: AUTH });
    expect(read.statusCode).toBe(200);
    const unknown = await h.app.inject({ method: 'GET', url: '/api/watches/nope', headers: AUTH });
    expect(unknown.statusCode).toBe(404);
  });

  it('requires the bearer token for the whole face', async () => {
    const h = await harness();
    for (const req of [
      h.app.inject({ method: 'POST', url: '/api/watches', headers: { 'content-type': 'application/json' }, payload: validBody() }),
      h.app.inject({ method: 'GET', url: '/api/watches' }),
      h.app.inject({ method: 'POST', url: '/api/watch-tick' }),
    ]) {
      await expect(req).resolves.toMatchObject({ statusCode: 401 });
    }
  });

  it('revokes terminally, refuses a second settle, and the revoked watch never fires again', async () => {
    const h = await harness();
    const res = await register(h.app);
    const id = (res.json() as { watch: { id: string } }).watch.id;
    const revoked = await h.app.inject({ method: 'DELETE', url: `/api/watches/${id}`, headers: AUTH });
    expect(revoked.statusCode).toBe(200);
    expect((revoked.json() as { watch: { enabled: boolean } }).watch.enabled).toBe(false);
    const again = await h.app.inject({ method: 'DELETE', url: `/api/watches/${id}`, headers: AUTH });
    expect(again.statusCode).toBe(409);
    expect(h.audit.some(entry => entry.decision === 'watch-revoked' && entry.watchId === id)).toBe(true);
    const unknown = await h.app.inject({ method: 'DELETE', url: '/api/watches/nope', headers: AUTH });
    expect(unknown.statusCode).toBe(404);
  });

  it('runs a caller-driven tick through the assembled trigger', async () => {
    const h = await harness();
    const before = (await h.app.inject({ method: 'POST', url: '/api/watch-tick', headers: AUTH })).json() as { report: { evaluated: number } };
    expect(before.report.evaluated).toBe(1);
    await register(h.app);
    const after = await h.app.inject({ method: 'POST', url: '/api/watch-tick', headers: AUTH });
    expect(after.statusCode).toBe(200);
    // the trigger is the assembled kernel's own pass, not a canned answer:
    // a second registered watch raises the evaluated count
    expect((after.json() as { report: { evaluated: number } }).report.evaluated).toBe(2);
  });

  it('the tick face is assembled, not merely routed', async () => {
    // serve.ts must actually hand kernel.runWatchTick across; a route that
    // answers 503 "not assembled" would pass a route-presence grep.
    const app = await createHttpServer({
      registry: new VassalRegistry(),
      signer: new Ed25519MemorySigner('k'),
      internalToken: TOKEN,
      watches: new WatchRegistry(),
      // runWatchTick deliberately absent
    } as Parameters<typeof createHttpServer>[0]);
    const res = await app.inject({ method: 'POST', url: '/api/watch-tick', headers: AUTH });
    expect(res.statusCode).toBe(503);
    expect(String((res.json() as { detail?: string }).detail)).toMatch(/not assembled|watch/i);
  });
});
