import { describe, expect, it } from 'vitest';
import {
  DecisionAuditChain,
  DecisionError,
  DecisionService,
  MemoryDecisionStore,
  PolicyNotFoundError,
  ValidationError,
  MemoryPolicyStore,
  Ed25519MemorySigner,
  verifyDecisionAuditChain,
} from '../src/core/index.js';
import { DEFAULT_POLICY_V1 } from '../src/core/grading/default-policy.js';
import type { DecisionPolicy } from '../src/core/grading/policy.js';

function harnessed(now: { t: string } = { t: '2026-10-22T00:00:00.000Z' }) {
  const signer = new Ed25519MemorySigner('audit-seal-test');
  const audit = new DecisionAuditChain(signer, () => now.t);
  const verifier = signer.verifier();
  const policyStore = new MemoryPolicyStore();
  policyStore.put(DEFAULT_POLICY_V1);
  const recordStore = new MemoryDecisionStore();
  const service = new DecisionService({
    policyStore,
    recordStore,
    audit,
    clock: () => now.t,
    idGen: (() => {
      let n = 0;
      return () => `dec_${(++n).toString(36)}`;
    })(),
  });
  return { service, audit, policyStore, recordStore, signer, verifier, now };
}

const baseReq = {
  intent: 'refund',
  domain: 'commerce',
  impact: 'self' as const,
  reversibility: 'reversible' as const,
};

describe('T-M1-06 DecisionService: grade -> status', () => {
  it('D0 self/reversible settles immediately as decided/auto', async () => {
    const { service, audit } = harnessed();
    const rec = await service.createDecision({ ...baseReq });
    expect(rec.grade).toBe('D0');
    expect(rec.mode).toBe('auto');
    expect(rec.status).toBe('decided');
    expect(rec.decidedAt).toBeDefined();
    expect(rec.result?.outcome).toBe('auto');
    expect(rec.ruleId).toBe('d0-self-reversible');
    expect(audit.length).toBe(1);
    expect(audit.list()[0]?.payload.kind).toBe('decision.created');
  });

  it('D1 small amount waits for async approval', async () => {
    const { service } = harnessed();
    const rec = await service.createDecision({
      ...baseReq,
      amount: { value: 100, currency: 'CNY' },
    });
    expect(rec.grade).toBe('D1');
    expect(rec.mode).toBe('approve-async');
    expect(rec.status).toBe('awaiting_approval');
    expect(rec.decidedAt).toBeUndefined();
  });

  it('D2 mid amount is blocked for synchronous approval', async () => {
    const { service } = harnessed();
    const rec = await service.createDecision({
      ...baseReq,
      impact: 'org',
      reversibility: 'hard',
      amount: { value: 1000, currency: 'CNY' },
    });
    expect(rec.grade).toBe('D2');
    expect(rec.mode).toBe('approve-sync');
    expect(rec.status).toBe('blocked');
  });

  it('D3 large amount is blocked/human-led', async () => {
    const { service } = harnessed();
    const rec = await service.createDecision({
      ...baseReq,
      impact: 'org',
      reversibility: 'hard',
      amount: { value: 9000, currency: 'CNY' },
    });
    expect(rec.grade).toBe('D3');
    expect(rec.mode).toBe('human-led');
    expect(rec.status).toBe('blocked');
  });

  it('D3 external impact is human-led even without an amount', async () => {
    const { service } = harnessed();
    const rec = await service.createDecision({
      ...baseReq,
      impact: 'external',
      reversibility: 'reversible',
    });
    expect(rec.grade).toBe('D3');
    expect(rec.mode).toBe('human-led');
  });
});

