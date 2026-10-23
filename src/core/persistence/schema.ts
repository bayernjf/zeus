/**
 * Durable schema for zeus (T-M6-01; T-M7-01 execution columns).
 * Domain tables: decision_policy, decision_records, decision_approvals,
 * organizations, departments, positions, org_tasks.
 *
 * Migration model: SCHEMA_SQL is the current baseline (every statement is
 * CREATE ... IF NOT EXISTS, so a fresh database is created fully up to date).
 * INCREMENTAL_MIGRATIONS upgrade older databases: each migration is recorded
 * in schema_migrations only after its `up` succeeds, so a failed migration is
 * not marked applied (fail-closed) and re-runs on the next start.
 */
import type { DatabaseSync } from 'node:sqlite';

export const MIGRATION_ID = '0001_init_decision_org';
export const MIGRATION_0002_ORG_TASK_EXECUTION = '0002_org_task_execution';

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS decision_policy (
  version INTEGER PRIMARY KEY,
  default_grade TEXT NOT NULL,
  rules_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS decision_records (
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

CREATE INDEX IF NOT EXISTS idx_decision_records_domain ON decision_records(domain);
CREATE INDEX IF NOT EXISTS idx_decision_records_status ON decision_records(status);
CREATE INDEX IF NOT EXISTS idx_decision_records_idempotency ON decision_records(idempotency_key);

CREATE TABLE IF NOT EXISTS decision_approvals (
  seq INTEGER NOT NULL,
  decision_id TEXT NOT NULL,
  approver TEXT NOT NULL,
  verdict TEXT NOT NULL,
  comment TEXT,
  at TEXT NOT NULL,
  PRIMARY KEY (decision_id, seq),
  FOREIGN KEY (decision_id) REFERENCES decision_records(id)
);

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  scale_tier TEXT NOT NULL,
  parent_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS departments (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mission TEXT NOT NULL,
  parent_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id)
);

CREATE TABLE IF NOT EXISTS positions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  department_id TEXT NOT NULL,
  name TEXT NOT NULL,
  responsibilities_json TEXT NOT NULL,
  required_skills_json TEXT NOT NULL,
  allowed_tools_json TEXT NOT NULL,
  decision_scope TEXT NOT NULL,
  agent_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id),
  FOREIGN KEY (department_id) REFERENCES departments(id)
);

CREATE TABLE IF NOT EXISTS org_tasks (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  title TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  required_skill TEXT,
  position_id TEXT,
  assigned_agent_id TEXT,
  run_id TEXT,
  status TEXT NOT NULL,
  decision_id TEXT,
  result_json TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  failed_kind TEXT,
  progress_json TEXT,
  next_attempt_at TEXT,
  deadline_at TEXT,
  idempotency_key TEXT,
  unmatched_reason TEXT,
  transitions_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id)
);
`;

interface Migration {
  id: string;
  up: (db: DatabaseSync) => void;
}

function columnExists(db: DatabaseSync, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === column);
}

function addColumnIfMissing(db: DatabaseSync, table: string, column: string, ddl: string): void {
  if (!columnExists(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

/**
 * Incremental migrations applied after the baseline. Each runs at most once;
 * every statement is idempotent so re-running on a partially upgraded database
 * is safe.
 */
const INCREMENTAL_MIGRATIONS: Migration[] = [
  {
    id: MIGRATION_0002_ORG_TASK_EXECUTION,
    up: (db) => {
      addColumnIfMissing(db, 'org_tasks', 'attempts', 'INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'org_tasks', 'failed_kind', 'TEXT');
      addColumnIfMissing(db, 'org_tasks', 'progress_json', 'TEXT');
      addColumnIfMissing(db, 'org_tasks', 'next_attempt_at', 'TEXT');
      addColumnIfMissing(db, 'org_tasks', 'deadline_at', 'TEXT');
      addColumnIfMissing(db, 'org_tasks', 'idempotency_key', 'TEXT');
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_org_tasks_idempotency
        ON org_tasks(organization_id, idempotency_key);`);
    },
  },
];

function isRecorded(db: DatabaseSync, id: string): boolean {
  const row = db.prepare('SELECT id FROM schema_migrations WHERE id = ?').get(id) as
    | { id?: string }
    | undefined;
  return row?.id !== undefined;
}

function record(db: DatabaseSync, id: string, now: () => string): void {
  db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(id, now());
}

/**
 * Apply the schema and any pending incremental migrations. Returns true when
 * at least one migration was newly applied on this run. A migration is recorded
 * only after its `up` succeeds, so a failure leaves it unrecorded (fail-closed).
 */
export function migrate(db: DatabaseSync, now: () => string = () => new Date().toISOString()): boolean {
  db.exec(SCHEMA_SQL);
  let applied = false;
  if (!isRecorded(db, MIGRATION_ID)) {
    record(db, MIGRATION_ID, now);
    applied = true;
  }
  for (const migration of INCREMENTAL_MIGRATIONS) {
    if (isRecorded(db, migration.id)) continue;
    migration.up(db);
    record(db, migration.id, now);
    applied = true;
  }
  return applied;
}

export function appliedMigrations(db: DatabaseSync): string[] {
  const rows = db.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as {
    id: string;
  }[];
  return rows.map((r) => r.id);
}
