/**
 * T-M7-02: agent-world HTTP client.
 *
 * Plain `fetch` client over the agent-world Hono API. It knows nothing about
 * zeus execution failure taxonomy: it raises {@link AgentWorldApiError} with a
 * `retryable` verdict that the ToolInvoker maps onto the runner's
 * retryable|business split. Authentication is a session JWT obtained from
 * `POST /api/auth/login` (the token arrives in the `auth_token` Set-Cookie,
 * not the body); the client caches it and replays it as `Authorization: Bearer`.
 *
 * This client is deliberately the ONLY place in the adapter that speaks to the
 * network. The executor reaches it exclusively through `ctx.tool(...)`.
 */

/** Login secret shape held behind the `agent-world:login` credential ref. */
export interface AgentWorldLogin {
  email: string;
  password: string;
}

/** Run lifecycle statuses as emitted by the agent-world engine. */
export type AgentWorldRunStatus = 'running' | 'done' | 'failed' | 'halted' | 'tripped' | 'cancelled';

/** What the timeline endpoint exposes about a run, mapped into zeus terms. */
export interface AgentWorldRunView {
  runId: string;
  graphId: string;
  status: AgentWorldRunStatus;
  /** Set when the run parked on a `human` node. */
  haltedNodeId: string | null;
  haltedReason: string | null;
  startedAt: string | null;
  endedAt: string | null;
}

/** A run artifact reference (evidence written back to the OrgTask result). */
export interface AgentWorldArtifactRef {
  id: string;
  kind: string;
  label?: string;
  [key: string]: unknown;
}

/**
 * Non-2xx or transport failure. `retryable` is the adapter's verdict for the
 * runner: transient upstream faults (network, timeout, 429, 5xx) retry;
 * definitive faults (400/404/409/422, bad credentials) do not.
 */
export class AgentWorldApiError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  readonly body: unknown;

  constructor(status: number, message: string, opts: { retryable: boolean; body?: unknown }) {
    super(message);
    this.name = 'AgentWorldApiError';
    this.status = status;
    this.retryable = opts.retryable;
    this.body = opts.body;
  }
}

/**
 * Raised when agent-world rejects the cached JWT (401). The invoker catches
 * this exactly once, re-logs-in, and retries; a second 401 becomes a business
 * failure rather than an infinite auth loop.
 */
export class AgentWorldAuthRequired extends Error {
  constructor(message = 'agent-world rejected the session token (401)') {
    super(message);
    this.name = 'AgentWorldAuthRequired';
  }
}

export interface AgentWorldClientOptions {
  baseUrl: string;
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout ms. */
  timeoutMs?: number;
}

interface StartRunArgs {
  graphId: string;
  input: string;
  trigger?: string;
  /** Forwarded as the `Idempotency-Key` header so agent-world dedupes replays. */
  idempotencyKey?: string;
}

