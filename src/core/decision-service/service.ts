import { canonicalDigest } from '../signing.js';
import { gradeDecision, modeForGrade } from '../grading/grade.js';
import {
  DECISION_ERROR_CODES,
  DecisionError,
  ValidationError,
} from '../grading/errors.js';
import type {
  DecisionPolicy,
  DecisionRequest,
} from '../grading/policy.js';
import {
  parsePolicy,
  type PolicyStore,
} from '../grading/policy-loader.js';
import type {
  DecisionAuditAppender,
} from '../audit/audit-chain.js';
import type { DecisionAuditEntry } from '../audit/types.js';
import type { DecisionRecordStore } from './store.js';
import type {
  ApprovalRequest,
  DecisionApprovalRecord,
  DecisionMode,
  DecisionRecord,
  DecisionStatus,
} from './types.js';

/** Thrown when an operation references a decision id that does not exist. */
export class DecisionRecordNotFoundError extends Error {
  constructor(readonly decisionId: string) {
    super(`decision not found: ${decisionId}`);
    this.name = 'DecisionRecordNotFoundError';
  }
}

const HOUR_MS = 60 * 60 * 1000;
const ISO_CURRENCY = /^[A-Z]{3}$/;

export interface DecisionServiceDeps {
  policyStore: PolicyStore;
  recordStore: DecisionRecordStore;
  audit: DecisionAuditAppender;
  clock?: () => string;
  idGen?: () => string;
  /**
   * How long a waiting decision stays in the pending-but-late window after
   * breaching timeoutAt before sweepTimeouts / lazy reads close it as
   * timed-out. Default 72h; set 0 to reproduce the pre-window behavior where
   * breach itself is the terminal timeout.
   */
  lateGraceHours?: number;
}

/** Default pending-but-late grace window before a breached SLA is closed. */
export const DEFAULT_LATE_GRACE_HOURS = 72;

/** Validate a POST /api/v1/decisions body. Returns all issues found. */
export function validateDecisionRequest(value: unknown): string[] {
  const out: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return ['request body: expected an object'];
  }
  const body = value as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (!['intent', 'domain', 'amount', 'riskTags', 'impact', 'reversibility', 'proposal', 'idempotencyKey', 'requester'].includes(key)) {
      out.push(`request.${key}: unknown field`);
    }
  }
  if (typeof body.intent !== 'string' || body.intent === '') out.push('request.intent: expected a non-empty string');
  if (typeof body.domain !== 'string' || body.domain === '') out.push('request.domain: expected a non-empty string');
  if (body.impact !== 'self' && body.impact !== 'team' && body.impact !== 'org' && body.impact !== 'external') {
    out.push(`request.impact: expected self/team/org/external, got ${JSON.stringify(body.impact)}`);
  }
  if (body.reversibility !== 'reversible' && body.reversibility !== 'hard' && body.reversibility !== 'irreversible') {
    out.push(`request.reversibility: expected reversible/hard/irreversible, got ${JSON.stringify(body.reversibility)}`);
  }
  if (body.amount !== undefined) {
    if (typeof body.amount !== 'object' || body.amount === null || Array.isArray(body.amount)) {
      out.push('request.amount: expected { value, currency }');
    } else {
      const amount = body.amount as Record<string, unknown>;
      if (typeof amount.value !== 'number' || !Number.isFinite(amount.value) || amount.value < 0) {
        out.push('request.amount.value: expected a finite number >= 0');
      }
      if (typeof amount.currency !== 'string' || !ISO_CURRENCY.test(amount.currency)) {
        out.push('request.amount.currency: expected an ISO 3-letter currency code');
      }
    }
  }
  if (body.riskTags !== undefined && (!Array.isArray(body.riskTags) || body.riskTags.some(t => typeof t !== 'string'))) {
    out.push('request.riskTags: expected an array of strings');
  }
  if (body.idempotencyKey !== undefined && (typeof body.idempotencyKey !== 'string' || body.idempotencyKey === '')) {
    out.push('request.idempotencyKey: expected a non-empty string');
  }
  return out;
}

function validateApprovalRequest(value: unknown): string[] {
  const out: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return ['approval body: expected an object'];
  }
  const body = value as Record<string, unknown>;
  if (body.decision !== 'approve' && body.decision !== 'reject') {
    out.push('approval.decision: expected approve|reject');
  }
  if (typeof body.approver !== 'string' || body.approver === '') {
    out.push('approval.approver: expected a non-empty string');
  }
  if (body.comment !== undefined && typeof body.comment !== 'string') {
    out.push('approval.comment: expected a string');
  }
  return out;
}

