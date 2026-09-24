import type { DriverWriteGrant, GrantVerification } from './types.js';

/**
 * E3.5 driver authorization gate for enterprise-realm writes
 * (design-realm.md §3: personal→enterprise requires explicit driver
 * authorization; enterprise→personal is always forbidden).
 *
 * Pure and offline: it checks presence, shape, realm binding and expiry.
 * Authenticating the driver and producing a signed grant is the job of the
 * P1 MCP/HTTP transport; the library only enforces what a grant must assert.
 */
export function verifyDriverWriteGrant(
  grant: DriverWriteGrant | undefined,
  realmId: string,
  now: () => Date = () => new Date(),
): GrantVerification {
  if (!grant) return { ok: false, reason: 'missing' };

  const malformed =
    grant.kind !== 'driver-write' ||
    typeof grant.realmId !== 'string' ||
    grant.realmId.length === 0 ||
    typeof grant.grantedBy !== 'string' ||
    grant.grantedBy.length === 0 ||
    typeof grant.grantedAt !== 'string' ||
    Number.isNaN(Date.parse(grant.grantedAt)) ||
    typeof grant.nonce !== 'string' ||
    grant.nonce.length === 0 ||
    (grant.expiresAt !== undefined && Number.isNaN(Date.parse(grant.expiresAt)));
  if (malformed) return { ok: false, reason: 'malformed' };

  if (grant.realmId !== realmId) return { ok: false, reason: 'wrong-realm' };

  if (grant.expiresAt !== undefined && now().getTime() > Date.parse(grant.expiresAt)) {
    return { ok: false, reason: 'expired' };
  }

  return { ok: true };
}
