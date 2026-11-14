import { describe, expect, it } from 'vitest';
import {
  DomainGrantRegistry,
  decideDataDomainAccess,
  verifyDomainGrant,
} from '../src/dataDomain/authorization.js';
import type { DomainGrant, DataDomainActor } from '../src/dataDomain/types.js';

const NOW = new Date('2026-09-25T00:00:00.000Z');
const now = () => NOW;

const operator: DataDomainActor = { kind: 'operator', id: 'operator' };
const deptExecutor: DataDomainActor = { kind: 'executor', id: 'loom', tenant: { org: 'acme', department: 'eng' } };
const orgExecutor: DataDomainActor = { kind: 'executor', id: 'pr-helper', tenant: { org: 'acme' } };
const personalExecutor: DataDomainActor = { kind: 'executor', id: 'jev' };

const deptDataDomain = { dataDomainId: 'dataDomain-dept', type: 'enterprise' as const, tenant: { org: 'acme', department: 'eng' }, readOnly: false };
const mktDataDomain = { dataDomainId: 'dataDomain-mkt', type: 'enterprise' as const, tenant: { org: 'acme', department: 'mkt' }, readOnly: false };
const orgDataDomain = { dataDomainId: 'dataDomain-org', type: 'enterprise' as const, tenant: { org: 'acme' }, readOnly: false };
const unscopedDataDomain = { dataDomainId: 'dataDomain-plain', type: 'enterprise' as const, readOnly: false };
const personalDataDomain = { dataDomainId: 'dataDomain-me', type: 'personal' as const, readOnly: false };
const readOnlyPersonal = { dataDomainId: 'dataDomain-ro', type: 'personal' as const, readOnly: true };

function grant(over: Partial<DomainGrant> = {}): DomainGrant {
  return {
    kind: 'domain-access',
    grantId: over.grantId ?? 'g1',
    subject: over.subject ?? 'jev',
    dataDomainId: over.dataDomainId ?? 'dataDomain-dept',
    access: over.access ?? 'read',
    grantedBy: over.grantedBy ?? 'operator',
    grantedAt: over.grantedAt ?? NOW.toISOString(),
    nonce: over.nonce ?? 'n1',
    ...(over.expiresAt ? { expiresAt: over.expiresAt } : {}),
    ...(over.reason ? { reason: over.reason } : {}),
  };
}

describe('E6.4 decideDataDomainAccess: the hierarchy is structural', () => {
  it('lets an org subject reach down into its departments', () => {
    expect(decideDataDomainAccess({ actor: orgExecutor, dataDomain: deptDataDomain, access: 'read' })).toEqual({
      ok: true,
      via: 'tenant-hierarchy',
    });
  });

  it('refuses a department looking up at the org corpus', () => {
    const decision = decideDataDomainAccess({ actor: deptExecutor, dataDomain: orgDataDomain, access: 'read' });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe('tenant-out-of-scope');
  });

  it('refuses a department looking sideways at its sibling', () => {
    const decision = decideDataDomainAccess({ actor: deptExecutor, dataDomain: mktDataDomain, access: 'read' });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe('tenant-out-of-scope');
  });

  it('refuses a tenant-scoped subject on an unscoped enterprise dataDomain', () => {
    // An unscoped dataDomain has nothing to match against, so only the operator may use
    // it; quietly letting any subject in would be the widened mount the tenant
    // exists to prevent.
    const decision = decideDataDomainAccess({ actor: orgExecutor, dataDomain: unscopedDataDomain, access: 'read' });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe('tenant-out-of-scope');
  });
});

