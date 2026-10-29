import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDecisionTraceSink } from '../src/observability/decision-trace-sink.js';
import type { DecisionTrace } from '../src/decision/types.js';

// TracePort v1 §6 (W2-1): the per-call decision ledger. JSONL, 0600, D-4
// redaction and a 2048-byte truncation bound on every free-text field.
function trace(overrides: Partial<DecisionTrace> = {}): DecisionTrace {
  return {
    runId: 'run-1',
    backend: 'hub',
    model: 'hub-model-x',
    request: { kind: 'choice', question: 'approve the release?', stateKeys: [] },
    result: { choice: 'approve' },
    latencyMs: 42,
    cost: { inputTokens: 100, outputTokens: 40, cents: 0.052 },
    decidedAt: '2026-10-30T00:00:00.000Z',
    ...overrides,
  };
}

function tempFile(relative: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'zeus-trace-sink-'));
  return { dir, path: join(dir, relative) };
}

function readRecords(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

describe('decision trace sink', () => {
  it('appends one JSONL record per call with the derived cost_micros', () => {
    const { dir, path } = tempFile('trace.jsonl');
    try {
      const sink = createDecisionTraceSink(path);
      sink.onTrace(trace());
      sink.onTrace(trace({ runId: 'run-2', request: { kind: 'score', question: 'risk level?', stateKeys: [] }, result: undefined, error: { code: 'timeout', message: 'upstream timeout' } }));

      const records = readRecords(path);
      expect(records).toHaveLength(2);

      expect(records[0]).toMatchObject({
        runId: 'run-1',
        backend: 'hub',
        model: 'hub-model-x',
        kind: 'choice',
        question: 'approve the release?',
        result: JSON.stringify({ choice: 'approve' }),
        tokens_in: 100,
        tokens_out: 40,
        // family-wide micros: cents * 10_000
        cost_micros: 520,
        latency_ms: 42,
        decided_at: '2026-10-30T00:00:00.000Z',
      });
      // No result key when the call produced none; the error is stringified.
      expect(records[0]).not.toHaveProperty('error');
      expect(records[1]!.runId).toBe('run-2');
      expect(records[1]!.kind).toBe('score');
      expect(records[1]).not.toHaveProperty('result');
      expect(records[1]!.error).toBe(JSON.stringify({ code: 'timeout', message: 'upstream timeout' }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports null cost_micros and zero tokens when cost is unknown', () => {
    const { dir, path } = tempFile('trace.jsonl');
    try {
      const sink = createDecisionTraceSink(path);
      sink.onTrace(trace({ cost: undefined }));
      const [record] = readRecords(path);
      expect(record!.cost_micros).toBeNull();
      expect(record!.tokens_in).toBe(0);
      expect(record!.tokens_out).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('redacts credentials in the question, result, and error fields', () => {
    const { dir, path } = tempFile('trace.jsonl');
    try {
      const sink = createDecisionTraceSink(path);
      sink.onTrace(trace({
        request: { kind: 'choice', question: 'token: sk-live-999 — approve?', stateKeys: [] },
        result: { choice: 'approve', note: 'Bearer abc.def.ghi checked' },
        error: { code: 'auth', message: 'https://user:hunter2@hub.example/api rejected' },
      }));
      const [record] = readRecords(path);
      expect(record!.question).toBe('token:[REDACTED] — approve?');
      expect(String(record!.result)).toContain('Bearer [REDACTED]');
      expect(String(record!.result)).not.toContain('abc.def.ghi');
      expect(String(record!.error)).not.toContain('hunter2');
      expect(String(record!.error)).toContain('https://hub.example/api');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('truncates a question beyond the 2048-byte bound with a replay pointer', () => {
    const { dir, path } = tempFile('trace.jsonl');
    try {
      const oversized = 'a'.repeat(3000);
      const sink = createDecisionTraceSink(path);
      sink.onTrace(trace({ request: { kind: 'noul', question: oversized, stateKeys: [] } }));
      const [record] = readRecords(path);
      const question = String(record!.question);
      expect(question.startsWith('a'.repeat(2048))).toBe(true);
      expect(question).toContain('(truncated, 3000 bytes; full context via replay by runId)');
      // The stored field is bounded, not the raw payload echoed back.
      expect(question.length).toBeLessThan(oversized.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves a question within the bound untouched', () => {
    const { dir, path } = tempFile('trace.jsonl');
    try {
      const sink = createDecisionTraceSink(path);
      sink.onTrace(trace());
      const [record] = readRecords(path);
      expect(record!.question).toBe('approve the release?');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates missing parent directories and writes the file 0600', () => {
    const { dir, path } = tempFile(join('nested', 'ledger', 'trace.jsonl'));
    try {
      expect(existsSync(path)).toBe(false);
      const sink = createDecisionTraceSink(path);
      expect(existsSync(path)).toBe(false); // creation is lazy until the first trace
      sink.onTrace(trace());

      expect(existsSync(path)).toBe(true);
      expect((statSync(path).mode & 0o777).toString(8)).toBe('600');
      // The auto-created parent chain is private too.
      expect((statSync(join(dir, 'nested', 'ledger')).mode & 0o777).toString(8)).toBe('700');
      expect((statSync(join(dir, 'nested')).mode & 0o777).toString(8)).toBe('700');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('appends across calls into an existing file without touching its mode', () => {
    const { dir, path } = tempFile('trace.jsonl');
    try {
      mkdirSync(dir, { recursive: true });
      const sink = createDecisionTraceSink(path);
      sink.onTrace(trace());
      sink.onTrace(trace({ runId: 'run-2' }));
      expect(readRecords(path)).toHaveLength(2);
      expect((statSync(path).mode & 0o777).toString(8)).toBe('600');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
