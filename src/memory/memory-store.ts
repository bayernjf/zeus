import { consolidate, stableStringify } from './consolidate.js';
import { LocalHashingEmbedder, RecallIndex } from './recall.js';
import { verifyMemoryState } from './reconcile.js';
import type { MemoryConsistencyViolation } from './reconcile.js';
import type {
  ConsolidateOptions,
  ConsolidationResult,
  DecayResult,
  Embedder,
  FactRecord,
  MemoryEvent,
  MemoryState,
  RecallHit,
  RecallSearchOptions,
  ReliabilityCorrection,
  RetractionRecord,
  WritebackRecord,
} from './types.js';
import {
  MIN_WRITEWEIGHT_FACTOR,
  selectionWeightsFromWritebacks,
  type RecordWritebackInput,
} from './writeback.js';

export { MemoryConsolidationError } from './consolidate.js';
export {
  WritebackLedger,
  MIN_WRITEWEIGHT_FACTOR,
  selectionWeightsFromWritebacks,
} from './writeback.js';
export type { RecordWritebackInput } from './writeback.js';

/** Per-correction penalty applied to future reliability scoring. */
const CORRECTION_PENALTY = 0.15;

export class MemoryBoundaryError extends Error {  constructor(message: string) {
    super(message);
    this.name = 'MemoryBoundaryError';
  }
}

/**
 * The append-only log already holds a different event under this id. An id is
 * spent once: a replay of identical content is the same assertion re-stated
 * (a no-op), but the same id carrying different content is a producer bug that
 * the log must not swallow - dropping it would erase an event from a log the
 * design promises never loses one.
 */
export class MemoryEventConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryEventConflictError';
  }
}

export interface MemoryAuditEntry {
  at: string;
  reason: 'cross-dataDomain-read' | 'cross-dataDomain-append';
  readerDataDomainId: string;
  targetDataDomainId: string;
}

export interface MemoryReplay {  events: MemoryEvent[];
  facts: FactRecord[];
}

/**
 * Owns the append-only event log and the fact store for all dataDomains.
 * Facts have no public write surface: they change only through
 * consolidateDataDomain(). Reading another dataDomain's memory is refused and audited.
 */
export class MemoryStore {
  private readonly events: MemoryEvent[] = [];
  private readonly factsByDataDomain = new Map<string, FactRecord[]>();
  private readonly corrections: ReliabilityCorrection[] = [];
  private readonly retractions: RetractionRecord[] = [];
  private readonly writebacks: WritebackRecord[] = [];
  private readonly indexesByDataDomain = new Map<string, RecallIndex>();
  private readonly embedder: Embedder;

  constructor(private readonly audit: (entry: MemoryAuditEntry) => void = () => {},
              private readonly now: () => Date = () => new Date(),
              options: { embedder?: Embedder } = {}) {
    this.embedder = options.embedder ?? new LocalHashingEmbedder();
  }

  append(event: MemoryEvent): void {
    const existing = this.events.find(e => e.eventId === event.eventId);
    if (existing) {
      if (stableStringify(existing) === stableStringify(event)) return;
      throw new MemoryEventConflictError(
        `event ${event.eventId} already exists with different content`,
      );
    }
    this.events.push(event);
  }

  /** Append on behalf of a writer bound to a dataDomain; a mismatch is refused. */
  appendFromDataDomain(writerDataDomainId: string, event: MemoryEvent): void {
    if (writerDataDomainId !== event.dataDomainId) {
      this.audit({
        at: this.now().toISOString(),
        reason: 'cross-dataDomain-append',
        readerDataDomainId: writerDataDomainId,
        targetDataDomainId: event.dataDomainId,
      });
      throw new MemoryBoundaryError(
        `dataDomain ${writerDataDomainId} cannot append memory to dataDomain ${event.dataDomainId}`,
      );
    }
    this.append(event);
  }

  read(readerDataDomainId: string, targetDataDomainId: string, runId?: string): MemoryEvent[] {
    if (readerDataDomainId !== targetDataDomainId) {
      this.audit({
        at: this.now().toISOString(),
        reason: 'cross-dataDomain-read',
        readerDataDomainId,
        targetDataDomainId,
      });
      throw new MemoryBoundaryError(
        `dataDomain ${readerDataDomainId} cannot read memory of dataDomain ${targetDataDomainId}`,
      );
    }
    return this.events.filter(
      e => e.dataDomainId === targetDataDomainId && (runId === undefined || e.runId === runId),
    );
  }

