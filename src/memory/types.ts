/**
 * Memory Consolidation Protocol (design-memory-consolidation.md).
 *
 * P0: append-only event log + pure, deterministic consolidation
 * (dedupe / merge / supersede / dispute). No recall index, personal realm.
 * Agents append events; facts are produced only by the consolidator.
 */

export type MemoryKind = 'observation' | 'action' | 'decision' | 'claim';

export interface MemoryEvent {
  eventId: string;
  realmId: string;
  runId: string;
  source: { agentId: string; taskId?: string };
  kind: MemoryKind;
  content: unknown;
  /** Source references (Realm itemId / evidence pointers). */
  refs: string[];
  /** Author self-reported confidence, 0..1. Never the sole weight in merging. */
  confidence: number;
  occurredAt: string;
}

export type FactStatus = 'active' | 'superseded' | 'disputed' | 'retracted';

export interface FactRecord {
  factId: string;
  realmId: string;
  subject: string;
  predicate: string;
  object: unknown;
  status: FactStatus;
  /** eventId list — the fact must be replayable to its sources. */
  provenance: string[];
  confidence: number;
  version: number;
  updatedAt: string;
}

export interface DisputeRecord {
  factId: string;
  conflicting: string[];
  reason: string;
}

export interface ConsolidationResult {  ingested: string[];
  added: string[];
  merged: Array<{ factId: string; with: string[] }>;
  superseded: string[];
  disputes: DisputeRecord[];
  /** Escalation identifiers produced for disputes (wired to the desk in P1). */
  escalations: string[];
}

/** Claim event content: the only shape the P0 consolidator can normalise. */
export interface ClaimContent {
  subject: string;
  predicate: string;
  object: unknown;
}

export interface ConsolidateOptions {
  now?: () => Date;
  /**
   * Historical per-agent reliability in 0..1. Unknown agents fall back to a
   * neutral default — authorship is never trusted from the self-reported
   * confidence alone.
   */
  reliability?: Record<string, number> | ((agentId: string) => number);
  /** Escalation ids are derived deterministically from this seed. */
  escalationId?: (dispute: DisputeRecord) => string;
}

/** A recorded driver correction against an author; lowers future reliability. */
export interface ReliabilityCorrection {
  agentId: string;
  runId: string;
  at: string;
}

/** Serializable memory state; the snapshot persisted with the kernel. */
export type MemoryState = {
  events: MemoryEvent[];
  facts: Array<[string, FactRecord[]]>;
  corrections?: ReliabilityCorrection[];
};
