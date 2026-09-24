import { consolidate } from './consolidate.js';
import { RecallIndex } from './recall.js';
import { verifyMemoryState } from './reconcile.js';
import type { MemoryConsistencyViolation } from './reconcile.js';
import type {
  ConsolidateOptions,
  ConsolidationResult,
  Embedder,
  FactRecord,
  MemoryEvent,
  MemoryState,
  RecallHit,
  RecallSearchOptions,
  ReliabilityCorrection,
  RetractionRecord,
} from './types.js';

export { MemoryConsolidationError } from './consolidate.js';

/** Per-correction penalty applied to future reliability scoring. */
const CORRECTION_PENALTY = 0.15;

export class MemoryBoundaryError extends Error {  constructor(message: string) {
    super(message);
    this.name = 'MemoryBoundaryError';
  }
}

export interface MemoryAuditEntry {
  at: string;
  reason: 'cross-realm-read' | 'cross-realm-append';
  readerRealmId: string;
  targetRealmId: string;
}

export interface MemoryReplay {  events: MemoryEvent[];
  facts: FactRecord[];
}

/**
 * Owns the append-only event log and the fact store for all realms.
 * Facts have no public write surface: they change only through
 * consolidateRealm(). Reading another realm's memory is refused and audited.
 */
export class MemoryStore {
  private readonly events: MemoryEvent[] = [];
  private readonly factsByRealm = new Map<string, FactRecord[]>();
  private readonly corrections: ReliabilityCorrection[] = [];
  private readonly retractions: RetractionRecord[] = [];
  private readonly indexesByRealm = new Map<string, RecallIndex>();

  constructor(private readonly audit: (entry: MemoryAuditEntry) => void = () => {},
              private readonly now: () => Date = () => new Date(),
              private readonly options: { embedder?: Embedder } = {}) {}

  append(event: MemoryEvent): void {
    if (this.events.some(e => e.eventId === event.eventId)) return;
    this.events.push(event);
  }

  /** Append on behalf of a writer bound to a realm; a mismatch is refused. */
  appendFromRealm(writerRealmId: string, event: MemoryEvent): void {
    if (writerRealmId !== event.realmId) {
      this.audit({
        at: new Date().toISOString(),
        reason: 'cross-realm-append',
        readerRealmId: writerRealmId,
        targetRealmId: event.realmId,
      });
      throw new MemoryBoundaryError(
        `realm ${writerRealmId} cannot append memory to realm ${event.realmId}`,
      );
    }
    this.append(event);
  }

  read(readerRealmId: string, targetRealmId: string, runId?: string): MemoryEvent[] {
    if (readerRealmId !== targetRealmId) {
      this.audit({
        at: new Date().toISOString(),
        reason: 'cross-realm-read',
        readerRealmId,
        targetRealmId,
      });
      throw new MemoryBoundaryError(
        `realm ${readerRealmId} cannot read memory of realm ${targetRealmId}`,
      );
    }
    return this.events.filter(
      e => e.realmId === targetRealmId && (runId === undefined || e.runId === runId),
    );
  }

  facts(readerRealmId: string, targetRealmId: string): FactRecord[] {
    if (readerRealmId !== targetRealmId) {
      this.audit({
        at: new Date().toISOString(),
        reason: 'cross-realm-read',
        readerRealmId,
        targetRealmId,
      });
      throw new MemoryBoundaryError(
        `realm ${readerRealmId} cannot read facts of realm ${targetRealmId}`,
      );
    }
    return this.factsByRealm.get(targetRealmId) ?? [];
  }

  consolidateRealm(realmId: string, options: ConsolidateOptions = {}): ConsolidationResult {
    const events = this.events.filter(e => e.realmId === realmId);
    const facts = this.factsByRealm.get(realmId) ?? [];
    const output = consolidate(events, facts, options);
    this.factsByRealm.set(realmId, output.facts);
    // The index is derived; refresh only when one has been materialised.
    this.indexesByRealm.get(realmId)?.sync(output.facts);
    return output.result;
  }

  /** Materialise (or rebuild) the derived recall index for a realm. */
  buildRecall(realmId: string): RecallIndex {
    let index = this.indexesByRealm.get(realmId);
    if (!index) {
      index = new RecallIndex(this.options.embedder);
      this.indexesByRealm.set(realmId, index);
    }
    index.sync(this.factsByRealm.get(realmId) ?? []);
    return index;
  }

