// S5: settle a decided meeting into memory. A decision becomes a `claim` event
// (subject = topic, predicate = meeting-decision), which the consolidator turns
// into a fact; the next meeting on the same topic can recall it and cite why the
// earlier choice was made — including what was rejected.

import type { MemoryStore } from '../memory/memory-store.js';
import type { MemoryEvent, RecallHit } from '../memory/types.js';
import { MeetingProtocolError } from './protocol.js';
import type { Meeting } from './types.js';

export type SettleOptions = {
  dataDomainId?: string;
  runId?: string;
  now?: string;
};

/** One memory event per decision. Idempotent by eventId: re-settling a meeting
 *  re-appends the same events, and the store ignores identical duplicates. */
export function decisionEvents(meeting: Meeting, options: SettleOptions = {}): MemoryEvent[] {
  if (meeting.status !== 'decided' && meeting.status !== 'archived') {
    throw new MeetingProtocolError('invalid-state', `only decided meetings can settle, got ${meeting.status}`);
  }
  const dataDomainId = options.dataDomainId ?? 'personal';
  const runId = options.runId ?? `meeting-${meeting.id}`;

  return meeting.decisions.map(decision => ({
    eventId: `${meeting.id}:${decision.id}`,
    dataDomainId,
    runId,
    source: { agentId: 'meeting', taskId: meeting.id },
    kind: 'claim',
    content: {
      subject: meeting.topic,
      predicate: 'meeting-decision',
      object: {
        meetingId: meeting.id,
        decisionId: decision.id,
        chosen: claimTexts(meeting, decision.chosenClaimIds),
        rejected: claimTexts(meeting, decision.rejectedClaimIds),
        rationale: decision.rationale,
        decidedBy: decision.by,
        decidedAt: decision.at,
      },
    },
    refs: [`meeting:${meeting.id}`, ...decision.chosenClaimIds.map(id => `claim:${id}`)],
    confidence: 0.9,
    occurredAt: decision.at,
  }));
}

/** Append the decision events and consolidate, so the facts are recallable. */
export async function settleMeeting(
  store: MemoryStore,
  meeting: Meeting,
  options: SettleOptions = {},
): Promise<{ events: MemoryEvent[]; facts: number }> {
  const events = decisionEvents(meeting, options);
  for (const event of events) store.append(event);
  await store.consolidateDataDomain(options.dataDomainId ?? 'personal');
  const facts = store.facts(options.dataDomainId ?? 'personal', options.dataDomainId ?? 'personal');
  return {
    events,
    facts: facts.filter(fact => fact.predicate === 'meeting-decision').length,
  };
}

/** Recall prior meeting decisions for a topic — the "next meeting cites the last
 *  conclusion" path. Returns only decision facts; ordinary claims stay out. */
export async function recallDecisions(
  store: MemoryStore,
  options: { query: string; dataDomainId?: string; runId?: string; limit?: number },
): Promise<RecallHit[]> {
  const dataDomainId = options.dataDomainId ?? 'personal';
  const hits = await store.searchRecall(dataDomainId, dataDomainId, options.query, {
    limit: options.limit ?? 5,
  });
  return hits.filter(hit => hit.fact.predicate === 'meeting-decision');
}

function claimTexts(meeting: Meeting, ids: readonly string[]): string[] {
  const byId = new Map(
    meeting.utterances.flatMap(utterance => utterance.claims).map(claim => [claim.id, claim.text]),
  );
  return ids.map(id => byId.get(id) ?? id);
}
