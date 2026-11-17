/**
 * P0 template executor unit coverage: local weekly-report steps, D2 human
 * review, agent-world delegation for content drafts, and payload routing.
 */
import { describe, expect, it } from 'vitest';
import type { Json, OrgTask, Position } from '../types.js';
import type {
  DecisionOutcome,
  DecisionRecord,
} from '../../decision-service/types.js';
import {
  ExecutorError,
  type ExecutorContext,
  type ExecutorDecisionRequest,
  type ExecutionProgress,
  type OrgTaskExecutorV2,
} from './index.js';
import { RoutingOrgTaskExecutor, RoutingToolInvoker } from './router.js';
import { TemplateOrgTaskExecutor } from './template-executor.js';

const AT = '2026-11-17T00:00:00.000Z';

function task(overrides: Partial<OrgTask> & { payload: Json }): OrgTask {
  return {
    format: 'zeus-org-task',
    version: 1,
    id: 'task-1',
    organizationId: 'org-1',
    title: '模板任务',
    status: 'running',
    transitions: [],
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

function position(): Position {
  return {
    format: 'zeus-position',
    version: 1,
    id: 'pos-1',
    organizationId: 'org-1',
    departmentId: 'dept-1',
    name: '模板执行岗',
    responsibilities: [],
    requiredSkills: [],
    allowedTools: [],
    decisionScope: 'D2',
    agentId: 'agent-1',
    createdAt: AT,
  };
}

function decision(outcome: DecisionOutcome): DecisionRecord {
  return {
    id: 'decision-1',
    intent: 'review',
    domain: 'template',
    impact: 'org',
    reversibility: 'hard',
    grade: 'D2',
    mode: 'approve-sync',
    status: 'decided',
    ruleId: 'default',
    gradeReason: 'org/hard',
    policyVersion: 1,
    createdAt: AT,
    updatedAt: AT,
    auditSeq: 1,
    approvals: [],
    result: { outcome, at: AT },
  };
}

function makeContext(
  input: OrgTask,
  options: { outcome?: DecisionOutcome } = {},
): {
  ctx: ExecutorContext;
  decisions: Array<ExecutorDecisionRequest>;
  progress: ExecutionProgress[];
} {
  const decisions: Array<ExecutorDecisionRequest> = [];
  const progress: ExecutionProgress[] = [];
  const ctx: ExecutorContext = {
    task: input,
    position: position(),
    agentId: 'agent-1',
    resumed: false,
    allowedTools: [],
    credentialRefs: [],
    signal: new AbortController().signal,
    remainingMs: 60_000,
    reportProgress: p => progress.push(p),
    requestDecision: async req => {
      decisions.push(req);
      return decision(options.outcome ?? 'approved');
    },
    tool: async () => {
      throw new Error('unexpected tool call');
    },
    action: async <T extends Json>(_key: string, fn: () => Promise<T>): Promise<T> => fn(),
  };
  return { ctx, decisions, progress };
}

describe('TemplateOrgTaskExecutor', () => {
  it('collects the occurrence tasks for weekly-report.collect', async () => {
    const tasks = [
      task({
        id: 'collect-1',
        title: '收集数据',
        payload: { goalId: 'goal-1', scheduledFor: '2026-11-17T06:00:00.000Z', stepId: 'collect' },
      }),
      task({
        id: 'summarize-1',
        title: '生成摘要',
        status: 'pending',
        payload: { goalId: 'goal-1', scheduledFor: '2026-11-17T06:00:00.000Z', stepId: 'summarize' },
      }),
      task({
        id: 'other-goal',
        title: '别的目标',
        payload: { goalId: 'goal-2', scheduledFor: '2026-11-17T06:00:00.000Z', stepId: 'collect' },
      }),
    ];
    const executor = new TemplateOrgTaskExecutor({
      listTasks: () => tasks,
      getTask: id => {
        const found = tasks.find(candidate => candidate.id === id);
        if (!found) throw new Error('missing task');
        return found;
      },
      clock: () => AT,
    });
    const input = task({
      id: 'collect-run',
      payload: {
        templateRef: 'weekly-report',
        stepId: 'collect',
        goalId: 'goal-1',
        goalTitle: '周报',
        scheduledFor: '2026-11-17T06:00:00.000Z',
      },
    });
    const { ctx, progress } = makeContext(input);

    const result = await executor.run(ctx);
    const report = (result.result as { report: { goalTitle: string; tasks: unknown[] } }).report;
    expect(result.outcome).toBe('complete');
    expect(report.goalTitle).toBe('周报');
    expect(report.tasks).toHaveLength(2);
    expect(progress[0]?.stage).toBe('template:weekly-report:collect');
  });

  it('summarizes the collect dependency as markdown', async () => {
    const dependency = task({
      id: 'collect-1',
      title: '收集数据',
      status: 'done',
      payload: { goalId: 'goal-1', stepId: 'collect' },
      result: {
        report: {
          goalId: 'goal-1',
          goalTitle: '周报',
          scheduledFor: '2026-11-17T06:00:00.000Z',
          generatedAt: AT,
          tasks: [
            { id: 'collect-1', title: '收集数据', status: 'done', stepId: 'collect', updatedAt: AT },
            { id: 'summarize-1', title: '生成摘要', status: 'pending', stepId: 'summarize', updatedAt: AT },
          ],
        },
      },
    });
    const executor = new TemplateOrgTaskExecutor({
      listTasks: () => [dependency],
      getTask: id => {
        if (id === dependency.id) return dependency;
        throw new Error('missing task');
      },
    });
    const input = task({
      id: 'summarize-run',
      dependsOn: ['collect-1'],
      payload: { templateRef: 'weekly-report', stepId: 'summarize', goalId: 'goal-1', goalTitle: '周报' },
    });
    const { ctx } = makeContext(input);

    const result = await executor.run(ctx);
    const summary = (result.result as { summary: string }).summary;
    expect(result.outcome).toBe('complete');
    expect(summary).toContain('# 周报');
    expect(summary).toContain('- [done] 收集数据 (collect)');
    expect((result.result as { taskCount: number }).taskCount).toBe(2);
  });

  it('fails summarize when the collect result is missing', async () => {
    const dependency = task({ id: 'collect-1', status: 'pending', payload: {} });
    const executor = new TemplateOrgTaskExecutor({
      listTasks: () => [dependency],
      getTask: () => dependency,
    });
    const input = task({
      id: 'summarize-run',
      dependsOn: ['collect-1'],
      payload: { templateRef: 'weekly-report', stepId: 'summarize' },
    });
    const { ctx } = makeContext(input);

    await expect(executor.run(ctx)).rejects.toMatchObject({ kind: 'business' });
  });

  it('pauses human review at a D2 decision and completes after approval', async () => {
    const executor = new TemplateOrgTaskExecutor({
      listTasks: () => [],
      getTask: () => {
        throw new Error('not used');
      },
    });
    const input = task({
      id: 'review-run',
      payload: { templateRef: 'weekly-report', stepId: 'human-review', goalId: 'goal-1' },
    });
    const { ctx, decisions } = makeContext(input);

    const result = await executor.run(ctx);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      impact: 'org',
      reversibility: 'hard',
      idempotencyKey: 'review-run:review',
    });
    expect(result.outcome).toBe('complete');
    expect((result.result as { decisionOutcome: string }).decisionOutcome).toBe('approved');
  });

  it('fails human review on rejection', async () => {
    const executor = new TemplateOrgTaskExecutor({
      listTasks: () => [],
      getTask: () => {
        throw new Error('not used');
      },
    });
    const input = task({
      id: 'review-run',
      payload: { templateRef: 'content-review', stepId: 'review' },
    });
    const { ctx } = makeContext(input, { outcome: 'rejected' });

    await expect(executor.run(ctx)).rejects.toMatchObject({ kind: 'business' });
  });

  it('delegates content-review.draft to the agent-world content workflow', async () => {
    let seen: ExecutorContext | undefined;
    const contentExecutor: OrgTaskExecutorV2 = {
      async run(inner) {
        seen = inner;
        return { outcome: 'complete', result: { system: 'agent-world', workflow: 'content' } };
      },
    };
    const executor = new TemplateOrgTaskExecutor({
      listTasks: () => [],
      getTask: () => {
        throw new Error('not used');
      },
      contentExecutor,
    });
    const input = task({
      id: 'draft-run',
      title: '新品草稿',
      payload: { templateRef: 'content-review', stepId: 'draft', goalTitle: '内容评审' },
    });
    const { ctx } = makeContext(input);

    const result = await executor.run(ctx);
    const innerPayload = seen?.task.payload as { workflow: string; input: string };
    expect(result.outcome).toBe('complete');
    expect(innerPayload.workflow).toBe('content');
    expect(innerPayload.input).toContain('内容评审');
    expect(seen?.remainingMs).toBe(ctx.remainingMs);
  });

  it('fails content-review.draft without an agent-world arm', async () => {
    const executor = new TemplateOrgTaskExecutor({
      listTasks: () => [],
      getTask: () => {
        throw new Error('not used');
      },
    });
    const input = task({
      id: 'draft-run',
      payload: { templateRef: 'content-review', stepId: 'draft' },
    });
    const { ctx } = makeContext(input);

    await expect(executor.run(ctx)).rejects.toMatchObject({ kind: 'business' });
  });
});