  facts(readerDataDomainId: string, targetDataDomainId: string): FactRecord[] {
    if (readerDataDomainId !== targetDataDomainId) {
      this.audit({
        at: this.now().toISOString(),
        reason: 'cross-dataDomain-read',
        readerDataDomainId,
        targetDataDomainId,
      });
      throw new MemoryBoundaryError(
        `dataDomain ${readerDataDomainId} cannot read facts of dataDomain ${targetDataDomainId}`,
      );
    }
    return this.factsByDataDomain.get(targetDataDomainId) ?? [];
  }

  async consolidateDataDomain(dataDomainId: string, options: ConsolidateOptions = {}): Promise<ConsolidationResult> {
    const events = this.events.filter(e => e.dataDomainId === dataDomainId);
    const facts = this.factsByDataDomain.get(dataDomainId) ?? [];
    const output = consolidate(events, facts, options);
    this.factsByDataDomain.set(dataDomainId, output.facts);
    // The index is derived; refresh only when one has been materialised.
    const index = this.indexesByDataDomain.get(dataDomainId);
    if (index) {
      if (index.dimension !== this.embedder.dimension) {
        // The embedder switched vector space (hub ↔ local fallback): rebuild
        // instead of mixing dimensions in one index.
        await this.buildRecall(dataDomainId);
      } else {
        await index.sync(output.facts);
      }
      this.decayDataDomain(dataDomainId);
    }
    return output.result;
  }

  /** Materialise (or rebuild) the derived recall index for a dataDomain. */
  async buildRecall(dataDomainId: string): Promise<RecallIndex> {
    let index = this.indexesByDataDomain.get(dataDomainId);
    if (!index || index.dimension !== this.embedder.dimension) {
      index = new RecallIndex(this.embedder, dataDomainId);
      this.indexesByDataDomain.set(dataDomainId, index);
    }
    await index.sync(this.factsByDataDomain.get(dataDomainId) ?? []);
    // The sync replays the whole fact source, which would resurrect episodic
    // facts a previous decay pass evicted from the index; re-apply decay so
    // the eviction survives a rebuild (searchRecall rebuilds on every call).
    this.decayDataDomain(dataDomainId);
    return index;
  }

  /**
   * Hybrid keyword+semantic recall, importance-ranked; subject to the same
   * dataDomain boundary. Hits touch `lastAccessAt`, the decay clock for episodic
   * entries.
   */
  async searchRecall(
    readerDataDomainId: string,
    targetDataDomainId: string,
    query: string,
    options?: RecallSearchOptions,
  ): Promise<RecallHit[]> {
    if (readerDataDomainId !== targetDataDomainId) {
      this.audit({
        at: this.now().toISOString(),
        reason: 'cross-dataDomain-read',
        readerDataDomainId,
        targetDataDomainId,
      });
      throw new MemoryBoundaryError(
        `dataDomain ${readerDataDomainId} cannot search memory of dataDomain ${targetDataDomainId}`,
      );
    }
    const index = await this.buildRecall(targetDataDomainId);
    const hits = await index.search(query, options);
    const stored = this.factsByDataDomain.get(targetDataDomainId);
    if (stored) {
      const now = this.now().toISOString();
      for (const hit of hits) {
        // The indexed doc holds the same fact object as the store, so the
        // touch is visible to the next snapshot export as well.
        const fact = stored.find(f => f.factId === hit.fact.factId);
        if (fact) fact.lastAccessAt = now;
      }
    }
    return hits;
  }

  /**
   * Episodic decay (MemoryPort contract v1 §5.2): non-destructive ranking
   * discount by a fourteen-day half-life, plus eviction from the recall
   * index after three half-lives without access. preference / fact /
   * decision entries never decay. `downWeighted` counts episodic entries
   * currently inside the discount window.
   */
  decayDataDomain(dataDomainId: string): DecayResult {
    const index = this.indexesByDataDomain.get(dataDomainId);
    const nowMs = this.now().getTime();
    let downWeighted = 0;
    const evicted: string[] = [];
    for (const fact of this.factsByDataDomain.get(dataDomainId) ?? []) {
      if (fact.kind !== 'episodic' || fact.status === 'retracted') continue;
      const last = Date.parse(fact.lastAccessAt ?? fact.updatedAt);
      const ageDays = Number.isFinite(last) ? Math.max(0, (nowMs - last) / 86_400_000) : 0;
      if (ageDays > 42) {
        index?.remove(fact.factId);
        evicted.push(fact.factId);
      } else if (ageDays > 0) {
        downWeighted += 1;
      }
    }
    return { downWeighted, evicted };
  }

