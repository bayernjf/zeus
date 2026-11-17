/**
 * F4.1 outcome ledger tests: every settlement writes a complete outcome
 * record (attempts, failure kind, timing) including timeout and tool-denied
 * failures.
 */
import { describe, expect, it } from 'vitest';
import { OrgService, type OrgTaskExecutor } from './index.js';

function setup(deadlineMs = 60_000) {
  let seq = 0;
  const service = new OrgService({
    clock: () => new Date().toISOString(),
    newId: prefix => `${prefix}-${++seq}`,
    taskDeadlineMs: deadlineMs,
  });
  const org = service.createOrganization({ name: '账本', scaleTier: 'small' });
  const dept = service.createDepartment({ organizationId: org.id, name: '运营', mission: 'm' });
  const position = service.createPosition({
    organizationId: org.id,
    departmentId: dept.id,
    name: '专员',
    requiredSkills: ['ops'],
    allowedTools: [], // no granted tools: ctx.tool must fail closed
    decisionScope: 'D0',
  });
  service.assignAgent(position.id, { agentId: 'agent-1' });
  return { service, org };
}

function taskOf(service: OrgService, orgId: string, title: string) {
  return service.createTask({ organizationId: orgId, title, payload: {}, requiredSkill: 'ops' });
}

describe('OrgTask outcome ledger (F4.1)', () => {
  it('records attempts, timing and a result summary on done', async () => {
    const { service, org } = setup();
    const task = taskOf(service, org.id, '正常');
    const executor: OrgTaskExecutor = { run: async () => ({ outcome: 'complete', result: { ok: true } }) };

    const result = await service.dispatch(task.id, executor);

    expect(result.task.status).toBe('done');
    const outcome = result.task.outcome;
    expect(outcome).toBeDefined();
    expect(outcome!.status).toBe('done');
    expect(outcome!.attempts).toBeGreaterThanOrEqual(1);
    expect(outcome!.settledAt).toBeTruthy();
    expect(outcome!.durationMs).toBeGreaterThanOrEqual(0);
    expect(outcome!.resultSummary).toContain('ok');
    expect(outcome!.decisions).toEqual([]);
  });

  it('records a timeout failure with its kind', async () => {
    const { service, org } = setup(40);
    const task = taskOf(service, org.id, '超时');
    const executor: OrgTaskExecutor = {
      run: async () => {
        await new Promise<void>(resolve => setTimeout(resolve, 300));
        return { outcome: 'complete' };
      },
    };

    const result = await service.dispatch(task.id, executor);

    expect(result.task.status).toBe('failed');
    expect(result.task.outcome?.status).toBe('failed');
    expect(result.task.outcome?.failedKind).toBe('timeout');
    expect(result.task.outcome?.error).toBeTruthy();
    expect(result.task.outcome?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('records a tool-denied failure with its kind', async () => {
    const { service, org } = setup();
    const task = taskOf(service, org.id, '越权');
    const executor: OrgTaskExecutor = {
      run: async ctx => {
        await ctx.tool('shell', { cmd: 'rm -rf /' });
        return { outcome: 'complete' };
      },
    };

    const result = await service.dispatch(task.id, executor);

    expect(result.task.status).toBe('failed');
    expect(result.task.outcome?.status).toBe('failed');
    expect(result.task.outcome?.failedKind).toBe('tool_denied');
  });
});
