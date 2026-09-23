import { factId, stableStringify } from './consolidate.js';
import type {
  FactRecord,
  MemoryState,
  ReliabilityCorrection,
  RetractionRecord,
} from './types.js';

/**
 * Memory drift reconciliation (design-memory-consolidation.md §7, P2).
 *
 * Two operations:
 *  - reconcileMemoryStates diffs two point-in-time snapshots and reports what
 *    drifted (events appended, facts added/removed/changed, corrections and
 *    tombstones recorded), per realm.
 *  - verifyMemoryState checks the cross-section invariants the fact source
 *    must satisfy (rebuildable fact ids, resolvable provenance, retracted
 *    facts paired with a tombstone). It is the memory analogue of the Realm
 *    digest reconciliation: silent corruption surfaces as a violation.
 */

type FlatFact = FactRecord;

function flattenFacts(state: MemoryState): Map<string, FlatFact> {
  const map = new Map<string, FlatFact>();
  for (const [, facts] of state.facts) {
    for (const fact of facts) {
      map.set(`${fact.realmId}␟${fact.factId}`, fact);
    }
  }
  return map;
}

export interface FactFieldChange {
  field: 'subject' | 'predicate' | 'object' | 'status' | 'confidence' | 'version' | 'provenance';
  before: unknown;
  after: unknown;
}

export interface FactDrift {
  realmId: string;
  factId: string;
  kind: 'added' | 'removed' | 'changed';
  changes?: FactFieldChange[];
}

export interface MemoryDriftReport {
  realms: string[];
  eventsAppended: number;
  eventsRemoved: number;
  factsAdded: string[];
  factsRemoved: string[];
  factsChanged: FactDrift[];
  correctionsAdded: number;
  retractionsAdded: number;
  /** True when the two snapshots differ in any way. */
  hasDrift: boolean;
}

const COMPARED_FIELDS: ReadonlyArray<FactFieldChange['field']> = [
  'subject', 'predicate', 'object', 'status', 'confidence', 'version', 'provenance',
];

function fieldValue(fact: FactRecord, field: FactFieldChange['field']): unknown {
  if (field === 'object') return stableStringify(fact.object);
  if (field === 'provenance') return [...fact.provenance].join(',');
  return fact[field];
}

function diffFact(previous: FactRecord, current: FactRecord): FactDrift | null {
  const changes: FactFieldChange[] = [];
  for (const field of COMPARED_FIELDS) {
    const before = fieldValue(previous, field);
    const after = fieldValue(current, field);
    if (before !== after) changes.push({ field, before, after });
  }
  if (changes.length === 0) return null;
  return { realmId: current.realmId, factId: current.factId, kind: 'changed', changes };
}

/** Diff two snapshots; symmetric and pure. Events are compared by eventId. */
export function reconcileMemoryStates(previous: MemoryState, current: MemoryState): MemoryDriftReport {
  const prevFacts = flattenFacts(previous);
  const currFacts = flattenFacts(current);

  const factsAdded: string[] = [];
  const factsRemoved: string[] = [];
  const factsChanged: FactDrift[] = [];

  for (const [key, fact] of currFacts) {
    const old = prevFacts.get(key);
    if (!old) {
      factsAdded.push(fact.factId);
    } else {
      const drift = diffFact(old, fact);
      if (drift) factsChanged.push(drift);
    }
  }
  for (const [key, fact] of prevFacts) {
    if (!currFacts.has(key)) factsRemoved.push(fact.factId);
  }

  const prevEventIds = new Set(previous.events.map(e => e.eventId));
  const currEventIds = new Set(current.events.map(e => e.eventId));
  const eventsAppended = current.events.filter(e => !prevEventIds.has(e.eventId)).length;
  const eventsRemoved = previous.events.filter(e => !currEventIds.has(e.eventId)).length;

  const correctionKey = (c: ReliabilityCorrection) => `${c.agentId}␟${c.runId}␟${c.at}`;
  const prevCorrections = new Set((previous.corrections ?? []).map(correctionKey));
  const correctionsAdded = (current.corrections ?? []).filter(c => !prevCorrections.has(correctionKey(c))).length;

  const retractionKey = (r: RetractionRecord) => `${r.factId}␟${r.at}`;
  const prevRetractions = new Set((previous.retractions ?? []).map(retractionKey));
  const retractionsAdded = (current.retractions ?? []).filter(r => !prevRetractions.has(retractionKey(r))).length;

  const realms = new Set<string>();
  for (const state of [previous, current]) {
    for (const e of state.events) realms.add(e.realmId);
    for (const [realmId] of state.facts) realms.add(realmId);
  }

  const hasDrift =
    eventsAppended > 0 || eventsRemoved > 0 ||
    factsAdded.length > 0 || factsRemoved.length > 0 || factsChanged.length > 0 ||
    correctionsAdded > 0 || retractionsAdded > 0;

  return {
    realms: [...realms].sort(),
    eventsAppended,
    eventsRemoved,
    factsAdded: factsAdded.sort(),
    factsRemoved: factsRemoved.sort(),
    factsChanged,
    correctionsAdded,
    retractionsAdded,
    hasDrift,
  };
}

