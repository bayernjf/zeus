/**
 * Durable decision policy + record store (T-M6-01). Implements the same
 * PolicyStore and DecisionRecordStore ports as the in-memory implementations,
 * so the memory stores stay available as the test/demo mode.
 */
import type { DatabaseSync } from 'node:sqlite';
import type {
  DecisionPolicy,
  PolicyRule,
} from '../grading/policy.js';
import type { PolicyStore } from '../grading/policy-loader.js';
import type {
  DecisionApprovalRecord,
  DecisionRecord,
  DecisionListFilter,
} from '../decision-service/types.js';
import type { DecisionRecordStore } from '../decision-service/store.js';

const parse = <T>(json: string | null | undefined): T | undefined =>
  json === null || json === undefined ? undefined : (JSON.parse(json) as T);

const opt = <T>(value: T | undefined): T | null => value ?? null;

/** Durable PolicyStore (append-only; versions are immutable). */
export class SqlitePolicyStore implements PolicyStore {
  constructor(private readonly db: DatabaseSync) {}

  put(policy: DecisionPolicy): DecisionPolicy {
    if (this.has(policy.version)) {
      throw new Error(
        `policy version ${policy.version} already exists; bump the version`,
      );
    }
    this.db
      .prepare(
        'INSERT INTO decision_policy (version, default_grade, rules_json, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(
        policy.version,
        policy.defaultGrade,
        JSON.stringify(policy.rules),
        new Date().toISOString(),
      );
    return policy;
  }

  get(version?: number): DecisionPolicy {
    const row = (version === undefined
      ? this.db.prepare('SELECT * FROM decision_policy ORDER BY version DESC LIMIT 1').get()
      : this.db.prepare('SELECT * FROM decision_policy WHERE version = ?').get(version)) as
      | {
          version: number;
          default_grade: DecisionPolicy['defaultGrade'];
          rules_json: string;
        }
      | undefined;
    if (!row) throw new Error(`no decision policy${version === undefined ? '' : ` v${version}`}`);
    return {
      version: row.version,
      defaultGrade: row.default_grade,
      rules: parse<PolicyRule[]>(row.rules_json) ?? [],
    };
  }

  has(version: number): boolean {
    const row = this.db.prepare('SELECT 1 FROM decision_policy WHERE version = ?').get(version);
    return row !== undefined;
  }

  versions(): number[] {
    const rows = this.db.prepare('SELECT version FROM decision_policy').all() as {
      version: number;
    }[];
    return rows.map((r) => r.version).sort((a, b) => a - b);
  }
}

