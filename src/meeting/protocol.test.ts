import { describe, expect, it } from 'vitest';
import {
  MeetingProtocolError,
  advanceRound,
  archive,
  claimGraph,
  createMeeting,
  decide,
  recordUtterance,
} from './protocol.js';
import type { Meeting, Utterance } from './types.js';

const AT = '2026-11-14T00:00:00.000Z';

function base(): Meeting {
  return createMeeting({ id: 'm1', topic: '是否做会议功能', createdAt: AT, maxRounds: 2 });
}

function proposal(id: string, claimId: string): Utterance {
  return {
    id,
    speakerId: 'proposer-a',
    kind: 'agent',
    round: 1,
    stance: 'propose',
    claims: [{ id: claimId, text: '先做单轮 fan-out 包装', evidence: [] }],
    rebuts: [],
    at: AT,
  };
}

function challenge(id: string, target: string, withEvidence = true): Utterance {
  return {
    id,
    speakerId: 'critic-a',
    kind: 'agent',
    round: 2,
    stance: 'challenge',
    claims: [{
      id: `${id}-c`,
      text: '单轮包装不足以暴露分歧',
      evidence: withEvidence ? [{ kind: 'counterexample', ref: 'eval:org-roles', note: '单轮场景未出现反驳' }] : [],
    }],
    rebuts: [target],
    at: AT,
  };
}

describe('meeting protocol', () => {
  it('rejects invalid ids, empty topics and out-of-range round caps', () => {
    expect(() => createMeeting({ id: 'Bad Id', topic: 'x', createdAt: AT })).toThrow(MeetingProtocolError);
    expect(() => createMeeting({ id: 'm1', topic: '   ', createdAt: AT })).toThrow(/topic/);
    expect(() => createMeeting({ id: 'm1', topic: 'x', createdAt: AT, maxRounds: 9 })).toThrow(/maxRounds/);
  });

  it('opens on the first proposal and refuses a challenge in round 1', () => {
    const meeting = recordUtterance(base(), proposal('u1', 'c1'));
    expect(meeting.status).toBe('proposing');
    expect(() => recordUtterance(meeting, { ...challenge('u2', 'c1'), round: 1 })).toThrow(/proposal-only/);
  });

  it('requires a real target and evidence for a round-2 challenge', () => {
    let meeting = recordUtterance(base(), proposal('u1', 'c1'));
    meeting = advanceRound(meeting);
    expect(meeting.round).toBe(2);
    expect(meeting.status).toBe('challenging');

    expect(() => recordUtterance(meeting, { ...challenge('u2', 'c1'), rebuts: [] })).toThrow(/rebut/);
    expect(() => recordUtterance(meeting, challenge('u2', 'c9'))).toThrow(/unknown claim/);
    expect(() => recordUtterance(meeting, challenge('u3', 'c1', false))).toThrow(/evidence/);

    meeting = recordUtterance(meeting, challenge('u2', 'c1'));
    expect(meeting.utterances).toHaveLength(2);
  });

  it('rejects duplicate claim ids across the meeting', () => {
    const meeting = recordUtterance(base(), proposal('u1', 'c1'));
    expect(() => recordUtterance(meeting, proposal('u2', 'c1'))).toThrow(/claim id already used/);
  });

  it('converges at the round cap and then requires a human decision', () => {
    let meeting = recordUtterance(base(), proposal('u1', 'c1'));
    meeting = advanceRound(meeting);
    meeting = recordUtterance(meeting, challenge('u2', 'c1'));
    meeting = advanceRound(meeting);
    expect(meeting.status).toBe('converging');
    expect(meeting.round).toBe(2);

    expect(() => decide(meeting, {
      id: 'd1', by: '', chosenClaimIds: ['c1'], rejectedClaimIds: [], rationale: 'x', at: AT,
    })).toThrow(/human owner/);
    expect(() => decide(meeting, {
      id: 'd1', by: 'owner', chosenClaimIds: [], rejectedClaimIds: [], rationale: 'x', at: AT,
    })).toThrow(/at least one claim/);
    expect(() => decide(meeting, {
      id: 'd1', by: 'owner', chosenClaimIds: ['c1'], rejectedClaimIds: ['c1'], rationale: 'x', at: AT,
    })).toThrow(/chosen and rejected/);
    expect(() => decide(meeting, {
      id: 'd1', by: 'owner', chosenClaimIds: ['c9'], rejectedClaimIds: [], rationale: 'x', at: AT,
    })).toThrow(/unknown claim/);

    const decided = decide(meeting, {
      id: 'd1', by: 'owner', chosenClaimIds: ['c1'], rejectedClaimIds: [], rationale: '先跑通单轮再扩多轮', at: AT,
    });
    expect(decided.status).toBe('decided');
    expect(archive(decided).status).toBe('archived');
  });

  it('cannot decide before converging', () => {
    let meeting = recordUtterance(base(), proposal('u1', 'c1'));
    expect(() => decide(meeting, {
      id: 'd1', by: 'owner', chosenClaimIds: ['c1'], rejectedClaimIds: [], rationale: 'x', at: AT,
    })).toThrow(/converging/);
    meeting = advanceRound(meeting);
    expect(meeting.status).toBe('challenging');
  });

  it('replays the claim graph: who rebutted what, and what is still open', () => {
    let meeting = recordUtterance(base(), proposal('u1', 'c1'));
    meeting = advanceRound(meeting);
    meeting = recordUtterance(meeting, challenge('u2', 'c1'));
    const graph = claimGraph(meeting);
    expect(graph.nodes).toHaveLength(2);
    expect(graph.nodes[0]!.rebuttedBy).toEqual(['u2']);
    expect(graph.undecided).toEqual(['c1']);
  });
});
