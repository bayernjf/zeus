/**
 * F5.3 + P0 end-to-end integration: a templateRef goal is expanded by the real
 * CronOrgScheduler into three persisted tasks, handed off through the same
 * `claim + TaskWorker.enqueue` closure serve.ts uses, and executed by the real
 * TemplateOrgTaskExecutor in dependency order. The human-review step pauses at
 * a D2 decision and resumes through the same worker after approval.
 */
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DecisionService } from '../../decision-service/service.js';
import { MemoryDecisionStore } from '../../decision-service/store.js';
import { DecisionAuditChain } from '../../audit/audit-chain.js';
import { Ed25519MemorySigner } from '../../../registry/signing.js';
import { MemoryPolicyStore } from '../../grading/policy-loader.js';
import { DEFAULT_POLICY_V1 } from '../../grading/default-policy.js';
import { openSqlite } from '../../persistence/sqlite-db.js';
import { migrate } from '../../persistence/schema.js';
import { SqliteOrgStore } from '../../persistence/sqlite-org-store.js';
import { OrgService } from '../org-service.js';
import { MemoryOrgStore } from '../store.js';
import { TaskWorker } from '../task-worker.js';
import { TemplateOrgTaskExecutor } from '../execution/template-executor.js';
import type { Json, OrgTask } from '../types.js';
import { CronOrgScheduler } from './cron-scheduler.js';
import { goalRunKey } from './scheduler.js';

function makeDecisionService(): DecisionService {
  const policyStore = new MemoryPolicyStore();
  policyStore.put(DEFAULT_POLICY_V1);
  return new DecisionService({
    policyStore,
    recordStore: new MemoryDecisionStore(),
    audit: new DecisionAuditChain(new Ed25519MemorySigner('template-exec-test')),
  });
}

function taskByKey(service: OrgService, goalId: string, occurrence: Date, stepId: string): OrgTask {
  const key = goalRunKey(goalId, occurrence, stepId);
  const task = service
    .listTasks()
    .find(candidate => candidate.idempotencyKey === key);
  if (!task) throw new Error(`missing task for ${key}`);
  return task;
}

