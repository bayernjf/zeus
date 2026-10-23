/**
 * T-M7-03 fail-closed B: SOP-missing / SOP-incompatible dispatch rejection.
 *
 *  - a task whose channel workflow has no catalogued SOP is rejected at claim
 *    with SOP_MISSING, left pending with unmatchedReason recorded (never
 *    dispatched, never silently run);
 *  - a matched position lacking the SOP's required tool grants is rejected with
 *    SOP_INCOMPATIBLE and the missing grants listed in details;
 *  - a properly equipped position still dispatches the content SOP (positive
 *    regression), and legacy generic org tasks (no channel skill/workflow) are
 *    untouched by the gate.
 *
 * Uses the real OrgService over its in-memory store; the executor is a stub
 * that settles complete — the gate under test runs before any executor.
 */
import { describe, expect, it } from 'vitest';
import { DecisionService } from '../../decision-service/service.js';
import { MemoryDecisionStore } from '../../decision-service/store.js';
import { DecisionAuditChain } from '../../audit/audit-chain.js';
import { Ed25519MemorySigner } from '../../../registry/signing.js';
import { MemoryPolicyStore } from '../../grading/policy-loader.js';
import { DEFAULT_POLICY_V1 } from '../../grading/default-policy.js';
import { ORG_ERROR_CODES, OrgService, SKILL_IDS } from '../index.js';
import { AGENT_WORLD_TOOLS } from '../adapters/agent-world/tools.js';
import type { OrgTaskExecutorV2 } from '../execution/index.js';

const ALL_TOOLS = [AGENT_WORLD_TOOLS.runGraph, AGENT_WORLD_TOOLS.resumeRun, AGENT_WORLD_TOOLS.getRun];

function makeService() {
  const policyStore = new MemoryPolicyStore();
  policyStore.put(DEFAULT_POLICY_V1);
  const decisions = new DecisionService({
    policyStore,
    recordStore: new MemoryDecisionStore(),
    audit: new DecisionAuditChain(new Ed25519MemorySigner('tm7-03-dispatch')),
  });
  let seq = 0;
  const service = new OrgService({
    decisions,
    clock: () => '2026-10-24T00:00:00.000Z',
    newId: prefix => `${prefix}-${++seq}`,
    retryPolicy: { maxAttempts: 1, baseBackoffMs: 1, maxBackoffMs: 1, factor: 1, jitter: 0 },
    taskDeadlineMs: 60_000,
  });
  const org = service.createOrganization({ name: '自营电商', scaleTier: 'small' });
  const dept = service.createDepartment({ organizationId: org.id, name: '运营', mission: '卖货' });
  return { service, org, dept };
}

/** A stub executor that always completes — the dispatch gate runs before it. */
const stubExecutor: OrgTaskExecutorV2 = {
  async run() {
    return { outcome: 'complete' as const, result: { settled: true } };
  },
};

describe('SOP dispatch gate (fail-closed B)', () => {
  it('SOP_MISSING: a channel workflow with no catalogued SOP is rejected, task stays pending', async () => {
    const { service, dept } = makeService();
    service.createPosition({
      id: 'pos:full',
      departmentId: dept.id,
      organizationId: dept.organizationId,
      name: '全职运营',
      requiredSkills: [SKILL_IDS.contentProduction],
      allowedTools: ALL_TOOLS,
      decisionScope: 'D2',
    });
    service.assignAgent('pos:full', { agentId: 'agent-1' });

    const task = service.createTask({
      organizationId: dept.organizationId,
      title: '未知工作流',
      payload: { workflow: 'mystery-flow', input: 'x' },
    });

    await expect(service.dispatch(task.id, stubExecutor)).rejects.toMatchObject({
      code: ORG_ERROR_CODES.SOP_MISSING,
      retryable: false,
      details: expect.objectContaining({ workflow: 'mystery-flow' }),
    });
    // The task never left pending and the reason was recorded.
    const pending = service.getTask(task.id);
    expect(pending.status).toBe('pending');
    expect(pending.unmatchedReason).toContain('mystery-flow');
  });

  it('SOP_INCOMPATIBLE: a position missing the SOP tool grants is rejected with gaps listed', async () => {
    const { service, dept } = makeService();
    // Only granted run-graph: missing get-run (and resume-run) for content.
    service.createPosition({
      id: 'pos:thin',
      departmentId: dept.id,
      organizationId: dept.organizationId,
      name: '薄岗',
      requiredSkills: [SKILL_IDS.contentProduction],
      allowedTools: [AGENT_WORLD_TOOLS.runGraph],
      decisionScope: 'D2',
    });
    service.assignAgent('pos:thin', { agentId: 'agent-1' });

    const task = service.createTask({
      organizationId: dept.organizationId,
      title: '发笔记',
      payload: { workflow: 'content', input: '推广香薰' },
      requiredSkill: SKILL_IDS.contentProduction,
      positionId: 'pos:thin',
    });

    await expect(service.dispatch(task.id, stubExecutor)).rejects.toMatchObject({
      code: ORG_ERROR_CODES.SOP_INCOMPATIBLE,
      retryable: false,
      details: expect.objectContaining({
        skillId: SKILL_IDS.contentProduction,
        missingTools: expect.arrayContaining([AGENT_WORLD_TOOLS.getRun]),
      }),
    });
    const pending = service.getTask(task.id);
    expect(pending.status).toBe('pending');
    expect(pending.unmatchedReason).toContain('pos:thin');
  });

  it('positive regression: a fully equipped position dispatches the content SOP to done', async () => {
    const { service, dept } = makeService();
    service.createPosition({
      id: 'pos:full',
      departmentId: dept.id,
      organizationId: dept.organizationId,
      name: '全职运营',
      requiredSkills: [SKILL_IDS.contentProduction],
      allowedTools: ALL_TOOLS,
      decisionScope: 'D2',
    });
    service.assignAgent('pos:full', { agentId: 'agent-1' });

    const task = service.createTask({
      organizationId: dept.organizationId,
      title: '发笔记',
      payload: { workflow: 'content', input: '推广香薰' },
      requiredSkill: SKILL_IDS.contentProduction,
    });
    const res = await service.dispatch(task.id, stubExecutor);
    expect(res.task.status).toBe('done');
  });

  it('legacy generic tasks (no channel skill/workflow) skip the SOP gate unchanged', async () => {
    const { service, dept } = makeService();
    service.createPosition({
      id: 'pos:ops',
      departmentId: dept.id,
      organizationId: dept.organizationId,
      name: '运营',
      requiredSkills: ['refund-processing'],
      allowedTools: [],
      decisionScope: 'D2',
    });
    service.assignAgent('pos:ops', { agentId: 'agent-1' });

    const task = service.createTask({
      organizationId: dept.organizationId,
      title: '退款审批',
      payload: { amount: 1200, currency: 'CNY' },
      requiredSkill: 'refund-processing',
    });
    const res = await service.dispatch(task.id, stubExecutor);
    expect(res.task.status).toBe('done');
  });
});
