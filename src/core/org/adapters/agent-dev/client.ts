/**
 * F1.3: agent-dev HTTP client.
 *
 * agent-dev exposes a governed project-scoped Feature Task / Runtime path.
 * This client is deliberately the only place in the adapter that speaks to
 * that daemon: read the approved Feature Task, prepare and execute its Runtime
 * run, then read the Git evidence of the worktree.
 *
 * Authentication is the daemon's persistent bearer token (the token file is
 * read by the assembler, never by this client). The client holds no secret.
 */
import { guardedFetch } from '../../../../util/outbound-dns.js';

export type AgentDevRunStatus = 'planned' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface AgentDevFeatureTask {
  id: string;
  projectId: string;
  blueprintRevision: number;
  title: string;
  objective: string;
  acceptanceCriteria: string[];
  status: 'draft' | 'approved';
  approvedBy?: string;
  approvedAt?: string;
  workspacePath: string;
}

export interface AgentDevRuntimeRun {
  id: string;
  taskId: string;
  projectId: string;
  blueprintRevision: number;
  agentId: string;
  status: AgentDevRunStatus;
  attempts: number;
  result?: {
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
    output: string;
    startedAt: string;
    completedAt: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface AgentDevGitEvidence {
  branch: string;
  head: string;
  status: string;
  diffStat: string;
}

/** The runtime auto-commits, so the implementation diff lives on this commit. */
export interface AgentDevLastCommit {
  hash: string;
  subject: string;
  diffStat: string;
}

/**
 * Non-2xx or transport failure. `retryable` is this adapter's verdict for the
 * runner: transient upstream faults (network, timeout, 429, 5xx) retry;
 * definitive faults (400/401/404/409/422) do not.
 */
export class AgentDevApiError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  readonly body: unknown;

  constructor(status: number, message: string, opts: { retryable: boolean; body?: unknown }) {
    super(message);
    this.name = 'AgentDevApiError';
    this.status = status;
    this.retryable = opts.retryable;
    this.body = opts.body;
  }
}

export interface AgentDevClientOptions {
  baseUrl: string;
  token: string;
  /** Injectable fetch (tests). Defaults to the outbound-DNS-guarded fetch. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout ms. */
  timeoutMs?: number;
  /**
   * The execute route runs the local coding CLI synchronously, so it needs a
   * much larger budget than metadata calls. Default 10 minutes.
   */
  executeTimeoutMs?: number;
}

export interface GetFeatureTaskArgs {
  projectId: string;
}

export interface PrepareRuntimeArgs {
  projectId: string;
  agentId?: string;
}

export interface ExecuteRuntimeArgs {
  projectId: string;
}

interface RawResult {
  ok: boolean;
  status: number;
  body: unknown;
}

export class AgentDevClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly executeTimeoutMs: number;

  constructor(opts: AgentDevClientOptions) {
    if (!opts.token.trim()) throw new AgentDevApiError(0, 'agent-dev token is empty', { retryable: false });
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? guardedFetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.executeTimeoutMs = opts.executeTimeoutMs ?? 600_000;
  }

  hasToken(): boolean {
    return this.token.length > 0;
  }

  async getFeatureTask(args: GetFeatureTaskArgs): Promise<{ task: AgentDevFeatureTask | null }> {
    return this.request(
      'GET',
      `/api/projects/${encodeURIComponent(args.projectId)}/feature-task`,
    ) as Promise<{ task: AgentDevFeatureTask | null }>;
  }

  async prepareRuntime(args: PrepareRuntimeArgs): Promise<{ run: AgentDevRuntimeRun }> {
    return this.request('POST', `/api/projects/${encodeURIComponent(args.projectId)}/runtime/run`, {
      confirmation: 'PREPARE_RUNTIME_RUN',
      ...(args.agentId ? { agentId: args.agentId } : {}),
    }) as Promise<{ run: AgentDevRuntimeRun }>;
  }

  /**
   * Execute the prepared run. agent-dev answers 422 when the CLI ran but the
   * run failed; that is a channel outcome, not a transport error, so the body
   * is returned and the executor decides how to settle the task.
   */
  async executeRuntime(args: ExecuteRuntimeArgs): Promise<{ run: AgentDevRuntimeRun }> {
    return this.request(
      'POST',
      `/api/projects/${encodeURIComponent(args.projectId)}/runtime/execute`,
      { confirmation: 'EXECUTE_RUNTIME_RUN' },
      { allowStatuses: [422], timeoutMs: this.executeTimeoutMs },
    ) as Promise<{ run: AgentDevRuntimeRun }>;
  }

  async getGitEvidence(args: { projectId: string }): Promise<{ evidence: AgentDevGitEvidence }> {
    return this.request('GET', `/api/projects/${encodeURIComponent(args.projectId)}/runtime/evidence`) as Promise<{
      evidence: AgentDevGitEvidence;
    }>;
  }

  async getLastCommit(args: { projectId: string }): Promise<{ lastCommit: AgentDevLastCommit | null }> {
    return this.request(
      'GET',
      `/api/projects/${encodeURIComponent(args.projectId)}/runtime/last-commit`,
    ) as Promise<{ lastCommit: AgentDevLastCommit | null }>;
  }

  private async request(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    opts: { allowStatuses?: number[]; timeoutMs?: number } = {},
  ): Promise<unknown> {
    const res = await this.raw(method, path, body, opts.timeoutMs);
    if (!res.ok && !opts.allowStatuses?.includes(res.status)) {
      throw new AgentDevApiError(res.status, `agent-dev ${method} ${path} failed (${res.status})`, {
        retryable: res.status === 408 || res.status === 429 || res.status >= 500,
        body: res.body,
      });
    }
    return res.body;
  }

  private async raw(method: string, path: string, body?: Record<string, unknown>, timeoutMs?: number): Promise<RawResult> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: `Bearer ${this.token}`,
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      const text = await response.text();
      let parsed: unknown = null;
      if (text.length > 0) {
        try {
          parsed = JSON.parse(text) as unknown;
        } catch {
          parsed = text;
        }
      }
      return { ok: response.ok, status: response.status, body: parsed };
    } catch (error) {
      if (error instanceof AgentDevApiError) throw error;
      throw new AgentDevApiError(0, `agent-dev ${method} ${path} transport error: ${(error as Error).message}`, {
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
