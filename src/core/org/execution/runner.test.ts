/**
 * T-M7-01 execution contract tests — the five settlements and the
 * framework-enforced limits.
 *
 * Covers complete / progress(checkpoint) / request(awaiting_decision) /
 * error(business|retryable) / timeout; bounded retry and a hard task deadline
 * that cannot be bypassed by executor code; tool authority fail-closed; and
 * at-most-once idempotency across retry and resume. Uses the real
 * DecisionService (D0 auto-decides, D2 blocks) so the decision integration is
 * exercised end to end; no HTTP.
 */
import { describe, expect, it } from 'vitest';
import { DecisionService } from '../../decision-service/service.js';
import { MemoryDecisionStore } from '../../decision-service/store.js';
import { DecisionAuditChain } from '../../audit/audit-chain.js';
import { Ed25519MemorySigner } from '../../../registry/signing.js';
import { MemoryPolicyStore } from '../../grading/policy-loader.js';
import { DEFAULT_POLICY_V1 } from '../../grading/default-policy.js';
import {
  ExecutorError,
  InMemoryActionStore,
  runTask,
  type ExecutorContext,
  type OrgTaskExecutorV2,
  type RunTaskParams,
  type ToolInvoker,
} from './index.js';
import type { OrgTask, Position } from '../types.js';

function makeDecisions(): DecisionService {
  const policyStore = new MemoryPolicyStore();
  policyStore.put(DEFAULT_POLICY_V1);
  return new DecisionService({
    policyStore,
    recordStore: new MemoryDecisionStore(),
    audit: new DecisionAuditChain(new Ed25519MemorySigner('m7-runner-test')),
  });
}

function makePosition(allowedTools: string[] = ['listing.publish', 'refund.issue']): Position {
  const now = '2026-10-24T00:00:00.000Z';
  return {
    format: 'zeus-position',
    version: 1,
    id: 'pos:ops',
    organizationId: 'org:test',
    departmentId: 'dept:ops',
    name: '运营专员',
    responsibilities: [],
    requiredSkills: ['ops'],
    allowedTools,
    decisionScope: 'D2',
    agentId: 'agent-1',
    createdAt: now,
  };
}

function makeTask(): OrgTask {
  const now = '2026-10-24T00:00:00.000Z';
  return {
    format: 'zeus-org-task',
    version: 1,
    id: 'task-1',
    organizationId: 'org:test',
    title: 't',
    payload: {},
    positionId: 'pos:ops',
    assignedAgentId: 'agent-1',
    status: 'running',
    transitions: [],
    createdAt: now,
    updatedAt: now,
  };
}

const FAST_RETRY = { maxAttempts: 3, baseBackoffMs: 1, maxBackoffMs: 1, factor: 1, jitter: 0 } as const;

function baseParams(
  decisions: DecisionService,
  executor: OrgTaskExecutorV2,
  overrides: Partial<RunTaskParams> = {},
): RunTaskParams {
  return {
    task: makeTask(),
    position: makePosition(),
    agentId: 'agent-1',
    executor,
    decisions,
    deadlineMs: 60_000,
    retryPolicy: { ...FAST_RETRY },
    ...overrides,
  };
}