describe('goal template execution (F5.3 + P0)', () => {
  it('runs collect → summarize → D2 human review through claim, worker, and approval', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-template-exec-'));
    const db = openSqlite(join(dir, 'zeus.db'));
    migrate(db);
    const store = new SqliteOrgStore(db);
    let seq = 0;
    const service = new OrgService({
      store,
      decisions: makeDecisionService(),
      clock: () => '2026-11-16T00:00:00.000Z',
      newId: prefix => `${prefix}-${++seq}`,
    });
    const worker = new TaskWorker({
      org: service,
      executor: new TemplateOrgTaskExecutor({
        listTasks: organizationId => service.listTasks(organizationId),
        getTask: taskId => service.getTask(taskId),
        clock: () => '2026-11-16T00:00:00.000Z',
      }),
      intervalMs: 20,
    });
    try {
      const org = service.createOrganization({ name: '模板执行验收', scaleTier: 'small' });
      const dept = service.createDepartment({ organizationId: org.id, name: '运营', mission: '模板执行' });
      const position = service.createPosition({
        organizationId: org.id,
        departmentId: dept.id,
        name: '模板执行岗',
        responsibilities: ['执行模板步骤'],
        requiredSkills: [],
        allowedTools: [],
        decisionScope: 'D0',
      });
      service.assignAgent(position.id, { agentId: 'agent:template-exec' });

      const goal = service.createGoal({
        organizationId: org.id,
        title: '周报流水线',
        period: 'daily',
        schedule: { hourUtc: 6, minuteUtc: 0 },
        templateRef: 'weekly-report',
      });
      const at = new Date('2026-11-16T06:00:00.000Z');

      worker.start();
      const scheduler = new CronOrgScheduler({
        org: service,
        deliver: ({ taskId }) => {
          // Mirrors src/http/serve.ts: claim synchronously, then enqueue the
          // task that actually reached `running`.
          const claimed = service.claim(taskId);
          if (claimed.status === 'running') worker.enqueue(taskId);
        },
      });

      const first = scheduler.tick(at);
      expect(first.created).toHaveLength(3);
      expect(first.failed).toEqual([]);
      await worker.drain();

      const collect = taskByKey(service, goal.id, at, 'collect');
      const summarize = taskByKey(service, goal.id, at, 'summarize');
      const review = taskByKey(service, goal.id, at, 'human-review');
      expect(service.getTask(collect.id).status).toBe('done');
      expect(service.getTask(summarize.id).status).toBe('pending');
      expect(service.getTask(review.id).status).toBe('pending');
      expect(summarize.dependsOn).toEqual([collect.id]);
      expect(review.dependsOn).toEqual([summarize.id]);
      expect(service.getTask(collect.id).result).toMatchObject({
        system: 'template',
        templateRef: 'weekly-report',
        stepId: 'collect',
        report: { goalId: goal.id },
      });
      const collected = service.getTask(collect.id).result as {
        report: { tasks: Array<{ stepId: string }> };
      };
      expect(collected.report.tasks).toHaveLength(3);
      expect(collected.report.tasks.map(item => item.stepId).sort()).toEqual([
        'collect',
        'human-review',
        'summarize',
      ]);

      const second = scheduler.tick(at);
      expect(second.created).toHaveLength(0);
      expect(second.duplicates).toHaveLength(3);
      await worker.drain();
      expect(service.getTask(summarize.id).status).toBe('done');
      expect(service.getTask(review.id).status).toBe('pending');
      expect(service.getTask(summarize.id).result).toMatchObject({
        system: 'template',
        stepId: 'summarize',
        taskCount: 3,
      });
      expect((service.getTask(summarize.id).result as { summary: string }).summary).toContain('# 周报流水线');

      scheduler.tick(at);
      await worker.drain();
      expect(service.getTask(review.id).status).toBe('awaiting_decision');
      expect(service.getTask(review.id).decisionId).toBeTruthy();

      // A D2 checkpoint does not auto-approve: the owner approves, then the
      // same worker resumes the task and replays the resolved decision.
      await service.claimResume(review.id, { decision: 'approve', approver: 'owner' });
      worker.enqueue(review.id);
      await worker.drain();
      const reviewed = service.getTask(review.id);
      expect(reviewed.status).toBe('done');
      expect(reviewed.result).toMatchObject({
        system: 'template',
        templateRef: 'weekly-report',
        stepId: 'human-review',
        decisionOutcome: 'approved',
      });

      // Replaying the same window must neither create nor re-run anything.
      const replay = scheduler.tick(at);
      expect(replay.created).toHaveLength(0);
      expect(replay.duplicates).toHaveLength(3);
      expect(service.listTasks(org.id).every(task => task.status === 'done')).toBe(true);
    } finally {
      worker.stop();
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('runs content-review draft through the delegated content arm, then D2 review', async () => {
    let seq = 0;
    const service = new OrgService({
      store: new MemoryOrgStore(),
      decisions: makeDecisionService(),
      clock: () => '2026-11-16T00:00:00.000Z',
      newId: prefix => `${prefix}-${++seq}`,
    });
    const delegated: Json[] = [];
    const worker = new TaskWorker({
      org: service,
      executor: new TemplateOrgTaskExecutor({
        listTasks: organizationId => service.listTasks(organizationId),
        getTask: taskId => service.getTask(taskId),
        contentExecutor: {
          async run(ctx) {
            delegated.push(ctx.task.payload);
            return { outcome: 'complete', result: { system: 'agent-world', workflow: 'content' } };
          },
        },
      }),
      intervalMs: 20,
    });
    try {
      const org = service.createOrganization({ name: '内容评审', scaleTier: 'small' });
      const dept = service.createDepartment({ organizationId: org.id, name: '内容', mission: '内容评审' });
      const position = service.createPosition({
        organizationId: org.id,
        departmentId: dept.id,
        name: '内容岗',
        responsibilities: ['撰写与评审内容'],
        requiredSkills: ['content-production'],
        allowedTools: ['agent-world:run-graph', 'agent-world:get-run'],
        decisionScope: 'D2',
      });
      service.assignAgent(position.id, { agentId: 'agent:content-review' });
      const goal = service.createGoal({
        organizationId: org.id,
        title: '内容评审流水线',
        period: 'daily',
        schedule: { hourUtc: 6, minuteUtc: 0 },
        templateRef: 'content-review',
      });
      const at = new Date('2026-11-16T06:00:00.000Z');

      worker.start();
      const scheduler = new CronOrgScheduler({
        org: service,
        deliver: ({ taskId }) => {
          const claimed = service.claim(taskId);
          if (claimed.status === 'running') worker.enqueue(taskId);
        },
      });

      expect(scheduler.tick(at).created).toHaveLength(2);
      await worker.drain();
      const draft = taskByKey(service, goal.id, at, 'draft');
      const review = taskByKey(service, goal.id, at, 'review');
      expect(service.getTask(draft.id).status).toBe('done');
      expect(service.getTask(review.id).status).toBe('pending');
      expect(delegated).toHaveLength(1);
      expect(delegated[0]).toMatchObject({ workflow: 'content' });

      scheduler.tick(at);
      await worker.drain();
      expect(service.getTask(review.id).status).toBe('awaiting_decision');

      await service.claimResume(review.id, { decision: 'approve', approver: 'owner' });
      worker.enqueue(review.id);
      await worker.drain();
      expect(service.getTask(review.id).status).toBe('done');
      expect(service.getTask(review.id).result).toMatchObject({
        system: 'template',
        templateRef: 'content-review',
        stepId: 'review',
        decisionOutcome: 'approved',
      });
    } finally {
      worker.stop();
    }
  });
});