describe('E6.4 decideDataDomainAccess: the domain edge', () => {
  it('never lets an enterprise subject read the personal domain, grant or not', () => {
    const decision = decideDataDomainAccess({
      actor: deptExecutor,
      dataDomain: personalDataDomain,
      access: 'read',
      grants: [grant({ subject: 'loom', dataDomainId: 'dataDomain-me', access: 'read' })],
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe('enterprise-to-personal');
  });

  it('requires an explicit grant for a personal-side subject to read enterprise content', () => {
    const without = decideDataDomainAccess({ actor: personalExecutor, dataDomain: deptDataDomain, access: 'read' });
    expect(without.ok).toBe(false);
    if (!without.ok) expect(without.reason).toBe('no-grant');

    const withGrant = decideDataDomainAccess({
      actor: personalExecutor,
      dataDomain: deptDataDomain,
      access: 'read',
      grants: [grant()],
      now,
    });
    expect(withGrant).toEqual({ ok: true, via: 'grant', grantId: 'g1' });
  });

  it('does not let a read grant authorize a write, and says which is missing', () => {
    const decision = decideDataDomainAccess({
      actor: personalExecutor,
      dataDomain: deptDataDomain,
      access: 'write',
      grants: [grant({ access: 'read' })],
      now,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe('access-not-granted');
  });

  it('binds a grant to its subject and to its dataDomain', () => {
    const otherSubject = decideDataDomainAccess({
      actor: { kind: 'executor', id: 'someone-else' },
      dataDomain: deptDataDomain,
      access: 'read',
      grants: [grant()],
      now,
    });
    expect(otherSubject.ok).toBe(false);

    const otherDataDomain = decideDataDomainAccess({
      actor: personalExecutor,
      dataDomain: mktDataDomain,
      access: 'read',
      grants: [grant()],
      now,
    });
    expect(otherDataDomain.ok).toBe(false);
  });

  it('stops honoring a grant the moment it expires', () => {
    const expired = grant({ expiresAt: new Date(NOW.getTime() - 1).toISOString() });
    const decision = decideDataDomainAccess({
      actor: personalExecutor,
      dataDomain: deptDataDomain,
      access: 'read',
      grants: [expired],
      now,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe('grant-expired');
    expect(verifyDomainGrant(expired, { subject: 'jev', dataDomainId: 'dataDomain-dept', access: 'read' }, now)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('refuses writes into a read-only dataDomain even for the operator', () => {
    const decision = decideDataDomainAccess({ actor: operator, dataDomain: readOnlyPersonal, access: 'write' });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe('read-only');
    expect(decideDataDomainAccess({ actor: operator, dataDomain: readOnlyPersonal, access: 'read' })).toEqual({
      ok: true,
      via: 'same-domain',
    });
  });

  it('treats the operator as the authorizer (they own both domains)', () => {
    expect(decideDataDomainAccess({ actor: operator, dataDomain: deptDataDomain, access: 'read' })).toEqual({
      ok: true,
      via: 'same-domain',
    });
  });
});

describe('E6.4 verifyDomainGrant shape rules', () => {
  const expected = { subject: 'jev', dataDomainId: 'dataDomain-dept', access: 'read' as const };

  it('rejects a credential that is missing any binding', () => {
    expect(verifyDomainGrant(grant({ nonce: '' }), expected, now)).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyDomainGrant(grant({ grantedAt: 'not-a-date' }), expected, now)).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyDomainGrant(grant({ grantedBy: '' }), expected, now)).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyDomainGrant({ ...grant(), kind: 'operator-write' as never }, expected, now)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('separates a wrong binding from a wrong access', () => {
    expect(verifyDomainGrant(grant({ dataDomainId: 'other' }), expected, now)).toEqual({ ok: false, reason: 'wrong-dataDomain' });
    expect(verifyDomainGrant(grant({ access: 'write' }), expected, now)).toEqual({ ok: false, reason: 'wrong-access' });
    expect(verifyDomainGrant(grant({ subject: 'x' }), expected, now)).toEqual({ ok: false, reason: 'wrong-subject' });
  });
});

describe('E6.4 grant registry lifecycle', () => {
  it('issues a grant, stamps it, and reports it in the audit trail', () => {
    const entries: string[] = [];
    const registry = new DomainGrantRegistry(now, entry => entries.push(`${entry.decision}:${entry.grantId}`));
    const issued = registry.issue({ subject: 'jev', dataDomainId: 'dataDomain-dept', access: 'read', grantedBy: 'operator', nonce: 'n9' });
    expect(issued).toMatchObject({ kind: 'domain-access', grantId: expect.stringMatching(/^grant-/), grantedAt: NOW.toISOString() });
    expect(registry.list()).toHaveLength(1);
    expect(entries).toEqual([`grant-issued:${issued.grantId}`]);
  });

  it('mints a distinct nonce when the issuer supplies none, and refuses a replayed one', () => {
    const registry = new DomainGrantRegistry(now);
    const a = registry.issue({ subject: 'jev', dataDomainId: 'r', access: 'read', grantedBy: 'operator' });
    const b = registry.issue({ subject: 'jev', dataDomainId: 'r', access: 'write', grantedBy: 'operator' });
    expect(a.nonce).toMatch(/[0-9a-f-]{20,}/);
    expect(a.nonce).not.toBe(b.nonce);
    // An explicitly supplied nonce is still a claim, and a claim cannot be made twice.
    registry.issue({ grantId: 'a1', subject: 'jev', dataDomainId: 'r', access: 'read', grantedBy: 'operator', nonce: 'same' });
    expect(() => registry.issue({ grantId: 'b1', subject: 'jev', dataDomainId: 'r', access: 'read', grantedBy: 'operator', nonce: 'same' }))
      .toThrow(/already used/);
  });

  it('refuses to overwrite a live grant id but never resurrects a spent nonce by revoking', () => {
    const registry = new DomainGrantRegistry(now);
    registry.issue({ grantId: 'dup', subject: 'jev', dataDomainId: 'r', access: 'read', grantedBy: 'operator', nonce: 'one' });
    expect(() => registry.issue({ grantId: 'dup', subject: 'jev', dataDomainId: 'r', access: 'read', grantedBy: 'operator', nonce: 'two' }))
      .toThrow(/already exists/);
    registry.revoke('dup');
    expect(() => registry.issue({ grantId: 'again', subject: 'jev', dataDomainId: 'r', access: 'read', grantedBy: 'operator', nonce: 'one' }))
      .toThrow(/already used/);
    expect(() => registry.revoke('dup')).toThrow(/unknown grant/);
  });

  it('round-trips through the runtime snapshot, spent nonces included', () => {
    const registry = new DomainGrantRegistry(now);
    const issued = registry.issue({ grantId: 'g', subject: 'jev', dataDomainId: 'dataDomain-dept', access: 'read', grantedBy: 'operator', nonce: 'n' });
    const restored = new DomainGrantRegistry(now);
    restored.importState(structuredClone(registry.exportState()));
    expect(restored.get('g')).toEqual(issued);
    expect(() => restored.issue({ subject: 'jev', dataDomainId: 'dataDomain-dept', access: 'read', grantedBy: 'operator', nonce: 'n' }))
      .toThrow(/already used/);
  });

  it('hands the decider a defensive copy, so a caller cannot edit live grants', () => {
    const registry = new DomainGrantRegistry(now);
    registry.issue({ grantId: 'g', subject: 'jev', dataDomainId: 'r', access: 'read', grantedBy: 'operator', nonce: 'n' });
    const list = registry.list();
    list[0]!.subject = 'attacker';
    expect(registry.get('g')?.subject).toBe('jev');
  });
});
