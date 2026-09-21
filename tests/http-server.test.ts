import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { VassalRegistry } from '../src/registry/registry.js';
import { Ed25519MemorySigner, verifySignedSnapshot } from '../src/registry/signing.js';
import { createHttpServer } from '../src/http/server.js';
import type { AgentCard } from '../src/a2a/types.js';
import type { SignedRosterSnapshot } from '../src/registry/signing.js';

function card(name: string, overrides: Record<string, unknown> = {}): AgentCard {
  return {
    name,
    description: `${name} vassal`,
    url: `http://${name}.internal/api/a2a/agent-card`,
    skills: [{ id: `${name}-skill`, name: `${name} skill`, description: '', tags: [] }],
    'x-zeus-fealty': {
      version: '1',
      swornTo: 'zeus',
      domain: `${name}-domain`,
      dataRealms: ['enterprise'],
      dataPolicy: 'read-task-scope',
      reportBack: true,
      escalationPolicy: 'auto',
    },
    ...overrides,
  } as AgentCard;
}

async function registryWithTwo(): Promise<VassalRegistry> {
  const registry = new VassalRegistry(async url =>
    new Response(
      JSON.stringify(url.includes('loom') ? card('loom') : card('pr-helper')),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  );
  await registry.register('http://pr-helper.internal/api/a2a/agent-card');
  await registry.register('http://loom.internal/api/a2a/agent-card');
  registry.revoke('loom');
  return registry;
}

const KEY_ID = 'zeus-rsk-2026-09';

async function serverWith(registry: VassalRegistry, internalToken?: string, signer = new Ed25519MemorySigner(KEY_ID)) {
  const app = await createHttpServer({
    registry,
    signer,
    ...(internalToken ? { internalToken } : {}),
    now: () => new Date('2026-09-21T12:00:00.000Z'),
  });
  return { app, signer };
}

describe('HTTP H1 server', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('GET /healthz returns liveness only, no vassal or realm data', async () => {
    const registry = await registryWithTwo();
    app = (await serverWith(registry)).app;
    const reply = await app.inject({ method: 'GET', url: '/healthz' });
    expect(reply.statusCode).toBe(200);
    const body = JSON.parse(reply.body) as Record<string, unknown>;
    expect(body).toEqual({ status: 'ok', ts: '2026-09-21T12:00:00.000Z' });
    expect(JSON.stringify(body)).not.toMatch(/pr-helper|loom|realm|enterprise/);
  });

  it('GET /api/roster/public returns a signed snapshot that verifies offline and trims all internal fields', async () => {
    const registry = await registryWithTwo();
    const { app: server, signer } = await serverWith(registry);
    app = server;
    const reply = await app.inject({ method: 'GET', url: '/api/roster/public' });
    expect(reply.statusCode).toBe(200);
    expect(reply.headers['cache-control']).toBe('public, max-age=3600');
    expect(reply.headers['content-type']).toContain('application/json');

    const envelope = JSON.parse(reply.body) as SignedRosterSnapshot;
    // revoked vassal absent from the public snapshot and its attestations
    expect(envelope.snapshot.scope).toBe('public');
    expect(envelope.snapshot.entries.map(e => e.name)).toEqual(['pr-helper']);
    expect(Object.keys(envelope.attestations).sort()).toEqual(['pr-helper']);

    // the roster projection itself carries no internal endpoints or probe details
    const entriesJson = JSON.stringify(envelope.snapshot.entries);
    expect(entriesJson).not.toContain('cardUrl');
    expect(entriesJson).not.toContain('taskUrl');
    expect(entriesJson).not.toContain('healthDetail');
    // taskUrl/healthDetail never appear anywhere in the envelope; the revoked
    // vassal's name is absent too. cardUrl is allowed ONLY inside attestation
    // provenance (fealty-signing §4.2 anchors {name,cardUrl} under the signature;
    // §8.1-6 requires tampering with it to fail verification).
    expect(reply.body).not.toContain('taskUrl');
    expect(reply.body).not.toContain('healthDetail');
    expect(reply.body).not.toContain('loom');
    expect((envelope.snapshot.entries[0] as Record<string, unknown>).cardUrl).toBeUndefined();
    expect(envelope.attestations['pr-helper'].vassal).toEqual({
      name: 'pr-helper',
      cardUrl: 'http://pr-helper.internal/api/a2a/agent-card',
    });

    // offline verification with the Zeus root public key
    const verdict = await verifySignedSnapshot(envelope, signer.verifier(), new Date('2026-09-21T12:30:00.000Z'));
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.snapshot.entries[0].name).toBe('pr-helper');

    const attestation = envelope.attestations['pr-helper'];
    expect(attestation).toMatchObject({ status: 'active', keyId: KEY_ID, issuer: 'zeus' });
    expect(attestation.cardDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(attestation.fealtyDigest).toMatch(/^sha256:/);
  });

  it('rejects a tampered snapshot (edited entry, provenance cardUrl) and a tampered seal signature', async () => {
    const registry = await registryWithTwo();
    const { app: server, signer } = await serverWith(registry);
    app = server;
    const reply = await app.inject({ method: 'GET', url: '/api/roster/public' });
    const envelope = JSON.parse(reply.body) as SignedRosterSnapshot;
    const withinWindow = new Date('2026-09-21T12:30:00.000Z');

    const tamperedEntry = structuredClone(envelope);
    tamperedEntry.snapshot.entries[0].domain = 'hacked-domain';
    const entryVerdict = await verifySignedSnapshot(tamperedEntry, signer.verifier(), withinWindow);
    expect(entryVerdict.ok).toBe(false);
    if (!entryVerdict.ok) expect(entryVerdict.reason).toMatch(/snapshotDigest/);

    // fealty-signing §8.1-6: tampering with the provenance cardUrl fails attestation
    const tamperedProvenance = structuredClone(envelope);
    tamperedProvenance.attestations['pr-helper'].vassal.cardUrl = 'http://evil.internal/agent-card';
    const provenanceVerdict = await verifySignedSnapshot(tamperedProvenance, signer.verifier(), withinWindow);
    expect(provenanceVerdict.ok).toBe(false);
    if (!provenanceVerdict.ok) expect(provenanceVerdict.reason).toMatch(/attestation signature/);

    const tamperedSeal = structuredClone(envelope);
    tamperedSeal.seal.sig = tamperedSeal.seal.sig.slice(0, -2) + (tamperedSeal.seal.sig.endsWith('AA') ? 'BB' : 'AA');
    const sealVerdict = await verifySignedSnapshot(tamperedSeal, signer.verifier(), withinWindow);
    expect(sealVerdict.ok).toBe(false);
    if (!sealVerdict.ok) expect(sealVerdict.reason).toMatch(/seal signature/);
  });

  it('rejects an expired seal (maxAge replay window)', async () => {
    const registry = await registryWithTwo();
    const { app: server, signer } = await serverWith(registry);
    app = server;
    const reply = await app.inject({ method: 'GET', url: '/api/roster/public' });
    const envelope = JSON.parse(reply.body) as SignedRosterSnapshot;
    const verdict = await verifySignedSnapshot(envelope, signer.verifier(), new Date('2026-09-21T13:00:01.000Z'));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/maxAge/);
  });

  it('GET /api/roster (internal) requires bearer and exposes revoked rows plus endpoints', async () => {
    const registry = await registryWithTwo();
    const { app: server } = await serverWith(registry, 'internal-secret');
    app = server;

    const noAuth = await app.inject({ method: 'GET', url: '/api/roster' });
    expect(noAuth.statusCode).toBe(401);
    const wrongAuth = await app.inject({ method: 'GET', url: '/api/roster', headers: { authorization: 'Bearer nope' } });
    expect(wrongAuth.statusCode).toBe(401);

    const ok = await app.inject({ method: 'GET', url: '/api/roster', headers: { authorization: 'Bearer internal-secret' } });
    expect(ok.statusCode).toBe(200);
    const snapshot = JSON.parse(ok.body);
    expect(snapshot.scope).toBe('internal');
    expect(snapshot.entries.map((e: { name: string }) => e.name).sort()).toEqual(['loom', 'pr-helper']);
    const loom = snapshot.entries.find((e: { name: string }) => e.name === 'loom');
    expect(loom.status).toBe('revoked');
    expect(loom.cardUrl).toContain('agent-card');
    expect(loom.taskUrl).toContain('/api/a2a/tasks');
  });

  it('does not mount the internal route when no internal token is configured', async () => {
    const registry = await registryWithTwo();
    const { app: server } = await serverWith(registry);
    app = server;
    const reply = await app.inject({ method: 'GET', url: '/api/roster' });
    expect(reply.statusCode).toBe(404);
  });

  it('seals an empty registry into a verifiable snapshot', async () => {
    const { app: server, signer } = await serverWith(new VassalRegistry());
    app = server;
    const reply = await app.inject({ method: 'GET', url: '/api/roster/public' });
    expect(reply.statusCode).toBe(200);
    const envelope = JSON.parse(reply.body) as SignedRosterSnapshot;
    expect(envelope.snapshot.entries).toEqual([]);
    const verdict = await verifySignedSnapshot(envelope, signer.verifier(), new Date('2026-09-21T12:30:00.000Z'));
    expect(verdict.ok).toBe(true);
  });
});