  /**
   * Execute the right to be forgotten: facts become retracted, their index
   * entries are dropped immediately, and a tombstone records the action for
   * downstream propagation. Retracting an already-retracted fact is a no-op.
   */
  retractFacts(
    dataDomainId: string,
    factIds: string[],
    context: { reason: string; requestedBy: string },
  ): RetractionRecord[] {
    const facts = this.factsByDataDomain.get(dataDomainId);
    if (!facts) return [];
    const records: RetractionRecord[] = [];
    for (const factId of factIds) {
      const fact = facts.find(f => f.factId === factId);
      if (!fact || fact.status === 'retracted') continue;
      fact.status = 'retracted';
      fact.updatedAt = this.now().toISOString();
      this.indexesByDataDomain.get(dataDomainId)?.remove(factId);
      const record: RetractionRecord = {
        factId,
        dataDomainId,
        subject: fact.subject,
        reason: context.reason,
        requestedBy: context.requestedBy,
        at: this.now().toISOString(),
      };
      this.retractions.push(record);
      records.push(record);
    }
    return records;
  }

  /** Forget every fact about a subject (identity match, case-insensitive). */
  forgetSubject(
    dataDomainId: string,
    subject: string,
    context: { reason: string; requestedBy: string },
  ): RetractionRecord[] {
    const normalized = subject.trim().toLowerCase();
    const factIds = (this.factsByDataDomain.get(dataDomainId) ?? [])
      .filter(f => f.subject.trim().toLowerCase() === normalized)
      .map(f => f.factId);
    return this.retractFacts(dataDomainId, factIds, context);
  }

  listRetractions(): RetractionRecord[] {
    return this.retractions.map(r => ({ ...r }));
  }

  /** Cross-section invariant check over the current fact source. */
  verifyIntegrity(): MemoryConsistencyViolation[] {
    return verifyMemoryState(this.exportState());
  }

  /**
   * Table sizes for the operator face. exportState() clones the whole fact
   * source, which is too heavy for a polling endpoint, so this counts only.
   */
  counts(): {
    events: number;
    facts: number;
    retractions: number;
    corrections: number;
    dataDomains: number;
    byKind: Record<string, number>;
  } {
    const byKind: Record<string, number> = {};
    for (const facts of this.factsByDataDomain.values()) {
      for (const fact of facts) {
        const kind = fact.kind ?? 'fact';
        byKind[kind] = (byKind[kind] ?? 0) + 1;
      }
    }
    return {
      events: this.events.length,
      facts: [...this.factsByDataDomain.values()].reduce((sum, facts) => sum + facts.length, 0),
      retractions: this.retractions.length,
      corrections: this.corrections.length,
      dataDomains: this.factsByDataDomain.size,
      byKind,
    };
  }

  /**
   * Record a operator correction: the named authors produced a claim the operator
   * rejected. Each correction permanently lowers the author's score; this is
   * the "被纠错" feedback the metrics failure rate cannot see.
   */
  recordCorrections(agentIds: string[], runId: string): void {
    for (const agentId of [...new Set(agentIds)]) {
      this.corrections.push({ agentId, runId, at: this.now().toISOString() });
    }
  }

  /** Reliability score: the observed base (1 − failure rate) less a fixed
   *  penalty per recorded correction, floored at 0. */
  reliabilityScore(agentId: string, base: number): number {
    const count = this.corrections.filter(c => c.agentId === agentId).length;
    return Math.max(0, base - CORRECTION_PENALTY * count);
  }

  /**
   * Distinct authors of the named facts in one dataDomain, resolved via their
   * provenance events. Scoped to a single dataDomain on purpose: an optional dataDomain
   * used to scan every domain, which is exactly the cross-dataDomain read the
   * boundary refuses everywhere else, and it left no audit trail.
   */
  authorsOfFacts(dataDomainId: string, factIds: string[]): string[] {
    const wanted = new Set(factIds);
    const facts = this.factsByDataDomain.get(dataDomainId) ?? [];
    const eventIds = new Set(
      facts.filter(f => wanted.has(f.factId)).flatMap(f => f.provenance),
    );
    return [...new Set(
      this.events.filter(e => eventIds.has(e.eventId)).map(e => e.source.agentId),
    )];
  }

