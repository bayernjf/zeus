import type { RealmType } from '../a2a/types.js';
import type { Conflict } from '../orchestrator/types.js';

/** A vassal task stopped at input-required and is asking the human driver to decide. */
export type EscalationStatus = 'pending' | 'approved' | 'rejected';

/** task-input: one vassal task paused at input-required (E6.1).
 *  intent-conflict: the fan-out split across stances and the rule could not conclude (E6.2).
 *  memory-dispute: consolidation found contradictory facts it could not rule on. */
export type EscalationKind = 'task-input' | 'intent-conflict' | 'memory-dispute';

export type Escalation = {
  id: string;
  kind: EscalationKind;
  runId: string;
  /** task-input: the pausing vassal; intent-conflict: '(intent)' (no single vassal). */
  vassal: string;
  skill: string;
  /** task-input only: the vassal-side task to cancel on rejection. */
  taskId?: string;
  realm: RealmType;
  /** Why the vassal escalated: taken from the terminal input-required event's
   *  x-zeus-escalation payload, with a neutral fallback. */
  reason: string;
  /** task-input: vassal-offered options; intent-conflict: the competing stances. */
  options: string[];
  status: EscalationStatus;
  createdAt: string;
  decidedAt?: string;
  decisionNote?: string;
  /** intent-conflict only. */
  intentId?: string;
  stances?: Conflict['stances'];
  /** Set when an intent-conflict is approved: the stance the driver accepted. */
  decidedStance?: string;
  /** memory-dispute only. */
  factId?: string;
  conflictingFacts?: string[];
};

export type OversightAuditEntry = {
  ts: string;
  escalationId: string;
  runId: string;
  vassal: string;
  action: 'escalated' | 'approved' | 'rejected';
  note?: string;
  /** Set when a rejection's downstream task cancel failed. */
  detail?: string;
  /** Set when an intent-conflict is decided. */
  decidedStance?: string;
};

/** Rejection cancels the vassal-side task; wired to Dispatcher.cancel in production. */
export type CancelTaskFn = (vassal: string, taskId: string) => Promise<unknown>;
