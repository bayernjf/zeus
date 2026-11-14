import { describe, expect, it } from 'vitest';
import { advanceRound, createMeeting } from './protocol.js';
import { convene } from './convene.js';
import { challenge, nextStep, projectClaims, selectTargets } from './challenge.js';
import type { Meeting } from './types.js';

const AT = '2026-11-15T00:00:00.000Z';

async function proposing(): Promise<Meeting> {
  const meeting = createMeeting({ id: 'm1', topic: '先做哪个', createdAt: AT, maxRounds: 2 });
  const result = await convene(meeting, async () => ({
    drafts: [
      { speakerId: 'proposer-a', claims: [{ text: '先做存储', evidence: [{ kind: 'reference', ref: 'doc:a', note: 'proposer 的推理，不应传给 critic' }] }] },
      { speakerId: 'proposer-b', claims: [{ text: '先做 UI' }, { text: '先做质疑' }] },
    ],
  }));
  return result.meeting;
}

describe('challenge (S3 cross-challenge)', () => {
  it('picks least-rebutted targets and excludes decided claims', async () => {
    let meeting = await proposing();
    expect(selectTargets(meeting, 2)).toEqual(['c1', 'c2']);
    meeting = { ...meeting, decisions: [{ id: 'd1', by: 'owner', chosenClaimIds: ['c1'], rejectedClaimIds: [], rationale: 'x', at: AT }] };
    expect(selectTargets(meeting, 2)).toEqual(['c2', 'c3']);
  });

  it('projects claims down to kind + ref, dropping the proposer note', async () => {
    const projections = projectClaims(await proposing());
    expect(projections[0]!.evidence).toEqual([{ kind: 'reference', ref: 'doc:a' }]);
    expect(projections[0]!.rebutCount).toBe(0);
  });

  it('records a valid rebuttal and skips one that carries no evidence', async () => {
    let meeting = await proposing();
    meeting = advanceRound(meeting);
    const result = await challenge(meeting, async () => ({
      drafts: [
        {
          speakerId: 'critic-a',
          rebuts: ['c1'],
          claims: [{ text: '存储并非瓶颈', evidence: [{ kind: 'counterexample', ref: 'bench:1', note: '实测' }] }],
        },
        { speakerId: 'critic-b', rebuts: ['c2'], claims: [{ text: '空口否定' }] },
      ],
    }));
    expect(result.recorded).toHaveLength(1);
    expect(result.skipped[0]!.speakerId).toBe('critic-b');
    expect(result.skipped[0]!.reason).toMatch(/evidence/);
    expect(result.meeting.utterances).toHaveLength(3);
    expect(result.stable).toBe(false);
  });

  it('marks a pure-rebuttal round stable (no new claim introduced)', async () => {
    let meeting = await proposing();
    meeting = advanceRound(meeting);
    const result = await challenge(meeting, async () => ({
      drafts: [{ speakerId: 'critic-a', rebuts: ['c1'], claims: [] }],
    }));
    expect(result.recorded).toHaveLength(1);
    expect(result.stable).toBe(true);
    expect(nextStep(result.meeting)).toBe('converge');
  });

  it('refuses to challenge outside a challenging round', async () => {
    const meeting = await proposing();
    await expect(challenge(meeting, async () => ({ drafts: [] }))).rejects.toThrow(/challenging/);
  });
});

describe('nextStep', () => {
  it('walks open → propose, proposing → challenge, converging → decide', async () => {
    expect(nextStep(createMeeting({ id: 'm2', topic: 't', createdAt: AT }))).toBe('propose');
    expect(nextStep(await proposing())).toBe('challenge');
    expect(nextStep({ ...(await proposing()), status: 'converging' })).toBe('decide');
  });
});
