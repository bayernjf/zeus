import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createHttpServer } from '../src/http/server.js';
import { VassalRegistry } from '../src/registry/registry.js';
import { Ed25519MemorySigner } from '../src/registry/signing.js';
import type { AuditEntry } from '../src/dispatch/dispatcher.js';

let app: FastifyInstance | undefined;
let dir: string | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function auditFileWith(entries: AuditEntry[]): string {
  dir = mkdtempSync(join(tmpdir(), 'zeus-audit-summary-'));
  const file = join(dir, 'audit.jsonl');
  writeFileSync(file, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n', 'utf8');
  return file;
}

async function mount(auditFile?: string): Promise<FastifyInstance> {
  app = await createHttpServer({
    registry: new VassalRegistry(),
    signer: new Ed25519MemorySigner('zeus-rsk-2026-09'),
    ...(auditFile ? { auditFile } : {}),
  });
  return app;
}

type Summary = {
  issuer: string;
  generatedAt: string;
  window: { events: number; earliest?: string; latest?: string };
  byDecision: Record<string, number>;
};

describe('public audit summary', () => {
  it('answers on the public face without a token and aggregates by decision', async () => {
    const file = auditFileWith([
      { ts: '2026-10-10T01:00:00.000Z', vassal: 'agent-7', decision: 'dispatched', runId: 'run-1', skill: 'research', realm: 'personal', taskId: 't1', detail: 'secret detail' },
      { ts: '2026-10-10T02:00:00.000Z', vassal: 'agent-7', decision: 'dispatch-failed', runId: 'run-1', taskId: 't1' },
      { ts: '2026-10-10T03:00:00.000Z', vassal: 'agent-8', decision: 'dispatch-failed', runId: 'run-2', taskId: 't2' },
    ]);
    const res = await (await mount(file)).inject({ method: 'GET', url: '/api/audit/summary' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toContain('public');
    const body = res.json() as unknown as Summary;
    expect(body.issuer).toBe('zeus');
    expect(body.window.events).toBe(3);
    expect(body.window.earliest).toBe('2026-10-10T01:00:00.000Z');
    expect(body.window.latest).toBe('2026-10-10T03:00:00.000Z');
    expect(body.byDecision).toEqual({ dispatched: 1, 'dispatch-failed': 2 });
  });

  it('never leaks per-event fields (vassal/runId/taskId/detail/realm)', async () => {
    const file = auditFileWith([
      { ts: '2026-10-10T01:00:00.000Z', vassal: 'agent-7', decision: 'dispatched', runId: 'run-1', skill: 'research', realm: 'personal', taskId: 't1', detail: 'secret detail' },
    ]);
    const res = await (await mount(file)).inject({ method: 'GET', url: '/api/audit/summary' });
    const raw = res.body;
    for (const forbidden of ['agent-7', 'run-1', 't1', 'secret detail', 'personal']) {
      expect(raw).not.toContain(forbidden);
    }
    const body = res.json() as unknown as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['byDecision', 'generatedAt', 'issuer', 'window']);
  });

  it('reports an empty window when the audit file does not exist yet', async () => {
    dir = mkdtempSync(join(tmpdir(), 'zeus-audit-summary-'));
    const res = await (await mount(join(dir, 'missing.jsonl'))).inject({ method: 'GET', url: '/api/audit/summary' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as unknown as Summary;
    expect(body.window.events).toBe(0);
    expect(body.window.earliest).toBeUndefined();
    expect(body.byDecision).toEqual({});
  });

  it('reports an empty window when no audit file is configured at all', async () => {
    const res = await (await mount()).inject({ method: 'GET', url: '/api/audit/summary' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as unknown as Summary;
    expect(body.window.events).toBe(0);
    expect(body.byDecision).toEqual({});
  });
});
