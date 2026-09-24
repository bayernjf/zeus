import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createHttpServer } from '../src/http/server.js';
import { VassalRegistry } from '../src/registry/registry.js';
import { Ed25519MemorySigner } from '../src/registry/signing.js';
import { jsonlAuditSink } from '../src/dispatch/audit.js';
import type { AuditEntry } from '../src/dispatch/dispatcher.js';

const TOKEN = 'driver-secret';
const AUTH = { authorization: `Bearer ${TOKEN}` };

let dir: string;
let auditFile: string;
let app: FastifyInstance | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'zeus-audit-http-'));
  auditFile = join(dir, 'audit.jsonl');
});
afterEach(async () => {
  await app?.close();
  await rm(dir, { recursive: true, force: true });
});

async function mount(withFile = true): Promise<FastifyInstance> {
  const registry = new VassalRegistry();
  app = await createHttpServer({
    registry,
    signer: new Ed25519MemorySigner('zeus-rsk-test'),
    internalToken: TOKEN,
    ...(withFile ? { auditFile } : {}),
  });
  return app;
}

function entry(ts: string, overrides: Partial<AuditEntry> = {}): AuditEntry {
  return { ts, vassal: 'loom', decision: 'dispatched', runId: 'run-1', ...overrides };
}

async function seed(entries: AuditEntry[]): Promise<void> {
  const sink = jsonlAuditSink(auditFile);
  for (const record of entries) sink(record);
}

describe('E4.7 audit HTTP face', () => {
  it('reads the trail back oldest first', async () => {
    const a = await mount();
    await seed([
      entry('t1'),
      entry('t2', { vassal: 'atlas', decision: 'dispatch-failed' }),
      entry('t3', { decision: 'vassal-revoked' }),
    ]);
    const res = await a.inject({ method: 'GET', url: '/api/audit', headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = await res.json();
    expect(body.file).toBe(auditFile);
    expect(body.entries.map((e: AuditEntry) => `${e.ts}:${e.decision}`))
      .toEqual(['t1:dispatched', 't2:dispatch-failed', 't3:vassal-revoked']);
  });

  it('filters by run, vassal and decision and trims to the newest with limit', async () => {
    const a = await mount();
    await seed([
      entry('t1', { runId: 'run-1' }),
      entry('t2', { vassal: 'atlas', runId: 'run-2' }),
      entry('t3', { runId: 'run-2' }),
    ]);
    const byRun = await a.inject({ method: 'GET', url: '/api/audit?runId=run-2', headers: AUTH });
    expect((await byRun.json()).entries.map((e: AuditEntry) => e.ts)).toEqual(['t2', 't3']);

    const byVassal = await a.inject({ method: 'GET', url: '/api/audit?vassal=atlas', headers: AUTH });
    expect((await byVassal.json()).entries).toHaveLength(1);

    const byDecision = await a.inject({
      method: 'GET', url: '/api/audit?decision=sla-ack-breached', headers: AUTH,
    });
    expect((await byDecision.json()).entries).toEqual([]);

    const trimmed = await a.inject({ method: 'GET', url: '/api/audit?limit=1', headers: AUTH });
    expect((await trimmed.json()).entries.map((e: AuditEntry) => e.ts)).toEqual(['t3']);
  });

  it('answers an empty trail before the process has audited anything', async () => {
    const a = await mount();
    const res = await a.inject({ method: 'GET', url: '/api/audit', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(await res.json()).toMatchObject({ entries: [] });
  });

  it('reports an unreadable trail as a 500 rather than a shortened one', async () => {
    const a = await mount();
    await writeFile(auditFile, '{"ts":"t1","vassal":"loom","decision":"dispatched"}\n{ not json }\n');
    const res = await a.inject({ method: 'GET', url: '/api/audit', headers: AUTH });
    expect(res.statusCode).toBe(500);
    expect(await res.json()).toMatchObject({ error: 'audit_unreadable' });
  });

  it('validates the query', async () => {
    const a = await mount();
    await seed([entry('t1')]);
    for (const url of [
      '/api/audit?decision=not-a-decision',
      '/api/audit?limit=0',
      '/api/audit?limit=abc',
      '/api/audit?runId=',
      '/api/audit?vassal=',
    ]) {
      const res = await a.inject({ method: 'GET', url, headers: AUTH });
      expect(res.statusCode, url).toBe(400);
    }
  });

  it('requires a bearer token and is absent when no audit file is configured', async () => {
    const a = await mount();
    expect((await a.inject({ method: 'GET', url: '/api/audit' })).statusCode).toBe(401);

    await app?.close();
    const bare = await mount(false);
    expect((await bare.inject({ method: 'GET', url: '/api/audit', headers: AUTH })).statusCode).toBe(404);
  });
});
