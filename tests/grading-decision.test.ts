import { describe, expect, it } from 'vitest';
import { gradeDecision, modeForGrade, GRADE_MODES } from '../src/core/grading/grade.js';
import { DEFAULT_POLICY_V1 } from '../src/core/grading/default-policy.js';
import { parsePolicy } from '../src/core/grading/policy-loader.js';
import type { DecisionPolicy, DecisionRequest } from '../src/core/grading/policy.js';

const policy = parsePolicy({
  version: 1,
  defaultGrade: 'D2',
  rules: [
    { id: 'legal', match: { riskTags: ['legal', 'compliance'] }, grade: 'D3' },
    { id: 'external', match: { impact: ['external'] }, grade: 'D3' },
    { id: 'org-irreversible', match: { impact: ['org'], reversibility: ['irreversible'] }, grade: 'D3' },
    { id: 'big', match: { amount: { min: 500.01, max: 5000, currency: 'CNY' } }, grade: 'D2' },
    { id: 'huge', match: { amount: { min: 5000.01, currency: 'CNY' } }, grade: 'D3' },
    { id: 'small', match: { amount: { min: 0, max: 500, currency: 'CNY' } }, grade: 'D1' },
    { id: 'team', match: { impact: ['team'] }, grade: 'D1' },
    { id: 'self-safe', match: { impact: ['self'], reversibility: ['reversible'] }, grade: 'D0' },
    { id: 'catch', match: {}, grade: 'D1', slaHours: 12, escalation: 'remind' },
  ],
} satisfies DecisionPolicy);

const req = (over: Partial<DecisionRequest>): DecisionRequest => ({
  intent: 'do',
  domain: 'misc',
  ...over,
});

describe('gradeDecision', () => {
  it('maps grades to modes', () => {
    expect(GRADE_MODES).toEqual({ D0: 'auto', D1: 'approve-async', D2: 'approve-sync', D3: 'human-led' });
    expect(modeForGrade('D0')).toBe('auto');
    expect(modeForGrade('D3')).toBe('human-led');
  });

  it('matches domains and intents (array OR)', () => {
    const p = parsePolicy({
      version: 1,
      defaultGrade: 'D2',
      rules: [
        { id: 'commerce', match: { domains: ['commerce', 'retail'], intents: ['refund', 'cancel'] }, grade: 'D1' },
      ],
    });
    expect(gradeDecision(p, req({ domain: 'retail', intent: 'cancel' })).ruleId).toBe('commerce');
    expect(gradeDecision(p, req({ domain: 'commerce', intent: 'refund' })).ruleId).toBe('commerce');
    expect(gradeDecision(p, req({ domain: 'hr', intent: 'refund' })).ruleId).toBe('default');
  });

  it('matches amounts: within / below / above / boundary / currency / missing', () => {
    const cny = (value: number) => req({ amount: { value, currency: 'CNY' } });
    expect(gradeDecision(policy, cny(100)).ruleId).toBe('small');
    expect(gradeDecision(policy, cny(500)).ruleId).toBe('small');
    expect(gradeDecision(policy, cny(500.01)).ruleId).toBe('big');
    expect(gradeDecision(policy, cny(5000)).ruleId).toBe('big');
    expect(gradeDecision(policy, cny(5000.01)).ruleId).toBe('huge');
    expect(gradeDecision(policy, cny(99999999)).ruleId).toBe('huge');
    expect(gradeDecision(policy, req({ amount: { value: 100, currency: 'USD' } })).ruleId).toBe('catch');
    // rule needs amount but request carries none -> amount rule does not match
    const noCatch = parsePolicy({ ...policy, rules: policy.rules.slice(0, 8) });
    expect(gradeDecision(noCatch, req({})).ruleId).toBe('default');
  });

  it('matches risk tags by any-overlap', () => {
    expect(gradeDecision(policy, req({ riskTags: ['legal'] })).ruleId).toBe('legal');
    expect(gradeDecision(policy, req({ riskTags: ['compliance', 'other'] })).ruleId).toBe('legal');
    const noCatch = parsePolicy({ ...policy, rules: policy.rules.slice(0, 8) });
    expect(gradeDecision(noCatch, req({ riskTags: ['spam'] })).ruleId).toBe('default');
    // rule asks for tags but request has none -> no match
    expect(gradeDecision(noCatch, req({})).ruleId).toBe('default');
  });

  it('matches impact and reversibility (AND across fields)', () => {
    expect(gradeDecision(policy, req({ impact: 'team' })).ruleId).toBe('team');
    expect(gradeDecision(policy, req({ impact: 'external' })).ruleId).toBe('external');
    // org alone is not enough for the org-irreversible rule (AND)
    expect(gradeDecision(policy, req({ impact: 'org' })).ruleId).toBe('catch');
    expect(gradeDecision(policy, req({ impact: 'org', reversibility: 'irreversible' })).ruleId).toBe('org-irreversible');
    expect(gradeDecision(policy, req({ impact: 'self', reversibility: 'reversible' })).ruleId).toBe('self-safe');
  });

  it('uses the first matching rule in order (highest grade wins)', () => {
    // external + small amount: external rule precedes small
    const r = gradeDecision(policy, req({ impact: 'external', amount: { value: 10, currency: 'CNY' } }));
    expect(r.ruleId).toBe('external');
    expect(r.grade).toBe('D3');
  });

  it('falls back to defaultGrade when nothing matches (fail-closed)', () => {
    const p = parsePolicy({
      version: 7,
      defaultGrade: 'D2',
      rules: [{ id: 'only-external', match: { impact: ['external'] }, grade: 'D3' }],
    });
    const r = gradeDecision(p, req({ intent: 'x', domain: 'y' }));
    expect(r).toMatchObject({ grade: 'D2', ruleId: 'default' });
    expect(r.reason).toContain('v7');
  });

  it('carries slaHours and escalation from the matched rule', () => {
    const r = gradeDecision(policy, req({}));
    expect(r.ruleId).toBe('catch');
    expect(r.slaHours).toBe(12);
    expect(r.escalation).toBe('remind');
  });

  it('reason names the matched rule and satisfied constraints', () => {
    const r = gradeDecision(policy, req({ amount: { value: 200, currency: 'CNY' } }));
    expect(r.reason).toContain('small');
    expect(r.reason).toContain('200 CNY');
  });
});