export interface MemoryConsistencyViolation {
  code:
    | 'duplicate-fact'
    | 'bad-fact-id'
    | 'unresolved-provenance'
    | 'provenance-realm-mismatch'
    | 'retracted-without-tombstone'
    | 'tombstone-without-retraction'
    | 'fact-realm-mismatch';
  factId?: string;
  realmId?: string;
  detail: string;
}

/**
 * Verify the invariants the derived indexes depend on. An empty list means the
 * state is internally consistent and can safely rebuild every index.
 */
export function verifyMemoryState(state: MemoryState): MemoryConsistencyViolation[] {
  const violations: MemoryConsistencyViolation[] = [];
  const eventById = new Map(state.events.map(e => [e.eventId, e]));
  const tombstonesByFact = new Map<string, RetractionRecord>();
  for (const r of state.retractions ?? []) tombstonesByFact.set(r.factId, r);

  const seen = new Set<string>();
  for (const [bucketRealmId, facts] of state.facts) {
    for (const fact of facts) {
      const key = `${fact.realmId}␟${fact.factId}`;
      if (seen.has(key)) {
        violations.push({ code: 'duplicate-fact', factId: fact.factId, realmId: fact.realmId, detail: 'fact appears more than once' });
      }
      seen.add(key);

      if (fact.realmId !== bucketRealmId) {
        violations.push({ code: 'fact-realm-mismatch', factId: fact.factId, realmId: fact.realmId, detail: `stored under realm ${bucketRealmId}` });
      }

      const expectedId = factId(fact.realmId, fact.subject, fact.predicate, fact.object);
      if (expectedId !== fact.factId) {
        violations.push({ code: 'bad-fact-id', factId: fact.factId, realmId: fact.realmId, detail: `fact id does not rebuild (expected ${expectedId})` });
      }

      for (const eventId of fact.provenance) {
        const event = eventById.get(eventId);
        if (!event) {
          violations.push({ code: 'unresolved-provenance', factId: fact.factId, realmId: fact.realmId, detail: `event ${eventId} missing from log` });
        } else if (event.realmId !== fact.realmId) {
          violations.push({ code: 'provenance-realm-mismatch', factId: fact.factId, realmId: fact.realmId, detail: `event ${eventId} belongs to realm ${event.realmId}` });
        }
      }

      const hasTombstone = tombstonesByFact.has(fact.factId);
      if (fact.status === 'retracted' && !hasTombstone) {
        violations.push({ code: 'retracted-without-tombstone', factId: fact.factId, realmId: fact.realmId, detail: 'retracted fact has no retraction record' });
      }
    }
  }

  const liveFactIds = new Set<string>();
  for (const [, facts] of state.facts) {
    for (const fact of facts) liveFactIds.add(fact.factId);
  }
  for (const [factId, record] of tombstonesByFact) {
    const fact = [...state.facts].flatMap(([, facts]) => facts).find(f => f.factId === factId);
    if (!fact) {
      violations.push({ code: 'tombstone-without-retraction', factId, realmId: record.realmId, detail: 'tombstone references an absent fact' });
    } else if (fact.status !== 'retracted') {
      violations.push({ code: 'tombstone-without-retraction', factId, realmId: record.realmId, detail: 'tombstone exists but fact is not retracted' });
    }
  }

  return violations;
}
