import { describe, expect, it } from 'vitest';
import {
  DomainGrantError,
  DomainGrantRegistry,
  decideRealmAccess,
  verifyDomainGrant,
} from '../src/realm/authorization.js';
import type { DomainGrant, RealmActor } from '../src/realm/types.js';

const NOW = new Date('2026-09-25T00:00:00.000Z');
const now = () => NOW;

const driver: RealmActor = { kind: 'driver', id: 'driver' };
const deptVassal: RealmActor = { kind: 'vassal', id: 'loom', tenant: { org: 'acme', department: 'eng' } };
const orgVassal: RealmActor = { kind: 'vassal', id: 'pr-helper', tenant: { org: 'acme' } };
const personalVassal: RealmActor = { kind: 'vassal', id: 'jev' };

const deptRealm = { realmId: 'realm-dept', type: 'enterprise' as const, tenant: { org: 'acme', department: 'eng' }, readOnly: false };
const mktRealm = { realmId: 'realm-mkt', type: 'enterprise' as const, tenant: { org: 'acme', department: 'mkt' }, readOnly: false };
const orgRealm = { realmId: 'realm-org', type: 'enterprise' as const, tenant: { org: 'acme' }, readOnly: false };
const unscopedRealm = { realmId: 'realm-plain', type: 'enterprise' as const, readOnly: false };
const personalRealm = { realmId: 'realm-me', type: 'personal' as const, readOnly: false };
const readOnlyPersonal = { realmId: 'realm-ro', type: 'personal' as const, readOnly: true };

function grant(over: Partial<DomainGrant> = {}): DomainGrant {
  return {
    kind: 'domain-access',
    grantId: over.grantId ?? 'g1',
    subject: over.subject ?? 'jev',
    realmId: over.realmId ?? 'realm-dept',
    access: over.access ?? 'read',
    grantedBy: over.grantedBy ?? 'driver',
    grantedAt: over.grantedAt ?? NOW.toISOString(),
    nonce: over.nonce ?? 'n1',
    ...(over.expiresAt ? { expiresAt: over.expiresAt } : {}),
    ...(over.reason ? { reason: over.reason } : {}),
  };
}

describe('E6.4 decideRealmAccess: the hierarchy is structural', () => {
  it('lets an org subject reach down into its departments', () => {
    expect(decideRealmAccess({ actor: orgVassal, realm: deptRealm, access: 'read' })).toEqual({
      ok: true,
      via: 'tenant-hierarchy',
    });
  });

  it('refuses a department looking up at the org corpus', () => {
    const decision = decideRealmAccess({ actor: deptVassal, realm: orgRealm, access: 'read' });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe('tenant-out-of-scope');
  });

  it('refuses a department looking sideways at its sibling', () => {
    const decision = decideRealmAccess({ actor: deptVassal, realm: mktRealm, access: 'read' });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe('tenant-out-of-scope');
  });

  it('refuses a tenant-scoped subject on an unscoped enterprise realm', () => {
    // An unscoped realm has nothing to match against, so only the driver may use
    // it; quietly letting any subject in would be the widened mount the tenant
    // exists to prevent.
    const decision = decideRealmAccess({ actor: orgVassal, realm: unscopedRealm, access: 'read' });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe('tenant-out-of-scope');
  });
});

