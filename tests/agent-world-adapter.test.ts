/**
 * T-M7-02 unit/integration tests for the agent-world adapter.
 *
 * The "fake agent-world" here is a REAL node:http server on an ephemeral port
 * that implements the subset of the Hono API the adapter speaks (login /
 * graphs / runs / timeline / artifacts / resume). Nothing in the adapter under
 * test is mocked — only the upstream agent-world process is, so the client's
 * JWT handling, error mapping, the ToolInvoker's least-privilege credential
 * resolution and the executor's checkpoint/idempotency flow all run for real.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DecisionService } from '../src/core/decision-service/service.js';
import { MemoryDecisionStore } from '../src/core/decision-service/store.js';
import { DecisionAuditChain } from '../src/core/audit/audit-chain.js';
import { Ed25519MemorySigner } from '../src/registry/signing.js';
import { MemoryPolicyStore } from '../src/core/grading/policy-loader.js';
import { DEFAULT_POLICY_V1 } from '../src/core/grading/default-policy.js';
import { EnvSecretBackend } from '../src/core/org/index.js';
import {
  AgentWorldClient,
  AgentWorldToolInvoker,
  AgentWorldOrgTaskExecutor,
  type AgentWorldRunView,
} from '../src/core/org/adapters/agent-world/index.js';
import { runTask, InMemoryActionStore } from '../src/core/org/execution/index.js';
import { CredentialError } from '../src/core/org/execution/credentials.js';
import type { OrgTask, Position } from '../src/core/org/types.js';

// ── fake upstream ─────────────────────────────────────────────────────────

interface FakeRun {
  status: AgentWorldRunView['status'];
  haltedNodeId: string | null;
  haltedReason: string | null;
}

class FakeAgentWorld {
  private server: Server;
  port = 0;
  runs = new Map<string, FakeRun>();
  graphSeq = 0;
  runSeq = 0;
  calls = { login: 0, createGraph: 0, startRun: 0, timeline: 0, artifacts: 0, resume: 0 };
  startRunKeys: string[] = [];
  /** When set, every timeline read returns this state (scripted halt/done). */
  stateOverride: FakeRun | null = null;
  /** Hook fired on resume so a test can flip the run to done. */
  onResume: ((runId: string, action: string) => void) | null = null;
  private closed = false;

  private constructor() {
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch(() => {
        res.statusCode = 500;
        res.end('{}');
      });
    });
  }

  static async start(): Promise<FakeAgentWorld> {
    const f = new FakeAgentWorld();
    await new Promise<void>(resolve => f.server.listen(0, '127.0.0.1', resolve));
    f.port = (f.server.address() as AddressInfo).port;
    return f;
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await new Promise<void>((resolve, reject) =>
      this.server.close(err => (err ? reject(err) : resolve())),
    );
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  private async handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.baseUrl);
    const body = await readBody(req);
    const route = `${req.method} ${url.pathname}`;
    res.setHeader('content-type', 'application/json');

    if (route === 'POST /api/auth/login') {
      this.calls.login += 1;
      res.setHeader('set-cookie', 'auth_token=fake-jwt-token; Path=/; HttpOnly');
      res.end(JSON.stringify({ user: { id: 'u1', email: JSON.parse(body).email } }));
      return;
    }
    if (route === 'POST /api/graphs') {
      this.calls.createGraph += 1;
      res.end(JSON.stringify({ id: `graph-${++this.graphSeq}`, template: JSON.parse(body).template, name: JSON.parse(body).name ?? null }));
      return;
    }
    if (route === 'POST /api/runs') {
      this.calls.startRun += 1;
      this.startRunKeys.push(req.headers['idempotency-key'] as string);
      const runId = `run-${++this.runSeq}`;
      this.runs.set(runId, { status: 'running', haltedNodeId: null, haltedReason: null });
      res.end(JSON.stringify({ runId, replay: false }));
      return;
    }
    let m = /^\/api\/runs\/([^/]+)\/timeline$/.exec(url.pathname);
    if (req.method === 'GET' && m) {
      this.calls.timeline += 1;
      const s = this.stateOverride
        ?? this.runs.get(m[1] ?? '')
        ?? { status: 'running' as const, haltedNodeId: null, haltedReason: null };
      res.end(JSON.stringify({ run: { id: m[1], graphId: 'graph-1', ...s, startedAt: '2026-10-24T00:00:00.000Z', endedAt: s.status === 'done' ? '2026-10-24T00:01:00.000Z' : null } }));
      return;
    }
    m = /^\/api\/runs\/([^/]+)\/artifacts$/.exec(url.pathname);
    if (req.method === 'GET' && m) {
      this.calls.artifacts += 1;
      res.end(JSON.stringify([{ id: 'art-1', kind: 'text', label: 'draft-note' }]));
      return;
    }
    m = /^\/api\/runs\/([^/]+)\/resume$/.exec(url.pathname);
    if (req.method === 'POST' && m) {
      this.calls.resume += 1;
      const action = JSON.parse(body).action;
      this.onResume?.(m[1]!, action);
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  }
}

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise(resolve => {
    let data = '';
    req.on('data', chunk => (data += chunk));
    req.on('end', () => resolve(data));
  });
}

