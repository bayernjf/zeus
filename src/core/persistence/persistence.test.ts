import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openSqlite } from './sqlite-db.js';
import { migrate, appliedMigrations, MIGRATION_ID } from './schema.js';
import { SqlitePolicyStore, SqliteDecisionStore } from './sqlite-decision-store.js';
import { SqliteOrgStore } from './sqlite-org-store.js';
import type { DecisionRecord } from '../decision-service/types.js';
import type {
  Organization,
  Department,
  Position,
  OrgTask,
} from '../org/types.js';
import { DEFAULT_POLICY_V1 } from '../grading/default-policy.js';

const TS = '2026-10-23T00:00:00.000Z';

let tempDir: string | undefined;
async function freshFile(): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), 'zeus-persist-'));
  return join(tempDir, 'zeus.db');
}

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function sampleRecord(): DecisionRecord {
  return {
    id: 'dec-1',
    intent: 'refund',
    domain: 'commerce',
    amount: { value: 1299, currency: 'CNY' },
    riskTags: ['refund', 'external'],
    impact: 'external',
    reversibility: 'hard',
    proposal: { sku: 'sku-1', qty: 1 },
    idempotencyKey: 'idem-1',
    grade: 'D2',
    mode: 'approve-sync',
    status: 'awaiting_approval',
    ruleId: 'rule-refund',
    gradeReason: 'refund over threshold',
    policyVersion: 1,
    slaHours: 24,
    createdAt: TS,
    updatedAt: TS,
    auditSeq: 3,
    timeoutAt: '2026-10-24T00:00:00.000Z',
    approvals: [
      { approver: 'owner', verdict: 'approve', comment: 'ok', at: '2026-10-23T01:00:00.000Z' },
    ],
  };
}

function sampleOrg(): Organization {
  return { format: 'zeus-organization', version: 1, id: 'org-1', name: '自营', scaleTier: 'single', createdAt: TS };
}
function sampleDept(): Department {
  return { format: 'zeus-department-v1', version: 1, id: 'dept-1', organizationId: 'org-1', name: '电商部', mission: '电商经营', createdAt: TS };
}
function samplePosition(): Position {
  return {
    format: 'zeus-position', version: 1, id: 'pos-1', organizationId: 'org-1',
    departmentId: 'dept-1', name: '运营岗', responsibilities: ['上架'],
    requiredSkills: ['listing'], allowedTools: ['loom'], decisionScope: 'D1', createdAt: TS,
  };
}
function sampleTask(): OrgTask {
  return {
    format: 'zeus-org-task', version: 1, id: 'task-1', organizationId: 'org-1',
    title: '上架商品', payload: { sku: 'sku-1' }, requiredSkill: 'listing',
    positionId: 'pos-1', status: 'pending',
    transitions: [{ status: 'pending', at: TS }], createdAt: TS, updatedAt: TS,
  };
}

describe('zeus SQLite persistence (T-M6-01)', () => {
  it('migrates idempotently and records the migration', async () => {
    const file = await freshFile();
    const db = openSqlite(file);
    expect(migrate(db)).toBe(true);
    expect(appliedMigrations(db)).toEqual([MIGRATION_ID]);
    expect(migrate(db)).toBe(false);
    expect(appliedMigrations(db)).toEqual([MIGRATION_ID]);
    db.close();
  });

  it('persists and reloads a decision record with approvals (idempotency lookup)', async () => {
    const file = await freshFile();
    const db = openSqlite(file);
    migrate(db);
    new SqlitePolicyStore(db).put(DEFAULT_POLICY_V1);
    const store = new SqliteDecisionStore(db);
    await store.put(sampleRecord());

    expect(await store.get('dec-1')).toEqual(sampleRecord());
    expect((await store.findByIdempotencyKey('idem-1'))?.id).toBe('dec-1');
    const list = await store.list({ domain: 'commerce', status: 'awaiting_approval' });
    expect(list).toHaveLength(1);
    expect(new SqlitePolicyStore(db).get(1).version).toBe(1);
    db.close();
  });

  it('survives a process restart (close + reopen same file)', async () => {
    const file = await freshFile();

    let db: DatabaseSync = openSqlite(file);
    migrate(db);
    await new SqliteDecisionStore(db).put(sampleRecord());
    const org = new SqliteOrgStore(db);
    org.putOrganization(sampleOrg());
    org.putDepartment(sampleDept());
    org.putPosition(samplePosition());
    org.putTask(sampleTask());
    db.close();

    db = openSqlite(file);
    expect(migrate(db)).toBe(false);
    const record = await new SqliteDecisionStore(db).get('dec-1');
    expect(record?.status).toBe('awaiting_approval');
    expect(record?.auditSeq).toBe(3);
    expect(record?.approvals).toHaveLength(1);
    const org2 = new SqliteOrgStore(db);
    expect(org2.getOrganization('org-1')?.name).toBe('自营');
    expect(org2.getDepartment('dept-1')?.mission).toBe('电商经营');
    expect(org2.getPosition('pos-1')?.decisionScope).toBe('D1');
    const task = org2.getTask('task-1');
    expect(task?.status).toBe('pending');
    expect(task?.transitions).toHaveLength(1);
    db.close();
  });

  it('fail-closed: policy get on empty store throws', async () => {
    const file = await freshFile();
    const db = openSqlite(file);
    migrate(db);
    expect(() => new SqlitePolicyStore(db).get()).toThrow();
    db.close();
  });

  it('fail-closed (T-M6-05): a corrupt db file is rejected and left intact', async () => {
    const file = await freshFile();
    writeFileSync(file, 'not-a-database-file'.repeat(30));
    expect(() => openSqlite(file)).toThrow();
    // The corrupt file must not be silently replaced by an empty database.
    expect(readFileSync(file, 'utf8').startsWith('not-a-database-file')).toBe(true);
  });

  it('fail-closed (T-M6-05): a failed migration is not recorded as applied', async () => {
    const file = await freshFile();
    const db = openSqlite(file);
    // A view occupying the schema_migrations name makes CREATE TABLE fail.
    db.exec('CREATE VIEW schema_migrations AS SELECT 1 AS id;');
    expect(() => migrate(db)).toThrow();
    expect(appliedMigrations(db)).not.toContain(MIGRATION_ID);
    db.close();
  });
});