  /** Hybrid keyword+semantic recall; subject to the same realm boundary. */
  searchRecall(
    readerRealmId: string,
    targetRealmId: string,
    query: string,
    options?: RecallSearchOptions,
  ): RecallHit[] {
    if (readerRealmId !== targetRealmId) {
      this.audit({
        at: this.now().toISOString(),
        reason: 'cross-realm-read',
        readerRealmId,
        targetRealmId,
      });
      throw new MemoryBoundaryError(
        `realm ${readerRealmId} cannot search memory of realm ${targetRealmId}`,
      );
    }
    return this.buildRecall(targetRealmId).search(query, options);
  }

  /**
   * Execute the right to be forgotten: facts become retracted, their index
   * entries are dropped immediately, and a tombstone records the action for
   * downstream propagation. Retracting an already-retracted fact is a no-op.
   */
  retractFacts(
    realmId: string,
    factIds: string[],
    context: { reason: string; requestedBy: string },
  ): RetractionRecord[] {
    const facts = this.factsByRealm.get(realmId);
    if (!facts) return [];
    const records: RetractionRecord[] = [];
    for (const factId of factIds) {
      const fact = facts.find(f => f.factId === factId);
      if (!fact || fact.status === 'retracted') continue;
      fact.status = 'retracted';
      fact.updatedAt = this.now().toISOString();
      this.indexesByRealm.get(realmId)?.remove(factId);
      const record: RetractionRecord = {
        factId,
        realmId,
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
    realmId: string,
    subject: string,
    context: { reason: string; requestedBy: string },
  ): RetractionRecord[] {
    const normalized = subject.trim().toLowerCase();
    const factIds = (this.factsByRealm.get(realmId) ?? [])
      .filter(f => f.subject.trim().toLowerCase() === normalized)
      .map(f => f.factId);
    return this.retractFacts(realmId, factIds, context);
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
  counts(): { events: number; facts: number; retractions: number; corrections: number; realms: number } {
    return {
      events: this.events.length,
      facts: [...this.factsByRealm.values()].reduce((sum, facts) => sum + facts.length, 0),
      retractions: this.retractions.length,
      corrections: this.corrections.length,
      realms: this.factsByRealm.size,
    };
  }

  /**
   * Record a driver correction: the named authors produced a claim the driver
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

  /** Distinct authors of the named facts, resolved via provenance events.
   *  Searches every realm when realmId is omitted. */
  authorsOfFacts(factIds: string[], realmId?: string): string[] {
    const wanted = new Set(factIds);
    const realmPairs: Array<[string, FactRecord[]]> = realmId
      ? [[realmId, this.factsByRealm.get(realmId) ?? []]]
      : [...this.factsByRealm.entries()];
    const eventIds = new Set(
      realmPairs.flatMap(([, facts]) =>
        facts.filter(f => wanted.has(f.factId)).flatMap(f => f.provenance)),
    );
    return [...new Set(
      this.events.filter(e => eventIds.has(e.eventId)).map(e => e.source.agentId),
    )];
  }

  listCorrections(): ReliabilityCorrection[] {
    return this.corrections.map(c => ({ ...c }));
  }

  /**
   * Offline decision replay along a runId: the run's events plus every fact
   * whose provenance cites one of those events.
   */
  replay(realmId: string, runId: string): MemoryReplay {
    const events = this.read(realmId, realmId, runId);
    const eventIds = new Set(events.map(e => e.eventId));
    const facts = (this.factsByRealm.get(realmId) ?? []).filter(f =>
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
      facts: [...this.factsByRealm.entries()].map(([realmId, facts]) => [
        realmId,
        facts.map(f => ({ ...f, provenance: [...f.provenance] })),
      ]),
      corrections: this.corrections.map(c => ({ ...c })),
      retractions: this.retractions.map(r => ({ ...r })),
    };
  }

  importState(state: MemoryState): void {
    this.events.length = 0;
    this.factsByRealm.clear();
    this.corrections.length = 0;
    this.retractions.length = 0;
    // Indexes are derived and never imported; they rebuild lazily.
    this.indexesByRealm.clear();
    for (const event of state.events) this.append(event);
    for (const [realmId, facts] of state.facts) {
      this.factsByRealm.set(realmId, facts.map(f => ({ ...f, provenance: [...f.provenance] })));
    }
    for (const correction of state.corrections ?? []) this.corrections.push({ ...correction });
    for (const retraction of state.retractions ?? []) this.retractions.push({ ...retraction });
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