describe('RoutingOrgTaskExecutor', () => {
  function arm(name: string, calls: string[]): OrgTaskExecutorV2 {
    return {
      async run() {
        calls.push(name);
        return { outcome: 'complete', result: { arm: name } };
      },
    };
  }

  it('routes template, agent-dev, and agent-world payloads to their arms', async () => {
    const calls: string[] = [];
    const router = new RoutingOrgTaskExecutor({
      template: arm('template', calls),
      agentDev: arm('agent-dev', calls),
      agentWorld: arm('agent-world', calls),
    });

    for (const payload of [
      { templateRef: 'weekly-report', stepId: 'collect' },
      { system: 'agent-dev', projectId: 'p' },
      { workflow: 'content', input: 'x' },
    ]) {
      const input = task({ id: `route-${calls.length}`, payload: payload as Json });
      const { ctx } = makeContext(input);
      await router.run(ctx);
    }
    expect(calls).toEqual(['template', 'agent-dev', 'agent-world']);
  });

  it('fails when the payload names an arm that is not assembled', async () => {
    const router = new RoutingOrgTaskExecutor({ template: arm('template', []) });
    const input = task({ id: 'dev-1', payload: { system: 'agent-dev', projectId: 'p' } });
    const { ctx } = makeContext(input);
    await expect(router.run(ctx)).rejects.toMatchObject({ kind: 'business' });
  });

  it('fails an undeclared payload instead of guessing an arm', async () => {
    const router = new RoutingOrgTaskExecutor({ template: arm('template', []) });
    const input = task({ id: 'unknown-1', payload: { arbitrary: true } });
    const { ctx } = makeContext(input);
    await expect(router.run(ctx)).rejects.toMatchObject({ kind: 'business' });
  });
});

describe('RoutingToolInvoker', () => {
  it('routes tool prefixes to the matching invoker and rejects unknown tools', async () => {
    const calls: string[] = [];
    const invoker = new RoutingToolInvoker({
      agentWorld: {
        async invoke(tool) {
          calls.push(tool);
          return { arm: 'agent-world' };
        },
      },
      agentDev: {
        async invoke(tool) {
          calls.push(tool);
          return { arm: 'agent-dev' };
        },
      },
    });
    const input = task({ id: 'tool-1', payload: {} });
    const { ctx } = makeContext(input);

    await invoker.invoke('agent-world:run-graph', {}, ctx);
    await invoker.invoke('agent-dev:get-feature-task', {}, ctx);
    expect(calls).toEqual(['agent-world:run-graph', 'agent-dev:get-feature-task']);
    await expect(invoker.invoke('unknown:tool', {}, ctx)).rejects.toBeInstanceOf(ExecutorError);
  });
});
