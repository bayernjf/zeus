/**
 * F4.2 experience candidate tests: rule-derived candidates land on settlement,
 * stay invisible in the catalog until a human promotes one, then surface as
 * advisories — with repeated promotion remaining idempotent.
 */
import { describe, expect, it } from 'vitest';
import { OrgService, type OrgTask, type OrgTaskExecutor, type OrgTaskOutcome } from '../index.js';
import { deriveCandidateDrafts } from './rules.js';

const SKILL = 'content-production';

function setup(deadlineMs = 60_000) {
  let seq = 0;
  const service = new OrgService({
    clock: () => new Date().toISOString(),
    newId: prefix => `${prefix}-${++seq}`,
    taskDeadlineMs: deadlineMs,
  });
  const org = service.createOrganization({ name: '经验账本', scaleTier: 'small' });
  const dept = service.createDepartment({ organizationId: org.id, name: '内容', mission: 'm' });
  const position = service.createPosition({
    organizationId: org.id,
    departmentId: dept.id,
    name: '内容专员',
    requiredSkills: [SKILL],
    // The catalog fit check requires the SOP's channel tools; the executor
    // itself never calls them here, so the timeout path stays the subject.
    allowedTools: ['agent-world:run-graph', 'agent-world:get-run', 'agent-world:resume-run'],
    decisionScope: 'D0',
  });
  service.assignAgent(position.id, { agentId: 'agent-1' });
  return { service, org };
}

function taskOf(service: OrgService, orgId: string, title: string) {
  return service.createTask({ organizationId: orgId, title, payload: {}, requiredSkill: SKILL });
}

describe('experience candidate rules (F4.2 auto stage)', () => {
  it('maps each failure kind to its own rule id', () => {
    const base = {
      status: 'failed' as const,
      attempts: 1,
      decisions: [],
      settledAt: new Date().toISOString(),
    };
    const task = {} as OrgTask;
    const timeout = deriveCandidateDrafts(task, {
      ...base,
      failedKind: 'timeout',
      durationMs: 40,
    } as OrgTaskOutcome);
    const denied = deriveCandidateDrafts(task, {
      ...base,
      failedKind: 'tool_denied',
      error: 'tool shell not granted',
    } as OrgTaskOutcome);
    const business = deriveCandidateDrafts(task, {
      ...base,
      failedKind: 'business',
      error: 'missing webhookUrl',
    } as OrgTaskOutcome);

    expect(timeout.map(d => d.ruleId)).toEqual(['failure.timeout']);
    expect(timeout[0]!.kind).toBe('failure-avoidance');
    expect(denied.map(d => d.ruleId)).toEqual(['failure.tool-denied']);
    expect(denied[0]!.detail).toContain('tool shell not granted');
    expect(business.map(d => d.ruleId)).toEqual(['failure.business']);
    expect(business[0]!.detail).toContain('missing webhookUrl');
  });

  it('yields success recipes only when retried or checkpointed', () => {
    const task = {} as OrgTask;
    const now = new Date().toISOString();
    const clean = deriveCandidateDrafts(task, {
      status: 'done',
      attempts: 1,
      decisions: [],
      settledAt: now,
    } as OrgTaskOutcome);
    const retried = deriveCandidateDrafts(task, {
      status: 'done',
      attempts: 2,
      decisions: [],
      settledAt: now,
    } as OrgTaskOutcome);
    const checkpointed = deriveCandidateDrafts(task, {
      status: 'done',
      attempts: 1,
      decisions: [{ id: 'dec-1', status: 'decided' }],
      settledAt: now,
    } as OrgTaskOutcome);

    expect(clean).toEqual([]);
    expect(retried.map(d => d.ruleId)).toEqual(['success.retry']);
    expect(checkpointed.map(d => d.ruleId)).toEqual(['success.checkpoint']);
    expect([...retried, ...checkpointed].every(d => d.kind === 'success-recipe')).toBe(true);
  });
});

