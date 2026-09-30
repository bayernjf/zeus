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
};

export type RosterView = {
  generatedAt: string;
  entries: Array<{ name: string; domain?: string; status: 'active' | 'revoked'; health?: string; skills: Array<{ id?: string; name?: string }> }>;
};

export type EscalationView = {
  id: string;
  kind: 'task-input' | 'intent-conflict' | 'memory-dispute';
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

export type DeckClient = {
  snapshot(): Promise<DeckSnapshot>;
  /** Read-only fan-out/decision timeline. */
  timeline(limit?: number): Promise<AuditView[]>;
  /** Read-only mounted realms and cross-domain grant ledger. */
  domains(): Promise<DomainsView>;
  revoke(name: string): Promise<void>;
  approve(id: string, note?: string): Promise<void>;
  reject(id: string, note?: string): Promise<void>;
  resolve(id: string, stance: string, note?: string): Promise<void>;
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

  async function post(path: string, payload?: unknown): Promise<void> {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new ApiError(res.status, body);
    }
  }

  return {
    async snapshot(): Promise<DeckSnapshot> {
      const [rosterEnv, escEnv, metricsEnv, stateEnv, auditEnv, domainsEnv] = await Promise.allSettled([
        getJson<{ snapshot: RosterView }>('/api/roster'),
        getJson<{ escalations: EscalationView[] }>('/api/escalations?status=pending'),
        getJson<MetricsView>('/api/metrics'),
        getJson<StateView>('/api/state'),
        getJson<{ entries: AuditView[] }>('/api/audit?limit=12'),
        getJson<DomainsView>('/api/domains'),
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
      };
    },
    timeline: async (limit = 12) => {
      const body = await getJson<{ entries: AuditView[] }>(`/api/audit?limit=${encodeURIComponent(limit)}`);
      return body.entries;
    },
    domains: async () => getJson<DomainsView>('/api/domains'),
    revoke: async name => {
      const res = await fetchImpl(`${baseUrl}/api/vassals/${encodeURIComponent(name)}`, { method: 'DELETE', headers });
      if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
    },
    approve: (id, note) => post(`/api/escalations/${encodeURIComponent(id)}/approve`, note !== undefined ? { note } : undefined),
    reject: (id, note) => post(`/api/escalations/${encodeURIComponent(id)}/reject`, note !== undefined ? { note } : undefined),
    resolve: (id, stance, note) =>
      post(`/api/escalations/${encodeURIComponent(id)}/resolve`, { stance, ...(note !== undefined ? { note } : {}) }),
  };
}