function rowToRecord(
  row: Record<string, unknown>,
  approvals: DecisionApprovalRecord[],
): DecisionRecord {
  const amount = parse<DecisionRecord['amount']>(row.amount_json as string);
  const riskTags = parse<string[]>(row.risk_tags_json as string);
  const proposal = parse<NonNullable<DecisionRecord['proposal']>>(
    row.proposal_json as string,
  );
  const result = parse<NonNullable<DecisionRecord['result']>>(
    row.result_json as string,
  );
  return {
    id: String(row.id),
    intent: String(row.intent),
    domain: String(row.domain),
    ...(amount ? { amount } : {}),
    ...(riskTags ? { riskTags } : {}),
    impact: row.impact as DecisionRecord['impact'],
    reversibility: row.reversibility as DecisionRecord['reversibility'],
    ...(proposal ? { proposal } : {}),
    ...(row.idempotency_key ? { idempotencyKey: String(row.idempotency_key) } : {}),
    grade: row.grade as DecisionRecord['grade'],
    mode: row.mode as DecisionRecord['mode'],
    status: row.status as DecisionRecord['status'],
    ruleId: String(row.rule_id),
    gradeReason: String(row.grade_reason),
    policyVersion: Number(row.policy_version),
    ...(row.sla_hours !== null && row.sla_hours !== undefined
      ? { slaHours: Number(row.sla_hours) }
      : {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    auditSeq: Number(row.audit_seq),
    ...(row.decided_at ? { decidedAt: String(row.decided_at) } : {}),
    ...(row.timeout_at ? { timeoutAt: String(row.timeout_at) } : {}),
    ...(result ? { result } : {}),
    approvals,
  };
}

function readApprovals(db: DatabaseSync, decisionId: string): DecisionApprovalRecord[] {
  const rows = db
    .prepare(
      'SELECT approver, verdict, comment, at FROM decision_approvals WHERE decision_id = ? ORDER BY seq',
    )
    .all(decisionId) as {
    approver: string;
    verdict: DecisionApprovalRecord['verdict'];
    comment: string | null;
    at: string;
  }[];
  return rows.map((r) => ({
    approver: r.approver,
    verdict: r.verdict,
    ...(r.comment ? { comment: r.comment } : {}),
    at: r.at,
  }));
}

/** Durable DecisionRecordStore. */
export class SqliteDecisionStore implements DecisionRecordStore {
  constructor(private readonly db: DatabaseSync) {}

  async put(record: DecisionRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO decision_records (
          id, intent, domain, amount_json, risk_tags_json, impact, reversibility,
          proposal_json, idempotency_key, grade, mode, status, rule_id, grade_reason,
          policy_version, sla_hours, created_at, updated_at, audit_seq, decided_at,
          timeout_at, result_json
        ) VALUES (
          @id, @intent, @domain, @amount_json, @risk_tags_json, @impact, @reversibility,
          @proposal_json, @idempotency_key, @grade, @mode, @status, @rule_id, @grade_reason,
          @policy_version, @sla_hours, @created_at, @updated_at, @audit_seq, @decided_at,
          @timeout_at, @result_json
        )
        ON CONFLICT(id) DO UPDATE SET
          amount_json=@amount_json, risk_tags_json=@risk_tags_json, proposal_json=@proposal_json,
          idempotency_key=@idempotency_key, grade=@grade, mode=@mode, status=@status,
          grade_reason=@grade_reason, policy_version=@policy_version, sla_hours=@sla_hours,
          updated_at=@updated_at, audit_seq=@audit_seq, decided_at=@decided_at,
          timeout_at=@timeout_at, result_json=@result_json`,
      )
      .run({
        id: record.id,
        intent: record.intent,
        domain: record.domain,
        amount_json: opt(record.amount ? JSON.stringify(record.amount) : undefined),
        risk_tags_json: opt(record.riskTags ? JSON.stringify(record.riskTags) : undefined),
        impact: record.impact,
        reversibility: record.reversibility,
        proposal_json: opt(record.proposal ? JSON.stringify(record.proposal) : undefined),
        idempotency_key: opt(record.idempotencyKey),
        grade: record.grade,
        mode: record.mode,
        status: record.status,
        rule_id: record.ruleId,
        grade_reason: record.gradeReason,
        policy_version: record.policyVersion,
        sla_hours: opt(record.slaHours),
        created_at: record.createdAt,
        updated_at: record.updatedAt,
        audit_seq: record.auditSeq,
        decided_at: opt(record.decidedAt),
        timeout_at: opt(record.timeoutAt),
        result_json: opt(record.result ? JSON.stringify(record.result) : undefined),
      });

    // Replace approvals (append-only within the service; re-write on upsert).
    this.db.prepare('DELETE FROM decision_approvals WHERE decision_id = ?').run(record.id);
    record.approvals.forEach((approval, seq) => {
      this.db
        .prepare(
          'INSERT INTO decision_approvals (seq, decision_id, approver, verdict, comment, at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(seq, record.id, approval.approver, approval.verdict, opt(approval.comment), approval.at);
    });
  }

  async get(id: string): Promise<DecisionRecord | undefined> {
    const row = this.db.prepare('SELECT * FROM decision_records WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToRecord(row, readApprovals(this.db, id)) : undefined;
  }

  async findByIdempotencyKey(key: string): Promise<DecisionRecord | undefined> {
    const row = this.db
      .prepare('SELECT * FROM decision_records WHERE idempotency_key = ?')
      .get(key) as Record<string, unknown> | undefined;
    return row ? rowToRecord(row, readApprovals(this.db, String(row.id))) : undefined;
  }

  async list(filter: DecisionListFilter = {}): Promise<DecisionRecord[]> {
    let rows = this.db.prepare('SELECT * FROM decision_records').all() as Record<string, unknown>[];
    rows = rows
      .filter((r) => filter.domain === undefined || r.domain === filter.domain)
      .filter((r) => filter.status === undefined || r.status === filter.status)
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    return rows.map((r) => rowToRecord(r, readApprovals(this.db, String(r.id))));
  }
}
