import type { RealmType } from '../a2a/types.js';

/** A vassal task stopped at input-required and is asking the human driver to decide. */
export type EscalationStatus = 'pending' | 'approved' | 'rejected';

export type Escalation = {
  id: string;
  runId: string;
  vassal: string;
  skill: string;
  taskId: string;
  realm: RealmType;
  /** Why the vassal escalated: taken from the terminal input-required event's
   *  x-zeus-escalation payload, with a neutral fallback. */
  reason: string;
  options: string[];
  status: EscalationStatus;
  createdAt: string;
  decidedAt?: string;
  decisionNote?: string;
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
};

/** Rejection cancels the vassal-side task; wired to Dispatcher.cancel in production. */
export type CancelTaskFn = (vassal: string, taskId: string) => Promise<unknown>;
