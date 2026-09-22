import { sha256Hex } from '../util/crypto.js';
import type {
  ClaimContent,
  ConsolidateOptions,
  ConsolidationResult,
  DisputeRecord,
  FactRecord,
  MemoryEvent,
} from './types.js';

/**
 * Pure, deterministic consolidation (design-memory-consolidation.md §4).
 *
 * Input: the full event history of one realm plus its current facts.
 * Output: the next fact set and a manifest of what happened. Conflicting
 * claims are either resolved by a strict later-and-more-reliable rule, or
 * both sides are marked disputed and escalated — never silently overwritten.
 */

const DEFAULT_RELIABILITY = 0.5;
/** Independent-corroboration boost per additional distinct author. */
const CORROBORATION_BOOST = 0.05;

export class MemoryConsolidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryConsolidationError';
  }
}

export function isClaimContent(content: unknown): content is ClaimContent {
  if (typeof content !== 'object' || content === null) return false;
  const c = content as Record<string, unknown>;
  return typeof c.subject === 'string' && typeof c.predicate === 'string' && 'object' in c;
}

/** Deterministic JSON for deep equality and fact ids. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map(key => [key, sortJson((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

function factKey(realmId: string, subject: string, predicate: string): string {
  return `${realmId}␟${subject.trim().toLowerCase()}␟${predicate.trim().toLowerCase()}`;
}

function factId(realmId: string, subject: string, predicate: string, object: unknown): string {
  return sha256Hex(`${factKey(realmId, subject, predicate)}␟${stableStringify(object)}`).slice(0, 24);
}

function reliabilityOf(opts: ConsolidateOptions, agentId: string): number {
  const r = typeof opts.reliability === 'function'
    ? opts.reliability(agentId)
    : opts.reliability?.[agentId];
  if (r === undefined) return DEFAULT_RELIABILITY;
  if (r < 0 || r > 1) throw new MemoryConsolidationError(`reliability out of range for ${agentId}`);
  return r;
}

/**
 * Reliability-weighted confidence over a set of source events. Self-reported
 * confidence is weighted by the author's historical reliability; repeated
 * reports from the same author do not corroborate, distinct authors do.
 */
export function aggregateConfidence(events: MemoryEvent[], opts: ConsolidateOptions): number {
  const byAgent = new Map<string, MemoryEvent[]>();
  for (const event of events) {
    byAgent.set(event.source.agentId, [...(byAgent.get(event.source.agentId) ?? []), event]);
  }

  let weighted = 0;
  let totalWeight = 0;
  for (const [agentId, group] of byAgent) {
    const reliability = reliabilityOf(opts, agentId);
    // Same-author repeats collapse to their mean self-report — no boost.
    const selfReport = group.reduce((sum, e) => sum + e.confidence, 0) / group.length;
    weighted += reliability * selfReport;
    totalWeight += reliability;
  }

  const base = totalWeight > 0 ? weighted / totalWeight : 0;
  const distinct = byAgent.size;
  return Math.min(1, base + CORROBORATION_BOOST * Math.max(0, distinct - 1));
}

interface ClaimGroup {
  key: string;
  subject: string;
  predicate: string;
  object: unknown;
  objectJson: string;
  events: MemoryEvent[];
}

function groupClaims(events: MemoryEvent[]): ClaimGroup[] {
  const groups = new Map<string, ClaimGroup>();
  for (const event of events) {
    if (event.kind !== 'claim' || !isClaimContent(event.content)) continue;
    const { subject, predicate, object } = event.content;
    const key = factKey(event.realmId, subject, predicate);
    const objectJson = stableStringify(object);
    const groupKey = `${key}␟${objectJson}`;
    const existing = groups.get(groupKey);
    if (existing) {
      existing.events.push(event);
    } else {
      groups.set(groupKey, { key, subject, predicate, object, objectJson, events: [event] });
    }
  }
  return [...groups.values()];
}

const latestOccurredAt = (events: MemoryEvent[]): string =>
  events.reduce((max, e) => (e.occurredAt > max ? e.occurredAt : max), '');

const meanReliability = (events: MemoryEvent[], opts: ConsolidateOptions): number => {
  const agents = new Set(events.map(e => e.source.agentId));
  let sum = 0;
  for (const agentId of agents) sum += reliabilityOf(opts, agentId);
  return sum / agents.size;
};