describe('T-M1-06 DecisionService: approval lifecycle', () => {
  it('approves a D2 decision into decided and seals the audit entry', async () => {
    const { service, audit } = harnessed();
    const created = await service.createDecision({
      ...baseReq,
      impact: 'org',
      reversibility: 'hard',
      amount: { value: 1000, currency: 'CNY' },
    });
    const approved = await service.approve(created.id, { decision: 'approve', approver: 'owner', comment: 'ok' });
    expect(approved.status).toBe('decided');
    expect(approved.decidedAt).toBeDefined();
    expect(approved.result).toMatchObject({ outcome: 'approved', approver: 'owner', comment: 'ok' });
    expect(approved.approvals).toHaveLength(1);
    expect(audit.list()[1]?.payload.kind).toBe('decision.approved');
    expect(audit.list()[1]?.payload.actor).toBe('owner');
  });

  it('rejects a D1 decision and seals decision.rejected', async () => {
    const { service, audit } = harnessed();
    const created = await service.createDecision({
      ...baseReq,
      amount: { value: 50, currency: 'CNY' },
    });
    const rejected = await service.approve(created.id, { decision: 'reject', approver: 'owner', comment: 'no' });
    expect(rejected.status).toBe('rejected');
    expect(rejected.result?.outcome).toBe('rejected');
    expect(audit.list()[1]?.payload.kind).toBe('decision.rejected');
  });

  it('refuses approval on a settled decision', async () => {
    const { service } = harnessed();
    const created = await service.createDecision({ ...baseReq }); // D0 decided
    await expect(
      service.approve(created.id, { decision: 'approve', approver: 'owner' }),
    ).rejects.toMatchObject({ name: 'DecisionError' });
  });

  it('throws when the decision id does not exist', async () => {
    const { service } = harnessed();
    await expect(service.approve('dec_nope', { decision: 'approve', approver: 'owner' }))
      .rejects.toThrow(/decision not found/);
  });

  it('validates the approval body', async () => {
    const { service } = harnessed();
    const created = await service.createDecision({
      ...baseReq, impact: 'org', reversibility: 'hard', amount: { value: 1000, currency: 'CNY' },
    });
    await expect(
      service.approve(created.id, { decision: 'maybe' as 'approve', approver: '' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('T-M1-06 DecisionService: SLA timeout', () => {
  function slaHarness() {
    const now = { t: '2026-10-22T00:00:00.000Z' };
    const h = harnessed(now);
    const policy: DecisionPolicy = {
      version: 2,
      defaultGrade: 'D2',
      rules: [
        { id: 'd1-amount', match: { amount: { min: 0, max: 500, currency: 'CNY' } }, grade: 'D1', slaHours: 1 },
        { id: 'd2-amount', match: { amount: { min: 500.01, max: 5000, currency: 'CNY' } }, grade: 'D2', slaHours: 24 },
        { id: 'd0-self-reversible', match: { impact: ['self'], reversibility: ['reversible'] }, grade: 'D0' },
      ],
    };
    h.policyStore.put(policy);
    return h;
  }

  it('sets timeoutAt from slaHours; breach enters late, grace closes it timed-out', async () => {
    const h = slaHarness();
    const created = await h.service.createDecision({
      ...baseReq, impact: 'org', reversibility: 'hard', amount: { value: 100, currency: 'CNY' },
    });
    expect(created.slaHours).toBe(1);
    expect(created.timeoutAt).toBe('2026-10-22T01:00:00.000Z');
    expect(await h.service.sweepTimeouts(h.now.t)).toHaveLength(0);
    h.now.t = '2026-10-22T00:59:59.000Z';
    expect(await h.service.sweepTimeouts(h.now.t)).toHaveLength(0);
    // Phase 1: breach marks late; nothing terminal yet (default grace 72h).
    h.now.t = '2026-10-22T01:00:00.000Z';
    expect(await h.service.sweepTimeouts(h.now.t)).toHaveLength(0);
    const breached = await h.service.get(created.id);
    expect(breached?.status).toBe('awaiting_approval');
    expect(breached?.lateAt).toBe('2026-10-22T01:00:00.000Z');
    expect(h.audit.list()[1]?.payload.kind).toBe('decision.late');
    // Phase 2: the grace window elapsed -> terminal timed-out.
    h.now.t = '2026-10-25T01:00:01.000Z';
    const timedOut = await h.service.sweepTimeouts(h.now.t);
    expect(timedOut).toHaveLength(1);
    expect(timedOut[0]?.status).toBe('rejected');
    expect(timedOut[0]?.result?.outcome).toBe('timed-out');
    expect(h.audit.list()[h.audit.list().length - 1]?.payload.kind).toBe('decision.timed-out');
  });

  it('marks late lazily on get while the window is open', async () => {
    const h = slaHarness();
    const created = await h.service.createDecision({
      ...baseReq, impact: 'org', reversibility: 'hard', amount: { value: 100, currency: 'CNY' },
    });
    h.now.t = '2026-10-22T02:00:00.000Z'; // past timeoutAt, inside the 72h grace window
    const fetched = await h.service.get(created.id);
    expect(fetched?.status).toBe('awaiting_approval');
    expect(fetched?.lateAt).toBe('2026-10-22T02:00:00.000Z');
    // Still approvable while the window is open.
    await expect(
      h.service.approve(created.id, { decision: 'approve', approver: 'owner' }),
    ).resolves.toMatchObject({ status: 'decided', result: { outcome: 'approved' } });
  });

  it('refuses verdicts only after the grace window closed the decision timed-out', async () => {
    const h = slaHarness();
    const created = await h.service.createDecision({
      ...baseReq, impact: 'org', reversibility: 'hard', amount: { value: 100, currency: 'CNY' },
    });
    h.now.t = '2026-10-25T01:00:01.000Z'; // breach (01:00) + 72h grace + 1s
    const fetched = await h.service.get(created.id);
    expect(fetched?.status).toBe('rejected');
    expect(fetched?.result?.outcome).toBe('timed-out');
    await expect(
      h.service.approve(created.id, { decision: 'approve', approver: 'owner' }),
    ).rejects.toBeInstanceOf(DecisionError);
  });
});

describe('T-M8 pending-but-late window', () => {
  function lateHarness(graceHours: number) {
    const now = { t: '2026-10-22T00:00:00.000Z' };
    const signer = new Ed25519MemorySigner('audit-seal-test');
    const audit = new DecisionAuditChain(signer, () => now.t);
    const policyStore = new MemoryPolicyStore();
    policyStore.put(DEFAULT_POLICY_V1);
    const recordStore = new MemoryDecisionStore();
    const service = new DecisionService({
      policyStore,
      recordStore,
      audit,
      clock: () => now.t,
      lateGraceHours: graceHours,
      idGen: (() => {
        let n = 0;
        return () => `dec_${(++n).toString(36)}`;
      })(),
    });
    return { service, audit, policyStore, recordStore, now };
  }

  it('stamps lateAt exactly once: repeated reads do not duplicate decision.late', async () => {
    const h = lateHarness(72);
    const created = await h.service.createDecision({
      ...baseReq, impact: 'org', amount: { value: 1200, currency: 'CNY' },
    });
    h.now.t = '2026-10-23T00:00:01.000Z'; // past 24h D2 SLA, inside grace
    await h.service.get(created.id);
    await h.service.get(created.id);
    await h.service.list({ domain: 'commerce' });
    const lateEntries = h.audit.list().filter(e => e.payload.kind === 'decision.late');
    expect(lateEntries).toHaveLength(1);
    expect((await h.service.get(created.id))?.lateAt).toBe('2026-10-23T00:00:01.000Z');
  });

  it('a late decision can still be rejected by an operator', async () => {
    const h = lateHarness(72);
    const created = await h.service.createDecision({
      ...baseReq, impact: 'org', amount: { value: 1200, currency: 'CNY' },
    });
    h.now.t = '2026-10-23T12:00:00.000Z';
    const settled = await h.service.approve(created.id, { decision: 'reject', approver: 'ops' });
    expect(settled.status).toBe('rejected');
    expect(settled.result?.outcome).toBe('rejected');
  });

  it('lateGraceHours=0 reproduces the old read-and-reject behavior', async () => {
    const h = lateHarness(0);
    const created = await h.service.createDecision({
      ...baseReq, impact: 'org', amount: { value: 1200, currency: 'CNY' },
    });
    h.now.t = '2026-10-23T00:00:00.000Z'; // exactly at the 24h SLA
    const fetched = await h.service.get(created.id);
    expect(fetched?.status).toBe('rejected');
    expect(fetched?.result?.outcome).toBe('timed-out');
  });

  it('reverse gate: a decided D0 record never enters late no matter how late the clock', async () => {
    const h = lateHarness(72);
    const created = await h.service.createDecision({ ...baseReq });
    h.now.t = '2027-01-01T00:00:00.000Z';
    const fetched = await h.service.get(created.id);
    expect(fetched?.status).toBe('decided');
    expect(fetched?.lateAt).toBeUndefined();
    expect(fetched?.timeoutAt).toBeUndefined();
  });

  it('replay renders the late event between created and approval', async () => {
    const h = lateHarness(72);
    const created = await h.service.createDecision({
      ...baseReq, impact: 'org', amount: { value: 1200, currency: 'CNY' },
    });
    h.now.t = '2026-10-23T12:00:00.000Z';
    await h.service.get(created.id);
    await h.service.approve(created.id, { decision: 'approve', approver: 'ops' });
    const record = (await h.service.get(created.id))!;
    const types = h.service.replay(record).events.map(e => e.type);
    expect(types).toEqual(['decision.created', 'decision.late', 'decision.approved']);
  });
});

describe('T-M8 slaHours on default policy rules', () => {
  it('D2 decisions created under DEFAULT_POLICY_V1 carry slaHours and timeoutAt', async () => {
    const { service } = harnessed();
    const d2 = await service.createDecision({
      ...baseReq, impact: 'org', reversibility: 'hard', amount: { value: 1200, currency: 'CNY' },
    });
    expect(d2.ruleId).toBe('d2-amount');
    expect(d2.slaHours).toBe(24);
    expect(d2.timeoutAt).toBe('2026-10-23T00:00:00.000Z');
  });

  it('D3 decisions created under DEFAULT_POLICY_V1 carry slaHours and timeoutAt', async () => {
    const { service } = harnessed();
    const d3 = await service.createDecision({
      ...baseReq, impact: 'external', reversibility: 'hard', amount: { value: 9000, currency: 'CNY' },
    });
    expect(d3.ruleId).toBe('d3-amount-large');
    expect(d3.slaHours).toBe(72);
    expect(d3.timeoutAt).toBe('2026-10-25T00:00:00.000Z');
  });

  it('reverse gate: D1 and D0 under the default policy carry no slaHours/timeoutAt', async () => {
    const { service } = harnessed();
    const d1 = await service.createDecision({ ...baseReq, amount: { value: 100, currency: 'CNY' } });
    expect(d1.ruleId).toBe('d1-amount');
    expect(d1.slaHours).toBeUndefined();
    expect(d1.timeoutAt).toBeUndefined();
    const d0 = await service.createDecision({ ...baseReq });
    expect(d0.ruleId).toBe('d0-self-reversible');
    expect(d0.slaHours).toBeUndefined();
    expect(d0.timeoutAt).toBeUndefined();
  });

  it('reverse gate: a custom rule without slaHours never produces timeoutAt', async () => {
    const h = harnessed();
    const noSlaPolicy: DecisionPolicy = {
      version: 2,
      defaultGrade: 'D2',
      rules: [
        { id: 'd2-amount', match: { amount: { min: 500.01, max: 5000, currency: 'CNY' } }, grade: 'D2' },
        { id: 'd0-self-reversible', match: { impact: ['self'], reversibility: ['reversible'] }, grade: 'D0' },
      ],
    };
    h.policyStore.put(noSlaPolicy);
    const rec = await h.service.createDecision({
      ...baseReq, impact: 'org', reversibility: 'hard', amount: { value: 1200, currency: 'CNY' },
    });
    expect(rec.slaHours).toBeUndefined();
    expect(rec.timeoutAt).toBeUndefined();
    // Far past any plausible SLA: a rule without slaHours must not time out.
    h.now.t = '2027-01-01T00:00:00.000Z';
    expect(await h.service.sweepTimeouts(h.now.t)).toHaveLength(0);
    const fetched = await h.service.get(rec.id);
    expect(fetched?.status).toBe('blocked');
  });
});

describe('T-M1-06 DecisionService: idempotency', () => {
  it('returns the same record for the same key and request', async () => {
    const { service } = harnessed();
    const body = {
      ...baseReq, impact: 'org' as const, reversibility: 'hard' as const,
      amount: { value: 1000, currency: 'CNY' }, idempotencyKey: 'idem-1',
    };
    const a = await service.createDecision(body);
    const b = await service.createDecision(body);
    expect(b.id).toBe(a.id);
  });

  it('conflicts when the same key carries a different request', async () => {
    const { service } = harnessed();
    await service.createDecision({
      ...baseReq, impact: 'org', reversibility: 'hard',
      amount: { value: 1000, currency: 'CNY' }, idempotencyKey: 'idem-2',
    });
    await expect(service.createDecision({
      ...baseReq, impact: 'org', reversibility: 'hard',
      amount: { value: 2000, currency: 'CNY' }, idempotencyKey: 'idem-2',
    })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
});

describe('T-M1-06 DecisionService: policy, validation, replay', () => {
  it('raises POLICY_NOT_FOUND when no policy is loaded', async () => {
    const { recordStore, audit } = harnessed();
    const empty = new DecisionService({
      policyStore: new MemoryPolicyStore(),
      recordStore,
      audit,
    });
    await expect(empty.createDecision({ ...baseReq })).rejects.toBeInstanceOf(PolicyNotFoundError);
  });

  it('reports validation issues all at once', async () => {
    const { service } = harnessed();
    await expect(
      service.createDecision({ intent: '', domain: '', impact: 'bad' as 'self', reversibility: 'nope' as 'reversible' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects unknown request fields', async () => {
    const { service } = harnessed();
    await expect(
      service.createDecision({ ...baseReq, unexpected: 1 } as never),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('updates policy with a higher version and seals policy.updated', async () => {
    const { service, audit, policyStore } = harnessed();
    const next: DecisionPolicy = { ...DEFAULT_POLICY_V1, version: 2 };
    await service.updatePolicy(next, 'admin');
    expect(service.getPolicy().version).toBe(2);
    expect(policyStore.get(1).version).toBe(1); // old version retained
    expect(audit.list().at(-1)?.payload.kind).toBe('policy.updated');
    await expect(service.updatePolicy(next, 'admin')).rejects.toBeInstanceOf(DecisionError);
  });

  it('filters the list by domain and status', async () => {
    const { service } = harnessed();
    await service.createDecision({ ...baseReq, domain: 'commerce' });
    await service.createDecision({
      ...baseReq, domain: 'finance', impact: 'org', reversibility: 'hard',
      amount: { value: 1000, currency: 'CNY' },
    });
    expect(await service.list({ domain: 'finance' })).toHaveLength(1);
    expect(await service.list({ status: 'blocked' })).toHaveLength(1);
    expect(await service.list({ domain: 'commerce', status: 'decided' })).toHaveLength(1);
  });

  it('replays a decision as json and text', async () => {
    const { service } = harnessed();
    const created = await service.createDecision({
      ...baseReq, impact: 'org', reversibility: 'hard', amount: { value: 1000, currency: 'CNY' },
    });
    await service.approve(created.id, { decision: 'approve', approver: 'owner' });
    const record = (await service.get(created.id))!;
    const replay = service.replay(record);
    expect(replay.format).toBe('json');
    expect(replay.events.map(e => e.type)).toEqual(['decision.created', 'decision.approved']);
    const text = service.renderReplay(record);
    expect(text).toContain('D2');
    expect(text).toContain('decision.approved by owner');
  });

  it('produces a fully verifiable audit chain across all event kinds', async () => {
    const { service, audit, verifier } = harnessed();
    const d2 = await service.createDecision({
      ...baseReq, impact: 'org', reversibility: 'hard', amount: { value: 1000, currency: 'CNY' },
    });
    await service.approve(d2.id, { decision: 'approve', approver: 'owner' });
    const d3 = await service.createDecision({
      ...baseReq, impact: 'org', reversibility: 'hard', amount: { value: 9000, currency: 'CNY' },
    });
    await service.approve(d3.id, { decision: 'reject', approver: 'owner' });
    const result = await verifyDecisionAuditChain(audit.list(), verifier);
    expect(result).toEqual({ ok: true, count: 4 });
  });
});
