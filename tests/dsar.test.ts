import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/dsar.mjs', import.meta.url));
const nodeRequire = createRequire(import.meta.url);
const sqlite = nodeRequire('node:sqlite') as typeof import('node:sqlite');

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

const SCHEMA = `
CREATE TABLE decision_records (
  id TEXT PRIMARY KEY,
  intent TEXT NOT NULL,
  domain TEXT NOT NULL,
  amount_json TEXT,
  risk_tags_json TEXT,
  impact TEXT NOT NULL,
  reversibility TEXT NOT NULL,
  proposal_json TEXT,
  idempotency_key TEXT,
  grade TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  grade_reason TEXT NOT NULL,
  policy_version INTEGER NOT NULL,
  sla_hours INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  audit_seq INTEGER NOT NULL,
  decided_at TEXT,
  timeout_at TEXT,
  result_json TEXT
);
CREATE TABLE decision_approvals (
  seq INTEGER NOT NULL,
  decision_id TEXT NOT NULL,
  approver TEXT NOT NULL,
  verdict TEXT NOT NULL,
  comment TEXT,
  at TEXT NOT NULL,
  PRIMARY KEY (decision_id, seq),
  FOREIGN KEY (decision_id) REFERENCES decision_records(id)
);
`;

function makeDb(): string {
  const root = mkdtempSync(join(tmpdir(), 'zeus-dsar-'));
  tempDir = root;
  const dbFile = join(root, 'zeus.db');
  const db = new sqlite.DatabaseSync(dbFile);
  db.exec(SCHEMA);
  db.prepare(
    `INSERT INTO decision_records
       (id, intent, domain, impact, reversibility, grade, mode, status, rule_id,
        grade_reason, policy_version, created_at, updated_at, audit_seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('dec-1', 'buy a laptop', 'procurement', 'low', 'reversible', 'L2', 'auto', 'decided', 'r1', 'ok', 1, '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z', 1);
  db.prepare(
    `INSERT INTO decision_approvals (seq, decision_id, approver, verdict, comment, at)
     VALUES (1, 'dec-1', 'alice', 'approved', 'looks fine', '2026-11-01T00:00:01Z')`,
  ).run();
  db.prepare(
    `INSERT INTO decision_approvals (seq, decision_id, approver, verdict, comment, at)
     VALUES (2, 'dec-1', 'bob', 'approved', NULL, '2026-11-01T00:00:02Z')`,
  ).run();
  db.close();
  return dbFile;
}

function run(args: string[]): { stdout: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: `${e.stdout ?? ''}${e.stderr ?? ''}`, status: e.status ?? 1 };
  }
}

function erasedToken(subject: string): string {
  return `erased:${createHash('sha256').update(subject, 'utf8').digest('hex')}`;
}

describe('dsar export', () => {
  it('exports one subject approval and the referenced decision', () => {
    const dbFile = makeDb();
    const outFile = join(tempDir!, 'export.json');
    const { status, stdout } = run(['export', '--subject', 'alice', '--db', dbFile, '--out', outFile]);
    expect(status).toBe(0);
    expect(stdout).toContain('exported 1 approval(s) and 1 decision(s) for "alice"');
    const payload = JSON.parse(readFileSync(outFile, 'utf8')) as {
      subject: string;
      approvals: Array<{ approver: string }>;
      decisions: Array<{ id: string }>;
    };
    expect(payload.subject).toBe('alice');
    expect(payload.approvals).toHaveLength(1);
    expect(payload.approvals[0]?.approver).toBe('alice');
    expect(payload.decisions).toHaveLength(1);
    expect(payload.decisions[0]?.id).toBe('dec-1');
  });

  it('reports zero rows for an unknown subject', () => {
    const dbFile = makeDb();
    const { status, stdout } = run(['export', '--subject', 'nobody', '--db', dbFile]);
    expect(status).toBe(0);
    expect(stdout).toContain('exported 0 approval(s) and 0 decision(s) for "nobody"');
  });
});

describe('dsar delete', () => {
  it('dry-runs without writing by default', () => {
    const dbFile = makeDb();
    const { status, stdout } = run(['delete', '--subject', 'alice', '--db', dbFile]);
    expect(status).toBe(0);
    expect(stdout).toContain('[dry-run]');
    expect(stdout).toContain('1 row(s)');

    const db = new sqlite.DatabaseSync(dbFile, { readOnly: true });
    const row = db.prepare('SELECT approver, comment FROM decision_approvals WHERE decision_id = ? AND seq = 1').get('dec-1');
    db.close();
    expect(row?.approver).toBe('alice');
    expect(row?.comment).toBe('looks fine');
  });

  it('erases approver to a hash and nulls comment with --commit', () => {
    const dbFile = makeDb();
    const { status, stdout } = run(['delete', '--subject', 'alice', '--db', dbFile, '--commit']);
    expect(status).toBe(0);
    expect(stdout).toContain(`-> ${erasedToken('alice')}`);

    const db = new sqlite.DatabaseSync(dbFile, { readOnly: true });
    const row = db.prepare('SELECT approver, comment FROM decision_approvals WHERE decision_id = ? AND seq = 1').get('dec-1');
    const other = db.prepare('SELECT approver FROM decision_approvals WHERE decision_id = ? AND seq = 2').get('dec-1');
    db.close();
    expect(row?.approver).toBe(erasedToken('alice'));
    expect(row?.comment).toBeNull();
    expect(other?.approver).toBe('bob');
  });

  it('leaves the erased token identical for the same subject', () => {
    expect(erasedToken('alice')).toBe(erasedToken('alice'));
    expect(erasedToken('alice')).not.toBe(erasedToken('bob'));
  });
});

describe('dsar fail-closed', () => {
  it('reports a missing database instead of pretending success', () => {
    const root = mkdtempSync(join(tmpdir(), 'zeus-dsar-missing-'));
    tempDir = root;
    const { status, stdout } = run(['export', '--subject', 'alice', '--db', join(root, 'nope.db')]);
    expect(status).toBe(1);
    expect(stdout).toContain('database does not exist');
  });
});
