/**
 * T-M7-03 fail-closed grade-scope authority (D-grade) enforcement.
 *
 * Fail-closed A: a position with decisionScope D2 cannot perform a D3 action.
 *  - a direct D3-graded tool call outside any approved decision is rejected
 *    (failed/tool_denied, invoker never reached — no silent downgrade);
 *  - the legitimate listing flow still halts at the D3 checkpoint: the D2
 *    position cannot self-approve, and the D3 resume action only proceeds after
 *    a real approved D3 decision is carried into the resumed run.
 *
 * Uses the real hardened runner and the real DecisionService; the ToolInvoker
 * is a recording double (the guard under test never touches a network).
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
  GradeDeniedError,
  InMemoryActionStore,
  runTask,
  type ExecutorContext,
  type EffectResult,
  type OrgTaskExecutorV2,
  type ToolInvoker,
} from '../execution/index.js';
import type { OrgTask, Position } from '../types.js';

function makeDecisions(): DecisionService {
  const policyStore = new MemoryPolicyStore();
  policyStore.put(DEFAULT_POLICY_V1);
  return new DecisionService({
    policyStore,
    recordStore: new MemoryDecisionStore(),
    audit: new DecisionAuditChain(new Ed25519MemorySigner('tm7-03-scope')),
  });
}

function makePosition(scope: Position['decisionScope']): Position {
  const now = '2026-10-24T00:00:00.000Z';
  return {
    format: 'zeus-position',
    version: 1,
    id: 'pos:ops',
    organizationId: 'org:test',
    departmentId: 'dept:ops',
    name: '运营专员',
    responsibilities: [],
    requiredSkills: ['listing-publish'],
    allowedTools: ['aw:start', 'aw:resume'],
    decisionScope: scope,
    agentId: 'agent-1',
    createdAt: now,
  };
}

function makeTask(): OrgTask {
  const now = '2026-10-24T00:00:00.000Z';
  return {
    format: 'zeus-org-task',
    version: 1,
    id: 'task-scope-1',
    organizationId: 'org:test',
    title: 'listing publish',
    payload: { workflow: 'listing', input: 'x' },
    positionId: 'pos:ops',
    assignedAgentId: 'agent-1',
    status: 'running',
    transitions: [],
    createdAt: now,
    updatedAt: now,
  };
}

/** Recording invoker: logs the channel args it actually receives. */
class RecordingInvoker implements ToolInvoker {
  calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  async invoke(tool: string, args: Record<string, unknown>): Promise<EffectResult> {
    this.calls.push({ tool, args });
    return { ok: true, tool };
  }
}

const FAST_RETRY = { maxAttempts: 1, baseBackoffMs: 1, maxBackoffMs: 1, factor: 1, jitter: 0 } as const;

/** Listing-shape executor: start, halt at a D3 checkpoint, resume only after approval. */
const listingExecutor: OrgTaskExecutorV2 = {
  async run(ctx: ExecutorContext): Promise<{ outcome: 'complete'; result: { runId: string } }> {
    await ctx.action('aw:start', async () => ctx.tool('aw:start', {}));
    const decision = await ctx.requestDecision({
      intent: 'publish listing externally',
      impact: 'external',
      reversibility: 'irreversible',
      proposal: { workflow: 'listing', runId: 'r1' },
      idempotencyKey: `${ctx.task.id}:human`,
    });
    if (decision.result?.outcome !== 'approved') {
      throw ExecutorError.business(`reviewer decided ${decision.result?.outcome ?? 'unknown'}`);
    }
    await ctx.action('aw:resume', async () =>
      ctx.tool('aw:resume', { action: 'approve', __requiredGrade: 'D3' }),
    );
    return { outcome: 'complete', result: { runId: 'r1' } };
  },
};