// ── harness ───────────────────────────────────────────────────────────────

function makeDecisions(): DecisionService {
  const policyStore = new MemoryPolicyStore();
  policyStore.put(DEFAULT_POLICY_V1);
  return new DecisionService({
    policyStore,
    recordStore: new MemoryDecisionStore(),
    audit: new DecisionAuditChain(new Ed25519MemorySigner('aw-test')),
  });
}

const LOGIN_SECRET = JSON.stringify({ email: 'zeus@example.test', password: 'pw-123' });

function makeInvoker(fake: FakeAgentWorld, env: Record<string, string> = { ZEUS_SECRET_AGENT_WORLD_LOGIN: LOGIN_SECRET }) {
  const client = new AgentWorldClient({ baseUrl: fake.baseUrl });
  const secrets = new EnvSecretBackend({ vars: env });
  return { client, invoker: new AgentWorldToolInvoker({ client, secrets }) };
}

function makeTask(payload: Record<string, unknown>, id = 'task-1'): OrgTask {
  return {
    format: 'zeus-org-task',
    version: 1,
    id,
    organizationId: 'org-1',
    title: 't',
    payload,
    status: 'pending',
  } as unknown as OrgTask;
}

function makePosition(allowedTools: string[], credentialRefs: string[] = ['agent-world:login']): Position {
  return { id: 'pos-1', allowedTools, credentialRefs } as unknown as Position;
}

const ALL_TOOLS = ['agent-world:run-graph', 'agent-world:resume-run', 'agent-world:get-run'];

let fake: FakeAgentWorld | undefined;
afterEach(async () => {
  await fake?.stop();
  fake = undefined;
});

// ── client ─────────────────────────────────────────────────────────────────

describe('AgentWorldClient against a real local fake server', () => {
  it('logs in once and reuses the JWT as a Bearer on later calls', async () => {
    fake = await FakeAgentWorld.start();
    const { invoker } = makeInvoker(fake);
    const position = makePosition(ALL_TOOLS);
    await invoker.invoke('agent-world:run-graph', { template: 'tpl-x', input: 'hi' }, ctx(position, ['agent-world:login']));
    expect(fake.calls.login).toBe(1);
    // A second tool call must NOT re-login (token cached).
    await invoker.invoke('agent-world:get-run', { runId: 'run-1', view: 'timeline' }, ctx(position, ['agent-world:login']));
    expect(fake.calls.login).toBe(1);
  });
});

// ── ToolInvoker credential fail-closed ─────────────────────────────────────

