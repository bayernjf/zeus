/**
 * Decision lifecycle events — the push counterpart of polling listPending.
 *
 * A DecisionService with an `events` sink emits one event per terminal
 * transition (created / late / approved / rejected / timed-out). Sinks must
 * be fail-soft by contract: the service never lets a broken sink turn a
 * decision write into a failure (it also catches sink errors itself).
 */
import type { DecisionMode, DecisionRecord, DecisionStatus } from './types.js';
import type { Grade } from '../types.js';

export type DecisionEventType =
  | 'created'
  | 'late'
  | 'approved'
  | 'rejected'
  | 'timed-out';

/** One lifecycle snapshot, enriched for downstream operators (webhooks). */
export interface DecisionEvent {
  type: DecisionEventType;
  decisionId: string;
  /** ISO time the transition was taken. */
  at: string;
  domain: string;
  intent: string;
  grade: Grade;
  mode: DecisionMode;
  /** Post-transition status of the record. */
  status: DecisionStatus;
  ruleId: string;
  slaHours?: number;
  timeoutAt?: string;
  lateAt?: string;
  outcome?: string;
  approver?: string;
}

/** Fail-soft receiver of lifecycle events. */
export interface DecisionEventSink {
  emit(event: DecisionEvent): Promise<void> | void;
}

/** Build the outbound event payload for a record right after a transition. */
export function decisionEventFromRecord(
  type: DecisionEventType,
  record: DecisionRecord,
  at: string,
): DecisionEvent {
  return {
    type,
    decisionId: record.id,
    at,
    domain: record.domain,
    intent: record.intent,
    grade: record.grade,
    mode: record.mode,
    status: record.status,
    ruleId: record.ruleId,
    ...(record.slaHours !== undefined ? { slaHours: record.slaHours } : {}),
    ...(record.timeoutAt !== undefined ? { timeoutAt: record.timeoutAt } : {}),
    ...(record.lateAt !== undefined ? { lateAt: record.lateAt } : {}),
    ...(record.result?.outcome !== undefined ? { outcome: record.result.outcome } : {}),
    ...(record.approvals.at(-1) !== undefined ? { approver: record.approvals.at(-1)!.approver } : {}),
  };
}
