import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createHttpServer } from '../src/http/server.js';
import { kernelStats } from '../src/state/stats.js';
import { readAuditLog } from '../src/dispatch/audit.js';
import { bootKernel } from '../src/state/boot.js';
import { VassalRegistry } from '../src/registry/registry.js';
import { Ed25519MemorySigner } from '../src/registry/signing.js';
import type { MemoryEvent } from '../src/memory/types.js';

const TOKEN = 'driver-secret';
const AUTH = { authorization: `Bearer ${TOKEN}` };
const CONNECTOR_TOKEN = 'kb-upstream-secret';

function cardFor(name: string) {
  return {
    name,
    url: `http://127.0.0.1/${name}/api/a2a/tasks`,
    version: '0.1.0',
    capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: true },
    skills: [{ id: `skill-${name}`, name, description: '', tags: [] }],
    authentication: { schemes: ['bearer'] },
    preferredTransport: 'JSONRPC',
    'x-zeus-fealty': { version: '1', swornTo: 'zeus', domain: 'test-domain', dataRealms: ['personal', 'enterprise'], dataPolicy: 'read-task-scope', reportBack: true, escalationPolicy: 'auto' },
  };
}

const nameAwareFetch = (async (input: RequestInfo | URL) =>
  new Response(JSON.stringify(cardFor(String(input).match(/\/(v\d+)\//)?.[1] ?? 'v')), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  })) as unknown as typeof fetch;

let dir: string;
let realmRoot: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'zeus-state-'));
  realmRoot = join(dir, 'realm');
  await (await import('node:fs/promises')).mkdir(realmRoot, { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function assemble() {
  const kernel = await bootKernel({
    fetchImpl: nameAwareFetch,
    vassalSeeds: ['http://127.0.0.1/v0/card.json', 'http://127.0.0.1/v1/card.json'],
    realmRoots: [realmRoot],
    auditFile: join(dir, 'audit.jsonl'),
    auditMaxBytes: Number.POSITIVE_INFINITY,
    auditKeep: 2,
  });
  kernel.registry.revoke('v1');
  kernel.connectorRegistry!.declare({
    id: 'kb', name: 'Knowledge Base', endpoint: 'http://127.0.0.1:9/mcp',
    permissions: ['mcp'], token: CONNECTOR_TOKEN,
  });
  kernel.orgRegistry!.createDepartment({ name: 'Engineering', mission: 'ship' });
  const event: MemoryEvent = {
    eventId: 'evt-1', realmId: 'realm-x', runId: 'run-1', source: { agentId: 'agent-a' },
    kind: 'observation', content: 'noted', refs: [], confidence: 0.5,
    occurredAt: '2026-09-25T00:00:00.000Z',
  };
  kernel.memoryStore!.append(event);
  await kernel.orchestrator.fanOut({ skill: 'nothing-provides-this', realm: 'personal', params: {} });
  return kernel;
}

describe('kernel inventory', () => {
  it('counts what the assembled kernel actually holds, live', async () => {
    const kernel = await assemble();
    const stats = kernelStats(kernel);
    expect(stats.persistence).toEqual({ enabled: false, stateFile: null, restoredFromSnapshot: false });
    expect(stats.audit).toEqual({
      file: join(dir, 'audit.jsonl'),
      maxBytes: 'unlimited',
      keep: 2,
      // Exact on purpose: a healthy kernel must report a clean trail, so a
      // regression that starts counting failures cannot slip through a
      // toMatchObject.
      failures: 0,
      degraded: false,
    });
    expect(stats.counts).toMatchObject({
      vassals: 1,
      vassalsRevoked: 1,
      connectors: 1,
      departments: 1,
      memoryEvents: 1,
      memoryFacts: 0, // appending an observation does not create a fact
      realms: 1,
      skills: 2, // both cards' skills were imported on registration
      intents: 1,
      mentorships: 0,
      escalations: 0,
    });
  });

  it('counts follow mutations, because the provider reads live state', async () => {
    const kernel = await assemble();
    const before = kernelStats(kernel).counts.vassals;
    kernel.registry.revoke('v0');
    const after = kernelStats(kernel);
    expect(after.counts.vassals).toBe(before - 1);
    expect(after.counts.vassalsRevoked).toBe(2);
  });

  it('serves the inventory over the bearer face and never the payload behind it', async () => {
    const kernel = await assemble();
    const app = await createHttpServer({
      registry: new VassalRegistry(),
      signer: new Ed25519MemorySigner('zeus-rsk-test'),
      internalToken: TOKEN,
      kernelStats: () => kernelStats(kernel),
    });
    const res = await app.inject({ method: 'GET', url: '/api/state', headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = await res.json();
    expect(body.counts.vassals).toBe(1);
    expect(body.persistence.enabled).toBe(false);
    // the snapshot this describes contains the connector token; this must not
    expect(res.body).not.toContain(CONNECTOR_TOKEN);
    // the revocation in assemble() went through the same audit spine, so the
    // log exists and holds governance - but never the connector secret
    const audited = readAuditLog(kernel.auditFile!);
    expect(audited.map(entry => entry.decision)).toEqual(['vassal-revoked']);
    expect(existsSync(`${kernel.auditFile!}`)).toBe(true);
    expect(readFileSync(kernel.auditFile!, 'utf8')).not.toContain(CONNECTOR_TOKEN);
    await app.close();
  });

  it('reports persistence once a state file is in play', async () => {
    const stateFile = join(dir, 'kernel.json');
    const kernel = await bootKernel({ stateFile });
    await kernel.saveState();
    const restarted = await bootKernel({ stateFile });
    const stats = kernelStats(restarted);
    expect(stats.persistence).toEqual({ enabled: true, stateFile, restoredFromSnapshot: true });
  });

  it('is not mounted without a provider, and requires a bearer token', async () => {
    const noProvider = await createHttpServer({
      registry: new VassalRegistry(),
      signer: new Ed25519MemorySigner('zeus-rsk-test'),
      internalToken: TOKEN,
    });
    expect((await noProvider.inject({ method: 'GET', url: '/api/state', headers: AUTH })).statusCode).toBe(404);
    await noProvider.close();

    const kernel = await assemble();
    const noToken = await createHttpServer({
      registry: new VassalRegistry(),
      signer: new Ed25519MemorySigner('zeus-rsk-test'),
      kernelStats: () => kernelStats(kernel),
    });
    expect((await noToken.inject({ method: 'GET', url: '/api/state' })).statusCode).toBe(404);
    await noToken.close();

    const guarded = await createHttpServer({
      registry: new VassalRegistry(),
      signer: new Ed25519MemorySigner('zeus-rsk-test'),
      internalToken: TOKEN,
      kernelStats: () => kernelStats(kernel),
    });
    expect((await guarded.inject({ method: 'GET', url: '/api/state' })).statusCode).toBe(401);
    await guarded.close();
  });
});
