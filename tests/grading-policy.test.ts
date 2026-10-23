import { describe, expect, it } from 'vitest';
import {
  loadPolicyFromJson,
  MemoryPolicyStore,
  parsePolicy,
  validatePolicy,
} from '../src/core/grading/policy-loader.js';
import { DecisionError } from '../src/core/grading/errors.js';
import type { DecisionPolicy } from '../src/core/grading/policy.js';

const validPolicy: DecisionPolicy = {
  version: 1,
  defaultGrade: 'D2',
  rules: [
    {
      id: 'auto-low-risk',
      match: { domains: ['knowledge'], intents: ['search'], impact: ['self'], reversibility: ['reversible'] },
      grade: 'D0',
    },
    {
      id: 'refund-amount',
      match: { intents: ['refund'], amount: { min: 500, max: 5000, currency: 'CNY' }, impact: ['org'] },
      grade: 'D2',
      slaHours: 24,
    },
  ],
};

const expectInvalid = (raw: unknown, needle: string) => {
  const issues = validatePolicy(raw);
  expect(issues.length, `expected rejection for ${JSON.stringify(raw)}`).toBeGreaterThan(0);
  expect(
    issues.some(i => i.includes(needle)),
    `expected issue containing "${needle}", got ${JSON.stringify(issues)}`
  ).toBe(true);
};

describe('decision policy loader', () => {
  it('accepts a valid policy (minimal and full)', () => {
    expect(parsePolicy({ version: 1, defaultGrade: 'D2', rules: [] })).toEqual({
      version: 1,
      defaultGrade: 'D2',
      rules: [],
    });
    expect(parsePolicy(validPolicy).rules).toHaveLength(2);
    expect(validatePolicy(validPolicy)).toEqual([]);
  });

  it('accepts every grade / impact / reversibility literal', () => {
    const policy = {
      version: 2,
      defaultGrade: 'D0',
      rules: [
        { id: 'all-impacts', match: { impact: ['external'], reversibility: ['irreversible'] }, grade: 'D3' },
        { id: 'hard', match: { reversibility: ['hard'] }, grade: 'D2' },
      ],
    };
    expect(validatePolicy(policy)).toEqual([]);
  });

  it('rejects non-object policies', () => {
    expectInvalid(null, 'expected an object');
    expectInvalid('nope', 'expected an object');
    expectInvalid([], 'expected an object');
  });

  it('rejects missing / illegal version', () => {
    expectInvalid({ defaultGrade: 'D2', rules: [] }, 'version');
    expectInvalid({ version: 0, defaultGrade: 'D2', rules: [] }, 'version');
    expectInvalid({ version: -1, defaultGrade: 'D2', rules: [] }, 'version');
    expectInvalid({ version: 1.5, defaultGrade: 'D2', rules: [] }, 'version');
    expectInvalid({ version: '1', defaultGrade: 'D2', rules: [] }, 'version');
  });

  it('rejects missing / unknown defaultGrade', () => {
    expectInvalid({ version: 1, rules: [] }, 'defaultGrade');
    expectInvalid({ version: 1, defaultGrade: 'D4', rules: [] }, 'defaultGrade');
    expectInvalid({ version: 1, defaultGrade: 'd2', rules: [] }, 'defaultGrade');
  });

  it('rejects rules that are not an array', () => {
    expectInvalid({ version: 1, defaultGrade: 'D2', rules: {} }, 'rules');
    expectInvalid({ version: 1, defaultGrade: 'D2', rules: null }, 'rules');
  });

  it('rejects rules with missing or duplicate ids', () => {
    expectInvalid({ version: 1, defaultGrade: 'D2', rules: [{ id: '', match: {}, grade: 'D0' }] }, 'id');
    expectInvalid({ version: 1, defaultGrade: 'D2', rules: [{ match: {}, grade: 'D0' }] }, 'id');
    expectInvalid(
      {
        version: 1,
        defaultGrade: 'D2',
        rules: [
          { id: 'x', match: {}, grade: 'D0' },
          { id: 'x', match: {}, grade: 'D1' },
        ],
      },
      'duplicate'
    );
  });

  it('rejects unknown grade on rules', () => {
    expectInvalid({ version: 1, defaultGrade: 'D2', rules: [{ id: 'x', match: {}, grade: 'D9' }] }, 'grade');
  });

  it('rejects illegal amount ranges', () => {
    const rule = (amount: unknown) => ({
      version: 1,
      defaultGrade: 'D2',
      rules: [{ id: 'x', grade: 'D0', match: { amount } }],
    });
    expectInvalid(rule({ min: -1, max: 10, currency: 'CNY' }), 'min');
    expectInvalid(rule({ min: 100, max: 10, currency: 'CNY' }), 'min');
    expectInvalid(rule({ min: 0, max: 10, currency: 'cny' }), 'currency');
    expectInvalid(rule({ min: 0, max: 10, currency: 'CNY', extra: 1 }), 'unknown field');
    expectInvalid(rule(null), 'expected an object');
  });

  it('accepts an open upper bound (max omitted) and a zero lower bound', () => {
    expect(
      validatePolicy({
        version: 1,
        defaultGrade: 'D2',
        rules: [{ id: 'x', match: { amount: { min: 5000.01, currency: 'CNY' } }, grade: 'D3' }],
      })
    ).toEqual([]);
    expectInvalid(
      { version: 1, defaultGrade: 'D2', rules: [{ id: 'x', match: { amount: { max: 10, currency: 'CNY' } }, grade: 'D3' }] },
      'min'
    );
  });

  it('rejects illegal impact, reversibility, slaHours and string lists', () => {
    expectInvalid({ version: 1, defaultGrade: 'D2', rules: [{ id: 'x', match: { impact: 'world' }, grade: 'D0' }] }, 'impact');
    expectInvalid({ version: 1, defaultGrade: 'D2', rules: [{ id: 'x', match: { impact: ['world'] }, grade: 'D0' }] }, 'impact');
    expectInvalid({ version: 1, defaultGrade: 'D2', rules: [{ id: 'x', match: { reversibility: 'maybe' }, grade: 'D0' }] }, 'reversibility');
    expectInvalid({ version: 1, defaultGrade: 'D2', rules: [{ id: 'x', match: { reversibility: ['maybe'] }, grade: 'D0' }] }, 'reversibility');
    expectInvalid({ version: 1, defaultGrade: 'D2', rules: [{ id: 'x', match: {}, grade: 'D0', slaHours: 0 }] }, 'slaHours');
    expectInvalid({ version: 1, defaultGrade: 'D2', rules: [{ id: 'x', match: { domains: ['ok', ''] }, grade: 'D0' }] }, 'domains');
    expectInvalid({ version: 1, defaultGrade: 'D2', rules: [{ id: 'x', match: { intents: 'nope' }, grade: 'D0' }] }, 'intents');
  });

  it('rejects malformed match block and unknown fields (fail-closed, no silent ignores)', () => {
    expectInvalid({ version: 1, defaultGrade: 'D2', rules: [{ id: 'x', grade: 'D0' }] }, 'match');
    expectInvalid({ version: 1, defaultGrade: 'D2', rules: [{ id: 'x', match: null, grade: 'D0' }] }, 'match');
    expectInvalid({ version: 1, defaultGrade: 'D2', rules: [{ id: 'x', match: { domians: ['x'] }, grade: 'D0' }] }, 'unknown field');
    expectInvalid({ version: 1, defaultGrade: 'D2', rules: [{ id: 'x', match: {}, grade: 'D0', escalate: 'me' }] }, 'unknown field');
    expectInvalid({ version: 1, defaultGrade: 'D2', rules: [], future: true }, 'unknown field');
  });

  it('collects every issue at once rather than failing on the first', () => {
    const issues = validatePolicy({ version: 0, rules: 'no' });
    expect(issues.length).toBeGreaterThanOrEqual(2);
  });

  it('parsePolicy throws ValidationError carrying code and issue list', () => {
    try {
      parsePolicy({ version: 1, defaultGrade: 'D2', rules: [{ id: 'x', match: {}, grade: 'D9' }] });
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(DecisionError);
      expect((error as DecisionError).code).toBe('VALIDATION_FAILED');
      expect((error as DecisionError).details).toEqual(
        expect.arrayContaining([expect.stringContaining('grade')])
      );
    }
  });

  it('loadPolicyFromJson wraps JSON syntax errors as VALIDATION_FAILED', () => {
    expect(() => loadPolicyFromJson('{bad')).toThrowError(DecisionError);
    expect(loadPolicyFromJson('{"version":1,"defaultGrade":"D2","rules":[]}').version).toBe(1);
  });
});

