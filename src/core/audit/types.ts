/**
 * Decision audit chain — ADR-04.
 *
 * Append-only JSONL trail of business decisions (distinct from the dispatch
 * audit sink in `src/dispatch/audit.ts`). Each entry is sealed individually
 * (per-record granularity, chosen in T-M1-05): the signature covers the
 * payload, its sequence number and the previous entry's hash, so tampering
 * with any single record — content, order, insertion or deletion — breaks
 * verification at that position.
 */

/** Business decision lifecycle events. */
export type DecisionAuditKind =
  | 'decision.created'
  | 'decision.approved'
  | 'decision.rejected'
  | 'decision.completed'
  | 'decision.failed'
  | 'decision.timed-out'
  | 'policy.updated';

export const DECISION_AUDIT_KINDS: readonly DecisionAuditKind[] = [
  'decision.created',
  'decision.approved',
  'decision.rejected',
  'decision.completed',
  'decision.failed',
  'decision.timed-out',
  'policy.updated',
];

/** The body of an audit event. `data` is the only place for kind-specific
 *  fields; top-level shape is fixed so unknown keys fail closed. */
export interface DecisionAuditPayload {
  kind: DecisionAuditKind;
  /** ISO-8601 event time. */
  at: string;
  /** Decision record id when the event relates to one decision. */
  decisionId?: string;
  /** Actor (requester / approver / system); omitted for system events. */
  actor?: string;
  /** Kind-specific structured body. */
  data: Record<string, unknown>;
}

/** Payload input accepted by the chain appender; `at` defaults to the clock. */
export type DecisionAuditInput = Omit<DecisionAuditPayload, 'at'> & { at?: string };

/** One sealed link of the chain. */
export interface DecisionAuditEntry {
  /** 0-based contiguous chain position. */
  seq: number;
  /** Hash of the previous sealed entry; the literal `GENESIS` for seq 0. */
  prevHash: string;
  /** Id of the key that sealed this entry. */
  keyId: string;
  payload: DecisionAuditPayload;
  /** `sha256:`-labeled digest of the sealing document (see audit-chain.ts). */
  hash: string;
  /** base64url Ed25519 signature over the canonical sealing document. */
  signature: string;
}

/** prevHash value of the first entry. */
export const AUDIT_GENESIS = 'GENESIS';

/** Top-level keys allowed on a sealed entry (tamper-rejection surface). */
export const AUDIT_ENTRY_KEYS = ['seq', 'prevHash', 'keyId', 'payload', 'hash', 'signature'] as const;

/** Top-level keys allowed on a payload. */
export const AUDIT_PAYLOAD_KEYS = ['kind', 'at', 'decisionId', 'actor', 'data'] as const;