describe('DEFAULT_POLICY_V1 (拍板阈值 500/5000, D2 fail-closed)', () => {
  const cny = (value: number, over: Partial<DecisionRequest> = {}) =>
    gradeDecision(DEFAULT_POLICY_V1, req({ amount: { value, currency: 'CNY' }, ...over }));

  it('grades the amount ladder at exact boundaries', () => {
    expect(cny(100).grade).toBe('D1');
    expect(cny(500).grade).toBe('D1');
    expect(cny(500.01).grade).toBe('D2');
    expect(cny(2300).grade).toBe('D2');
    expect(cny(5000).grade).toBe('D2');
    expect(cny(5000.01).grade).toBe('D3');
    expect(cny(100000).grade).toBe('D3');
  });

  it('grades impact dimensions', () => {
    expect(gradeDecision(DEFAULT_POLICY_V1, req({ impact: 'team' })).grade).toBe('D1');
    expect(gradeDecision(DEFAULT_POLICY_V1, req({ impact: 'org' })).grade).toBe('D2');
    expect(gradeDecision(DEFAULT_POLICY_V1, req({ impact: 'external' })).grade).toBe('D3');
  });

  it('grades reversibility and risk tags', () => {
    expect(gradeDecision(DEFAULT_POLICY_V1, req({ reversibility: 'hard' })).grade).toBe('D2');
    expect(gradeDecision(DEFAULT_POLICY_V1, req({ reversibility: 'irreversible' })).grade).toBe('D3');
    expect(gradeDecision(DEFAULT_POLICY_V1, req({ riskTags: ['legal'] })).grade).toBe('D3');
    expect(gradeDecision(DEFAULT_POLICY_V1, req({ riskTags: ['pii'] })).grade).toBe('D2');
  });

  it('high dimensions override low amounts', () => {
    expect(cny(10, { impact: 'external' }).grade).toBe('D3');
    expect(cny(100, { reversibility: 'irreversible' }).grade).toBe('D3');
    expect(cny(600, { impact: 'team' }).grade).toBe('D2'); // amount D2 outranks team D1
  });

  it('matches impact/reversibility arrays with OR within the list (AND across fields)', () => {
    const pImpact = parsePolicy({
      version: 1,
      defaultGrade: 'D2',
      rules: [{ id: 'hi', match: { impact: ['org', 'external'] }, grade: 'D3' }],
    });
    expect(gradeDecision(pImpact, req({ impact: 'org' })).ruleId).toBe('hi');
    expect(gradeDecision(pImpact, req({ impact: 'external' })).ruleId).toBe('hi');
    expect(gradeDecision(pImpact, req({ impact: 'team' })).ruleId).toBe('default');

    const pRev = parsePolicy({
      version: 1,
      defaultGrade: 'D2',
      rules: [{ id: 'hard', match: { reversibility: ['hard', 'irreversible'] }, grade: 'D3' }],
    });
    expect(gradeDecision(pRev, req({ reversibility: 'hard' })).ruleId).toBe('hard');
    expect(gradeDecision(pRev, req({ reversibility: 'irreversible' })).ruleId).toBe('hard');
    expect(gradeDecision(pRev, req({ reversibility: 'reversible' })).ruleId).toBe('default');

    const pBoth = parsePolicy({
      version: 1,
      defaultGrade: 'D2',
      rules: [{ id: 'both', match: { impact: ['org'], reversibility: ['hard'] }, grade: 'D3' }],
    });
    expect(gradeDecision(pBoth, req({ impact: 'org' })).ruleId).toBe('default');
    expect(gradeDecision(pBoth, req({ impact: 'org', reversibility: 'hard' })).ruleId).toBe('both');
  });

  it('D0 for self+reversible with no amount; empty request fails closed to D2', () => {
    expect(gradeDecision(DEFAULT_POLICY_V1, req({ impact: 'self', reversibility: 'reversible' })).grade).toBe('D0');
    expect(gradeDecision(DEFAULT_POLICY_V1, req({})).grade).toBe('D2');
  });

  it('non-CNY amounts do not hit CNY amount rules (default D2 unless dimensions say otherwise)', () => {
    expect(gradeDecision(DEFAULT_POLICY_V1, req({ amount: { value: 100, currency: 'USD' } })).grade).toBe('D2');
    expect(gradeDecision(DEFAULT_POLICY_V1, req({
      amount: { value: 100, currency: 'USD' },
      impact: 'self',
      reversibility: 'reversible',
    })).grade).toBe('D0');
  });
});
