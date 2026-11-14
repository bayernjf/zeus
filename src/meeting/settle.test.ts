import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../memory/memory-store.js';
import { advanceRound, createMeeting, decide } from './protocol.js';
import { convene } from './convene.js';
import { challenge } from './challenge.js';
import { decisionEvents, recallDecisions, settleMeeting } from './settle.js';
import type { Meeting } from './types.js';

const AT = '2026-11-15T00:00:00.000Z';

async function decidedMeeting(): Promise<Meeting> {
  let meeting = createMeeting({ id: 'm1', topic: '会议功能先做自动质疑还是先做 UI', createdAt: AT, maxRounds: 2 });
  meeting = (await convene(meeting, async () => ({
    drafts: [
      { speakerId: 'proposer-a', claims: [{ text: '先做自动质疑' }] },
      { speakerId: 'proposer-b', claims: [{ text: '先做 UI' }] },
    ],
  }))).meeting;
  meeting = advanceRound(meeting);
  meeting = (await challenge(meeting, async () => ({
    drafts: [{
      speakerId: 'critic-a',
      rebuts: ['c2'],
      claims: [{ text: '没有回放界面，记录没人看', evidence: [{ kind: 'observation', ref: 'demo', note: '' }] }],
    }],
  }))).meeting;
  meeting = advanceRound(meeting);
  return decide(meeting, {
    id: 'd1',
    by: 'owner',
    chosenClaimIds: ['c1'],
    rejectedClaimIds: ['c2'],
    rationale: '先做质疑，UI 等记录稳定',
    at: AT,
  });
}

describe('settle (S5 decision writeback)', () => {
  it('turns one decision into one claim event carrying chosen/rejected and rationale', async () => {
    const meeting = await decidedMeeting();
    const events = decisionEvents(meeting);
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('claim');
    expect(events[0]!.eventId).toBe('m1:d1');
    expect(events[0]!.refs).toContain('meeting:m1');
    const content = events[0]!.content as { subject: string; predicate: string; object: Record<string, unknown> };
    expect(content.predicate).toBe('meeting-decision');
    expect(content.subject).toBe(meeting.topic);
    expect(content.object.chosen).toEqual(['先做自动质疑']);
    expect(content.object.rejected).toEqual(['先做 UI']);
    expect(content.object.rationale).toBe('先做质疑，UI 等记录稳定');
  });

  it('refuses an undecided meeting', async () => {
    const meeting = createMeeting({ id: 'm2', topic: 'x', createdAt: AT });
    expect(() => decisionEvents(meeting)).toThrow(/decided/);
  });

  it('consolidates into a recallable decision fact and stays idempotent', async () => {
    const store = new MemoryStore();
    const meeting = await decidedMeeting();
    const first = await settleMeeting(store, meeting);
    expect(first.facts).toBe(1);

    const second = await settleMeeting(store, meeting);
    expect(second.facts).toBe(1);

    const hits = await recallDecisions(store, { query: meeting.topic });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.fact.predicate).toBe('meeting-decision');
  });
});
