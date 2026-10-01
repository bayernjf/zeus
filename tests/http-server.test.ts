import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { VassalRegistry } from '../src/registry/registry.js';
import { Ed25519MemorySigner, verifySignedSnapshot } from '../src/registry/signing.js';
import { timingSafeEqual } from 'node:crypto';
import {
  classifyCatalogueError,
  classifyConnectorError,
  classifyKernelError,
  classifyOrgError,
  createHttpServer,
  constantTimeEqual,
} from '../src/http/server.js';
import { DomainError } from '../src/util/domain-error.js';
import { UnknownIntentError } from '../src/orchestrator/orchestrator.js';
import { DuplicateSkillError, SkillNotFoundError } from '../src/skills/registry.js';
import { OrgError } from '../src/org/types.js';
import { ConnectorError } from '../src/mcp/connectors.js';
import type { AgentCard } from '../src/a2a/types.js';
import type { SignedRosterSnapshot } from '../src/registry/signing.js';

function card(name: string, overrides: Record<string, unknown> = {}): AgentCard {
  return {
    name,
    description: `${name} vassal`,
    url: `http://${name}.internal/api/a2a/tasks`,
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

  it('GET /api/roster (internal) requires bearer, seals revoked+active rows, and verifies offline', async () => {
    const registry = await registryWithTwo();
    const { app: server, signer } = await serverWith(registry, 'internal-secret');
    app = server;

    const noAuth = await app.inject({ method: 'GET', url: '/api/roster' });
    expect(noAuth.statusCode).toBe(401);
    // RFC 6750 §3: the challenge names the scheme; no credentials means no error
    // code, only the realm-shaped challenge.
    expect(noAuth.headers['www-authenticate']).toBe('Bearer');
    const wrongAuth = await app.inject({ method: 'GET', url: '/api/roster', headers: { authorization: 'Bearer nope' } });
    expect(wrongAuth.statusCode).toBe(401);
    // A token *was* presented and rejected: the client is told which failure this
    // is, instead of having to guess whether it forgot the header.
    expect(wrongAuth.headers['www-authenticate']).toContain('error="invalid_token"');

    const ok = await app.inject({ method: 'GET', url: '/api/roster', headers: { authorization: 'Bearer internal-secret' } });
    expect(ok.statusCode).toBe(200);
    // governance view is bearer-protected and must never be cached by intermediaries
    expect(ok.headers['cache-control']).toBe('no-store');

    const envelope = JSON.parse(ok.body) as SignedRosterSnapshot;
    expect(envelope.snapshot.scope).toBe('internal');
    expect(envelope.snapshot.entries.map((e: { name: string }) => e.name).sort()).toEqual(['loom', 'pr-helper']);
    const loom = envelope.snapshot.entries.find((e: { name: string }) => e.name === 'loom')!;
    expect(loom.status).toBe('revoked');
    expect(loom.cardUrl).toContain('agent-card');
    expect(loom.taskUrl).toContain('/api/a2a/tasks');

    // v1.1: the internal envelope (revoked row included) seals and verifies offline
    const verdict = await verifySignedSnapshot(envelope, signer.verifier(), new Date('2026-09-21T12:30:00.000Z'));
    expect(verdict.ok).toBe(true);

    // the revoked row carries a permanent revocation attestation (no hard expiry),
    // the active row carries an expiring active attestation
    expect(envelope.attestations.loom.status).toBe('revoked');
    expect(envelope.attestations.loom.expiresAt).toBeUndefined();
    expect(envelope.attestations['pr-helper'].status).toBe('active');
    expect(typeof envelope.attestations['pr-helper'].expiresAt).toBe('string');
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

describe('bearer token comparison (length-safe)', () => {
  it('accepts the exact token and rejects everything else', () => {
    expect(constantTimeEqual('internal-secret', 'internal-secret')).toBe(true);
    expect(constantTimeEqual('internal-secret', 'internal-secretx')).toBe(false);
    expect(constantTimeEqual('', 'internal-secret')).toBe(false);
  });

  it('reduces both sides to equal-length digests before comparing', () => {
    // The guard under test is "no early return on a length mismatch". An obvious
    // `a.length !== b.length` short-circuit never reaches the comparator for
    // differently-sized inputs, leaking the expected token's length by timing.
    const widths: Array<[number, number]> = [];
    const result = constantTimeEqual('short', 'a-far-longer-expected-token', (a, b) => {
      widths.push([a.length, b.length]);
      return timingSafeEqual(a, b);
    });
    expect(result).toBe(false);
    expect(widths).toHaveLength(1);
    expect(widths[0][0]).toBe(32);
    expect(widths[0][0]).toBe(widths[0][1]);
  });
});

describe('domain error -> HTTP status classification', () => {
  // The messages below deliberately share no keyword with the retired mapper
  // regexes ("unknown department", "not found", "already ..."): a mapper that
  // still decides by message text returns 400 for every one of them.
  it('reads the kind off the type, whatever the message says', () => {
    expect(classifyKernelError(new DomainError('totally unrelated wording', 'not-found')))
      .toEqual({ status: 404, code: 'not_found' });
    expect(classifyOrgError(new DomainError('totally unrelated wording', 'not-found')))
      .toEqual({ status: 404, code: 'not_found' });
    expect(classifyCatalogueError(new DomainError('totally unrelated wording', 'conflict')))
      .toEqual({ status: 409, code: 'conflict' });
    expect(classifyConnectorError(new DomainError('totally unrelated wording', 'conflict'), 400))
      .toEqual({ status: 409, code: 'conflict' });
  });

  it('classifies the real domain errors by class, not by message text', () => {
    expect(classifyKernelError(new UnknownIntentError('anything at all')))
      .toEqual({ status: 404, code: 'not_found' });
    expect(classifyCatalogueError(new SkillNotFoundError('anything at all')))
      .toEqual({ status: 404, code: 'not_found' });
    expect(classifyCatalogueError(new DuplicateSkillError('anything at all')))
      .toEqual({ status: 409, code: 'conflict' });
    expect(classifyOrgError(new OrgError('anything at all', 'not-found')))
      .toEqual({ status: 404, code: 'not_found' });
    expect(classifyConnectorError(new ConnectorError('anything at all', 'conflict'), 400))
      .toEqual({ status: 409, code: 'conflict' });
  });

  it('does not classify an untyped throw by its message', () => {
    expect(classifyKernelError(new Error('unknown intent: x')))
      .toEqual({ status: 400, code: 'invalid_request' });
    expect(classifyOrgError(new Error('Unknown department dept:nope')))
      .toEqual({ status: 400, code: 'invalid_request' });
    expect(classifyCatalogueError(new Error('skill s not found')))
      .toEqual({ status: 400, code: 'invalid_request' });
  });

  it('keeps the caller-supplied handshake outcome for a non-domain throw', () => {
    expect(classifyConnectorError(new Error('connection refused'), 502))
      .toEqual({ status: 502, code: 'bad_gateway' });
    expect(classifyConnectorError(new Error('connection refused'), 400))
      .toEqual({ status: 400, code: 'invalid_request' });
  });
});
