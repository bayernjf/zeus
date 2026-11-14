import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpServer } from '../src/http/server.js';
import { runtimeStats } from '../src/state/stats.js';
import { readAuditLog } from '../src/dispatch/audit.js';
import { bootRuntime } from '../src/state/boot.js';
import { ExecutorRegistry } from '../src/registry/registry.js';
import { Ed25519MemorySigner } from '../src/registry/signing.js';
import type { MemoryEvent } from '../src/memory/types.js';

const TOKEN = 'operator-secret';
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
    'x-zeus-handshake': { version: '1', swornTo: 'zeus', domain: 'test-domain', dataDomains: ['personal', 'enterprise'], dataPolicy: 'read-task-scope', reportBack: true, escalationPolicy: 'auto' },
  };
}

const nameAwareFetch = async (input: RequestInfo | URL) =>
  new Response(JSON.stringify(cardFor(String(input).match(/\/(v\d+)\//)?.[1] ?? 'v')), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });

let dir: string;
let dataDomainRoot: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'zeus-state-'));
  dataDomainRoot = join(dir, 'dataDomain');
  await (await import('node:fs/promises')).mkdir(dataDomainRoot, { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function assemble() {
  const runtime = await bootRuntime({
    fetchImpl: nameAwareFetch,
    executorSeeds: ['http://127.0.0.1/v0/card.json', 'http://127.0.0.1/v1/card.json'],
    dataDomainRoots: [dataDomainRoot],
    auditFile: join(dir, 'audit.jsonl'),
    auditMaxBytes: Number.POSITIVE_INFINITY,
    auditKeep: 2,
  });
  runtime.registry.revoke('v1');
  runtime.connectorRegistry!.declare({
    id: 'kb', name: 'Knowledge Base', endpoint: 'http://127.0.0.1:9/mcp',
    permissions: ['mcp'], token: CONNECTOR_TOKEN,
  });
  runtime.orgRegistry!.createDepartment({ name: 'Engineering', mission: 'ship' });
  const event: MemoryEvent = {
    eventId: 'evt-1', dataDomainId: 'dataDomain-x', runId: 'run-1', source: { agentId: 'agent-a' },
    kind: 'observation', content: 'noted', refs: [], confidence: 0.5,
    occurredAt: '2026-09-25T00:00:00.000Z',
  };
  runtime.memoryStore!.append(event);
  await runtime.orchestrator.fanOut({ skill: 'nothing-provides-this', dataDomain: 'personal', params: {} });
  return runtime;
}

describe('runtime inventory', () => {
  it('counts what the assembled runtime actually holds, live', async () => {
    const runtime = await assemble();
    const stats = runtimeStats(runtime);
    expect(stats.persistence).toEqual({ enabled: false, stateFile: null, restoredFromSnapshot: false });
    expect(stats.audit).toEqual({
      file: join(dir, 'audit.jsonl'),
      maxBytes: 'unlimited',
      keep: 2,
      // Exact on purpose: a healthy runtime must report a clean trail, so a
      // regression that starts counting failures cannot slip through a
      // toMatchObject.
      failures: 0,
      degraded: false,
    });
    expect(stats.counts).toMatchObject({
      executors: 1,
      executorsRevoked: 1,
      connectors: 1,
      departments: 1,
      memoryEvents: 1,
      memoryFacts: 0, // appending an observation does not create a fact
      dataDomains: 1,
      skills: 2, // both cards' skills were imported on registration
      intents: 1,
      mentorships: 0,
      escalations: 0,
    });
  });

  it('counts follow mutations, because the provider reads live state', async () => {
    const runtime = await assemble();
    const before = runtimeStats(runtime).counts.executors;
    runtime.registry.revoke('v0');
    const after = runtimeStats(runtime);
    expect(after.counts.executors).toBe(before - 1);
    expect(after.counts.executorsRevoked).toBe(2);
  });

  it('serves the inventory over the bearer face and never the payload behind it', async () => {
    const runtime = await assemble();
    const app = await createHttpServer({
      registry: new ExecutorRegistry(),
      signer: new Ed25519MemorySigner('zeus-rsk-test'),
      internalToken: TOKEN,
      runtimeStats: () => runtimeStats(runtime),
    });
    const res = await app.inject({ method: 'GET', url: '/api/state', headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = await res.json();
    expect(body.counts.executors).toBe(1);
    expect(body.persistence.enabled).toBe(false);
    // the snapshot this describes contains the connector token; this must not
    expect(res.body).not.toContain(CONNECTOR_TOKEN);
    // the revocation in assemble() went through the same audit spine, so the
    // log exists and holds governance - but never the connector secret
    const audited = readAuditLog(runtime.auditFile!);
    expect(audited.map(entry => entry.decision)).toEqual(['executor-revoked']);
    expect(existsSync(`${runtime.auditFile!}`)).toBe(true);
    expect(readFileSync(runtime.auditFile!, 'utf8')).not.toContain(CONNECTOR_TOKEN);
    await app.close();
  });

  it('reports persistence once a state file is in play', async () => {
    const stateFile = join(dir, 'runtime.json');
    const runtime = await bootRuntime({ stateFile });
    await runtime.saveState();
    const restarted = await bootRuntime({ stateFile });
    const stats = runtimeStats(restarted);
    expect(stats.persistence).toEqual({ enabled: true, stateFile, restoredFromSnapshot: true });
  });

  it('reports the roster key source when the assembly supplied it, and nothing when it did not', async () => {
    const runtime = await assemble();
    const withSource = await createHttpServer({
      registry: new ExecutorRegistry(),
      signer: new Ed25519MemorySigner('zeus-rsk-2026-09'),
      internalToken: TOKEN,
      runtimeStats: () => runtimeStats(runtime),
      rosterKey: { keyId: 'zeus-rsk-2026-09', source: 'ephemeral' },
    });
    const reported = await (await withSource.inject({ method: 'GET', url: '/api/state', headers: AUTH })).json();
    expect(reported.rosterKey).toEqual({ keyId: 'zeus-rsk-2026-09', source: 'ephemeral' });
    await withSource.close();

    // An embedding process that built its own signer must not have a reassuring
    // default written on its behalf.
    const withoutSource = await createHttpServer({
      registry: new ExecutorRegistry(),
      signer: new Ed25519MemorySigner('zeus-rsk-2026-09'),
      internalToken: TOKEN,
      runtimeStats: () => runtimeStats(runtime),
    });
    const bare = await (await withoutSource.inject({ method: 'GET', url: '/api/state', headers: AUTH })).json();
    expect(bare.rosterKey).toBeUndefined();
    expect(bare.counts).toBeTruthy(); // the rest of the inventory is unaffected
    await withoutSource.close();
  });

  it('is not mounted without a provider, and requires a bearer token', async () => {
    const noProvider = await createHttpServer({
      registry: new ExecutorRegistry(),
      signer: new Ed25519MemorySigner('zeus-rsk-test'),
      internalToken: TOKEN,
    });
    expect((await noProvider.inject({ method: 'GET', url: '/api/state', headers: AUTH })).statusCode).toBe(404);
    await noProvider.close();

    const runtime = await assemble();
    const noToken = await createHttpServer({
      registry: new ExecutorRegistry(),
      signer: new Ed25519MemorySigner('zeus-rsk-test'),
      runtimeStats: () => runtimeStats(runtime),
    });
    expect((await noToken.inject({ method: 'GET', url: '/api/state' })).statusCode).toBe(404);
    await noToken.close();

    const guarded = await createHttpServer({
      registry: new ExecutorRegistry(),
      signer: new Ed25519MemorySigner('zeus-rsk-test'),
      internalToken: TOKEN,
      runtimeStats: () => runtimeStats(runtime),
    });
    expect((await guarded.inject({ method: 'GET', url: '/api/state' })).statusCode).toBe(401);
    await guarded.close();
  });
});
