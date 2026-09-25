/**
 * Enterprise realm tenancy (design-realm.md §8, E3.6).
 *
 * A tenant is a position in the enterprise hierarchy: org / department / member.
 * It exists ONLY on enterprise realms; the personal domain is not a tenant —
 * that distinction is what makes "个人域默认二极管隔离" checkable instead of
 * rhetorical.
 *
 * Hierarchy is a HARD boundary: a subject reaches an enterprise realm only when
 * its own scope is that realm's scope or an ancestor of it (an org may look
 * down into departments; a department may never look up at the org corpus, nor
 * sideways at a sibling). No grant loosens this — grants only cover the
 * personal <-> enterprise domain edge (see authorization.ts).
 */
import type { TenantScope } from './types.js';
import { RealmError } from './types.js';

const MAX_SEGMENT_CHARS = 120;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export class TenantError extends RealmError {
  constructor(message: string) {
    super(message);
    this.name = 'TenantError';
  }
}

/** Match on case-folded segments so 'ACME/Eng' and 'acme/eng' are one tenant. */
function fold(segment: string): string {
  return segment.toLowerCase();
}

function segmentsOf(scope: TenantScope): string[] {
  return [scope.org, scope.department, scope.member].filter((part): part is string => part !== undefined);
}

/** Parse 'acme' | 'acme/eng' | 'acme/eng/zhang'. Segment text is kept verbatim. */
export function parseTenant(raw: string): TenantScope {
  const parts = raw.split('/').map(part => part.trim());
  if (parts.length < 1 || parts.length > 3) {
    throw new TenantError(`tenant path needs 1-3 segments (org[/department[/member]]), got ${parts.length}: ${raw}`);
  }
  for (const part of parts) {
    if (!part) throw new TenantError(`tenant has an empty segment: ${raw}`);
    if (part === '.' || part === '..') throw new TenantError(`tenant segment must not be a path marker: ${raw}`);
    if (part.length > MAX_SEGMENT_CHARS) {
      throw new TenantError(`tenant segment longer than ${MAX_SEGMENT_CHARS} chars: ${raw}`);
    }
    if (CONTROL_CHARS.test(part)) throw new TenantError(`tenant segment has control characters: ${raw}`);
  }
  const [org, department, member] = parts;
  return { org, ...(department ? { department } : {}), ...(member ? { member } : {}) };
}

/** Render a scope for a message. An absent scope renders as '' — a display
 *  helper that throws on "no tenant" would be useless in exactly the audit line
 *  that explains why a realm has no boundary. */
export function formatTenant(tenant?: TenantScope): string {
  return tenant ? segmentsOf(tenant).join('/') : '';
}

/** Validate without inventing a scope: only enterprise realms carry one. */
export function normalizeTenant(tenant: string | TenantScope | undefined): TenantScope | undefined {
  if (tenant === undefined) return undefined;
  const scope = typeof tenant === 'string' ? parseTenant(tenant) : tenant;
  if (!scope.org?.trim()) throw new TenantError('tenant.org is required');
  return {
    org: scope.org.trim(),
    ...(scope.department ? { department: scope.department.trim() } : {}),
    ...(scope.member ? { member: scope.member.trim() } : {}),
  };
}

/**
 * The subtree rule: may a subject at `subject` reach a realm scoped `target`?
 * Equal or strictly-broader subject scopes reach inward; a deeper or sideways
 * subject never reaches out. The segment comparison alone is the prefix test -
 * a separate `left.length > right.length` guard was removed after a defect plant
 * showed no test could tell it was there, i.e. it was not enforcing anything.
 */
export function tenantReaches(subject: TenantScope, target: TenantScope): boolean {
  const left = segmentsOf(subject).map(fold);
  const right = segmentsOf(target).map(fold);
  return left.every((segment, index) => segment === right[index]);
}
