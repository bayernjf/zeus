/**
 * Durable schema for zeus (T-M6-01). Seven domain tables:
 * decision_policy, decision_records, decision_approvals, organizations,
 * departments, positions, org_tasks. Migration is idempotent
 * (CREATE TABLE IF NOT EXISTS + schema_migrations bookkeeping).
 */
import type { DatabaseSync } from 'node:sqlite';

export const MIGRATION_ID = '0001_init_decision_org';

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
  unmatched_reason TEXT,
  transitions_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id)
);
`;

/** Apply the schema once; re-running is a no-op (idempotent). */
export function migrate(db: DatabaseSync, now: () => string = () => new Date().toISOString()): boolean {
  db.exec(SCHEMA_SQL);
  const row = db
    .prepare('SELECT id FROM schema_migrations WHERE id = ?')
    .get(MIGRATION_ID) as { id?: string } | undefined;
  if (row?.id) return false;
  db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(
    MIGRATION_ID,
    now(),
  );
  return true;
}

export function appliedMigrations(db: DatabaseSync): string[] {
  const rows = db.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as {
    id: string;
  }[];
  return rows.map((r) => r.id);
}