/**
 * Core decision service: grade, status lifecycle, SLA timeout and idempotency.
 * Pure of HTTP; every state transition writes one signed audit entry.
 */
export class DecisionService {
  private readonly clock: () => string;
  private readonly idGen: () => string;
  private readonly lateGraceMs: number;
  private seq = 0;

  constructor(private readonly deps: DecisionServiceDeps) {
    this.clock = deps.clock ?? (() => new Date().toISOString());
    this.idGen = deps.idGen ?? (() => `dec_${Date.now().toString(36)}_${(this.seq += 1).toString(36)}`);
    if (deps.lateGraceHours !== undefined && (!Number.isFinite(deps.lateGraceHours) || deps.lateGraceHours < 0)) {
      throw new Error(`lateGraceHours must be a non-negative number, got ${String(deps.lateGraceHours)}`);
    }
    this.lateGraceMs = (deps.lateGraceHours ?? DEFAULT_LATE_GRACE_HOURS) * HOUR_MS;
  }

  /** Create a decision: grade it, settle D0 immediately, park D1-D3 for
   *  approval. Idempotent keys replay the original record. */
  async createDecision(req: DecisionRequest & { requester?: string }): Promise<DecisionRecord> {
    const issues = validateDecisionRequest(req);
    if (issues.length > 0) throw new ValidationError('decision request invalid', issues);

    // Idempotency: same key + same request returns the stored record; a key
    // reused with a different payload is a hard conflict.
    if (req.idempotencyKey !== undefined) {
      const existing = await this.deps.recordStore.findByIdempotencyKey(req.idempotencyKey);
      if (existing) {
        if (this.fingerprint(existing) !== this.fingerprint(req)) {
          throw new DecisionError(
            DECISION_ERROR_CODES.IDEMPOTENCY_CONFLICT,
            `idempotency key ${req.idempotencyKey} already used with a different request`,
            { retryable: false },
          );
        }
        return existing;
      }
    }

    let policy: DecisionPolicy;
    try {
      policy = this.deps.policyStore.get();
    } catch (error) {
      throw error; // POLICY_NOT_FOUND from the store
    }
    const now = this.clock();
    const graded = gradeDecision(policy, req);
    const mode = modeForGrade(graded.grade);
    const rule = policy.rules.find(r => r.id === graded.ruleId);
    const id = this.idGen();

    const record: DecisionRecord = {
      id,
      intent: req.intent,
      domain: req.domain,
      ...(req.amount ? { amount: req.amount } : {}),
      ...(req.riskTags ? { riskTags: [...req.riskTags] } : {}),
      impact: req.impact!,
      reversibility: req.reversibility!,
      ...(req.proposal !== undefined ? { proposal: req.proposal } : {}),
      ...(req.idempotencyKey !== undefined ? { idempotencyKey: req.idempotencyKey } : {}),
      grade: graded.grade,
      mode,
      status: this.initialStatus(mode),
      ruleId: graded.ruleId,
      gradeReason: graded.reason,
      policyVersion: policy.version,
      ...(rule?.slaHours !== undefined ? { slaHours: rule.slaHours } : {}),
      createdAt: now,
      updatedAt: now,
      auditSeq: 0,
      approvals: [],
    };

    if (record.status === 'awaiting_approval' || record.status === 'blocked') {
      if (rule?.slaHours !== undefined) {
        record.timeoutAt = new Date(Date.parse(now) + rule.slaHours * HOUR_MS).toISOString();
      }
    }
    if (record.status === 'decided') {
      record.decidedAt = now;
      record.result = { outcome: 'auto', at: now };
    }

    const createdEntry = await this.deps.audit.append({
      kind: 'decision.created',
      decisionId: id,
      ...(req.requester !== undefined ? { actor: req.requester } : {}),
      data: {
        grade: record.grade,
        mode: record.mode,
        status: record.status,
        ruleId: record.ruleId,
        policyVersion: record.policyVersion,
        domain: record.domain,
        intent: record.intent,
      },
    });
    record.auditSeq = createdEntry.seq;
    await this.deps.recordStore.put(record);
    return record;
  }

