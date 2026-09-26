/**
 * Kernel-side realm retrieval (design-realm.md §8.4, E6.4).
 *
 * Before this, `realmHits` were whatever the caller asserted: an intent could
 * declare `realm:"personal"` while pasting content mined from an enterprise
 * corpus, and nothing downstream could tell, because the kernel never looked in
 * a realm itself. Here the kernel does the search, so three things become
 * checkable: which realm the content actually came from, that its real type
 * matches what the intent declared, and that the asking subject was allowed
 * across whatever boundary that move required.
 *
 * Refusals are audited too — a boundary that leaves no trace of being tested is
 * indistinguishable from one that was never crossed.
 */
import { decideRealmAccess, type ScopedRealm } from './authorization.js';
import { formatTenant } from './tenant.js';
import type { RealmAccess, RealmActor, RealmHit, RealmStore, RealmType, SearchQuery } from './types.js';
import type { DomainDecision, DomainGrant } from './types.js';

export type RealmSource = {
  realmId: string;
  text?: string;
  since?: string;
  limit?: number;
};

export type RealmAuditEntry = {
  ts: string;
  /** The asking subject (vassal name, agent id, or driver id). */
  vassal: string;
  decision: 'domain-read' | 'domain-refused' | 'realm-disconnected' | 'realm-tenant-retargeted';
  realm?: RealmType;
  detail: string;
};

export type ResolveRealmSourceInput = {
  store: RealmStore;
  actor: RealmActor;
  access?: RealmAccess;
  source: RealmSource;
  /** The realm type the intent declared; cross-checked against the real one. */
  declaredRealm?: RealmType;
  grants?: DomainGrant[];
  audit?: (entry: RealmAuditEntry) => void;
  now?: () => Date;
};

export type ResolvedRealmSource = {
  realmId: string;
  /** The realm's ACTUAL type, which is what the dispatch diode must gate on. */
  realm: RealmType;
  tenant?: ScopedRealm['tenant'];
  hits: RealmHit[];
  via: Extract<DomainDecision, { ok: true }>['via'];
  grantId?: string;
};

export class RealmSourceError extends Error {
  constructor(
    readonly decision: Extract<DomainDecision, { ok: false }>,
  ) {
    // The reason leads: whoever reads a log line or an HTTP detail needs the
    // machine-readable category as much as the sentence describing it.
    super(`[${decision.reason}] ${decision.detail}`);
    this.name = 'RealmSourceError';
  }
}

export async function resolveRealmSource(input: ResolveRealmSourceInput): Promise<ResolvedRealmSource> {
  const now = input.now ?? (() => new Date());
  const access = input.access ?? 'read';
  const { source, actor } = input;
  const emit = (decision: RealmAuditEntry['decision'], detail: string, realm?: RealmType) => {
    input.audit?.({ ts: now().toISOString(), vassal: actor.id, decision, detail, ...(realm ? { realm } : {}) });
  };

  /** One format for a refusal: the reason leads in both the audit line and the
   *  error a caller sees, so the two can be matched up during an incident.
   *  Typed `Promise<never>` on purpose - as a bare `never` returning arrow
   *  function it does not tell the type checker the call site cannot continue,
   *  which is exactly the property a refusal needs. */
  const refuse = (decision: Extract<DomainDecision, { ok: false }>, realm?: RealmType): Promise<never> => {
    emit('domain-refused', `[${decision.reason}] ${decision.detail}`, realm);
    throw new RealmSourceError(decision);
  };

  let scoped: ScopedRealm;
  try {
    const manifest = await input.store.manifest(source.realmId);
    scoped = {
      realmId: manifest.realmId,
      type: manifest.type,
      ...(manifest.tenant ? { tenant: manifest.tenant } : {}),
      readOnly: input.store.connections().find(entry => entry.realmId === manifest.realmId)?.readOnly ?? false,
    };
  } catch {
    return refuse({ ok: false, reason: 'unknown-realm', detail: `realm not connected: ${source.realmId}` });
  }

  // The declared type is what the fealty diode would have checked, so a mismatch
  // means the gate was pointed at a different domain than the data.
  if (input.declaredRealm && input.declaredRealm !== scoped.type) {
    return refuse(
      {
        ok: false,
        reason: 'realm-type-mismatch',
        detail: `intent declared realm="${input.declaredRealm}" but ${scoped.realmId} is "${scoped.type}"`,
      },
      input.declaredRealm,
    );
  }

  const decision = decideRealmAccess({
    actor,
    realm: scoped,
    access,
    ...(input.grants ? { grants: input.grants } : {}),
    now,
  });
  if (!decision.ok) return refuse(decision, scoped.type);

  const query: SearchQuery = {
    ...(source.text ? { text: source.text } : {}),
    ...(source.since ? { since: source.since } : {}),
    ...(source.limit !== undefined ? { limit: source.limit } : {}),
  };
  const hits = await input.store.search(source.realmId, query);
  emit('domain-read', `${actor.kind} ${actor.id} read ${hits.length} hit(s) from ${scoped.realmId}${scoped.tenant ? ` (tenant ${formatTenant(scoped.tenant)})` : ''}`, scoped.type);

  return {
    realmId: scoped.realmId,
    realm: scoped.type,
    ...(scoped.tenant ? { tenant: scoped.tenant } : {}),
    hits,
    via: decision.via,
    ...(decision.grantId ? { grantId: decision.grantId } : {}),
  };
}
