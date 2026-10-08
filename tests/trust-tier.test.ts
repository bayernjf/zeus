import { describe, expect, it } from 'vitest';
import { isReadOnlyTagged, tierConstraints, trustTierOf } from '../src/trust/tier.js';

describe('trustTierOf (design-external-trust, PRD E9.4)', () => {
  it('admits a card naming a registered, active agent on tier-2', () => {
    const decision = trustTierOf({ name: 'helper' }, name => name === 'helper');
    expect(decision).toEqual({ tier: 'tier-2', name: 'helper' });
  });

  it('admits an unregistered card on tier-1 (shape-trust only)', () => {
    const decision = trustTierOf({ name: 'stranger' }, () => false);
    expect(decision).toEqual({ tier: 'tier-1', name: 'stranger' });
  });

  it('treats a revoked agent as not active (status is decided by the roster)', () => {
    // The isActive predicate is the roster's own statusOf projection; a revoked
    // name must not sneak through the tier gate.
    const decision = trustTierOf({ name: 'retired' }, name => name === 'retired' && false);
    expect(decision.tier).toBe('tier-1');
  });
});

describe('tierConstraints (design-external-trust §3)', () => {
  it('binds tier-1 to plan mode, the strictest data policy, no credentials and 1/3 resources', () => {
    expect(tierConstraints('tier-1')).toEqual({
      mode: 'plan',
      injectCredentials: false,
      dataPolicy: 'none',
      resourceScale: 1 / 3,
    });
  });

  it('leaves tier-2 requests untouched (current rules)', () => {
    expect(tierConstraints('tier-2')).toEqual({
      mode: null,
      injectCredentials: true,
      dataPolicy: null,
      resourceScale: 1,
    });
  });

  it('treats tier-3 like tier-2 (signed-on-roster is the same surface)', () => {
    expect(tierConstraints('tier-3')).toEqual(tierConstraints('tier-2'));
  });

  it('refuses a constraint set for tier-0 (a refusal has no limits to apply)', () => {
    expect(() => tierConstraints('tier-0')).toThrow('tier-0 is a refusal');
  });
});

describe('isReadOnlyTagged (design-external-trust §3, V2 capability face)', () => {
  it('recognizes the read-only tag on a skill spec', () => {
    expect(isReadOnlyTagged({ tags: ['read-only'] })).toBe(true);
    expect(isReadOnlyTagged({ tags: ['analysis', 'read-only'] })).toBe(true);
  });

  it('treats a skill without tags as not read-only', () => {
    expect(isReadOnlyTagged({ tags: [] })).toBe(false);
  });

  it('treats an undeclared tags field as not read-only', () => {
    expect(isReadOnlyTagged({})).toBe(false);
  });

  it('does not confuse unrelated tags with the read-only marker', () => {
    expect(isReadOnlyTagged({ tags: ['execute', 'release'] })).toBe(false);
  });
});