  listCorrections(): ReliabilityCorrection[] {
    return this.corrections.map(c => ({ ...c }));
  }

  /**
   * Record a write-back card (经验卡) from a pure-rule reflection. The factor
   * is clamped to (MIN_WRITEWEIGHT_FACTOR, 1] so a down-weighted target stays
   * fail-soft (reachable when others saturate) and is never zeroed. Cards are
   * the S2 write-back face (design-memory-self-evolution §九); they live in the
   * user-dir snapshot (D3).
   */
  recordWriteback(input: RecordWritebackInput): WritebackRecord {
    if (!(input.factor >= MIN_WRITEWEIGHT_FACTOR) || input.factor > 1) {
      throw new RangeError(
        `writeback factor must be within (${MIN_WRITEWEIGHT_FACTOR}, 1], got ${input.factor}`,
      );
    }
    const card: WritebackRecord = {
      id: input.id ?? crypto.randomUUID(),
      dataDomainId: input.dataDomainId,
      createdAt: this.now().toISOString(),
      source: input.source,
      param: input.param,
      target: input.target,
      factor: input.factor,
      reason: input.reason,
      status: 'active',
    };
    this.writebacks.push(card);
    return { ...card };
  }

  /** Retract a card by id (keeps the row, flips status) for full traceability. */
  retractWriteback(id: string): WritebackRecord | null {
    const card = this.writebacks.find((c) => c.id === id);
    if (card === undefined || card.status === 'retracted') return null;
    card.status = 'retracted';
    card.retractedAt = this.now().toISOString();
    return { ...card };
  }

  listWritebacks(dataDomainId?: string): WritebackRecord[] {
    return this.writebacks
      .filter((c) => dataDomainId === undefined || c.dataDomainId === dataDomainId)
      .map((c) => ({ ...c }));
  }

  /** Active `selection-weight` overrides for a dataDomain; `{}` is the baseline. */
  selectionWeights(dataDomainId: string): Record<string, number> {
    return selectionWeightsFromWritebacks(this.listWritebacks(dataDomainId));
  }

  /**
   * Offline decision replay along a runId: the run's events plus every fact
   * whose provenance cites one of those events.
   */
  replay(dataDomainId: string, runId: string): MemoryReplay {
    const events = this.read(dataDomainId, dataDomainId, runId);
    const eventIds = new Set(events.map(e => e.eventId));
    const facts = (this.factsByDataDomain.get(dataDomainId) ?? []).filter(f =>
      f.provenance.some(id => eventIds.has(id)),
    );
    return { events, facts };
  }

  /**
   * Serializable fact source (indexes are derived; P0 has none). A fresh
   * store rebuilt from this export offers the same facts and the same
   * replay against the retained event log.
   */
  exportState(): MemoryState {
    return {
      events: this.events.map(e => ({ ...e })),
      facts: [...this.factsByDataDomain.entries()].map(([dataDomainId, facts]) => [
        dataDomainId,
        facts.map(f => ({ ...f, provenance: [...f.provenance] })),
      ]),
      corrections: this.corrections.map(c => ({ ...c })),
      retractions: this.retractions.map(r => ({ ...r })),
      writebacks: this.writebacks.map(w => ({ ...w })),
    };
  }

  importState(state: MemoryState): void {
    this.events.length = 0;
    this.factsByDataDomain.clear();
    this.corrections.length = 0;
    this.retractions.length = 0;
    this.writebacks.length = 0;
    // Indexes are derived and never imported; they rebuild lazily.
    this.indexesByDataDomain.clear();
    for (const event of state.events) this.append(event);
    for (const [dataDomainId, facts] of state.facts) {
      this.factsByDataDomain.set(dataDomainId, facts.map(f => ({ ...f, provenance: [...f.provenance] })));
    }
    for (const correction of state.corrections ?? []) this.corrections.push({ ...correction });
    for (const retraction of state.retractions ?? []) this.retractions.push({ ...retraction });
    for (const writeback of state.writebacks ?? []) this.writebacks.push({ ...writeback });
  }

  static fromState(
    state: MemoryState,
    audit?: (entry: MemoryAuditEntry) => void,
    options: { embedder?: Embedder } = {},
  ): MemoryStore {
    const store = new MemoryStore(audit, undefined, options);
    store.importState(state);
    return store;
  }
}