export class AgentWorldClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private token: string | null = null;

  constructor(opts: AgentWorldClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  hasToken(): boolean {
    return this.token !== null;
  }

  clearToken(): void {
    this.token = null;
  }

  /** Exchange email/password for a session JWT cached in memory. */
  async login(login: AgentWorldLogin): Promise<void> {
    const res = await this.raw('POST', '/api/auth/login', {
      body: JSON.stringify({ email: login.email, password: login.password, remember: true }),
      auth: false,
    });
    if (!res.ok) {
      // 401 here means wrong credentials — definitive, never retry.
      throw new AgentWorldApiError(res.status, `agent-world login failed (${res.status})`, {
        retryable: false,
        body: res.body,
      });
    }
    const setCookie = res.headers.get('set-cookie') ?? '';
    const match = /(?:^|,\s*)auth_token=([^;]+)/.exec(setCookie);
    if (!match?.[1]) {
      throw new AgentWorldApiError(0, 'agent-world login response carried no auth_token cookie', {
        retryable: false,
      });
    }
    this.token = match[1];
  }

  /** Instantiate a built-in template as a graph; returns the new graph id. */
  async createGraph(args: { template: string; name?: string; fieldValues?: Record<string, string> }): Promise<{ graphId: string }> {
    const res = await this.request('POST', '/api/graphs', {
      body: JSON.stringify({
        template: args.template,
        ...(args.name ? { name: args.name } : {}),
        ...(args.fieldValues ? { fieldValues: args.fieldValues } : {}),
      }),
    });
    const graph = res as { id?: string };
    if (typeof graph.id !== 'string') {
      throw new AgentWorldApiError(0, 'agent-world createGraph returned no graph id', { retryable: false });
    }
    return { graphId: graph.id };
  }

  /** Start an async run; agent-world dedupes the Idempotency-Key across replays. */
  async startRun(args: StartRunArgs): Promise<{ runId: string; replay: boolean }> {
    const res = await this.request('POST', '/api/runs', {
      body: JSON.stringify({
        graphId: args.graphId,
        input: args.input,
        ...(args.trigger ? { trigger: args.trigger } : {}),
      }),
      ...(args.idempotencyKey ? { headers: { 'Idempotency-Key': args.idempotencyKey } } : {}),
    });
    const body = res as { runId?: string; replay?: boolean };
    if (typeof body.runId !== 'string') {
      throw new AgentWorldApiError(0, 'agent-world startRun returned no runId', { retryable: false });
    }
    return { runId: body.runId, replay: body.replay === true };
  }

  /** Read the run timeline (status + halt location). */
  async getTimeline(runId: string): Promise<AgentWorldRunView> {
    const res = await this.request('GET', `/api/runs/${encodeURIComponent(runId)}/timeline`);
    const body = res as {
      run?: {
        id?: string;
        graphId?: string;
        status?: string;
        haltedNodeId?: string | null;
        haltedReason?: string | null;
        startedAt?: string | null;
        endedAt?: string | null;
      };
    };
    const run = body.run ?? {};
    return {
      runId: run.id ?? runId,
      graphId: run.graphId ?? '',
      status: (run.status as AgentWorldRunStatus | undefined) ?? 'running',
      haltedNodeId: run.haltedNodeId ?? null,
      haltedReason: run.haltedReason ?? null,
      startedAt: run.startedAt ?? null,
      endedAt: run.endedAt ?? null,
    };
  }

  /** List artifacts produced by the run (evidence refs). */
  async listArtifacts(runId: string): Promise<AgentWorldArtifactRef[]> {
    const res = await this.request('GET', `/api/runs/${encodeURIComponent(runId)}/artifacts`);
    return Array.isArray(res) ? (res as AgentWorldArtifactRef[]) : [];
  }

  /** Resume a halted run with approve/reject/continue/scrap. */
  async resumeRun(runId: string, action: 'approve' | 'reject' | 'continue' | 'scrap'): Promise<void> {
    await this.request('POST', `/api/runs/${encodeURIComponent(runId)}/resume`, {
      body: JSON.stringify({ action }),
    });
  }

  // ── internals ─────────────────────────────────────────────────────────

  private async request(method: string, path: string, opts: { body?: string; headers?: Record<string, string> } = {}): Promise<unknown> {
    const res = await this.raw(method, path, { ...opts, auth: true });
    if (!res.ok) {
      if (res.status === 401) throw new AgentWorldAuthRequired();
      throw new AgentWorldApiError(res.status, `agent-world ${method} ${path} failed (${res.status})`, {
        retryable: res.status === 408 || res.status === 429 || res.status >= 500,
        body: res.body,
      });
    }
    return res.body;
  }

  private async raw(
    method: string,
    path: string,
    opts: { body?: string; headers?: Record<string, string>; auth?: boolean },
  ): Promise<RawResult> {
    const headers: Record<string, string> = { accept: 'application/json', ...(opts.headers ?? {}) };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (opts.auth !== false && this.token) headers.authorization = `Bearer ${this.token}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(opts.body !== undefined ? { body: opts.body } : {}),
        signal: controller.signal,
      });
      const text = await response.text();
      let body: unknown = null;
      if (text.length > 0) {
        try {
          body = JSON.parse(text) as unknown;
        } catch {
          body = text;
        }
      }
      return { ok: response.ok, status: response.status, body, headers: response.headers };
    } catch (error) {
      if (error instanceof AgentWorldApiError || error instanceof AgentWorldAuthRequired) throw error;
      // AbortError / network error: transient upstream fault.
      throw new AgentWorldApiError(0, `agent-world ${method} ${path} transport error: ${(error as Error).message}`, {
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

interface RawResult {
  ok: boolean;
  status: number;
  body: unknown;
  headers: Headers;
}