describe('T-M7-01 execution contract — five settlements', () => {
  it('complete: returns the result after a single attempt', async () => {
    const decisions = makeDecisions();
    const r = await runTask(
      baseParams(decisions, { run: async () => ({ outcome: 'complete', result: { listed: true } }) }),
    );
    expect(r.outcome).toBe('complete');
    if (r.outcome === 'complete') {
      expect(r.result).toEqual({ listed: true });
      expect(r.attempts).toBe(1);
    }
  });

  it('checkpoint/progress: records non-pausing progress points and completes', async () => {
    const decisions = makeDecisions();
    const seen: { stage: string; percent?: number; at: string }[] = [];
    const executor: OrgTaskExecutorV2 = {
      run: async (ctx: ExecutorContext) => {
        ctx.reportProgress({ stage: 'draft', percent: 50 });
        ctx.reportProgress({ stage: 'published', percent: 100 });
        return { outcome: 'complete' };
      },
    };
    const r = await runTask(baseParams(decisions, executor, { onProgress: p => seen.push(p) }));
    expect(r.outcome).toBe('complete');
    expect(seen.map(p => p.stage)).toEqual(['draft', 'published']);
    expect(seen[0]?.percent).toBe(50);
    expect(typeof seen[0]?.at).toBe('string');
  });

  it('request: suspends at a blocked D2 checkpoint without completing', async () => {
    const decisions = makeDecisions();
    const executor: OrgTaskExecutorV2 = {
      run: async (ctx: ExecutorContext) => {
        const d = await ctx.requestDecision({
          intent: 'refund',
          amount: { value: 1200, currency: 'CNY' },
          impact: 'self',
          reversibility: 'reversible',
          idempotencyKey: 'refund-task-1',
        });
        return { outcome: 'complete', result: { grade: d.grade } };
      },
    };
    const r = await runTask(baseParams(decisions, executor));
    expect(r.outcome).toBe('awaiting_decision');
    if (r.outcome === 'awaiting_decision') {
      expect(r.decision.grade).toBe('D2');
      expect(r.decision.status).toBe('blocked');
      expect(r.attempts).toBe(1);
    }
  });

  it('request: auto-decides a D0 checkpoint and continues to completion', async () => {
    const decisions = makeDecisions();
    const executor: OrgTaskExecutorV2 = {
      run: async (ctx: ExecutorContext) => {
        const d = await ctx.requestDecision({
          intent: 'edit-title',
          impact: 'self',
          reversibility: 'reversible',
          idempotencyKey: 'edit-task-1',
        });
        expect(d.status).toBe('decided');
        expect(d.grade).toBe('D0');
        return { outcome: 'complete', result: { grade: d.grade } };
      },
    };
    const r = await runTask(baseParams(decisions, executor));
    expect(r.outcome).toBe('complete');
  });

  it('resume: replays the approved decision and performs the side effect exactly once', async () => {
    const decisions = makeDecisions();
    const store = new InMemoryActionStore();
    let draftCalls = 0;
    const executor: OrgTaskExecutorV2 = {
      run: async (ctx: ExecutorContext) => {
        const draft = await ctx.action('draft', async () => {
          draftCalls++;
          return { sku: 'sku-1' };
        });
        const d = await ctx.requestDecision({
          intent: 'refund',
          amount: { value: 1200, currency: 'CNY' },
          impact: 'self',
          reversibility: 'reversible',
          idempotencyKey: 'refund-task-1',
        });
        // On replay the blocked call below never throws; status is decided.
        return { outcome: 'complete', result: { draft, approved: d.status === 'decided' } };
      },
    };
    const first = await runTask(baseParams(decisions, executor, { actionStore: store }));
    expect(first.outcome).toBe('awaiting_decision');
    expect(draftCalls).toBe(1);
    const decisionId = first.outcome === 'awaiting_decision' ? first.decision.id : '';
    const approved = await decisions.approve(decisionId, {
      decision: 'approve',
      approver: 'owner',
      comment: 'ok',
    });
    const second = await runTask(
      baseParams(decisions, executor, { actionStore: store, resumed: true, lastDecision: approved }),
    );
    expect(second.outcome).toBe('complete');
    expect(draftCalls).toBe(1); // draft action not re-executed on replay
    if (second.outcome === 'complete') {
      expect(second.result).toEqual({ draft: { sku: 'sku-1' }, approved: true });
    }
  });

  it('error/business: fails immediately and never retries', async () => {
    const decisions = makeDecisions();
    let runs = 0;
    const executor: OrgTaskExecutorV2 = {
      run: async () => {
        runs++;
        throw ExecutorError.business('out of stock');
      },
    };
    const r = await runTask(baseParams(decisions, executor));
    expect(r).toMatchObject({ outcome: 'failed', failureKind: 'business' });
    expect(runs).toBe(1);
  });

  it('error/retryable: retries with backoff and succeeds within the budget', async () => {
    const decisions = makeDecisions();
    let runs = 0;
    const executor: OrgTaskExecutorV2 = {
      run: async () => {
        runs++;
        if (runs < 3) throw ExecutorError.retryable('upstream 5xx');
        return { outcome: 'complete', result: { tries: runs } };
      },
    };
    const r = await runTask(baseParams(decisions, executor));
    expect(r.outcome).toBe('complete');
    expect(runs).toBe(3);
    if (r.outcome === 'complete') expect(r.result).toEqual({ tries: 3 });
  });

  it('error/retryable: settles retryable_exhausted once the budget is spent', async () => {
    const decisions = makeDecisions();
    let runs = 0;
    const executor: OrgTaskExecutorV2 = {
      run: async () => {
        runs++;
        throw ExecutorError.retryable('always down');
      },
    };
    const r = await runTask(baseParams(decisions, executor, {
      retryPolicy: { maxAttempts: 2, baseBackoffMs: 1, maxBackoffMs: 1, factor: 1, jitter: 0 },
    }));
    expect(r).toMatchObject({ outcome: 'failed', failureKind: 'retryable_exhausted' });
    if (r.outcome === 'failed') expect(r.attempts).toBe(2);
    expect(runs).toBe(2);
  });

  it('error/unknown: a plain throw is treated as retryable, not business', async () => {
    const decisions = makeDecisions();
    let runs = 0;
    const executor: OrgTaskExecutorV2 = {
      run: async () => {
        runs++;
        throw new Error('unexpected');
      },
    };
    const r = await runTask(baseParams(decisions, executor, {
      retryPolicy: { maxAttempts: 1, baseBackoffMs: 1, maxBackoffMs: 1, factor: 1, jitter: 0 },
    }));
    expect(r).toMatchObject({ outcome: 'failed', failureKind: 'retryable_exhausted' });
    expect(runs).toBe(1);
  });

  it('timeout: a non-cooperating executor that never resolves still hits the deadline', async () => {
    const decisions = makeDecisions();
    const executor: OrgTaskExecutorV2 = {
      run: () => new Promise(() => {
        /* intentionally never resolves and ignores the signal */
      }),
    };
    const r = await runTask(baseParams(decisions, executor, { deadlineMs: 30 }));
    expect(r).toMatchObject({ outcome: 'failed', failureKind: 'timeout' });
    if (r.outcome === 'failed') expect(r.attempts).toBe(1); // timeout is not retried
  });

  it('timeout: once aborted, further effects are refused', async () => {
    const decisions = makeDecisions();
    const external = new AbortController();
    const executor: OrgTaskExecutorV2 = {
      run: async (ctx: ExecutorContext) => {
        external.abort();
        ctx.reportProgress({ stage: 'after-abort' });
        return { outcome: 'complete' };
      },
    };
    const r = await runTask(baseParams(decisions, executor, { abort: external.signal }));
    expect(r).toMatchObject({ outcome: 'failed', failureKind: 'timeout' });
  });

  it('tool authority: a denied tool fails closed without retrying', async () => {
    const decisions = makeDecisions();
    let runs = 0;
    const invoker: ToolInvoker = { invoke: async () => ({ reached: true }) };
    const executor: OrgTaskExecutorV2 = {
      run: async (ctx: ExecutorContext) => {
        runs++;
        await ctx.tool('payment.drain', {});
        return { outcome: 'complete' };
      },
    };
    const r = await runTask(baseParams(decisions, executor, {
      toolInvoker: invoker,
      position: makePosition(['listing.publish']),
    }));
    expect(r).toMatchObject({ outcome: 'failed', failureKind: 'tool_denied' });
    expect(runs).toBe(1);
  });

  it('tool authority: a granted tool is invoked through the framework invoker', async () => {
    const decisions = makeDecisions();
    const invoker: ToolInvoker = {
      invoke: async (tool, args) => ({ tool, echo: args as Record<string, string> }),
    };
    const executor: OrgTaskExecutorV2 = {
      run: async (ctx: ExecutorContext) => {
        const out = await ctx.tool('listing.publish', { sku: 'sku-1' });
        return { outcome: 'complete', result: out };
      },
    };
    const r = await runTask(baseParams(decisions, executor, { toolInvoker: invoker }));
    expect(r.outcome).toBe('complete');
    if (r.outcome === 'complete') {
      expect(r.result).toEqual({ tool: 'listing.publish', echo: { sku: 'sku-1' } });
    }
  });

  it('idempotency: a decision request without an idempotency key fails (business)', async () => {
    const decisions = makeDecisions();
    const executor: OrgTaskExecutorV2 = {
      run: async (ctx: ExecutorContext) => {
        await ctx.requestDecision({
          intent: 'refund',
          amount: { value: 1200, currency: 'CNY' },
          impact: 'self',
          reversibility: 'reversible',
        } as never);
        return { outcome: 'complete' };
      },
    };
    const r = await runTask(baseParams(decisions, executor));
    expect(r).toMatchObject({ outcome: 'failed', failureKind: 'business' });
  });

  it('idempotency: an action is executed at most once across a retry', async () => {
    const decisions = makeDecisions();
    let runs = 0;
    let chargeCalls = 0;
    const executor: OrgTaskExecutorV2 = {
      run: async (ctx: ExecutorContext) => {
        runs++;
        const charge = await ctx.action('charge', async () => {
          chargeCalls++;
          return { charged: 1 };
        });
        if (runs < 2) throw ExecutorError.retryable('blip');
        return { outcome: 'complete', result: charge };
      },
    };
    const r = await runTask(baseParams(decisions, executor));
    expect(r.outcome).toBe('complete');
    expect(chargeCalls).toBe(1);
    if (r.outcome === 'complete') expect(r.result).toEqual({ charged: 1 });
  });

  it('exposes only credential references, never secret values', async () => {
    const decisions = makeDecisions();
    let seen: readonly string[] | undefined;
    const executor: OrgTaskExecutorV2 = {
      run: async (ctx: ExecutorContext) => {
        seen = ctx.credentialRefs;
        return { outcome: 'complete' };
      },
    };
    await runTask(baseParams(decisions, executor, {
      credentialRefs: ['agent-world:service-token'],
    }));
    expect(seen).toEqual(['agent-world:service-token']);
  });

  it('框架强制决策点上限：超过 maxDecisionHops 的 auto-decided 决策链 → failed/business', async () => {
    const decisions = makeDecisions();
    const r = await runTask(baseParams(decisions, {
      run: async ctx => {
        let n = 0;
        for (;;) {
          await ctx.requestDecision({
            intent: `edit-${n}`,
            impact: 'self',
            reversibility: 'reversible',
            idempotencyKey: `hop-${n++}`,
          });
        }
      },
    }, { maxDecisionHops: 3 }));
    expect(r.outcome).toBe('failed');
    if (r.outcome === 'failed') {
      expect(r.failureKind).toBe('business');
      expect(r.error).toMatch(/exceeded 3 decision checkpoints/);
    }
  });
});