  /** Apply an approve/reject verdict to a waiting decision. */
  async approve(decisionId: string, body: ApprovalRequest): Promise<DecisionRecord> {
    const issues = validateApprovalRequest(body);
    if (issues.length > 0) throw new ValidationError('approval request invalid', issues);
    const record = await this.deps.recordStore.get(decisionId);
    if (!record) throw new DecisionRecordNotFoundError(decisionId);

    // Lazy timeout so a verdict landing after the SLA is refused.
    await this.applyTimeout(record, this.clock());
    if (record.status !== 'awaiting_approval' && record.status !== 'blocked') {
      throw new DecisionError(
        DECISION_ERROR_CODES.GRADE_REQUIRES_APPROVAL,
        `decision ${decisionId} is ${record.status} and cannot be approved/rejected`,
        { retryable: false },
      );
    }

    const at = this.clock();
    const approval: DecisionApprovalRecord = {
      approver: body.approver,
      verdict: body.decision,
      ...(body.comment !== undefined ? { comment: body.comment } : {}),
      at,
    };
    record.approvals.push(approval);
    record.updatedAt = at;
    if (body.decision === 'approve') {
      record.status = 'decided';
      record.decidedAt = at;
      record.result = { outcome: 'approved', at, approver: body.approver, ...(body.comment !== undefined ? { comment: body.comment } : {}) };
    } else {
      record.status = 'rejected';
      record.result = { outcome: 'rejected', at, approver: body.approver, ...(body.comment !== undefined ? { comment: body.comment } : {}) };
    }
    await this.deps.recordStore.put(record);
    const entry = await this.deps.audit.append({
      kind: body.decision === 'approve' ? 'decision.approved' : 'decision.rejected',
      decisionId,
      actor: body.approver,
      data: { grade: record.grade, status: record.status, comment: body.comment ?? null },
    });
    record.auditSeq = entry.seq;
    await this.deps.recordStore.put(record);
    return record;
  }

  /** Fetch a record, applying any SLA timeout before returning. */
  async get(decisionId: string): Promise<DecisionRecord | undefined> {
    const record = await this.deps.recordStore.get(decisionId);
    if (record) await this.applyTimeout(record, this.clock());
    return record;
  }

  /** List records, applying SLA timeouts lazily. */
  async list(filter: { domain?: string; status?: DecisionStatus } = {}): Promise<DecisionRecord[]> {
    const baseFilter = filter.domain !== undefined ? { domain: filter.domain } : {};
    const records = await this.deps.recordStore.list(baseFilter);
    const now = this.clock();
    for (const record of records) await this.applyTimeout(record, now);
    // Timeout can change status, so re-filter by status afterwards.
    return filter.status === undefined ? records : records.filter(r => r.status === filter.status);
  }

  /** Reject every waiting decision whose SLA elapsed. Returns the records
   *  that timed out during this sweep. Default action is reject (design §4.2). */
  async sweepTimeouts(now: string = this.clock()): Promise<DecisionRecord[]> {
    const timedOut: DecisionRecord[] = [];
    for (const record of await this.deps.recordStore.list()) {
      if (await this.applyTimeout(record, now)) timedOut.push(record);
    }
    return timedOut;
  }

  /** Read the active policy (POLICY_NOT_FOUND when none is loaded). */
  getPolicy(): DecisionPolicy {
    return this.deps.policyStore.get();
  }

  /** Validate and store a new policy version. The version must be greater
   *  than the current one (the store itself rejects duplicate versions). */
  async updatePolicy(policy: DecisionPolicy, actor = 'system'): Promise<DecisionPolicy> {
    const parsed = parsePolicy(policy);
    const versions = this.deps.policyStore.versions();
    const currentVersion = versions.length === 0 ? 0 : versions[versions.length - 1] as number;
    if (parsed.version <= currentVersion) {
      throw new DecisionError(
        DECISION_ERROR_CODES.VALIDATION_FAILED,
        `policy version must be greater than current ${currentVersion}, got ${parsed.version}`,
        { retryable: false },
      );
    }
    this.deps.policyStore.put(parsed);
    await this.deps.audit.append({
      kind: 'policy.updated',
      actor,
      data: { version: parsed.version, defaultGrade: parsed.defaultGrade, ruleCount: parsed.rules.length },
    });
    return parsed;
  }

  /** Reconstruct a decision's timeline for GET :id/replay. */
  replay(record: DecisionRecord): { format: 'json'; record: DecisionRecord; events: Array<{ type: string; at: string; detail?: Record<string, unknown> }> } {
    const events: Array<{ type: string; at: string; detail?: Record<string, unknown> }> = [
      {
        type: 'decision.created',
        at: record.createdAt,
        detail: { grade: record.grade, mode: record.mode, status: record.status, ruleId: record.ruleId, policyVersion: record.policyVersion },
      },
      ...(record.lateAt !== undefined
        ? [{ type: 'decision.late' as const, at: record.lateAt, detail: { slaHours: record.slaHours ?? null, timeoutAt: record.timeoutAt ?? null } }]
        : []),
      ...record.approvals.map(a => ({
        type: a.verdict === 'approve' ? 'decision.approved' : 'decision.rejected',
        at: a.at,
        detail: { approver: a.approver, comment: a.comment ?? null },
      })),
    ];
    if (record.result?.outcome === 'timed-out') {
      events.push({ type: 'decision.timed-out', at: record.result.at, detail: { slaHours: record.slaHours ?? null } });
    }
    return { format: 'json', record, events };
  }