describe('OrgService experience wiring (F4.2)', () => {
  it('records a pending candidate when a task fails, without touching the catalog', async () => {
    const { service, org } = setup(40);
    const task = taskOf(service, org.id, '超时任务');
    const executor: OrgTaskExecutor = {
      run: async () => {
        await new Promise<void>(resolve => setTimeout(resolve, 300));
        return { outcome: 'complete' };
      },
    };

    const result = await service.dispatch(task.id, executor);
    expect(result.task.status).toBe('failed');

    const candidates = service.listExperience(org.id);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.ruleId).toBe('failure.timeout');
    expect(candidates[0]!.status).toBe('pending');
    expect(candidates[0]!.taskId).toBe(task.id);
    expect(candidates[0]!.skillId).toBe(SKILL);

    // Negative half of the review gate: a pending candidate is invisible.
    const sops = service.catalogView(org.id, SKILL);
    expect(sops).toHaveLength(1);
    expect(sops[0]!.advisories).toEqual([]);
  });

  it('records a business candidate when the task dies at claim (workspace missing)', async () => {
    const { service, org } = setup();
    const task = service.createTask({
      organizationId: org.id,
      title: '需要隔离工作区的任务',
      payload: {},
      requiredSkill: SKILL,
      workspace: { baseRepo: 'git@example.invalid:repo.git' },
    });
    const executor: OrgTaskExecutor = { run: async () => ({ outcome: 'complete' }) };
    const result = await service.dispatch(task.id, executor);
    expect(result.task.status).toBe('failed');

    const candidates = service.listExperience(org.id);
    expect(candidates.map(c => c.ruleId)).toEqual(['failure.business']);
    expect(candidates[0]!.status).toBe('pending');
  });

  it('promotes a candidate to a catalog advisory, idempotently', async () => {
    const { service, org } = setup(40);
    const task = taskOf(service, org.id, '超时任务');
    const executor: OrgTaskExecutor = {
      run: async () => {
        await new Promise<void>(resolve => setTimeout(resolve, 300));
        return { outcome: 'complete' };
      },
    };
    await service.dispatch(task.id, executor);
    const candidate = service.listExperience(org.id)[0]!;

    const promoted = service.promoteExperience(candidate.id);
    expect(promoted.status).toBe('promoted');
    expect(promoted.promotedAt).toBeTruthy();

    const sops = service.catalogView(org.id, SKILL);
    expect(sops[0]!.advisories).toHaveLength(1);
    expect(sops[0]!.advisories[0]).toMatchObject({
      candidateId: candidate.id,
      skillId: SKILL,
      summary: candidate.title,
    });

    // Duplicate promotion is a no-op: same record, same timestamp, one advisory.
    const again = service.promoteExperience(candidate.id);
    expect(again.promotedAt).toBe(promoted.promotedAt);
    expect(service.catalogView(org.id, SKILL)[0]!.advisories).toHaveLength(1);
  });

  it('rejects promotion of an unknown candidate and of one with no catalog SOP', () => {
    const { service, org } = setup();
    expect(() => service.promoteExperience('exp-missing')).toThrowError(/not found/i);

    const other = service.createOrganization({ name: '无技能', scaleTier: 'small' });
    const dept = service.createDepartment({ organizationId: other.id, name: '杂', mission: 'm' });
    const position = service.createPosition({
      organizationId: other.id,
      departmentId: dept.id,
      name: '杂工',
      requiredSkills: ['misc'],
      allowedTools: [],
      decisionScope: 'D0',
    });
    service.assignAgent(position.id, { agentId: 'agent-2' });
    const task = service.createTask({
      organizationId: other.id,
      title: '无目录技能',
      payload: {},
      requiredSkill: 'misc',
    });
    // Hand-place a candidate without skillId, mirroring a task whose skill the
    // catalog does not cover.
    const exp = service as unknown as { experience: { putCandidate: (c: unknown) => void } };
    exp.experience.putCandidate({
      format: 'zeus-experience-candidate',
      version: 1,
      id: 'exp-orphan',
      organizationId: other.id,
      taskId: task.id,
      ruleId: 'failure.business',
      kind: 'failure-avoidance',
      title: 't',
      detail: 'd',
      createdAt: new Date().toISOString(),
      status: 'pending',
    });

    expect(() => service.promoteExperience('exp-orphan')).toThrowError(/no catalog SOP/i);
    expect(() => service.promoteExperience('exp-orphan', SKILL)).not.toThrow();
    void org;
  });
});
