/**
 * Thin read/write client over the existing H2 HTTP face. It adds no kernel
 * route and no UI-private logic: every write is the same API call a curl user
 * would make, so it reads back identically in GET /api/audit.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(typeof body === 'object' && body && 'message' in body ? String((body as { message: unknown }).message) : `HTTP ${status}`);
    this.name = 'ApiError';
  }
}

export type DeckSnapshot = {
  roster: RosterView;
  escalations: EscalationView[];
  metrics: MetricsView | null;
  state: StateView | null;
  audit: AuditView[] | null;
  domains: DomainsView | null;
  contracts: ContractsView | null;
};

export type RosterView = {
  generatedAt: string;
  entries: Array<{ name: string; domain?: string; status: 'active' | 'revoked'; health?: string; skills: Array<{ id?: string; name?: string }> }>;
};

export type EscalationView = {
  id: string;
  kind: 'task-input' | 'intent-conflict' | 'memory-dispute' | 'delegation-limit';
  vassal: string;
  skill: string;
  realm: string;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  options: string[];
  createdAt: string;
  intentId?: string;
  stances?: Array<{ stance: string; vassals: string[]; summary?: string }>;
  factId?: string;
  conflictingFacts?: string[];
};

export type MetricsView = {
  inFlight: number;
  maxInFlight: number;
  queueDepth: number;
  finished: number;
  completed: number;
  failed: number;
  timedOut: number;
};

export type StateView = {
  persistence?: { enabled: boolean; stateFile: string | null; restoredFromSnapshot: boolean };
  audit?: { file: string | null; failures: number; degraded: boolean };
  counts?: {
    vassals: number; vassalsRevoked: number; escalations: number; intents: number; skills: number;
  };
  driverGrants?: { authority: 'signed' | 'shape-only'; keyId: string | null };
};

/** One audit-log row as returned by GET /api/audit (the fan-out timeline). */
export type AuditView = {
  ts: string;
  vassal: string;
  decision: string;
  runId?: string;
  skill?: string;
  realm?: string;
  taskId?: string;
  state?: string;
  detail?: string;
};

/** GET /api/domains: mounted realms plus the personal->enterprise grant ledger. */
export type DomainsView = {
  realms: Array<{
    realmId: string;
    type: 'personal' | 'enterprise';
    /** Structured enterprise tenant as served by GET /api/domains. */
    tenant?: { org: string; department?: string; member?: string };
    readOnly: boolean;
    itemCount: number;
    contentDigest: string;
  }>;
  grants: Array<{
    grantId: string;
    subject: string;
    realmId: string;
    access: 'read' | 'write';
    grantedBy: string;
    reason?: string;
    grantedAt: string;
    expiresAt?: string;
    nonce: string;
  }>;
};

/** GET /api/delegation-contracts: the bounded execute-authority ledger. */
export type ContractView = {
  id: string;
  grantedBy: string;
  skill: string;
  vassal?: string;
  capabilities: string[];
  limits: { maxChildTickets: number; maxConcurrent: number; windowEndsAt: string };
  used: { childTickets: number; inFlight: number };
  issuedAt: string;
  revokedAt?: string;
};

export type ContractsView = { contracts: ContractView[] };

