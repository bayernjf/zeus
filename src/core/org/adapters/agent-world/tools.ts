/**
 * T-M7-02: agent-world ToolInvoker — the framework-invoked seam that holds the
 * HTTP client and resolves credentials. The executor never sees the client or
 * any secret: it calls `ctx.tool(name, args)`, the runner enforces the position
 * allow-list, and this invoker is the only code that turns a granted credential
 * reference into a session.
 *
 * Tool surface (explicit names; a position grants exactly the ones it needs):
 *   - `agent-world:run-graph`  — instantiate a template + start a run (write).
 *   - `agent-world:resume-run` — resume a halted run (write).
 *   - `agent-world:get-run`    — read timeline/artifacts (read-only).
 *
 * Credentials: the `agent-world:login` ref resolves to a JSON
 * `{"email","password"}` secret through the configured SecretBackend. It is
 * resolved per call with `resolveGrantedCredential` (least-privilege): a ref
 * the position does not grant, or that no backend can resolve, fails closed as
 * a business settlement — never an anonymous channel call.
 */
import {
  CredentialError,
  resolveGrantedCredential,
  type CredentialRef,
  type SecretBackend,
} from '../../execution/credentials.js';
import { ExecutorError } from '../../execution/errors.js';
import type {
  EffectResult,
  ExecutorContext,
  ToolInvoker,
} from '../../execution/contract.js';
import {
  AgentWorldApiError,
  AgentWorldAuthRequired,
  AgentWorldClient,
  type AgentWorldLogin,
} from './client.js';

/** The explicit tool names this adapter serves. */
export const AGENT_WORLD_TOOLS = {
  runGraph: 'agent-world:run-graph',
  resumeRun: 'agent-world:resume-run',
  getRun: 'agent-world:get-run',
} as const;

/** The credential reference a granted position must carry to authenticate. */
export const AGENT_WORLD_LOGIN_REF: CredentialRef = 'agent-world:login';

export interface AgentWorldToolInvokerOptions {
  client: AgentWorldClient;
  secrets: SecretBackend;
  /** Override the credential ref (tests). Defaults to `agent-world:login`. */
  loginRef?: CredentialRef;
}

export class AgentWorldToolInvoker implements ToolInvoker {
  private readonly client: AgentWorldClient;
  private readonly secrets: SecretBackend;
  private readonly loginRef: CredentialRef;
  /** Email the cached session belongs to; a new login identity forces re-auth. */
  private authedEmail: string | null = null;

  constructor(opts: AgentWorldToolInvokerOptions) {
    this.client = opts.client;
    this.secrets = opts.secrets;
    this.loginRef = opts.loginRef ?? AGENT_WORLD_LOGIN_REF;
  }

  async invoke(tool: string, args: Record<string, unknown>, ctx: ExecutorContext): Promise<EffectResult> {
    switch (tool) {
      case AGENT_WORLD_TOOLS.runGraph:
        return this.withAuth(ctx, () => this.runGraph(args));
      case AGENT_WORLD_TOOLS.resumeRun:
        return this.withAuth(ctx, () => this.resumeRun(args));
      case AGENT_WORLD_TOOLS.getRun:
        return this.withAuth(ctx, () => this.getRun(args));
      default:
        // The guard already refuses non-granted tools; an unknown tool reaching
        // here is an adapter/position misconfiguration — fail closed, no retry.
        throw ExecutorError.business(`agent-world invoker has no tool "${tool}"`);
    }
  }

  // ── tool handlers (authenticated) ───────────────────────────────────────

  private async runGraph(args: Record<string, unknown>): Promise<EffectResult> {
    const template = requireString(args.template);
    const graph = await this.client.createGraph({
      template,
      ...(typeof args.name === 'string' && args.name ? { name: args.name } : {}),
      ...(isStringRecord(args.fieldValues) ? { fieldValues: args.fieldValues } : {}),
    });
    const run = await this.client.startRun({
      graphId: graph.graphId,
      input: requireString(args.input),
      ...(typeof args.trigger === 'string' && args.trigger ? { trigger: args.trigger } : {}),
      ...(typeof args.idempotencyKey === 'string' && args.idempotencyKey
        ? { idempotencyKey: args.idempotencyKey }
        : {}),
    });
    return { graphId: graph.graphId, runId: run.runId, replay: run.replay };
  }

  private async resumeRun(args: Record<string, unknown>): Promise<EffectResult> {
    const runId = requireString(args.runId);
    const action = args.action === 'approve' || args.action === 'reject'
      || args.action === 'continue' || args.action === 'scrap'
      ? args.action
      : 'continue';
    await this.client.resumeRun(runId, action);
    return { runId, resumed: true, action };
  }

  private async getRun(args: Record<string, unknown>): Promise<EffectResult> {
    const runId = requireString(args.runId);
    if (args.view === 'artifacts') return (await this.client.listArtifacts(runId)) as unknown as EffectResult;
    return (await this.client.getTimeline(runId)) as unknown as EffectResult;
  }

  // ── auth + error mapping ───────────────────────────────────────────────

  /** Resolve the granted login, authenticate once, run `fn`; retry on a single 401. */
  private async withAuth(ctx: ExecutorContext, fn: () => Promise<EffectResult>): Promise<EffectResult> {
    await this.authenticate(ctx);
    try {
      return await fn();
    } catch (error) {
      if (error instanceof AgentWorldAuthRequired) {
        // The cached JWT was rejected: flush it, re-login once, retry.
        this.client.clearToken();
        this.authedEmail = null;
        await this.authenticate(ctx);
        return await fn();
      }
      throw mapToExecutorError(error);
    }
  }

  private async authenticate(ctx: ExecutorContext): Promise<void> {
    const resolved = await resolveGrantedCredential(this.secrets, ctx.credentialRefs, this.loginRef);
    let login: AgentWorldLogin;
    try {
      const parsed = JSON.parse(resolved.secret) as Partial<AgentWorldLogin>;
      if (typeof parsed.email !== 'string' || typeof parsed.password !== 'string') {
        throw new Error('shape');
      }
      login = { email: parsed.email, password: parsed.password };
    } catch (error) {
      if (error instanceof CredentialError) throw error;
      throw new CredentialError(
        this.loginRef,
        `credential "${this.loginRef}" must be a JSON object with email and password (fail-closed)`,
      );
    }
    if (!this.client.hasToken() || this.authedEmail !== login.email) {
      await this.client.login(login);
      this.authedEmail = login.email;
    }
  }
}

/** Map an agent-world transport error onto the runner's retryable|business split. */
function mapToExecutorError(error: unknown): Error {
  if (error instanceof AgentWorldApiError) {
    return error.retryable
      ? ExecutorError.retryable(error.message, { cause: error })
      : ExecutorError.business(error.message, { cause: error });
  }
  // Unknown throws are treated as transient by the runner (its default path).
  return error instanceof Error ? error : new Error(String(error));
}

function requireString(v: unknown): string {
  if (typeof v !== 'string' || v.trim() === '') {
    throw ExecutorError.business('agent-world tool call requires a non-empty string argument');
  }
  return v;
}

function isStringRecord(v: unknown): v is Record<string, string> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    && Object.values(v as Record<string, unknown>).every(x => typeof x === 'string');
}
