import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditLogError,
  jsonlAuditSink,
  memoryAuditSink,
  readAuditLog,
  revokeAuditBridge,
} from '../src/dispatch/audit.js';

describe('audit sinks', () => {
  it('jsonlAuditSink appends one JSON object per line, including revocation governance events', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zeus-audit-'));
    const path = join(dir, 'audit.jsonl');
    try {
      const sink = jsonlAuditSink(path);
      sink({ ts: '2026-09-21T10:00:00.000Z', runId: 'run-1', vassal: 'pr-helper', skill: 'create-pr', realm: 'enterprise', decision: 'dispatched' });
      revokeAuditBridge(sink)('pr-helper', '2026-09-21T11:00:00.000Z');

      const lines = readFileSync(path, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0])).toMatchObject({ decision: 'dispatched', runId: 'run-1' });
      expect(JSON.parse(lines[1])).toMatchObject({ decision: 'vassal-revoked', vassal: 'pr-helper', ts: '2026-09-21T11:00:00.000Z' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('memoryAuditSink collects entries in order', () => {
    const { log, sink } = memoryAuditSink();
    sink({ ts: 't1', vassal: 'a', decision: 'dispatched' });
    revokeAuditBridge(sink)('a', 't2');
    expect(log.map(entry => entry.decision)).toEqual(['dispatched', 'vassal-revoked']);
  });
});

describe('jsonlAuditSink disk ceiling', () => {
  const entry = (ts: string): Parameters<ReturnType<typeof jsonlAuditSink>>[0] => ({
    ts, vassal: 'loom', decision: 'dispatched',
  });
  const sizes = (path: string) => {
    const active = statSync(path).size;
    const generations: string[] = [];
    for (const name of readdirSync(dirname(path))) {
      if (name.startsWith(basename(path) + '.')) generations.push(name);
    }
    return { active, generations: generations.sort() };
  };
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zeus-audit-rotate-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('never lets the active file grow past the ceiling, and retires the oldest first', () => {
    const path = join(dir, 'audit.jsonl');
    const maxBytes = 400;
    const sink = jsonlAuditSink(path, { maxBytes, keep: 2 });
    for (let i = 0; i < 40; i += 1) sink(entry(`t${String(i).padStart(3, '0')}`));

    expect(sizes(path).active).toBeLessThanOrEqual(maxBytes);
    // keep=2 means at most .1 and .2 - a third generation would defeat the ceiling
    expect(sizes(path).generations).toEqual(['audit.jsonl.1', 'audit.jsonl.2']);
    // total on disk stays inside the documented bound: ceiling * (keep + 1)
    const total = sizes(path).generations.reduce(
      (sum, name) => sum + statSync(join(dir, name)).size, sizes(path).active);
    expect(total).toBeLessThanOrEqual(maxBytes * 3);

    // the newest records survived in the active file...
    const tail = readAuditLog(path);
    expect(tail[tail.length - 1].ts).toBe('t039');
    // ...the earliest ones left the active file...
    expect(tail.some(e => e.ts === 't000')).toBe(false);
    // ...and with keep=2 the oldest generation is gone entirely: the ceiling is
    // a real bound on disk, not just a rollover that keeps everything forever.
    const gen1 = readAuditLog(`${path}.1`);
    const gen2 = readAuditLog(`${path}.2`);
    expect(gen2[0].ts < gen1[0].ts).toBe(true);
    expect(gen1[gen1.length - 1].ts < tail[0].ts).toBe(true);
    const everything = [...gen2, ...gen1, ...tail].map(e => e.ts);
    expect(everything).not.toContain('t000');
    expect(everything).toContain('t039');
    // the first retained record is later than the very first written one
    expect(gen2[0].ts > 't000').toBe(true);
  });

  it('does not rotate when the ceiling is lifted', () => {
    const path = join(dir, 'audit.jsonl');
    const sink = jsonlAuditSink(path, { maxBytes: Number.POSITIVE_INFINITY, keep: 1 });
    for (let i = 0; i < 30; i += 1) sink(entry(`t${i}`));
    expect(existsSync(`${path}.1`)).toBe(false);
    expect(readAuditLog(path)).toHaveLength(30);
  });

  it('rejects a ceiling it could not honour', () => {
    const path = join(dir, 'audit.jsonl');
    expect(() => jsonlAuditSink(path, { maxBytes: 0 })).toThrow(/maxBytes must be >= 1/);
    expect(() => jsonlAuditSink(path, { keep: 0 })).toThrow(/keep must be a whole number/);
    expect(() => jsonlAuditSink(path, { keep: 1.5 })).toThrow(/keep must be a whole number/);
  });
});

describe('readAuditLog', () => {
  function write(path: string, text: string): void {
    writeFileSync(path, text);
  }

  it('reads back what the sink appended, oldest first', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zeus-audit-read-'));
    const path = join(dir, 'audit.jsonl');
    try {
      const sink = jsonlAuditSink(path);
      sink({ ts: 't1', vassal: 'loom', runId: 'run-1', decision: 'dispatched' });
      sink({ ts: 't2', vassal: 'atlas', runId: 'run-2', decision: 'dispatch-failed' });
      revokeAuditBridge(sink)('loom', 't3');

      expect(readAuditLog(path).map(e => e.decision))
        .toEqual(['dispatched', 'dispatch-failed', 'vassal-revoked']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('filters by run, vassal and decision, and a limit keeps the newest entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zeus-audit-filter-'));
    const path = join(dir, 'audit.jsonl');
    try {
      const sink = jsonlAuditSink(path);
      for (let i = 0; i < 5; i++) {
        sink({ ts: `t${i}`, vassal: i % 2 ? 'loom' : 'atlas', runId: `run-${i % 2}`, decision: 'dispatched' });
      }
      expect(readAuditLog(path, { runId: 'run-1' })).toHaveLength(2);
      expect(readAuditLog(path, { vassal: 'atlas' }).map(e => e.ts)).toEqual(['t0', 't2', 't4']);
      expect(readAuditLog(path, { decision: 'vassal-revoked' })).toEqual([]);
      expect(readAuditLog(path, { limit: 2 }).map(e => e.ts)).toEqual(['t3', 't4']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('drops the partial line where a bounded tail window starts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zeus-audit-tail-'));
    const path = join(dir, 'audit.jsonl');
    try {
      const line = (ts: string) => JSON.stringify({ ts, vassal: ts, decision: 'dispatched' });
      const lines = [line('old'), line('mid'), line('new')];
      const content = `${lines.join('\n')}\n`;
      writeFileSync(path, content);

      expect(readAuditLog(path).map(e => e.ts)).toEqual(['old', 'mid', 'new']);

      // Start the window 5 bytes into the second line: that line is truncated by
      // the read, so it is dropped rather than reported as corruption.
      const offset = Buffer.byteLength(lines[0]) + 1 + 5;
      const tail = readAuditLog(path, {}, { readBytes: Buffer.byteLength(content) - offset });
      expect(tail.map(e => e.ts)).toEqual(['new']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws instead of quietly skipping an unreadable or malformed record', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zeus-audit-bad-'));
    const path = join(dir, 'audit.jsonl');
    try {
      write(path, `${JSON.stringify({ ts: 'ok', vassal: 'a', decision: 'dispatched' })}\n{ not json }\n`);
      expect(() => readAuditLog(path)).toThrow(AuditLogError);

      write(path, `${JSON.stringify({ ts: 'ok', decision: 'dispatched' })}\n`);
      expect(() => readAuditLog(path)).toThrow(/missing ts\/vassal\/decision/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