describe('grade-scope authority (fail-closed)', () => {
  it('rejects a direct D3-graded tool call from a D2 position with no approved decision', async () => {
    const invoker = new RecordingInvoker();
    const rogue: OrgTaskExecutorV2 = {
      async run(ctx) {
        await ctx.tool('aw:resume', { action: 'approve', __requiredGrade: 'D3' });
        return { outcome: 'complete' as const, result: {} };
      },
    };
    const settlement = await runTask({
      task: makeTask(),
      position: makePosition('D2'),
      agentId: 'agent-1',
      executor: rogue,
      toolInvoker: invoker,
      decisions: makeDecisions(),
      retryPolicy: { ...FAST_RETRY, maxAttempts: 2 },
      deadlineMs: 20_000,
    });
    expect(settlement.outcome).toBe('failed');
    if (settlement.outcome !== 'failed') return;
    expect(settlement.failureKind).toBe('tool_denied');
    // Fail-closed: the channel was never reached.
    expect(invoker.calls).toEqual([]);
    // The body shows the grade comparison, never a silent downgrade.
    expect(settlement.error).toContain('D3');
    expect(settlement.error).toContain('D2');
  });

  it('a D2 position may perform D0-graded channel work autonomously', async () => {
    const invoker = new RecordingInvoker();
    const autonomous: OrgTaskExecutorV2 = {
      async run(ctx) {
        await ctx.tool('aw:start', {});
        return { outcome: 'complete' as const, result: {} };
      },
    };
    const settlement = await runTask({
      task: makeTask(),
      position: makePosition('D2'),
      agentId: 'agent-1',
      executor: autonomous,
      toolInvoker: invoker,
      decisions: makeDecisions(),
      retryPolicy: FAST_RETRY,
      deadlineMs: 20_000,
    });
    expect(settlement.outcome).toBe('complete');
    expect(invoker.calls.map(c => c.tool)).toEqual(['aw:start']);
  });

  it('unlocks the D3 call once an approved D3 decision covers the resumed run', async () => {
    const decisions = makeDecisions();
    const invoker = new RecordingInvoker();
    const actionStore = new InMemoryActionStore();
    const task = makeTask();

    // First pass: halts at the D3 checkpoint; the D2 position cannot proceed.
    const first = await runTask({
      task,
      position: makePosition('D2'),
      agentId: 'agent-1',
      executor: listingExecutor,
      toolInvoker: invoker,
      decisions,
      actionStore,
      retryPolicy: FAST_RETRY,
      deadlineMs: 20_000,
    });
    expect(first.outcome).toBe('awaiting_decision');
    if (first.outcome !== 'awaiting_decision') return;
    // The external/irreversible decision is graded D3 — the D2 position cannot
    // self-approve it; it parks here for a human.
    expect(first.decision.grade).toBe('D3');
    expect(first.decision.status).toBe('blocked');
    // Only the D0 start happened; the D3 resume never ran on the first pass.
    expect(invoker.calls.map(c => c.tool)).toEqual(['aw:start']);

    // Human approval, then resume with the approved decision carried in.
    const approved = await decisions.approve(first.decision.id, { decision: 'approve', approver: 'ops-lead' });
    const second = await runTask({
      task,
      position: makePosition('D2'),
      agentId: 'agent-1',
      executor: listingExecutor,
      toolInvoker: invoker,
      decisions,
      actionStore,
      resumed: true,
      lastDecision: approved,
      retryPolicy: FAST_RETRY,
      deadlineMs: 20_000,
    });
    expect(second.outcome).toBe('complete');
    // The D3 resume now runs exactly once, and the runner strips the grade hint
    // before the channel sees it.
    expect(invoker.calls.map(c => c.tool)).toEqual(['aw:start', 'aw:resume']);
    const resumeArgs = invoker.calls.find(c => c.tool === 'aw:resume')!.args;
    expect(resumeArgs).not.toHaveProperty('__requiredGrade');
    expect(resumeArgs.action).toBe('approve');
  });

  it('GradeDeniedError carries required vs position scope vs approved coverage', () => {
    const err = new GradeDeniedError('aw:resume', 'D3', 'D2', 'D0', ['aw:start', 'aw:resume']);
    expect(err.requiredGrade).toBe('D3');
    expect(err.positionScope).toBe('D2');
    expect(err.approvedCeil).toBe('D0');
    expect(err.message).toContain('D3');
  });
});