describe('AgentWorldToolInvoker credential resolution (fail-closed)', () => {
  it('fails closed when the position was not granted the login ref', async () => {
    fake = await FakeAgentWorld.start();
    const { invoker } = makeInvoker(fake);
    await expect(
      invoker.invoke('agent-world:run-graph', { template: 'tpl-x', input: 'hi' }, ctx(makePosition(ALL_TOOLS), [])),
    ).rejects.toBeInstanceOf(CredentialError);
    expect(fake.calls.startRun).toBe(0);
  });

  it('fails closed when the backend cannot resolve the granted secret', async () => {
    fake = await FakeAgentWorld.start();
    const { invoker } = makeInvoker(fake, {}); // no secret in env
    await expect(
      invoker.invoke('agent-world:run-graph', { template: 'tpl-x', input: 'hi' }, ctx(makePosition(ALL_TOOLS), ['agent-world:login'])),
    ).rejects.toBeInstanceOf(CredentialError);
    expect(fake.calls.startRun).toBe(0);
  });

  it('rejects an unknown tool name (no anonymous fall-through)', async () => {
    fake = await FakeAgentWorld.start();
    const { invoker } = makeInvoker(fake);
    await expect(
      invoker.invoke('agent-world:delete-everything', {}, ctx(makePosition(ALL_TOOLS), ['agent-world:login'])),
    ).rejects.toThrow(/no tool/);
  });
});

// ── executor flows through the hardened runner ─────────────────────────────