describe('E6.4 decideRealmAccess: the domain edge', () => {
  it('never lets an enterprise subject read the personal domain, grant or not', () => {
    const decision = decideRealmAccess({
      actor: deptVassal,
      realm: personalRealm,
      access: 'read',
      grants: [grant({ subject: 'loom', realmId: 'realm-me', access: 'read' })],
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe('enterprise-to-personal');
  });

  it('requires an explicit grant for a personal-side subject to read enterprise content', () => {
    const without = decideRealmAccess({ actor: personalVassal, realm: deptRealm, access: 'read' });
    expect(without.ok).toBe(false);
    if (!without.ok) expect(without.reason).toBe('no-grant');

    const withGrant = decideRealmAccess({
      actor: personalVassal,
      realm: deptRealm,
      access: 'read',
      grants: [grant()],
      now,
    });
    expect(withGrant).toEqual({ ok: true, via: 'grant', grantId: 'g1' });
  });

  it('does not let a read grant authorize a write, and says which is missing', () => {
    const decision = decideRealmAccess({
      actor: personalVassal,
      realm: deptRealm,
      access: 'write',
      grants: [grant({ access: 'read' })],
      now,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe('access-not-granted');
  });

  it('binds a grant to its subject and to its realm', () => {
    const otherSubject = decideRealmAccess({
      actor: { kind: 'vassal', id: 'someone-else' },
      realm: deptRealm,
      access: 'read',
      grants: [grant()],
      now,
    });
    expect(otherSubject.ok).toBe(false);

    const otherRealm = decideRealmAccess({
      actor: personalVassal,
      realm: mktRealm,
      access: 'read',
      grants: [grant()],
      now,
    });
    expect(otherRealm.ok).toBe(false);
  });

  it('stops honoring a grant the moment it expires', () => {
    const expired = grant({ expiresAt: new Date(NOW.getTime() - 1).toISOString() });
    const decision = decideRealmAccess({
      actor: personalVassal,
      realm: deptRealm,
      access: 'read',
      grants: [expired],
      now,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe('grant-expired');
    expect(verifyDomainGrant(expired, { subject: 'jev', realmId: 'realm-dept', access: 'read' }, now)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('refuses writes into a read-only realm even for the driver', () => {
    const decision = decideRealmAccess({ actor: driver, realm: readOnlyPersonal, access: 'write' });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe('read-only');
    expect(decideRealmAccess({ actor: driver, realm: readOnlyPersonal, access: 'read' })).toEqual({
      ok: true,
      via: 'same-domain',
    });
  });

  it('treats the driver as the authorizer (they own both domains)', () => {
    expect(decideRealmAccess({ actor: driver, realm: deptRealm, access: 'read' })).toEqual({
      ok: true,
      via: 'same-domain',
    });
  });
});

describe('E6.4 verifyDomainGrant shape rules', () => {
  const expected = { subject: 'jev', realmId: 'realm-dept', access: 'read' as const };

  it('rejects a credential that is missing any binding', () => {
    expect(verifyDomainGrant(grant({ nonce: '' }), expected, now)).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyDomainGrant(grant({ grantedAt: 'not-a-date' }), expected, now)).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyDomainGrant(grant({ grantedBy: '' }), expected, now)).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyDomainGrant({ ...grant(), kind: 'driver-write' as never }, expected, now)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('separates a wrong binding from a wrong access', () => {
    expect(verifyDomainGrant(grant({ realmId: 'other' }), expected, now)).toEqual({ ok: false, reason: 'wrong-realm' });
    expect(verifyDomainGrant(grant({ access: 'write' }), expected, now)).toEqual({ ok: false, reason: 'wrong-access' });
    expect(verifyDomainGrant(grant({ subject: 'x' }), expected, now)).toEqual({ ok: false, reason: 'wrong-subject' });
  });
});

describe('E6.4 grant registry lifecycle', () => {
  it('issues a grant, stamps it, and reports it in the audit trail', () => {
    const entries: string[] = [];
    const registry = new DomainGrantRegistry(now, entry => entries.push(`${entry.decision}:${entry.grantId}`));
    const issued = registry.issue({ subject: 'jev', realmId: 'realm-dept', access: 'read', grantedBy: 'driver', nonce: 'n9' });
    expect(issued).toMatchObject({ kind: 'domain-access', grantId: expect.stringMatching(/^grant-/), grantedAt: NOW.toISOString() });
    expect(registry.list()).toHaveLength(1);
    expect(entries).toEqual([`grant-issued:${issued.grantId}`]);
  });

  it('mints a distinct nonce when the issuer supplies none, and refuses a replayed one', () => {
    const registry = new DomainGrantRegistry(now);
    const a = registry.issue({ subject: 'jev', realmId: 'r', access: 'read', grantedBy: 'driver' });
    const b = registry.issue({ subject: 'jev', realmId: 'r', access: 'write', grantedBy: 'driver' });
    expect(a.nonce).toMatch(/[0-9a-f-]{20,}/);
    expect(a.nonce).not.toBe(b.nonce);
    // An explicitly supplied nonce is still a claim, and a claim cannot be made twice.
    registry.issue({ grantId: 'a1', subject: 'jev', realmId: 'r', access: 'read', grantedBy: 'driver', nonce: 'same' });
    expect(() => registry.issue({ grantId: 'b1', subject: 'jev', realmId: 'r', access: 'read', grantedBy: 'driver', nonce: 'same' }))
      .toThrow(/already used/);
  });

  it('refuses to overwrite a live grant id but never resurrects a spent nonce by revoking', () => {
    const registry = new DomainGrantRegistry(now);
    registry.issue({ grantId: 'dup', subject: 'jev', realmId: 'r', access: 'read', grantedBy: 'driver', nonce: 'one' });
    expect(() => registry.issue({ grantId: 'dup', subject: 'jev', realmId: 'r', access: 'read', grantedBy: 'driver', nonce: 'two' }))
      .toThrow(/already exists/);
    registry.revoke('dup');
    expect(() => registry.issue({ grantId: 'again', subject: 'jev', realmId: 'r', access: 'read', grantedBy: 'driver', nonce: 'one' }))
      .toThrow(/already used/);
    expect(() => registry.revoke('dup')).toThrow(/unknown grant/);
  });

  it('round-trips through the kernel snapshot, spent nonces included', () => {
    const registry = new DomainGrantRegistry(now);
    const issued = registry.issue({ grantId: 'g', subject: 'jev', realmId: 'realm-dept', access: 'read', grantedBy: 'driver', nonce: 'n' });
    const restored = new DomainGrantRegistry(now);
    restored.importState(structuredClone(registry.exportState()));
    expect(restored.get('g')).toEqual(issued);
    expect(() => restored.issue({ subject: 'jev', realmId: 'realm-dept', access: 'read', grantedBy: 'driver', nonce: 'n' }))
      .toThrow(/already used/);
  });

  it('hands the decider a defensive copy, so a caller cannot edit live grants', () => {
    const registry = new DomainGrantRegistry(now);
    registry.issue({ grantId: 'g', subject: 'jev', realmId: 'r', access: 'read', grantedBy: 'driver', nonce: 'n' });
    const list = registry.list();
    list[0]!.subject = 'attacker';
    expect(registry.get('g')?.subject).toBe('jev');
  });
});
