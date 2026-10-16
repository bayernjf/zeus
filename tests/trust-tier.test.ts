import { describe, expect, it } from 'vitest';
import { isReadOnlyTagged, tierConstraints, trustTierOf, type RosterAnchor } from '../src/trust/tier.js';
import { createAttestation, Ed25519MemorySigner } from '../src/registry/signing.js';
import type { AgentCard } from '../src/a2a/types.js';

function makeCard(name: string): AgentCard {
  return { name, url: `https://${name}.example/`, skills: [] };
}

describe('trustTierOf (design-external-trust, PRD E9.4)', () => {
  it('admits a card naming a registered, active agent on tier-2', () => {
    const decision = trustTierOf(makeCard('helper'), name => name === 'helper');
    expect(decision).toEqual({ tier: 'tier-2', name: 'helper' });
  });

  it('admits an unregistered card on tier-1 (shape-trust only)', () => {
    const decision = trustTierOf(makeCard('stranger'), () => false);
    expect(decision).toEqual({ tier: 'tier-1', name: 'stranger' });
  });

  it('treats a revoked agent as not active (status is decided by the roster)', () => {
    // The isActive predicate is the roster's own statusOf projection; a revoked
    // name must not sneak through the tier gate.
    const decision = trustTierOf(makeCard('retired'), name => name === 'retired' && false);
    expect(decision.tier).toBe('tier-1');
  });
});

describe('trustTierOf tier-3 (design-external-trust §4, V3 roster anchor)', () => {
  const signer = new Ed25519MemorySigner('test-rsk');
  const now = new Date('2026-10-16T00:00:00.000Z');

  /** An anchor carrying a real attestation for exactly one card. */
  async function anchorFor(card: AgentCard): Promise<RosterAnchor> {
    const attestation = await createAttestation({ name: card.name, card, cardUrl: card.url }, signer, { now, ttlSeconds: 3600 });
    return { attestationFor: name => (name === card.name ? attestation : undefined) };
  }

  it('admits a caller on tier-3 when the signed roster anchors the exact card it presents', async () => {
    const card = makeCard('helper');
    const decision = trustTierOf(card, () => true, await anchorFor(card));
    expect(decision).toEqual({ tier: 'tier-3', name: 'helper' });
  });

  it('falls back to tier-2 when the presented card no longer matches its attestation (tampered content)', async () => {
    const anchor = await anchorFor(makeCard('helper'));
    const tampered: AgentCard = { ...makeCard('helper'), url: 'https://evil.example/' };
    const decision = trustTierOf(tampered, () => true, anchor);
    expect(decision).toEqual({ tier: 'tier-2', name: 'helper' });
  });

  it('falls back to tier-2 when the anchor has no attestation for the name', async () => {
    const anchor = await anchorFor(makeCard('someone-else'));
    const decision = trustTierOf(makeCard('helper'), () => true, anchor);
    expect(decision).toEqual({ tier: 'tier-2', name: 'helper' });
  });

  it('keeps an unregistered caller on tier-1 even with an anchor present', async () => {
    const anchor = await anchorFor(makeCard('helper'));
    const decision = trustTierOf(makeCard('stranger'), () => false, anchor);
    expect(decision).toEqual({ tier: 'tier-1', name: 'stranger' });
  });

  it('keeps the no-anchor behavior unchanged: registered active is tier-2, unknown is tier-1', () => {
    expect(trustTierOf(makeCard('helper'), () => true).tier).toBe('tier-2');
    expect(trustTierOf(makeCard('stranger'), () => false).tier).toBe('tier-1');
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
