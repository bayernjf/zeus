import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openSqlite } from './sqlite-db.js';
import {
  migrate,
  appliedMigrations,
  MIGRATION_ID,
  MIGRATION_0002_ORG_TASK_EXECUTION,
  MIGRATION_0003_ORG_TASK_ACTIONS,
  MIGRATION_0004_POSITION_CREDENTIALS,
  MIGRATION_0005_DECISION_WEBHOOKS,
} from './schema.js';
import { SqlitePolicyStore, SqliteDecisionStore } from './sqlite-decision-store.js';
import { SqliteOrgStore } from './sqlite-org-store.js';
import { SqliteActionStore } from './sqlite-action-store.js';
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
    requiredSkills: ['listing'], allowedTools: ['loom'],
    credentialRefs: ['agent-world:service-token'], decisionScope: 'D1', createdAt: TS,
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
    expect(appliedMigrations(db)).toEqual([
      MIGRATION_ID,
      MIGRATION_0002_ORG_TASK_EXECUTION,
      MIGRATION_0003_ORG_TASK_ACTIONS,
      MIGRATION_0004_POSITION_CREDENTIALS,
      MIGRATION_0005_DECISION_WEBHOOKS,
    ]);
    expect(migrate(db)).toBe(false);
    expect(appliedMigrations(db)).toEqual([
      MIGRATION_ID,
      MIGRATION_0002_ORG_TASK_EXECUTION,
      MIGRATION_0003_ORG_TASK_ACTIONS,
      MIGRATION_0004_POSITION_CREDENTIALS,
      MIGRATION_0005_DECISION_WEBHOOKS,
    ]);
    db.close();
  });

  it('upgrades a 0001 database in place with the execution columns (0002)', async () => {
    const file = await freshFile();
    const db = openSqlite(file);
    // Build the legacy 0001 schema directly: org_tasks without execution columns.
    db.exec(`
      CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE organizations (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, scale_tier TEXT NOT NULL,
        parent_id TEXT, created_at TEXT NOT NULL);
      CREATE TABLE org_tasks (
        id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, title TEXT NOT NULL,
        payload_json TEXT NOT NULL, required_skill TEXT, position_id TEXT,
        assigned_agent_id TEXT, run_id TEXT, status TEXT NOT NULL, decision_id TEXT,
        result_json TEXT, error TEXT, unmatched_reason TEXT,
        transitions_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      INSERT INTO schema_migrations (id, applied_at) VALUES ('${MIGRATION_ID}', '${TS}');
      INSERT INTO organizations (id, name, scale_tier, created_at)
        VALUES ('org-1', '自营', 'single', '${TS}');
      INSERT INTO org_tasks (
        id, organization_id, title, payload_json, status, transitions_json,
        created_at, updated_at)
      VALUES ('task-legacy', 'org-1', '老任务', '{}', 'pending',
        '[{"status":"pending","at":"${TS}"}]', '${TS}', '${TS}');
    `);
    // Migration 0002 is the only pending migration; it adds the columns.
    expect(migrate(db)).toBe(true);
    expect(appliedMigrations(db)).toContain(MIGRATION_0002_ORG_TASK_EXECUTION);
    const cols = (db.prepare('PRAGMA table_info(org_tasks)').all() as { name: string }[])
      .map((c) => c.name);
    for (const col of ['attempts', 'failed_kind', 'progress_json', 'next_attempt_at', 'deadline_at', 'idempotency_key']) {
      expect(cols).toContain(col);
    }
    // The pre-existing row survives and reads with the new defaults.
    const store = new SqliteOrgStore(db);
    const legacy = store.getTask('task-legacy');
    expect(legacy?.status).toBe('pending');
    expect(legacy?.attempts).toBeUndefined();
    db.close();
  });

  it('persists and reloads execution fields (attempts, failureKind, progress, idempotencyKey)', async () => {
    const file = await freshFile();
    const db = openSqlite(file);
    migrate(db);
    new SqliteOrgStore(db).putOrganization(sampleOrg());
    const store = new SqliteOrgStore(db);
    const task: OrgTask = {
      ...sampleTask(),
      id: 'task-exec',
      attempts: 3,
      failedKind: 'retryable_exhausted',
      progress: [{ stage: 'refund-check', percent: 50, at: TS }],
      idempotencyKey: 'idem-task-1',
      nextAttemptAt: TS,
      deadlineAt: '2026-10-23T01:00:00.000Z',
    };
    store.putTask(task);
    const reloaded = store.getTask('task-exec');
    expect(reloaded?.attempts).toBe(3);
    expect(reloaded?.failedKind).toBe('retryable_exhausted');
    expect(reloaded?.progress).toEqual(task.progress);
    expect(reloaded?.idempotencyKey).toBe('idem-task-1');
    expect(reloaded?.nextAttemptAt).toBe(TS);
    expect(reloaded?.deadlineAt).toBe('2026-10-23T01:00:00.000Z');
    // Idempotent lookup by organization + key.
    expect(store.getTaskByIdempotencyKey('org-1', 'idem-task-1')?.id).toBe('task-exec');
    expect(store.getTaskByIdempotencyKey('org-1', 'missing')).toBeUndefined();
    // The unique index rejects a second task with the same org + key.
    expect(() =>
      store.putTask({ ...task, id: 'task-dup' }),
    ).toThrow();
    db.close();
  });

  it('durable action store replays committed effects after a restart', async () => {
    const file = await freshFile();
    let db = openSqlite(file);
    migrate(db);
    new SqliteOrgStore(db).putOrganization(sampleOrg());
    new SqliteOrgStore(db).putTask(sampleTask());
    const before = new SqliteActionStore(db, 'task-1');
    expect(before.get('refund-1').ok).toBe(false);
    before.put('refund-1', { refunded: true, orderId: 'ord-1' });
    db.close();

    // Reopen as a new process and rebuild the per-task store from the table.
    db = openSqlite(file);
    migrate(db);
    const after = new SqliteActionStore(db, 'task-1');
    const hit = after.get('refund-1');
    expect(hit.ok).toBe(true);
    if (hit.ok) expect(hit.value).toEqual({ refunded: true, orderId: 'ord-1' });
    // Other tasks/keys are isolated.
    expect(new SqliteActionStore(db, 'task-other').get('refund-1').ok).toBe(false);
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
    expect(org2.getPosition('pos-1')?.credentialRefs).toEqual(['agent-world:service-token']);
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
