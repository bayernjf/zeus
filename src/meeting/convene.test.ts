import { describe, expect, it, vi } from 'vitest';
import type { FanOutResult } from '../core/orchestrator/types.js';
import { convene, proposalBatchFromFanOut } from './convene.js';
import { createMeeting } from './protocol.js';

const AT = '2026-11-15T00:00:00.000Z';

function meeting() {
  return createMeeting({ id: 'm1', topic: '先做哪个', createdAt: AT, maxRounds: 2 });
}

describe('convene (S2 automatic proposals)', () => {
  it('fills round 1 with one utterance per proposal and assigns claim ids itself', async () => {
    const result = await convene(meeting(), async () => ({
      drafts: [
        { speakerId: 'proposer-a', claims: [{ text: '先做存储' }, { text: '再做 UI' }] },
        { speakerId: 'proposer-b', claims: [{ text: '先做 UI 验证价值' }] },
      ],
    }));
    expect(result.meeting.status).toBe('proposing');
    expect(result.recorded).toHaveLength(2);
    expect(result.recorded[0]!.claimIds).toEqual(['c1', 'c2']);
    expect(result.recorded[1]!.claimIds).toEqual(['c3']);
    expect(result.skipped).toEqual([]);
    expect(result.meeting.utterances[1]!.speakerId).toBe('proposer-b');
  });

  it('skips a draft that carries no usable claim without touching the meeting', async () => {
    const result = await convene(meeting(), async () => ({
      drafts: [
        { speakerId: 'proposer-a', claims: [{ text: '   ' }] },
        { speakerId: 'proposer-b', claims: [{ text: '先做存储' }] },
      ],
    }));
    expect(result.skipped).toEqual([{ speakerId: 'proposer-a', reason: 'proposal has no claim' }]);
    expect(result.meeting.utterances).toHaveLength(1);
    expect(result.meeting.utterances[0]!.speakerId).toBe('proposer-b');
  });

  it('keeps source-level failures as skipped entries', async () => {
    const result = await convene(meeting(), async () => ({
      drafts: [{ speakerId: 'proposer-a', claims: [{ text: '先做存储' }] }],
      skipped: [{ speakerId: 'proposer-c', reason: 'credential missing' }],
    }));
    expect(result.skipped).toEqual([{ speakerId: 'proposer-c', reason: 'credential missing' }]);
    expect(result.meeting.utterances).toHaveLength(1);
  });

  it('refuses to convene after round 1 has closed', async () => {
    let m = meeting();
    m = { ...m, round: 2, status: 'proposing' };
    const source = vi.fn(async () => ({ drafts: [] }));
    await expect(convene(m, source)).rejects.toThrow(/round 1 only/);
    expect(source).not.toHaveBeenCalled();
  });
});

describe('fan-out mapping', () => {
  it('maps settled branches to proposals and keeps failures as skipped', () => {
    const branch = (executor: string, ok: boolean, text: string | undefined, reason?: string) => ({
      executor,
      runId: `run-${executor}`,
      ok,
      reason,
      state: ok ? 'completed' : 'failed',
      events: [],
      task: ok && text !== undefined
        ? { kind: 'task', id: executor, contextId: executor, status: { state: 'completed' }, artifacts: [text] }
        : undefined,
    });
    const result = {
      branches: [
        branch('A', true, '{"claims":[{"text":"先做存储","evidence":[{"kind":"fact","ref":"fact-1"}]}]}'),
        branch('B', true, '先做 UI，能更快看到价值'),
        branch('C', false, undefined, 'credential missing'),
      ],
    } as unknown as FanOutResult;

    const batch = proposalBatchFromFanOut(result);
    expect(batch.drafts).toHaveLength(2);
    expect(batch.drafts[0]!.claims).toEqual([{
      text: '先做存储',
      evidence: [{ kind: 'fact', ref: 'fact-1', note: '' }],
    }]);
    expect(batch.drafts[1]!.claims[0]!.text).toBe('先做 UI，能更快看到价值');
    expect(batch.drafts[1]!.claims[0]!.evidence?.[0]?.ref).toBe('run:run-B');
    expect(batch.skipped).toEqual([{ speakerId: 'C', reason: 'credential missing' }]);
  });
});
