/**
 * Runtime-side dataDomain retrieval (design-dataDomain.md §8.4, E6.4).
 *
 * Before this, `dataDomainHits` were whatever the caller asserted: an intent could
 * declare `dataDomain:"personal"` while pasting content mined from an enterprise
 * corpus, and nothing downstream could tell, because the runtime never looked in
 * a dataDomain itself. Here the runtime does the search, so three things become
 * checkable: which dataDomain the content actually came from, that its real type
 * matches what the intent declared, and that the asking subject was allowed
 * across whatever boundary that move required.
 *
 * Refusals are audited too — a boundary that leaves no trace of being tested is
 * indistinguishable from one that was never crossed.
 */
import { decideDataDomainAccess, type ScopedDataDomain } from './authorization.js';
import { formatTenant } from './tenant.js';
import type { DataDomainAccess, DataDomainActor, DataDomainHit, DataDomainStore, DataDomainType, SearchQuery } from './types.js';
import type { DomainDecision, DomainGrant } from './types.js';
import { DataDomainNotConnectedError } from './types.js';

export type DataDomainSource = {
  dataDomainId: string;
  text?: string;
  since?: string;
  limit?: number;
};

export type DataDomainAuditEntry = {
  ts: string;
  /** The asking subject (executor name, agent id, or operator id). */
  executor: string;
  decision: 'domain-read' | 'domain-refused' | 'dataDomain-disconnected' | 'dataDomain-tenant-retargeted';
  dataDomain?: DataDomainType;
  detail: string;
};

export type ResolveDataDomainSourceInput = {
  store: DataDomainStore;
  actor: DataDomainActor;
  access?: DataDomainAccess;
  source: DataDomainSource;
  /** The dataDomain type the intent declared; cross-checked against the real one. */
  declaredDataDomain?: DataDomainType;
  grants?: DomainGrant[];
  audit?: (entry: DataDomainAuditEntry) => void;
  now?: () => Date;
};

export type ResolvedDataDomainSource = {
  dataDomainId: string;
  /** The dataDomain's ACTUAL type, which is what the dispatch diode must gate on. */
  dataDomain: DataDomainType;
  tenant?: ScopedDataDomain['tenant'];
  hits: DataDomainHit[];
  via: Extract<DomainDecision, { ok: true }>['via'];
  grantId?: string;
};

export class DataDomainSourceError extends Error {
  constructor(
    readonly decision: Extract<DomainDecision, { ok: false }>,
  ) {
    // The reason leads: whoever reads a log line or an HTTP detail needs the
    // machine-readable category as much as the sentence describing it.
    super(`[${decision.reason}] ${decision.detail}`);
    this.name = 'DataDomainSourceError';
  }
}

export async function resolveDataDomainSource(input: ResolveDataDomainSourceInput): Promise<ResolvedDataDomainSource> {
  const now = input.now ?? (() => new Date());
  const access = input.access ?? 'read';
  const { source, actor } = input;
  const emit = (decision: DataDomainAuditEntry['decision'], detail: string, dataDomain?: DataDomainType) => {
    input.audit?.({ ts: now().toISOString(), executor: actor.id, decision, detail, ...(dataDomain ? { dataDomain } : {}) });
  };

  /** One format for a refusal: the reason leads in both the audit line and the
   *  error a caller sees, so the two can be matched up during an incident.
   *  Typed `Promise<never>` on purpose - as a bare `never` returning arrow
   *  function it does not tell the type checker the call site cannot continue,
   *  which is exactly the property a refusal needs. */
  const refuse = (decision: Extract<DomainDecision, { ok: false }>, dataDomain?: DataDomainType): Promise<never> => {
    emit('domain-refused', `[${decision.reason}] ${decision.detail}`, dataDomain);
    throw new DataDomainSourceError(decision);
  };

  let scoped: ScopedDataDomain;
  try {
    const manifest = await input.store.manifest(source.dataDomainId);
    scoped = {
      dataDomainId: manifest.dataDomainId,
      type: manifest.type,
      ...(manifest.tenant ? { tenant: manifest.tenant } : {}),
      readOnly: input.store.connections().find(entry => entry.dataDomainId === manifest.dataDomainId)?.readOnly ?? false,
    };
  } catch (error) {
    // Only "not mounted" is an unknown dataDomain. A store fault (I/O, corrupt
    // manifest) is a different incident with a different remedy, so relabelling
    // every failure as "not connected" would send the operator to the wrong
    // place and hide the real error.
    if (!(error instanceof DataDomainNotConnectedError)) throw error;
    return refuse({ ok: false, reason: 'unknown-dataDomain', detail: `dataDomain not connected: ${source.dataDomainId}` });
  }

  // The declared type is what the handshake diode would have checked, so a mismatch
  // means the gate was pointed at a different domain than the data.
  if (input.declaredDataDomain && input.declaredDataDomain !== scoped.type) {
    return refuse(
      {
        ok: false,
        reason: 'dataDomain-type-mismatch',
        detail: `intent declared dataDomain="${input.declaredDataDomain}" but ${scoped.dataDomainId} is "${scoped.type}"`,
      },
      input.declaredDataDomain,
    );
  }

  const decision = decideDataDomainAccess({
    actor,
    dataDomain: scoped,
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
  const hits = await input.store.search(source.dataDomainId, query);
  emit('domain-read', `${actor.kind} ${actor.id} read ${hits.length} hit(s) from ${scoped.dataDomainId}${scoped.tenant ? ` (tenant ${formatTenant(scoped.tenant)})` : ''}`, scoped.type);

  return {
    dataDomainId: scoped.dataDomainId,
    dataDomain: scoped.type,
    ...(scoped.tenant ? { tenant: scoped.tenant } : {}),
    hits,
    via: decision.via,
    ...(decision.grantId ? { grantId: decision.grantId } : {}),
  };
}