export type DeckClient = {
  snapshot(): Promise<DeckSnapshot>;
  /** Read-only fan-out/decision timeline. */
  timeline(limit?: number): Promise<AuditView[]>;
  /** Read-only mounted realms and cross-domain grant ledger. */
  domains(): Promise<DomainsView>;
  /** Issue a personal -> enterprise cross-domain grant (audited by the kernel). */
  issueGrant(input: {
    subject: string;
    realmId: string;
    access: 'read' | 'write';
    grantedBy: string;
    reason?: string;
    expiresAt?: string;
  }): Promise<DomainsView['grants'][number]>;
  /** Revoke a cross-domain grant by its grantId. */
  revokeGrant(grantId: string): Promise<void>;
  /** Read-only delegation contract ledger (step 5 operator face). */
  contracts(): Promise<ContractsView>;
  /** Issue a delegation contract; capabilities are the deck's fixed narrow set. */
  issueContract(input: {
    grantedBy: string;
    skill: string;
    capabilities: string[];
    limits: { maxChildTickets: number; maxConcurrent: number; windowEndsAt: string };
  }): Promise<ContractView>;
  /** Revoke a delegation contract; derivations block immediately. */
  revokeContract(id: string): Promise<void>;
  /** One-click answer to a delegation-limit escalation: issue an execute-only
   *  contract, rebind the watch, approve the row - all kernel-side. The endpoint
   *  requires grantedBy and limits, so the deck states the shape it approves. */
  approveContract(
    id: string,
    input: { grantedBy: string; maxChildTickets: number; maxConcurrent: number; windowEndsAt: string },
  ): Promise<{ contractId: string; watchId: string }>;
  revoke(name: string): Promise<void>;
  approve(id: string, note?: string): Promise<void>;
  reject(id: string, note?: string): Promise<void>;
  resolve(id: string, stance: string, note?: string): Promise<void>;
  /** E2.6: recognize an operator instruction as a plan-only intent. */
  recognize(text: string, opts?: { realm?: 'personal' | 'enterprise'; useModel?: boolean }): Promise<RecognizeView>;
};

