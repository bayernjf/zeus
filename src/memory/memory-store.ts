import { consolidate } from './consolidate.js';
import type {
  ConsolidateOptions,
  ConsolidationResult,
  FactRecord,
  MemoryEvent,
  MemoryState,
  ReliabilityCorrection,
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

  constructor(private readonly audit: (entry: MemoryAuditEntry) => void = () => {},
              private readonly now: () => Date = () => new Date()) {}

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
    return output.result;
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
    };
  }

  importState(state: MemoryState): void {
    this.events.length = 0;
    this.factsByRealm.clear();
    this.corrections.length = 0;
    for (const event of state.events) this.append(event);
    for (const [realmId, facts] of state.facts) {
      this.factsByRealm.set(realmId, facts.map(f => ({ ...f, provenance: [...f.provenance] })));
    }
    for (const correction of state.corrections ?? []) this.corrections.push({ ...correction });
  }

  static fromState(state: MemoryState, audit?: (entry: MemoryAuditEntry) => void): MemoryStore {
    const store = new MemoryStore(audit);
    store.importState(state);
    return store;
  }
}
