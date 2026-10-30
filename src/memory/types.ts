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

/**
 * Cross-session memory category fixed onto a fact at consolidation
 * (MemoryPort contract v1 §2). Drives the importance baseline and the
 * decay policy: episodic entries age out of the recall index, the other
 * three categories are long-lived. Absent on legacy facts, where recall
 * falls back to the neutral default.
 */
export type FactCategory = 'preference' | 'fact' | 'decision' | 'episodic';

/** Default importance baseline per category (MemoryPort contract v1 §5.1). */
export const FACT_CATEGORY_BASELINE: Record<FactCategory, number> = {
  preference: 0.8,
  fact: 0.5,
  decision: 0.9,
  episodic: 0.3,
};

/** Neutral importance for facts written before the field existed. */
export const DEFAULT_FACT_IMPORTANCE = 0.5;

/**
 * The content-origin classification fixed onto a fact at consolidation
 * (design-guardrails §3.3). A claim is always an execution-agent's output —
 * data, never an operator instruction — so every fact the consolidator
 * produces carries `agent-produced`. The label travels with the fact into
 * later recall, where the assembler forwards it as the entry's provenance
 * (the consumer sees "another agent said this", not "the kernel/user
 * requires this"). Absent on facts written before this field existed
 * (old snapshots), where the assembler falls back to `kernel-resolved-realm`.
 */
export type FactOrigin = 'agent-produced' | 'kernel-resolved-realm';

export interface FactRecord {
  factId: string;
  realmId: string;
  subject: string;
  predicate: string;
  object: unknown;
  status: FactStatus;
  /** eventId list — the fact must be replayable to its sources. */
  provenance: string[];
  /** Content-origin classification fixed at consolidation. */
  origin?: FactOrigin;
  /** Memory category; drives importance and decay. */
  kind?: FactCategory;
  /** Importance baseline 0..1; recall blends it into the ranking. */
  importance?: number;
  /** Last recall hit; the decay clock for episodic entries. */
  lastAccessAt?: string;
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
  escalations: string[];
}

/** Claim event content: the only shape the P0 consolidator can normalise. */
export interface ClaimContent {
  subject: string;
  predicate: string;
  object: unknown;
  /** Memory category carried onto the fact (contract v1 §2). */
  category?: FactCategory;
  /** Explicit importance override; clamped to 0..1 at consolidation. */
  importance?: number;
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

/**
 * Right-to-be-forgotten tombstone. Retracted facts stay auditable only as
 * these records: the fact and every derived index entry are removed, while
 * the append-only event log is preserved for governance replay. A tombstone
 * is the traceable declaration that must propagate to snapshots/downstream.
 */
export interface RetractionRecord {
  factId: string;
  realmId: string;
  subject: string;
  reason: string;
  requestedBy: string;
  at: string;
}

/**
 * Text embedder behind the recall index. Asynchronous since MemoryPort v1:
 * the hub-backed implementation (ruling D-1) performs an authorised
 * out-of-realm call, so embedding can no longer be a synchronous local
 * operation. The `dimension` stays synchronous — it describes the vector
 * space currently served, and a change of dimension (hub ↔ local fallback)
 * tells the store to rebuild the index.
 */
/**
 * Per-call context for embed requests. The hub-backed embedder carries the
 * realm scope into its external-call audit lines (P2-5) so the operator can
 * tell which realm's memory an embedding call served; the local embedder
 * ignores it (no external call, no audit line).
 */
export interface EmbedContext {
  realmId?: string;
}

export interface Embedder {
  readonly dimension: number;
  embed(text: string, ctx?: EmbedContext): Promise<number[]>;
}

/** Outcome of a decay pass (MemoryPort contract v1 §5.2). */
export interface DecayResult {
  /** Episodic facts whose effective importance dropped below the floor. */
  downWeighted: number;
  /** Fact ids evicted from the recall index (three half-lives unread). */
  evicted: string[];
}

/**
 * A write-back card (经验卡): a pure-rule reflection's recommendation to adjust
 * a decision parameter, derived from a stable failure pattern. This is the
 * *write-back face* of the execution-after loop (design-memory-self-evolution
 * §2.2 / §九). The card itself stores only the recommendation plus audit
 * metadata; applying it is mechanical (see src/memory/writeback.ts) and fully
 * reversible (retracting a card returns behaviour to baseline).
 *
 * D3: cards live in the user-dir memory snapshot, so they are backup-able and
 * inheritable like the rest of memory. D2: only sorting-weight parameters are
 * writable; circuit/threshold parameters stay closed until #9 real load.
 */
export type WritebackParam = 'selection-weight';

export interface WritebackRecord {
  id: string;
  realmId: string;
  createdAt: string;
  /** The stable pattern that produced this recommendation (read-only attribution). */
  source: { kind: string; target: string; confidence: 'stable' | 'suggestive' };
  param: WritebackParam;
  /** Entity the parameter applies to (a vassal id for `selection-weight`). */
  target: string;
  /** Multiplicative weight; 1 = no change, <1 down-weights a failure-concentrated target. */
  factor: number;
  reason: string;
  status: 'active' | 'retracted';
  retractedAt?: string;
}

/** One hybrid-retrieval result, with its lexical and semantic components. */
export interface RecallHit {
  fact: FactRecord;
  /** Combined hybrid+importance score in 0..1 (contract v1 §5.1). */
  score: number;
  /** BM25 lexical score, normalised against the best lexical match. */
  lexical: number;
  /** Cosine similarity against the query embedding. */
  semantic: number;
}

export interface RecallSearchOptions {
  limit?: number;
  /** Weight on the semantic component; 1 − alpha weights lexical. Default 0.5. */
  alpha?: number;
}

/** Serializable memory state; the snapshot persisted with the kernel. */
export type MemoryState = {
  events: MemoryEvent[];
  facts: Array<[string, FactRecord[]]>;
  corrections?: ReliabilityCorrection[];
  retractions?: RetractionRecord[];
  /** Write-back cards (经验卡); persisted in the user-dir snapshot (D3). */
  writebacks?: WritebackRecord[];
};