describe('MemoryPolicyStore', () => {
  const seed = (): DecisionPolicy => ({
    version: 1,
    defaultGrade: 'D2',
    rules: [{ id: 'r1', match: { domains: ['commerce'] }, grade: 'D1' }],
  });

  it('throws POLICY_NOT_FOUND when empty (latest and specific version)', () => {
    const store = new MemoryPolicyStore();
    expect(() => store.get()).toThrowError(/no decision policy available/);
    expect(() => store.get(99)).toThrowError(/version 99 not found/);
    for (const call of [() => store.get(), () => store.get(99)]) {
      try {
        call();
        throw new Error('expected throw');
      } catch (error) {
        expect((error as DecisionError).code).toBe('POLICY_NOT_FOUND');
      }
    }
  });

  it('returns the latest version by default and exact versions on request', () => {
    const store = new MemoryPolicyStore();
    store.put(seed());
    store.put({ version: 2, defaultGrade: 'D1', rules: [] });
    expect(store.get().version).toBe(2);
    expect(store.get(1)?.defaultGrade).toBe('D2');
    expect(store.versions()).toEqual([1, 2]);
    expect(store.has(1)).toBe(true);
    expect(store.has(3)).toBe(false);
  });

  it('rejects duplicate versions (append-only for rollback) and malformed puts', () => {
    const store = new MemoryPolicyStore();
    store.put(seed());
    expect(() => store.put(seed())).toThrowError(/already exists/);
    expect(() =>
      store.put({
        ...seed(),
        version: 3,
        rules: [{ id: 'x', match: {}, grade: 'ZZ' }],
      } as unknown as DecisionPolicy)
    ).toThrowError(DecisionError);
  });
});
