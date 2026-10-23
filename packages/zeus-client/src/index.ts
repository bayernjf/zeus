/**
 * zeus-client: typed bearer client for the Decision API v1 (design §4.2).
 *
 * This package is transport-only. It shapes requests, injects the bearer
 * token, and maps the §8.1 error body into ZeusClientError. It deliberately
 * contains NO grading, policy or decision logic: a caller can never make a
 * decision locally that the server would not make.
 *
 * Zero runtime dependencies: uses the global fetch available on Node >= 22.
 */

// ---------------------------------------------------------------------------
// Domain types (mirror of src/core; the client is self-contained so that
// consumers such as commerce-os / loom do not pull in the zeus server).
// ---------------------------------------------------------------------------

export type Grade = 'D0' | 'D1' | 'D2' | 'D3';
export type Impact = 'self' | 'team' | 'org' | 'external';
export type Reversibility = 'reversible' | 'hard' | 'irreversible';
export type DecisionStatus = 'decided' | 'awaiting_approval' | 'blocked' | 'rejected';
export type DecisionMode = 'auto' | 'approve-async' | 'approve-sync' | 'human-led';
export type ApprovalVerdict = 'approve' | 'reject';
export type DecisionOutcome = 'auto' | 'approved' | 'rejected' | 'timed-out';

export interface Amount {
  value: number;
  currency: string;
}

export interface AmountRange {
  min: number;
  max?: number;
  currency: string;
}

export interface RuleMatch {
  domains?: string[];
  intents?: string[];
  amount?: AmountRange;
  riskTags?: string[];
  impact?: Impact[];
  reversibility?: Reversibility[];
}

export interface PolicyRule {
  id: string;
  match: RuleMatch;
  grade: Grade;
  slaHours?: number;
  escalation?: string;
}

export interface DecisionPolicy {
  version: number;
  defaultGrade: Grade;
  rules: PolicyRule[];
}

export interface DecisionRequest {
  intent: string;
  domain: string;
  amount?: Amount;
  riskTags?: string[];
  impact?: Impact;
  reversibility?: Reversibility;
  proposal?: unknown;
  idempotencyKey?: string;
}

export interface DecisionApprovalRecord {
  approver: string;
  verdict: ApprovalVerdict;
  comment?: string;
  at: string;
}

export interface DecisionResult {
  outcome: DecisionOutcome;
  at: string;
  approver?: string;
  comment?: string;
}

export interface DecisionRecord {
  id: string;
  intent: string;
  domain: string;
  amount?: Amount;
  riskTags?: string[];
  impact: Impact;
  reversibility: Reversibility;
  proposal?: unknown;
  idempotencyKey?: string;
  grade: Grade;
  mode: DecisionMode;
  status: DecisionStatus;
  ruleId: string;
  gradeReason: string;
  policyVersion: number;
  slaHours?: number;
  createdAt: string;
  updatedAt: string;
  auditSeq: number;
  decidedAt?: string;
  timeoutAt?: string;
  result?: DecisionResult;
  approvals: DecisionApprovalRecord[];
}

/** POST /api/v1/decisions response shape (design §4.2). */
export interface DecisionResponse {
  decisionId: string;
  grade: Grade;
  mode: DecisionMode;
  status: DecisionStatus;
  ruleId: string;
  proposal?: unknown;
  auditSeq: number;
}

export interface ApprovalInput {
  decision: ApprovalVerdict;
  approver: string;
  comment?: string;
}

export interface DecisionListFilter {
  domain?: string;
  status?: DecisionStatus;
}

export interface ReplayEvent {
  type: string;
  at: string;
  detail?: Record<string, unknown>;
}

export interface DecisionReplay {
  format: 'json';
  record: DecisionRecord;
  events: ReplayEvent[];
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Error body shape (design §8.1): { code, message, retryable, details? }. */
export interface DecisionErrorBody {
  code?: string;
  message?: string;
  retryable?: boolean;
  details?: unknown;
}

export interface ZeusClientErrorOptions {
  retryable: boolean;
  details?: unknown;
}

/**
 * Every failed call rejects with this error. `status` is the HTTP status
 * (0 when the request never reached the server); `code` is the server's
 * machine-readable error code, or a client-side NETWORK_ERROR /
 * REQUEST_TIMEOUT / BAD_RESPONSE.
 */
export class ZeusClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, options: ZeusClientErrorOptions) {
    super(message);
    this.name = 'ZeusClientError';
    this.status = status;
    this.code = code;
    this.retryable = options.retryable;
    if (options.details !== undefined) this.details = options.details;
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface ZeusClientOptions {
  /** e.g. http://127.0.0.1:8790 - no trailing slash required. */
  baseUrl: string;
  /** Bearer token sent as `Authorization: Bearer <token>`. */
  token: string;
  /** Injectable fetch for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Default per-request timeout; 30s when omitted. */
  timeoutMs?: number;
}

export interface CallOptions {
  /** Caller-provided abort signal. */
  signal?: AbortSignal;
  /** Per-call override of the constructor timeout. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class ZeusClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: ZeusClientOptions) {
    if (typeof options.baseUrl !== 'string' || options.baseUrl.trim() === '') {
      throw new TypeError('ZeusClient: baseUrl is required');
    }
    if (typeof options.token !== 'string' || options.token.trim() === '') {
      throw new TypeError('ZeusClient: token is required');
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof this.fetchImpl !== 'function') {
      throw new TypeError('ZeusClient: no fetch implementation available (Node >= 22 required)');
    }
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** POST /api/v1/decisions - create a decision (graded immediately). */
  decide(request: DecisionRequest, options?: CallOptions): Promise<DecisionResponse> {
    return this.request('POST', '/api/v1/decisions', request, options);
  }