describe('AgentWorldOrgTaskExecutor flows via runTask', () => {
  it('content workflow: starts a run, polls to done, completes with evidence', async () => {
    fake = await FakeAgentWorld.start();
    const { invoker } = makeInvoker(fake);
    fake.stateOverride = { status: 'done', haltedNodeId: null, haltedReason: null };
    const executor = new AgentWorldOrgTaskExecutor({ pollIntervalMs: 1 });
    const settlement = await runTask({
      task: makeTask({ workflow: 'content', input: '推广香薰蜡烛' }),
      position: makePosition(ALL_TOOLS),
      agentId: 'agent-1',
      credentialRefs: ['agent-world:login'],
      executor,
      toolInvoker: invoker,
      decisions: makeDecisions(),
      retryPolicy: { maxAttempts: 2, baseBackoffMs: 1, maxBackoffMs: 1, factor: 1, jitter: 0 },
      deadlineMs: 20_000,
    });
    expect(settlement.outcome).toBe('complete');
    if (settlement.outcome !== 'complete') return;
    const result = settlement.result as Record<string, unknown>;
    expect(result.system).toBe('agent-world');
    expect(result.workflow).toBe('content');
    expect(result.finalStatus).toBe('done');
    expect(result.runId).toBeTruthy();
    expect(result.artifacts).toEqual([expect.objectContaining({ id: 'art-1', kind: 'text' })]);
    expect(fake.calls.startRun).toBe(1);
  });

  it('listing workflow: suspends at the D3 human halt, resumes after approval and completes', async () => {
    fake = await FakeAgentWorld.start();
    const { invoker } = makeInvoker(fake);
    const executor = new AgentWorldOrgTaskExecutor({ pollIntervalMs: 1 });
    const decisions = makeDecisions();
    const position = makePosition(ALL_TOOLS);
    const task = makeTask({ workflow: 'listing', input: '上架listing A', fieldValues: { reviewWebhookUrl: 'http://127.0.0.1:9/w' } });
    const actionStore = new InMemoryActionStore();
    fake.stateOverride = { status: 'halted', haltedNodeId: 'human', haltedReason: 'human review required' };

    // First pass: run halts at the human node -> task suspends awaiting_decision.
    const first = await runTask({
      task, position, agentId: 'agent-1', credentialRefs: ['agent-world:login'], executor, toolInvoker: invoker, decisions,
      actionStore, retryPolicy: { maxAttempts: 2, baseBackoffMs: 1, maxBackoffMs: 1, factor: 1, jitter: 0 }, deadlineMs: 20_000,
    });
    expect(first.outcome).toBe('awaiting_decision');
    if (first.outcome !== 'awaiting_decision') return;
    expect(first.decision.status).toBe('blocked');
    expect(fake.calls.resume).toBe(0);

    // Approve the suspended decision, then resume the task (replay).
    const approved = await decisions.approve(first.decision.id, { decision: 'approve', approver: 'ops-lead' });
    fake.onResume = (runId) => {
      fake!.stateOverride = null;
      fake!.runs.set(runId, { status: 'done', haltedNodeId: null, haltedReason: null });
    };

    const second = await runTask({
      task, position, agentId: 'agent-1', credentialRefs: ['agent-world:login'], executor, toolInvoker: invoker, decisions,
      actionStore, resumed: true, lastDecision: approved,
      retryPolicy: { maxAttempts: 2, baseBackoffMs: 1, maxBackoffMs: 1, factor: 1, jitter: 0 }, deadlineMs: 20_000,
    });
    expect(second.outcome).toBe('complete');
    expect(fake.calls.resume).toBe(1);
    // Exactly one channel start across the whole suspend/resume replay: the
    // action store returned the cached start on replay (no duplicate graph run).
    expect(fake.calls.startRun).toBe(1);
  });

  it('listing reject path: approval=reject resumes the channel with reject and settles failed/business', async () => {
    fake = await FakeAgentWorld.start();
    const { invoker } = makeInvoker(fake);
    const executor = new AgentWorldOrgTaskExecutor({ pollIntervalMs: 1 });
    const decisions = makeDecisions();
    const position = makePosition(ALL_TOOLS);
    const task = makeTask({ workflow: 'listing', input: '上架listing B' });
    const actionStore = new InMemoryActionStore();
    fake.stateOverride = { status: 'halted', haltedNodeId: 'human', haltedReason: 'human review required' };

    const first = await runTask({
      task, position, agentId: 'agent-1', credentialRefs: ['agent-world:login'], executor, toolInvoker: invoker, decisions, actionStore,
      retryPolicy: { maxAttempts: 2, baseBackoffMs: 1, maxBackoffMs: 1, factor: 1, jitter: 0 }, deadlineMs: 20_000,
    });
    expect(first.outcome).toBe('awaiting_decision');
    if (first.outcome !== 'awaiting_decision') return;
    const rejected = await decisions.approve(first.decision.id, { decision: 'reject', approver: 'ops-lead' });

    const second = await runTask({
      task, position, agentId: 'agent-1', credentialRefs: ['agent-world:login'], executor, toolInvoker: invoker, decisions, actionStore,
      resumed: true, lastDecision: rejected,
      retryPolicy: { maxAttempts: 2, baseBackoffMs: 1, maxBackoffMs: 1, factor: 1, jitter: 0 }, deadlineMs: 20_000,
    });
    expect(second.outcome).toBe('failed');
    if (second.outcome !== 'failed') return;
    expect(second.failureKind).toBe('business');
    expect(fake.calls.resume).toBe(1);
  });

  it('denies a position whose allowedTools lacks the channel tool (tool_denied, fail-closed)', async () => {
    fake = await FakeAgentWorld.start();
    const { invoker } = makeInvoker(fake);
    const executor = new AgentWorldOrgTaskExecutor({ pollIntervalMs: 1 });
    const position = makePosition([]); // no channel tools granted
    const settlement = await runTask({
      task: makeTask({ workflow: 'content', input: 'x' }), position, agentId: 'agent-1',
      executor, toolInvoker: invoker, decisions: makeDecisions(),
      retryPolicy: { maxAttempts: 1, baseBackoffMs: 1, maxBackoffMs: 1, factor: 1, jitter: 0 }, deadlineMs: 20_000,
    });
    expect(settlement.outcome).toBe('failed');
    if (settlement.outcome !== 'failed') return;
    expect(settlement.failureKind).toBe('tool_denied');
    expect(fake.calls.startRun).toBe(0);
  });
});

/** Build a minimal ExecutorContext-shaped object for direct invoker calls. */
function ctx(position: Position, credentialRefs: string[]) {
  return {
    task: makeTask({ workflow: 'content', input: 'x' }),
    position,
    agentId: 'agent-1',
    credentialRefs,
  } as unknown as Parameters<AgentWorldToolInvoker['invoke']>[2];
}
