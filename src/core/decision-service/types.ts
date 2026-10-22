import type { Grade, Impact, Reversibility } from '../types.js';
import type { Amount } from '../grading/policy.js';

/** Lifecycle status of a decision record (design §4.2). */
export type DecisionStatus = 'decided' | 'awaiting_approval' | 'blocked' | 'rejected';

/** Processing mode derived from the grade (design §4.1). */
export type DecisionMode = 'auto' | 'approve-async' | 'approve-sync' | 'human-led';

export type ApprovalVerdict = 'approve' | 'reject';

/** How a decision finally settled. */
export type DecisionOutcome = 'auto' | 'approved' | 'rejected' | 'timed-out';

/** One approval action against a decision. */
export interface DecisionApprovalRecord {
  approver: string;
  verdict: ApprovalVerdict;
  comment?: string;
  at: string;
}

/** Final settlement attached once a decision leaves the waiting states. */
export interface DecisionResult {
  outcome: DecisionOutcome;
  at: string;
  approver?: string;
  comment?: string;
}

/**
 * A graded business decision and its full lifecycle. Append-only approvals;
 * status transitions go through DecisionService so the SLA and audit chain
 * stay consistent.
 */
export interface DecisionRecord {
  id: string;
  intent: string;
  domain: string;
  amount?: Amount;
  riskTags?: string[];
  impact: Impact;
  reversibility: Reversibility;
  /** Opaque candidate proposal the agent already formed (D1+). */
  proposal?: unknown;
  idempotencyKey?: string;

  grade: Grade;
  mode: DecisionMode;
  status: DecisionStatus;
  ruleId: string;
  gradeReason: string;
  policyVersion: number;
  slaHours?: number;

  createdAt: string;
  updatedAt: string;
  /** Seq of the latest audit entry for this decision. */
  auditSeq: number;
  decidedAt?: string;
  /** Waiting records with an SLA expire at this ISO time. */
  timeoutAt?: string;
  result?: DecisionResult;
  approvals: DecisionApprovalRecord[];
}

/** Body of POST /api/v1/decisions/:id/approval. */
export interface ApprovalRequest {
  decision: ApprovalVerdict;
  approver: string;
  comment?: string;
}

/** Filters for GET /api/v1/decisions. */
export interface DecisionListFilter {
  domain?: string;
  status?: DecisionStatus;
}