/** E2.6 recognition result normalized for the deck (no protocol details). */
export type RecognizeView =
  | {
      ok: true;
      skill: string;
      confidence: number;
      /** null when the local rule path resolved it (zero model involvement). */
      backend: { kind: string; model: string } | null;
      decisionAt: string;
    }
  | {
      ok: false;
      reason: string;
      detail?: string;
    };

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export function createDeckClient(baseUrl: string, token: string, fetchImpl: FetchLike = fetch): DeckClient {
  const headers = { authorization: `Bearer ${token}`, accept: 'application/json' };

  async function getJson<T>(path: string): Promise<T> {
    const res = await fetchImpl(`${baseUrl}${path}`, { headers });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(res.status, body);
    return body as T;
  }

  async function postFor<T>(path: string, payload?: unknown): Promise<T> {
    // Always send a body: the header says JSON, and a JSON-labelled empty body
    // is a transport-level 400 on a real Fastify before any route runs. The
    // deck's plain approve/reject carries no payload, and mocked-fetch tests
    // cannot see this - only a real process can (P0-8 pilot finding).
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
    });
    const body = (await res.json().catch(() => null)) as T;
    if (!res.ok) throw new ApiError(res.status, body);
    return body as T;
  }

  async function post(path: string, payload?: unknown): Promise<void> {
    await postFor<unknown>(path, payload);
  }

  return {
    async snapshot(): Promise<DeckSnapshot> {
      const [rosterEnv, escEnv, metricsEnv, stateEnv, auditEnv, domainsEnv, contractsEnv] = await Promise.allSettled([
        getJson<{ snapshot: RosterView }>('/api/roster'),
        getJson<{ escalations: EscalationView[] }>('/api/escalations?status=pending'),
        getJson<MetricsView>('/api/metrics'),
        getJson<StateView>('/api/state'),
        getJson<{ entries: AuditView[] }>('/api/audit?limit=12'),
        getJson<DomainsView>('/api/domains'),
        getJson<ContractsView>('/api/delegation-contracts'),
      ]);
      // Roster + escalations are core; their failure aborts the render. Metrics/
      // state are additive and degrade to null if that face is not mounted.
      if (rosterEnv.status === 'rejected') throw rosterEnv.reason;
      if (escEnv.status === 'rejected') throw escEnv.reason;
      return {
        roster: rosterEnv.value.snapshot,
        escalations: escEnv.value.escalations,
        metrics: metricsEnv.status === 'fulfilled' ? metricsEnv.value : null,
        state: stateEnv.status === 'fulfilled' ? stateEnv.value : null,
        audit: auditEnv.status === 'fulfilled' ? auditEnv.value.entries : null,
        domains: domainsEnv.status === 'fulfilled' ? domainsEnv.value : null,
        contracts: contractsEnv.status === 'fulfilled' ? contractsEnv.value : null,
      };
    },
    timeline: async (limit = 12) => {
      const body = await getJson<{ entries: AuditView[] }>(`/api/audit?limit=${encodeURIComponent(limit)}`);
      return body.entries;
    },
    domains: async () => getJson<DomainsView>('/api/domains'),
    issueGrant: async input => {
      const res = await fetchImpl(`${baseUrl}/api/domains/grants`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
      return (await res.json()) as DomainsView['grants'][number];
    },
    revokeGrant: async grantId => {
      const res = await fetchImpl(`${baseUrl}/api/domains/grants/${encodeURIComponent(grantId)}`, { method: 'DELETE', headers });
      if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
    },
    contracts: async () => getJson<ContractsView>('/api/delegation-contracts'),
    issueContract: async input => {
      const res = await fetchImpl(`${baseUrl}/api/delegation-contracts`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      const body = (await res.json().catch(() => null)) as { contract?: ContractView } | null;
      if (!res.ok || !body?.contract) throw new ApiError(res.status, body);
      return body.contract;
    },
    revokeContract: async id => {
      const res = await fetchImpl(`${baseUrl}/api/delegation-contracts/${encodeURIComponent(id)}`, { method: 'DELETE', headers });
      if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
    },
    approveContract: async (id, input) => {
      const body = await postFor(`/api/escalations/${encodeURIComponent(id)}/approve-contract`, {
        grantedBy: input.grantedBy,
        limits: { maxChildTickets: input.maxChildTickets, maxConcurrent: input.maxConcurrent, windowEndsAt: input.windowEndsAt },
      }) as { contract?: { id?: string }; watch?: { id?: string } } | null;
      return { contractId: body?.contract?.id ?? '', watchId: body?.watch?.id ?? '' };
    },
    revoke: async name => {
      const res = await fetchImpl(`${baseUrl}/api/vassals/${encodeURIComponent(name)}`, { method: 'DELETE', headers });
      if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
    },
    approve: (id, note) => post(`/api/escalations/${encodeURIComponent(id)}/approve`, note !== undefined ? { note } : undefined),
    reject: (id, note) => post(`/api/escalations/${encodeURIComponent(id)}/reject`, note !== undefined ? { note } : undefined),
    resolve: (id, stance, note) =>
      post(`/api/escalations/${encodeURIComponent(id)}/resolve`, { stance, ...(note !== undefined ? { note } : {}) }),
    recognize: async (text, opts) => {
      const res = await fetchImpl(`${baseUrl}/api/intents/recognize`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          text,
          ...(opts?.realm !== undefined ? { realm: opts.realm } : {}),
          ...(opts?.useModel === true ? { useModel: true } : {}),
        }),
      });
      const raw = (await res.json().catch(() => null)) as
        | { ok: true; intent: { skill: string }; confidence: number; backend: { kind: string; model: string } | null; decisionAt: string }
        | { ok: false; reason: string; detail?: string }
        | null;
      // A structured fail-closed response is a product outcome, not a
      // transport error: the kernel answers 422 with {ok:false, reason} and
      // the deck surfaces that reason verbatim instead of throwing.
      if (raw !== null && typeof raw === 'object' && typeof raw.ok === 'boolean') {
        if (raw.ok) {
          if (!res.ok) throw new ApiError(res.status, raw);
          return {
            ok: true,
            skill: raw.intent.skill,
            confidence: raw.confidence,
            backend: raw.backend,
            decisionAt: raw.decisionAt,
          };
        }
        return { ok: false, reason: raw.reason, ...(raw.detail !== undefined ? { detail: raw.detail } : {}) };
      }
      throw new ApiError(res.status, raw);
    },
  };
}