function escalationIdFor(dispute: DisputeRecord, opts: ConsolidateOptions): string {
  if (opts.escalationId) return opts.escalationId(dispute);
  return `mem-esc-${sha256Hex(dispute.factId + '|' + dispute.conflicting.join(',')).slice(0, 12)}`;
}

export interface ConsolidateOutput {
  facts: FactRecord[];
  result: ConsolidationResult;
}

export function consolidate(
  events: MemoryEvent[],
  facts: FactRecord[] = [],
  options: ConsolidateOptions = {},
): ConsolidateOutput {
  if (events.length > 0) {
    const realmId = events[0].realmId;
    if (events.some(e => e.realmId !== realmId)) {
      throw new MemoryConsolidationError('consolidation cannot mix events from multiple realms');
    }
    if (facts.some(f => f.realmId !== realmId)) {
      throw new MemoryConsolidationError('facts must belong to the same realm as the events');
    }
  }

  const now = options.now ?? (() => new Date());
  const result: ConsolidationResult = {
    ingested: events.map(e => e.eventId),
    added: [],
    merged: [],
    superseded: [],
    disputes: [],
    escalations: [],
  };

  // Work on copies; existing facts are superseded/disputed in place.
  let nextFacts = facts.map(f => ({ ...f, provenance: [...f.provenance] }));
  const seen = new Set<string>();

  for (const group of groupClaims(events)) {
    const { subject, predicate, object, events: claimEvents } = group;
    const id = factId(events[0]?.realmId ?? '', subject, predicate, object);
    if (seen.has(id)) continue;
    seen.add(id);

    const candidateTime = latestOccurredAt(claimEvents);
    const candidateReliability = meanReliability(claimEvents, options);
    const sameKey = nextFacts.filter(
      f => factKey(f.realmId, f.subject, f.predicate) === group.key &&
        f.status !== 'superseded' && f.status !== 'retracted',
    );
    const matching = sameKey.find(f => stableStringify(f.object) === group.objectJson);
    const clashing = sameKey.filter(f => stableStringify(f.object) !== group.objectJson);

    if (matching) {
      const freshEvents = claimEvents.filter(e => !matching.provenance.includes(e.eventId));
      if (freshEvents.length === 0) continue;
      matching.provenance.push(...freshEvents.map(e => e.eventId));
      matching.version += 1;
      matching.updatedAt = now().toISOString();
      matching.status = 'active';
      matching.confidence = aggregateConfidence(
        provenanceEvents(matching.provenance, events),
        options,
      );
      result.merged.push({ factId: matching.factId, with: freshEvents.map(e => e.eventId) });
      continue;
    }

    // Strict rule: strictly later observation AND strictly more reliable
    // authors supersede; anything else stays a dispute for the driver.
    const resolvable = clashing.filter(
      f =>
        latestOccurredAt(provenanceEvents(f.provenance, events)) < candidateTime &&
        meanReliability(provenanceEvents(f.provenance, events), options) < candidateReliability,
    );
    const unresolved = clashing.filter(f => !resolvable.includes(f));

    const newFact: FactRecord = {
      factId: id,
      realmId: claimEvents[0].realmId,
      subject,
      predicate,
      object,
      status: unresolved.length > 0 ? 'disputed' : 'active',
      provenance: claimEvents.map(e => e.eventId),
      confidence: aggregateConfidence(claimEvents, options),
      version: 1,
      updatedAt: now().toISOString(),
    };
    nextFacts.push(newFact);
    result.added.push(id);

    for (const old of resolvable) {
      old.status = 'superseded';
      result.superseded.push(old.factId);
    }

    if (unresolved.length > 0) {
      for (const old of unresolved) old.status = 'disputed';
      const conflicting = unresolved.map(f => f.factId);
      const dispute: DisputeRecord = {
        factId: id,
        conflicting,
        reason: 'conflicting objects for the same subject/predicate; rule could not decide',
      };
      result.disputes.push(dispute);
      result.escalations.push(escalationIdFor(dispute, options));
    }
  }

  nextFacts = nextFacts.sort((a, b) => a.factId.localeCompare(b.factId));
  return { facts: nextFacts, result };
}

function provenanceEvents(eventIds: string[], batch: MemoryEvent[]): MemoryEvent[] {
  const known = new Map(batch.map(e => [e.eventId, e]));
  return eventIds.map(id => known.get(id)).filter((e): e is MemoryEvent => e !== undefined);
}
