import { describe, it, expect, afterEach } from 'vitest';
import {
  statSync,
  writeFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupSnapshot, pruneSnapshots } from '../scripts/backup.mjs';
import { restoreSnapshot } from '../scripts/restore.mjs';
import { checkMode0600 } from '../scripts/check-file-perms.mjs';
import { openSqlite } from '../src/core/persistence/sqlite-db.js';
import { migrate } from '../src/core/persistence/schema.js';
import { SqliteDecisionStore } from '../src/core/persistence/sqlite-decision-store.js';
import { SqliteOrgStore } from '../src/core/persistence/sqlite-org-store.js';
import type { DecisionRecord } from '../src/core/decision-service/types.js';
import type { Organization } from '../src/core/org/types.js';

const TS = '2026-10-23T00:00:00.000Z';

let tempDir: string | undefined;
async function freshLayout(): Promise<{
  root: string;
  dbFile: string;
  backups: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'zeus-backup-'));
  tempDir = root;
  const dataDir = join(root, 'data');
  return {
    root,
    dbFile: join(dataDir, 'zeus.db'),
    backups: join(root, 'backups'),
  };
}

async function seed(dbFile: string): Promise<void> {
  const db = openSqlite(dbFile);
  migrate(db);
  const record: DecisionRecord = {
    id: 'dec-1', intent: 'refund', domain: 'commerce',
    amount: { value: 1299, currency: 'CNY' }, riskTags: ['refund'],
    impact: 'external', reversibility: 'hard', proposal: { x: 1 },
    idempotencyKey: 'idem-1', grade: 'D2', mode: 'approve-sync',
    status: 'awaiting_approval', ruleId: 'rule-refund', gradeReason: 'r',
    policyVersion: 1, slaHours: 24, createdAt: TS, updatedAt: TS, auditSeq: 3,
    timeoutAt: '2026-10-24T00:00:00.000Z',
    approvals: [{ approver: 'owner', verdict: 'approve', at: TS }],
  };
  await new SqliteDecisionStore(db).put(record);
  const org: Organization = {
    format: 'zeus-organization', version: 1, id: 'org-1',
    name: '自营', scaleTier: 'single', createdAt: TS,
  };
  new SqliteOrgStore(db).putOrganization(org);
  db.close();
}

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe('backup and restore (T-M6-02)', () => {
  it('backs up, then restores the full durable state', async () => {
    const layout = await freshLayout();
    await seed(layout.dbFile);

    const backup = backupSnapshot({
      dbFile: layout.dbFile,
      backupDir: layout.backups,
      now: new Date('2026-10-23T01:00:00Z'),
    });

    // Artifact exists and is owner-only (0600).
    const backedDb = join(backup.dir, 'zeus.db');
    expect(existsSync(backedDb)).toBe(true);
    expect(checkMode0600(backedDb).ok).toBe(true);

    // Simulate loss of the live db.
    await rm(layout.dbFile, { force: true });
    expect(existsSync(layout.dbFile)).toBe(false);

    // Restore and verify data.
    restoreSnapshot({
      snapshotDir: backup.dir,
      targetDb: layout.dbFile,
      force: true,
    });
    const db = openSqlite(layout.dbFile);
    const record = await new SqliteDecisionStore(db).get('dec-1');
    expect(record?.status).toBe('awaiting_approval');
    expect(record?.auditSeq).toBe(3);
    expect(record?.approvals).toHaveLength(1);
    expect(new SqliteOrgStore(db).getOrganization('org-1')?.name).toBe('自营');
    db.close();
    expect(checkMode0600(layout.dbFile).ok).toBe(true);
  });

  it('fail-closed: restore refuses when the backup db is missing', async () => {
    const layout = await freshLayout();
    const emptySnapshot = join(layout.backups, 'snapshot-empty');
    expect(() =>
      restoreSnapshot({ snapshotDir: emptySnapshot, targetDb: layout.dbFile }),
    ).toThrow(/backup db missing/);
  });

  it('fail-closed: restore refuses when the backup db is corrupt', async () => {
    const layout = await freshLayout();
    const snapshotDir = join(layout.backups, 'snapshot-bad');
    await rm(snapshotDir, { recursive: true, force: true });
    mkdirSync(snapshotDir, { recursive: true });
    writeFileSync(join(snapshotDir, 'zeus.db'), 'not a sqlite database');
    chmodSync(join(snapshotDir, 'zeus.db'), 0o600);
    expect(() =>
      restoreSnapshot({ snapshotDir, targetDb: layout.dbFile, force: true }),
    ).toThrow();
    expect(existsSync(layout.dbFile)).toBe(false);
  });

  it('prunes snapshots beyond the retention count', async () => {
    const layout = await freshLayout();
    await seed(layout.dbFile);
    for (let i = 0; i < 4; i += 1) {
      backupSnapshot({
        dbFile: layout.dbFile,
        backupDir: layout.backups,
        now: new Date(Date.UTC(2026, 9, 23, 1, i, 0)),
      });
    }
    const removed = pruneSnapshots(layout.backups, 2);
    expect(removed).toHaveLength(2);
    expect(readdirSync(layout.backups).filter((d) => d.startsWith('snapshot-'))).toHaveLength(2);
  });
});

void statSync;
