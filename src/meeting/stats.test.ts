import { describe, expect, it } from 'vitest';
import { advanceRound, createMeeting, decide } from './protocol.js';
import { convene } from './convene.js';
import { meetingStats } from './stats.js';
import type { Meeting } from './types.js';

const AT = '2026-11-15T00:00:00.000Z';

async function sample(): Promise<Meeting> {
  let meeting = createMeeting({ id: 's1', topic: '先做质疑还是先做 UI', createdAt: AT, maxRounds: 2 });
  meeting = (await convene(meeting, async () => ({
    drafts: [
      { speakerId: 'a', claims: [{ text: '先做质疑', evidence: [{ kind: 'fact', ref: 'doc:s3', note: '' }] }] },
      { speakerId: 'b', claims: [{ text: '先做 UI' }] },
    ],
  }))).meeting;
  meeting = advanceRound(meeting);
  meeting = {
    ...meeting,
    utterances: [
      ...meeting.utterances,
      { id: 'u-9', speakerId: 'owner', kind: 'human', round: 2, stance: 'note', claims: [], rebuts: [], at: AT },
    ],
  };
  meeting = advanceRound(meeting);
  return decide(meeting, {
    id: 'd1', by: 'owner', chosenClaimIds: ['c1'], rejectedClaimIds: ['c2'], rationale: '理由', at: AT,
  });
}

describe('meetingStats', () => {
  it('counts claims, evidence coverage, rebuttals and decisions', async () => {
    const stats = meetingStats(await sample());
    expect(stats.claims).toBe(2);
    expect(stats.claimsWithEvidence).toBe(1);
    expect(stats.adopted).toBe(1);
    expect(stats.rejected).toBe(1);
    expect(stats.openClaims).toBe(0);
    expect(stats.adoptionRate).toBe(0.5);
    expect(stats.humanUtterances).toBe(1);
    expect(stats.estimatedTokens).toBeGreaterThan(0);
  });

  it('reports an undecided meeting without inventing a rate', () => {
    const fresh = createMeeting({ id: 's2', topic: '空会', createdAt: AT });
    const stats = meetingStats(fresh);
    expect(stats.claims).toBe(0);
    expect(stats.adoptionRate).toBeNull();
    expect(stats.roundsUsed).toBe(1);
  });
});
