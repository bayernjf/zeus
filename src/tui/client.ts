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

export type DeckClient = {
  snapshot(): Promise<DeckSnapshot>;
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
      const [rosterEnv, escEnv, metricsEnv, stateEnv] = await Promise.allSettled([
        getJson<{ snapshot: RosterView }>('/api/roster'),
        getJson<{ escalations: EscalationView[] }>('/api/escalations?status=pending'),
        getJson<MetricsView>('/api/metrics'),
        getJson<StateView>('/api/state'),
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
      };
    },
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
