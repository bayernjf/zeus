// design-evals (tech map S7) W4-2: the eval run query face. GET /api/v1/eval-runs
// projects suite/model/time/run_id filters over the JsonlEvalRunsStore's
// in-memory index, bearer-gated like every other observability face, and
// mounts only when a store exists (the offline runner writes it; the serve
// process only reads).

import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpServer } from '../src/http/server.js';
import { VassalRegistry } from '../src/registry/registry.js';
import { Ed25519MemorySigner } from '../src/registry/signing.js';
import { JsonlEvalRunsStore } from '../src/evals/runs-store.js';
import type { EvalRunRecord } from '../src/evals/runs-store.js';

const TOKEN = 'driver-secret';
const AUTH = { authorization: `Bearer ${TOKEN}` };

function record(runId: string, suite: string, model: string, ranAt: string): EvalRunRecord {
  return {
    runId,
    suite,
    model,
    ranAt,
    cases: [{ caseId: 'decision/unanimous-approve', checks: [] }],
    report: {
      caseCount: 1, passed: 2, failed: 0, blocked: 0, warned: 0,
      byFamily: { decision: { total: 2, passed: 2, blocked: 0 } },
    },
  };
}

describe('W4-2 eval-runs query endpoint', () => {
  let app: FastifyInstance | undefined;
  let dir: string | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  async function serverWith(store: JsonlEvalRunsStore): Promise<FastifyInstance> {
    return createHttpServer({
      registry: new VassalRegistry(),
      signer: new Ed25519MemorySigner('zeus-rsk-test'),
      internalToken: TOKEN,
      evalRunsStore: store,
    });
  }

  it('serves stored runs with suite/model/time filters', async () => {
    dir = mkdtempSync(join(tmpdir(), 'zeus-eval-runs-http-'));
    const store = new JsonlEvalRunsStore(join(dir, 'runs.jsonl'));
    await store.append(record('run-1', 'core', 'rules-only', '2026-10-30T00:00:00.000Z'));
    await store.append(record('run-2', 'loom', 'hub:choice', '2026-10-31T00:00:00.000Z'));
    app = await serverWith(store);

    const all = await app.inject({ method: 'GET', url: '/api/v1/eval-runs', headers: AUTH });
    expect(all.statusCode).toBe(200);
    expect(all.json().runs.map((r: EvalRunRecord) => r.runId)).toEqual(['run-1', 'run-2']);
    expect(all.json().count).toBe(2);

    const bySuite = await app.inject({ method: 'GET', url: '/api/v1/eval-runs?suite=loom', headers: AUTH });
    expect(bySuite.json().runs.map((r: EvalRunRecord) => r.runId)).toEqual(['run-2']);

    const byModel = await app.inject({ method: 'GET', url: '/api/v1/eval-runs?model=rules-only', headers: AUTH });
    expect(byModel.json().runs.map((r: EvalRunRecord) => r.runId)).toEqual(['run-1']);

    const byWindow = await app.inject({ method: 'GET', url: '/api/v1/eval-runs?from=2026-10-31T00:00:00.000Z', headers: AUTH });
    expect(byWindow.json().runs.map((r: EvalRunRecord) => r.runId)).toEqual(['run-2']);

    const byId = await app.inject({ method: 'GET', url: '/api/v1/eval-runs?run_id=run-1', headers: AUTH });
    expect(byId.json().runs[0].report.caseCount).toBe(1);
  });

  it('is bearer-gated like every other observability face', async () => {
    dir = mkdtempSync(join(tmpdir(), 'zeus-eval-runs-http-'));
    const store = new JsonlEvalRunsStore(join(dir, 'runs.jsonl'));
    await store.append(record('run-1', 'core', 'rules-only', '2026-10-30T00:00:00.000Z'));
    app = await serverWith(store);

    const res = await app.inject({ method: 'GET', url: '/api/v1/eval-runs' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects malformed query params', async () => {
    dir = mkdtempSync(join(tmpdir(), 'zeus-eval-runs-http-'));
    app = await serverWith(new JsonlEvalRunsStore(join(dir, 'runs.jsonl')));

    for (const url of [
      '/api/v1/eval-runs?from=not-a-date',
      '/api/v1/eval-runs?to=also-not-a-date',
      '/api/v1/eval-runs?limit=0',
      '/api/v1/eval-runs?limit=abc',
    ]) {
      const res = await app.inject({ method: 'GET', url, headers: AUTH });
      expect(res.statusCode).toBe(400);
      expect(res.json().code ?? res.json().error).toBeDefined();
    }
  });

  it('is not mounted without an eval-runs store', async () => {
    app = await createHttpServer({
      registry: new VassalRegistry(),
      signer: new Ed25519MemorySigner('zeus-rsk-test'),
      internalToken: TOKEN,
    });
    const res = await app.inject({ method: 'GET', url: '/api/v1/eval-runs', headers: AUTH });
    expect(res.statusCode).toBe(404);
  });
});
