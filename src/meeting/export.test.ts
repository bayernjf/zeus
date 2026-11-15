import { describe, expect, it } from 'vitest';
import { exportMarkdown } from './export.js';
import { advanceRound, createMeeting, decide, recordUtterance } from './protocol.js';
import type { Utterance } from './types.js';

const at = '2026-11-14T10:00:00.000Z';

function say(
  meeting: ReturnType<typeof createMeeting>,
  input: Omit<Utterance, 'id' | 'round' | 'at'> & { claims: Utterance['claims'] },
) {
  return recordUtterance(meeting, {
    ...input,
    id: `u-${meeting.utterances.length + 1}`,
    round: meeting.round,
    at,
  });
}

function decidedMeeting() {
  let meeting = createMeeting({ id: 'm-export', topic: '先做 UI 还是先做自动质疑', createdAt: at, maxRounds: 2 });
  meeting = say(meeting, {
    speakerId: 'proposer',
    kind: 'agent',
    stance: 'propose',
    claims: [{ id: 'c1', text: '先做自动质疑', evidence: [{ kind: 'reference', ref: 'design-meeting.md', note: '' }] }],
    rebuts: [],
  });
  meeting = advanceRound(meeting);
  meeting = say(meeting, {
    speakerId: 'critic',
    kind: 'agent',
    stance: 'challenge',
    claims: [{ id: 'c2', text: '没有回放界面没人看得见质疑', evidence: [{ kind: 'observation', ref: 'demo.json', note: '' }] }],
    rebuts: ['c1'],
  });
  meeting = advanceRound(meeting);
  return decide(meeting, {
    id: 'd-1',
    by: 'owner',
    chosenClaimIds: ['c2'],
    rejectedClaimIds: ['c1'],
    rationale: '先补 UI，再谈自动质疑',
    at,
  });
}

describe('meeting markdown export', () => {
  it('puts the decision first, with the losing proposal and its reason', () => {
    const markdown = exportMarkdown(decidedMeeting(), { now: at });
    const decisionSection = markdown.slice(0, markdown.indexOf('## 过程'));
    expect(decisionSection).toContain('# 先做 UI 还是先做自动质疑');
    expect(decisionSection).toContain('**采纳**');
    expect(decisionSection).toContain('`c2` 没有回放界面没人看得见质疑');
    expect(decisionSection).toContain('**否决**');
    expect(decisionSection).toContain('`c1` 先做自动质疑');
    expect(decisionSection).toContain('> 先补 UI，再谈自动质疑');
    expect(decisionSection).toContain('证据：observation:demo.json');
  });

  it('keeps the cross-challenge trace with speakers and rounds', () => {
    const markdown = exportMarkdown(decidedMeeting(), { now: at });
    expect(markdown).toContain('### 第 1 轮');
    expect(markdown).toContain('**proposer**（agent）· propose');
    expect(markdown).toContain('### 第 2 轮');
    expect(markdown).toContain('· 反驳 `c1`');
    expect(markdown).toContain('`c1` 先做自动质疑');
  });

  it('says a meeting is undecided instead of pretending it decided', () => {
    let meeting = createMeeting({ id: 'm-open', topic: '未收敛的会', createdAt: at, maxRounds: 2 });
    meeting = say(meeting, {
      speakerId: 'a',
      kind: 'agent',
      stance: 'propose',
      claims: [{ id: 'c1', text: '方案一', evidence: [] }],
      rebuts: [],
    });
    meeting = advanceRound(meeting);
    meeting = say(meeting, {
      speakerId: 'b',
      kind: 'agent',
      stance: 'challenge',
      claims: [{ id: 'c2', text: '方案一要补证据', evidence: [{ kind: 'fact', ref: 'x', note: '' }] }],
      rebuts: ['c1'],
    });
    const markdown = exportMarkdown(meeting, { now: at });
    expect(markdown).toContain('_尚未决策');
    expect(markdown).toContain('## 被反驳但未裁决');
    expect(markdown).toContain('`c1` 方案一');
  });
});