  /** Render a replay as stable plain text (format=text). */
  renderReplay(record: DecisionRecord): string {
    const r = this.replay(record);
    const lines = [
      `decision ${record.id} [${record.grade}/${record.mode}] ${record.status}`,
      `created ${record.createdAt} rule=${record.ruleId} policy=v${record.policyVersion} reason=${record.gradeReason}`,
      ...r.events.slice(1).map(e => `${e.at} ${e.type}${e.detail?.approver ? ` by ${String(e.detail.approver)}` : ''}`),
    ];
    return lines.join('\n');
  }

  private initialStatus(mode: DecisionMode): DecisionStatus {
    if (mode === 'auto') return 'decided';
    if (mode === 'approve-async') return 'awaiting_approval';
    return 'blocked'; // approve-sync and human-led
  }

  /**
   * Apply SLA state to one waiting record. Two phases, both idempotent:
   *
   *  1. breach — timeoutAt has passed but lateAt is unset: stamp lateAt and
   *     write one `decision.late` audit entry. The record stays
   *     awaiting_approval/blocked in the pending-but-late window and remains
   *     approvable/rejectable. Nothing is terminal yet.
   *  2. close — the record already breached (lateAt set) and the grace window
   *     has now elapsed: close it as rejected/timed-out, like the old
   *     read-and-reject behavior.
   *
   * Returns true only for phase 2 (the record terminated as timed-out during
   * this call), so sweepTimeouts keeps its old return contract.
   */
  private async applyTimeout(record: DecisionRecord, now: string): Promise<boolean> {
    const waiting = record.status === 'awaiting_approval' || record.status === 'blocked';
    if (!waiting || record.timeoutAt === undefined) return false;
    const dueMs = Date.parse(record.timeoutAt);
    const nowMs = Date.parse(now);
    if (nowMs < dueMs) return false;

    // Phase 1: first detection of the breach stamps the window start. lateAt is
    // observational ("when we first saw it was late"); the grace deadline is
    // always measured from timeoutAt below, so a first read arriving after the
    // whole window elapses closes it in this same call.
    if (record.lateAt === undefined) {
      record.lateAt = now;
      record.updatedAt = now;
      const entry = await this.deps.audit.append({
        kind: 'decision.late',
        decisionId: record.id,
        data: { grade: record.grade, slaHours: record.slaHours ?? null, timeoutAt: record.timeoutAt },
      });
      record.auditSeq = entry.seq;
      await this.deps.recordStore.put(record);
    }

    if (nowMs < dueMs + this.lateGraceMs) return false;

    record.status = 'rejected';
    record.updatedAt = now;
    record.result = { outcome: 'timed-out', at: now };
    const entry = await this.deps.audit.append({
      kind: 'decision.timed-out',
      decisionId: record.id,
      data: { grade: record.grade, slaHours: record.slaHours ?? null, timeoutAt: record.timeoutAt, lateAt: record.lateAt },
    });
    record.auditSeq = entry.seq;
    await this.deps.recordStore.put(record);
    return true;
  }

  private fingerprint(req: DecisionRequest | DecisionRecord): string {
    if ('id' in req) {
      // Existing record: fingerprint its request-shape fields.
      const r = req as DecisionRecord;
      return canonicalDigest({
        intent: r.intent,
        domain: r.domain,
        amount: r.amount ?? null,
        riskTags: r.riskTags ?? [],
        impact: r.impact,
        reversibility: r.reversibility,
        proposal: r.proposal ?? null,
      });
    }
    return canonicalDigest({
      intent: req.intent,
      domain: req.domain,
      amount: req.amount ?? null,
      riskTags: req.riskTags ?? [],
      impact: req.impact ?? null,
      reversibility: req.reversibility ?? null,
      proposal: req.proposal ?? null,
    });
  }
}

/** Audit chain entries relevant to one decision (replay support). */
export function filterAuditByDecision(entries: readonly DecisionAuditEntry[], decisionId: string): DecisionAuditEntry[] {
  return entries.filter(e => e.payload.decisionId === decisionId);
}
