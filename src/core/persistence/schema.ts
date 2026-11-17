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
export const MIGRATION_0003_ORG_TASK_ACTIONS = '0003_org_task_actions';
export const MIGRATION_0004_POSITION_CREDENTIALS = '0004_position_credentials';
export const MIGRATION_0005_DECISION_WEBHOOKS = '0005_decision_webhooks';
export const MIGRATION_0006_ORG_FIELD_GAPS = '0006_org_field_gaps';
export const MIGRATION_0007_ORG_EXPERIENCE = '0007_org_experience';
export const MIGRATION_0008_ORG_GOALS = '0008_org_goals';
export const MIGRATION_0009_ORG_GOAL_SCHEDULES = '0009_org_goal_schedules';
export const MIGRATION_0010_ORG_GOAL_TEMPLATES = '0010_org_goal_templates';

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
  concurrency_limit INTEGER,
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
  credential_refs_json TEXT NOT NULL DEFAULT '[]',
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
  workspace_path TEXT,
  outcome_json TEXT,
  transitions_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id)
);

CREATE TABLE IF NOT EXISTS org_task_actions (
  task_id TEXT NOT NULL,
  action_key TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, action_key),
  FOREIGN KEY (task_id) REFERENCES org_tasks(id)
);

CREATE TABLE IF NOT EXISTS decision_webhooks (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  -- HMAC signing key, stored like the rest of the local secrets: plaintext on
  -- the operator's own disk (the DB file and its WAL/SHM sidecars are
  -- tightened to 0600 on every open), never shipped back
  -- over HTTP and never logged. At-rest encryption would need a key-management
  -- story this local-first deployment does not have yet.
  secret TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  -- Rows seeded from ZEUS_DECISION_WEBHOOK_URL/_SECRET are re-upserted on every
  -- boot that still declares them; rows an operator created over the API are
  -- never touched by boot.
  seeded_from_env INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
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
  {
    id: MIGRATION_0003_ORG_TASK_ACTIONS,
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS org_task_actions (
        task_id TEXT NOT NULL,
        action_key TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (task_id, action_key),
        FOREIGN KEY (task_id) REFERENCES org_tasks(id)
      );`);
    },
  },
  {
    id: MIGRATION_0004_POSITION_CREDENTIALS,
    up: (db) => {
      addColumnIfMissing(
        db,
        'positions',
        'credential_refs_json',
        `TEXT NOT NULL DEFAULT '[]'`,
      );
    },
  },
  {
    id: MIGRATION_0005_DECISION_WEBHOOKS,
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS decision_webhooks (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        secret TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        seeded_from_env INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );`);
    },
  },
  {
    // F1.1/F1.2/F4.1 additions that were missing from the durable store: an
    // org's concurrencyLimit and a task's per-task workspace + outcome. Without
    // these columns SQLite silently dropped them and every worker fell back to
    // the default limit of 2.
    id: MIGRATION_0006_ORG_FIELD_GAPS,
    up: (db) => {
      addColumnIfMissing(db, 'organizations', 'concurrency_limit', 'INTEGER');
      addColumnIfMissing(db, 'org_tasks', 'workspace_path', 'TEXT');
      addColumnIfMissing(db, 'org_tasks', 'outcome_json', 'TEXT');
    },
  },
  {
    // F4.2: rule-derived SOP experience candidates. Inert until a human
    // promotes one; the unique key keeps a replayed settlement from
    // duplicating candidates for the same rule.
    id: MIGRATION_0007_ORG_EXPERIENCE,
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS sop_experience_candidates (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        skill_id TEXT,
        rule_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        promoted_at TEXT,
        UNIQUE (task_id, rule_id)
      );`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_sop_candidates_org
        ON sop_experience_candidates(organization_id, status);`);
    },
  },
  {
    // F5.1: goal registration. Deliberately flat: id/org/title/period/status
    // plus an optional project binding — no OKR hierarchy.
    id: MIGRATION_0008_ORG_GOALS,
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS org_goals (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        title TEXT NOT NULL,
        period TEXT NOT NULL,
        status TEXT NOT NULL,
        project_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_org_goals_org
        ON org_goals(organization_id, status);`);
    },
  },
  {
    // F5.2: attach the UTC trigger and a one-task template to a goal.
    id: MIGRATION_0009_ORG_GOAL_SCHEDULES,
    up: (db) => {
      db.exec('ALTER TABLE org_goals ADD COLUMN schedule_json TEXT;');
      db.exec('ALTER TABLE org_goals ADD COLUMN task_template_json TEXT;');
    },
  },
  {
    // F5.3: a goal may reference a built-in template, and a task may declare
    // dependencies on earlier tasks. `addColumnIfMissing` keeps a retried
    // migration idempotent if one ALTER succeeded before another failed.
    id: MIGRATION_0010_ORG_GOAL_TEMPLATES,
    up: (db) => {
      addColumnIfMissing(db, 'org_goals', 'template_ref', 'TEXT');
      addColumnIfMissing(db, 'org_tasks', 'depends_on_json', 'TEXT');
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
