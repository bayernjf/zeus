import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { jsonlAuditSink, memoryAuditSink, revokeAuditBridge } from '../src/dispatch/audit.js';

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
