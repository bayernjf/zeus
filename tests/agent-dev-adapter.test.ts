/**
 * F1.3 adapter tests: a REAL local HTTP server emulates the agent-dev daemon's
 * approved Feature Task / Runtime routes. Nothing in the adapter is mocked —
 * only the upstream daemon is faked — so the client's bearer handling, the
 * executor's action idempotency and the ToolInvoker's argument validation run
 * for real.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  AgentDevClient,
  AgentDevToolInvoker,
  AgentDevOrgTaskExecutor,
  AGENT_DEV_TOOLS,
} from '../src/core/org/index.js';
import { runTask, InMemoryActionStore } from '../src/core/org/execution/index.js';
import type { OrgTask, Position } from '../src/core/org/types.js';

const TOKEN = 'test-daemon-token';

class FakeAgentDev {
  private server: Server;
  port = 0;
  calls = { getTask: 0, prepare: 0, execute: 0, evidence: 0, lastCommit: 0, unauthorized: 0 };
  bodies: Record<string, unknown>[] = [];
  taskStatus: 'draft' | 'approved' = 'approved';
  taskId = 'ft-1';
  /** When true the execute route answers 422 with a failed run. */
  failExecution = false;
  /** Delay the synchronous execute route to exercise the long timeout budget. */
  executeDelayMs = 0;
  private closed = false;

  private constructor() {
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch(() => {
        res.statusCode = 500;
        res.end('{}');
      });
    });
  }

  static async start(): Promise<FakeAgentDev> {
    const f = new FakeAgentDev();
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
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      this.calls.unauthorized += 1;
      res.statusCode = 401;
      res.end(JSON.stringify({ error: 'Unauthorized.' }));
      return;
    }

    const projectId = decodeURIComponent(/^\/api\/projects\/([^/]+)/.exec(url.pathname)?.[1] ?? '');
    const parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {};

    if (req.method === 'GET' && /^\/api\/projects\/[^/]+\/feature-task$/.test(url.pathname)) {
      this.calls.getTask += 1;
      res.end(JSON.stringify({
        task: {
          id: this.taskId,
          projectId,
          blueprintRevision: 1,
          title: 'Fix the pricing copy',
          objective: 'Change "perpurchase" to "per purchase".',
          acceptanceCriteria: ['The typo is gone'],
          status: this.taskStatus,
          workspacePath: '/tmp/agent-dev-workspace',
        },
      }));
      return;
    }
    if (req.method === 'POST' && /^\/api\/projects\/[^/]+\/runtime\/run$/.test(url.pathname)) {
      this.calls.prepare += 1;
      this.bodies.push(parsed);
      res.statusCode = 201;
      res.end(JSON.stringify({ run: { id: 'run-1', projectId, status: 'planned', agentId: parsed.agentId ?? 'codex' } }));
      return;
    }
    if (req.method === 'POST' && /^\/api\/projects\/[^/]+\/runtime\/execute$/.test(url.pathname)) {
      this.calls.execute += 1;
      this.bodies.push(parsed);
      if (this.executeDelayMs > 0) await new Promise(resolve => setTimeout(resolve, this.executeDelayMs));
      const status = this.failExecution ? 'failed' : 'completed';
      const exitCode = this.failExecution ? 1 : 0;
      res.statusCode = this.failExecution ? 422 : 200;
      res.end(JSON.stringify({
        run: {
          id: 'run-1',
          taskId: this.taskId,
          projectId,
          blueprintRevision: 1,
          agentId: 'codex',
          status,
          attempts: 1,
          result: {
            exitCode,
            signal: null,
            timedOut: false,
            output: this.failExecution ? 'typecheck failed' : 'copy fixed',
            startedAt: '2026-11-17T00:00:00.000Z',
            completedAt: '2026-11-17T00:01:00.000Z',
          },
        },
      }));
      return;
    }
    if (req.method === 'GET' && /^\/api\/projects\/[^/]+\/runtime\/evidence$/.test(url.pathname)) {
      this.calls.evidence += 1;
      res.end(JSON.stringify({
        evidence: {
          branch: 'feature/agent-dev/revision-1',
          head: 'abc123',
          status: 'M src/copy.ts',
          diffStat: ' src/copy.ts | 2 +-',
        },
      }));
      return;
    }
    if (req.method === 'GET' && /^\/api\/projects\/[^/]+\/runtime\/last-commit$/.test(url.pathname)) {
      this.calls.lastCommit += 1;
      res.end(JSON.stringify({
        lastCommit: {
          hash: 'def456',
          subject: 'feat: Fix the pricing copy',
          diffStat: ' src/copy.ts | 2 +-',
        },
      }));
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

function makeTask(payload: Record<string, unknown> = {}): OrgTask {
  return {
    format: 'zeus-org-task',
    version: 1,
    id: 'org-task-1',
    organizationId: 'org-1',
    title: 'Fix the pricing copy',
    payload: {
      system: 'agent-dev',
      projectId: 'project-1',
      blueprintRevision: 3,
      featureTaskId: 'ft-1',
      ...payload,
    },
    status: 'pending',
  } as unknown as OrgTask;
}

const ALL_TOOLS = Object.values(AGENT_DEV_TOOLS);

function makePosition(allowedTools: string[] = ALL_TOOLS): Position {
  return {
    id: 'pos-1',
    organizationId: 'org-1',
    departmentId: 'dep-1',
    name: 'engineer',
    responsibilities: [],
    requiredSkills: [],
    allowedTools,
    decisionScope: 'D0',
    agentId: 'agent-1',
  } as unknown as Position;
}

function makeExecutor(fake: FakeAgentDev) {
  const client = new AgentDevClient({ baseUrl: fake.baseUrl, token: TOKEN, fetchImpl: fetch });
  return {
    client,
    executor: new AgentDevOrgTaskExecutor(),
    invoker: new AgentDevToolInvoker({ client }),
  };
}

let fake: FakeAgentDev | undefined;
afterEach(async () => {
  await fake?.stop();
  fake = undefined;
});

describe('AgentDevClient bearer handling', () => {
  it('rejects a wrong token as a definitive 401', async () => {
    fake = await FakeAgentDev.start();
    const client = new AgentDevClient({ baseUrl: fake.baseUrl, token: 'wrong', fetchImpl: fetch });
    await expect(client.getFeatureTask({ projectId: 'project-1' })).rejects.toMatchObject({
      status: 401,
      retryable: false,
    });
  });
});

describe('AgentDevClient timeout budget', () => {
  it('waits for the synchronous execute route instead of the metadata timeout', async () => {
    fake = await FakeAgentDev.start();
    fake.executeDelayMs = 60;
    const client = new AgentDevClient({
      baseUrl: fake.baseUrl,
      token: TOKEN,
      fetchImpl: fetch,
      timeoutMs: 20,
      executeTimeoutMs: 500,
    });
    const result = await client.executeRuntime({ projectId: 'project-1' });
    expect(result.run.status).toBe('completed');
  });
});

describe('AgentDevOrgTaskExecutor through runTask', () => {
  it('reads the approved task, prepares and executes the run, and returns the diff', async () => {
    fake = await FakeAgentDev.start();
    const { executor, invoker } = makeExecutor(fake);
    const settlement = await runTask({
      task: makeTask(),
      position: makePosition(),
      agentId: 'agent-1',
      executor,
      toolInvoker: invoker,
      retryPolicy: { maxAttempts: 1, baseBackoffMs: 1, maxBackoffMs: 1, factor: 1, jitter: 0 },
      deadlineMs: 20_000,
    });

    expect(settlement.outcome).toBe('complete');
    if (settlement.outcome !== 'complete') return;
    expect(settlement.result).toMatchObject({
      system: 'agent-dev',
      projectId: 'project-1',
      featureTaskId: 'ft-1',
      runId: 'run-1',
      status: 'completed',
      git: {
        branch: 'feature/agent-dev/revision-1',
        head: 'abc123',
        diffStat: ' src/copy.ts | 2 +-',
        lastCommit: {
          hash: 'def456',
          subject: 'feat: Fix the pricing copy',
          diffStat: ' src/copy.ts | 2 +-',
        },
      },
    });
    expect(fake.calls).toMatchObject({ getTask: 1, prepare: 1, execute: 1, evidence: 1, lastCommit: 1, unauthorized: 0 });
    expect(fake.bodies[0]).toMatchObject({ confirmation: 'PREPARE_RUNTIME_RUN' });
    expect(fake.bodies[1]).toMatchObject({ confirmation: 'EXECUTE_RUNTIME_RUN' });
  });

  it('replays the cached runtime steps without starting a second CLI run', async () => {
    fake = await FakeAgentDev.start();
    const { executor, invoker } = makeExecutor(fake);
    const actionStore = new InMemoryActionStore();
    const args = {
      task: makeTask(),
      position: makePosition(),
      agentId: 'agent-1',
      executor,
      toolInvoker: invoker,
      retryPolicy: { maxAttempts: 1, baseBackoffMs: 1, maxBackoffMs: 1, factor: 1, jitter: 0 },
      deadlineMs: 20_000,
    };
    const first = await runTask({ ...args, actionStore });
    const second = await runTask({ ...args, actionStore, resumed: true });
    expect(first.outcome).toBe('complete');
    expect(second.outcome).toBe('complete');
    expect(fake.calls).toMatchObject({ prepare: 1, execute: 1 });
  });

  it('refuses a Feature Task that is not approved before touching the runtime', async () => {
    fake = await FakeAgentDev.start();
    fake.taskStatus = 'draft';
    const { executor, invoker } = makeExecutor(fake);
    const settlement = await runTask({
      task: makeTask(),
      position: makePosition(),
      agentId: 'agent-1',
      executor,
      toolInvoker: invoker,
      retryPolicy: { maxAttempts: 1, baseBackoffMs: 1, maxBackoffMs: 1, factor: 1, jitter: 0 },
      deadlineMs: 20_000,
    });
    expect(settlement.outcome).toBe('failed');
    if (settlement.outcome !== 'failed') return;
    expect(settlement.failureKind).toBe('business');
    expect(settlement.error).toContain('not approved');
    expect(fake.calls.prepare).toBe(0);
    expect(fake.calls.execute).toBe(0);
  });

  it('refuses a stale featureTaskId instead of executing a different task', async () => {
    fake = await FakeAgentDev.start();
    fake.taskId = 'ft-2';
    const { executor, invoker } = makeExecutor(fake);
    const settlement = await runTask({
      task: makeTask(),
      position: makePosition(),
      agentId: 'agent-1',
      executor,
      toolInvoker: invoker,
      retryPolicy: { maxAttempts: 1, baseBackoffMs: 1, maxBackoffMs: 1, factor: 1, jitter: 0 },
      deadlineMs: 20_000,
    });
    expect(settlement.outcome).toBe('failed');
    if (settlement.outcome !== 'failed') return;
    expect(settlement.failureKind).toBe('business');
    expect(settlement.error).toContain('changed from ft-1 to ft-2');
    expect(fake.calls.prepare).toBe(0);
  });

  it('settles a failed CLI run as a business failure with the real output', async () => {
    fake = await FakeAgentDev.start();
    fake.failExecution = true;
    const { executor, invoker } = makeExecutor(fake);
    const settlement = await runTask({
      task: makeTask(),
      position: makePosition(),
      agentId: 'agent-1',
      executor,
      toolInvoker: invoker,
      retryPolicy: { maxAttempts: 1, baseBackoffMs: 1, maxBackoffMs: 1, factor: 1, jitter: 0 },
      deadlineMs: 20_000,
    });
    expect(settlement.outcome).toBe('failed');
    if (settlement.outcome !== 'failed') return;
    expect(settlement.failureKind).toBe('business');
    expect(settlement.error).toContain('status "failed"');
    expect(fake.calls.execute).toBe(1);
  });

  it('denies a position that was not granted the agent-dev tools', async () => {
    fake = await FakeAgentDev.start();
    const { executor, invoker } = makeExecutor(fake);
    const settlement = await runTask({
      task: makeTask(),
      position: makePosition([]),
      agentId: 'agent-1',
      executor,
      toolInvoker: invoker,
      retryPolicy: { maxAttempts: 1, baseBackoffMs: 1, maxBackoffMs: 1, factor: 1, jitter: 0 },
      deadlineMs: 20_000,
    });
    expect(settlement.outcome).toBe('failed');
    if (settlement.outcome !== 'failed') return;
    expect(settlement.failureKind).toBe('tool_denied');
    expect(fake.calls.getTask).toBe(0);
  });
});
