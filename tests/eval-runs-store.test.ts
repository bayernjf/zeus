// design-evals (tech map S7) W4-2: the eval-runs JSONL store and query. The
// persistence contract mirrors the JsonlTraceExporter: keyed append by runId
// (a retried run cannot double-write), 0700 dir / 0600 file, in-memory index
// rebuilt on readBack so a restart reads the same runs. The record is a
// superset of the legacy evals/reports JSON artifact — ranAt/cases/report stay
// top-level, so a legacy consumer of the store file keeps working.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlEvalRunsStore, queryEvalRuns } from '../src/evals/runs-store.js';
import type { EvalRunRecord } from '../src/evals/runs-store.js';
import type { EvalMetricsReport, EvalResult } from '../src/evals/score.js';

function report(family = 'decision', passed = 2, blocked = 0): EvalMetricsReport {
  return {
    caseCount: 1, passed, failed: 0, blocked, warned: 0,
    byFamily: { [family]: { total: 2, passed, blocked } },
  };
}

function caseResult(caseId: string): EvalResult {
  return { caseId, checks: [{ name: 'decision.decision', family: 'decision', passed: true, severity: 'block' }] };
}

function record(overrides: Partial<EvalRunRecord> = {}): EvalRunRecord {
  return {
    runId: 'run-2026-10-31T00:00:00.000Z',
    suite: 'core',
    model: 'rules-only',
    ranAt: '2026-10-31T00:00:00.000Z',
    cases: [caseResult('decision/unanimous-approve')],
    report: report(),
    ...overrides,
  };
}

describe('JsonlEvalRunsStore (W4-2)', () => {
  it('appends records and reads them back oldest first', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zeus-eval-runs-'));
    try {
      const store = new JsonlEvalRunsStore(join(dir, 'runs.jsonl'));
      await store.append(record({ runId: 'run-a' }));
      await store.append(record({ runId: 'run-b', suite: 'loom' }));
      const runs = await store.readBack();
      expect(runs.map(r => r.runId)).toEqual(['run-a', 'run-b']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips a duplicate runId (keyed append) and persists 0600', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zeus-eval-runs-'));
    try {
      const path = join(dir, 'runs.jsonl');
      const store = new JsonlEvalRunsStore(path);
      await store.append(record({ runId: 'run-a' }));
      await store.append(record({ runId: 'run-a', suite: 'duplicate-attempt' }));
      const runs = await store.readBack();
      expect(runs).toHaveLength(1);
      expect(runs[0]!.suite).toBe('core');
      const mode = statSync(path).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rebuilds the index from disk and keeps the legacy artifact fields top-level', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zeus-eval-runs-'));
    try {
      const path = join(dir, 'runs.jsonl');
      const first = new JsonlEvalRunsStore(path);
      await first.append(record({ runId: 'run-a', judgeModel: 'judge-m', revision: 'abc123' }));
      // A second store instance (a restarted process) reads the same runs.
      const second = new JsonlEvalRunsStore(path);
      const runs = await second.readBack();
      expect(runs.map(r => r.runId)).toEqual(['run-a']);
      const stored = runs[0]!;
      // Legacy compatibility: every field the evals/reports JSON carries is
      // still present at the top level of the stored record.
      expect(stored.ranAt).toBe('2026-10-31T00:00:00.000Z');
      expect(stored.cases[0]!.caseId).toBe('decision/unanimous-approve');
      expect(stored.report.caseCount).toBe(1);
      expect(stored.judgeModel).toBe('judge-m');
      expect(stored.revision).toBe('abc123');
      const line = JSON.parse(readFileSync(path, 'utf8').trim()) as EvalRunRecord;
      expect(line.suite).toBe('core');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats a missing file as an empty store', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zeus-eval-runs-'));
    try {
      const store = new JsonlEvalRunsStore(join(dir, 'absent.jsonl'));
      expect(await store.readBack()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('queryEvalRuns (W4-2)', () => {
  const runs = [
    record({ runId: 'run-1', suite: 'core', model: 'rules-only', ranAt: '2026-10-30T00:00:00.000Z' }),
    record({ runId: 'run-2', suite: 'loom', model: 'hub:choice', ranAt: '2026-10-31T00:00:00.000Z' }),
    record({ runId: 'run-3', suite: 'core', model: 'hub:choice', ranAt: '2026-11-01T00:00:00.000Z' }),
  ];

  it('filters by suite, model and run_id', () => {
    expect(queryEvalRuns(runs, { suite: 'core' }).runs.map(r => r.runId)).toEqual(['run-1', 'run-3']);
    expect(queryEvalRuns(runs, { model: 'hub:choice' }).runs.map(r => r.runId)).toEqual(['run-2', 'run-3']);
    expect(queryEvalRuns(runs, { runId: 'run-2' }).runs.map(r => r.runId)).toEqual(['run-2']);
    expect(queryEvalRuns(runs, { suite: 'core', model: 'hub:choice' }).runs.map(r => r.runId)).toEqual(['run-3']);
  });

  it('filters by an inclusive time window over ranAt', () => {
    const within = queryEvalRuns(runs, { from: '2026-10-31T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z' });
    expect(within.runs.map(r => r.runId)).toEqual(['run-2', 'run-3']);
    expect(queryEvalRuns(runs, { from: '2026-11-02T00:00:00.000Z' }).runs).toEqual([]);
  });

  it('applies the limit (default 50, capped 200) over the oldest-first order', () => {
    expect(queryEvalRuns(runs, { limit: 2 }).runs.map(r => r.runId)).toEqual(['run-1', 'run-2']);
    expect(queryEvalRuns(runs, { limit: 999 }).count).toBe(3);
    expect(queryEvalRuns(runs, {}).count).toBe(3);
  });
});