  /** GET /api/v1/decisions/:id */
  getDecision(id: string, options?: CallOptions): Promise<DecisionRecord> {
    return this.request('GET', `/api/v1/decisions/${encodePathSegment(id)}`, undefined, options);
  }

  /** GET /api/v1/decisions?domain&status */
  async listDecisions(filter?: DecisionListFilter, options?: CallOptions): Promise<DecisionRecord[]> {
    const params = new URLSearchParams();
    if (filter?.domain !== undefined) params.set('domain', filter.domain);
    if (filter?.status !== undefined) params.set('status', filter.status);
    const query = params.toString();
    const body = await this.request<{ decisions: DecisionRecord[] }>(
      'GET',
      `/api/v1/decisions${query === '' ? '' : `?${query}`}`,
      undefined,
      options,
    );
    return body.decisions;
  }

  /** POST /api/v1/decisions/:id/approval */
  approve(id: string, input: ApprovalInput, options?: CallOptions): Promise<DecisionResponse> {
    return this.request(
      'POST',
      `/api/v1/decisions/${encodePathSegment(id)}/approval`,
      input,
      options,
    );
  }

  /** GET /api/v1/decisions/:id/replay?format=json */
  replay(id: string, options?: CallOptions): Promise<DecisionReplay> {
    return this.request(
      'GET',
      `/api/v1/decisions/${encodePathSegment(id)}/replay?format=json`,
      undefined,
      options,
    );
  }

  /** GET /api/v1/decisions/:id/replay?format=text */
  async replayText(id: string, options?: CallOptions): Promise<string> {
    return this.requestText(
      'GET',
      `/api/v1/decisions/${encodePathSegment(id)}/replay?format=text`,
      options,
    );
  }

  /** GET /api/v1/policy */
  getPolicy(options?: CallOptions): Promise<DecisionPolicy> {
    return this.request('GET', '/api/v1/policy', undefined, options);
  }

  /** PUT /api/v1/policy (version must increment server-side). */
  updatePolicy(policy: DecisionPolicy, actor = 'system', options?: CallOptions): Promise<DecisionPolicy> {
    return this.request('PUT', '/api/v1/policy', policy, options, { 'x-zeus-actor': actor });
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private async request<T>(
    method: string,
    path: string,
    body: unknown,
    options?: CallOptions,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const response = await this.performFetch(method, path, body, options, extraHeaders);
    if (response.ok) {
      return (await this.parseJson(response)) as T;
    }
    throw await this.toError(response);
  }

  private async requestText(method: string, path: string, options?: CallOptions): Promise<string> {
    const response = await this.performFetch(method, path, undefined, options);
    if (response.ok) return await response.text();
    throw await this.toError(response);
  }

  private async performFetch(
    method: string,
    path: string,
    body: unknown,
    options?: CallOptions,
    extraHeaders?: Record<string, string>,
  ): Promise<Response> {
    const timeoutMs = options?.timeoutMs ?? this.timeoutMs;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const callerSignal = options?.signal;
    const signal = callerSignal !== undefined
      ? AbortSignal.any([callerSignal, timeoutSignal])
      : timeoutSignal;
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: 'application/json',
      ...extraHeaders,
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        signal,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (thrown) {
      // AbortSignal.timeout aborts with a TimeoutError DOMException.
      if (timeoutSignal.aborted) {
        throw new ZeusClientError(0, 'REQUEST_TIMEOUT', `request ${method} ${path} timed out after ${timeoutMs}ms`, {
          retryable: true,
        });
      }
      if (callerSignal?.aborted) {
        throw new ZeusClientError(0, 'REQUEST_ABORTED', `request ${method} ${path} aborted`, {
          retryable: false,
        });
      }
      throw new ZeusClientError(
        0,
        'NETWORK_ERROR',
        `request ${method} ${path} failed: ${thrown instanceof Error ? thrown.message : String(thrown)}`,
        { retryable: true },
      );
    }
  }

  private async parseJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch (thrown) {
      throw new ZeusClientError(
        response.status,
        'BAD_RESPONSE',
        `server returned non-JSON body (${response.status})`,
        { retryable: response.status >= 500 },
      );
    }
  }

  private async toError(response: Response): Promise<ZeusClientError> {
    const raw = await response.text();
    let parsed: DecisionErrorBody | undefined;
    if (raw !== '') {
      try {
        parsed = JSON.parse(raw) as DecisionErrorBody;
      } catch {
        // Non-JSON error body, e.g. gateway HTML.
      }
    }
    if (parsed?.code !== undefined) {
      return new ZeusClientError(
        response.status,
        parsed.code,
        parsed.message ?? `request failed with ${response.status}`,
        {
          retryable: parsed.retryable ?? response.status >= 500,
          ...(parsed.details !== undefined ? { details: parsed.details } : {}),
        },
      );
    }
    if (response.status === 401) {
      return new ZeusClientError(response.status, 'UNAUTHORIZED', 'missing or invalid bearer token', {
        retryable: false,
      });
    }
    return new ZeusClientError(
      response.status,
      `HTTP_${response.status}`,
      raw === '' ? `request failed with ${response.status}` : raw.slice(0, 500),
      { retryable: response.status >= 500 },
    );
  }
}

function encodePathSegment(segment: string): string {
  return encodeURIComponent(segment);
}
