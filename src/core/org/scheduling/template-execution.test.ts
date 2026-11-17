/**
 * F5.3 end-to-end integration: a templateRef goal is expanded by the real
 * CronOrgScheduler into three persisted tasks, handed off through the same
 * `claim + TaskWorker.enqueue` closure serve.ts uses, and executed by the
 * hardened runner in dependency order. The earlier scheduling tests stop at a
 * simulated handoff; this one exercises the real worker path over SQLite.
 */
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqlite } from '../../persistence/sqlite-db.js';
import { migrate } from '../../persistence/schema.js';
import { SqliteOrgStore } from '../../persistence/sqlite-org-store.js';
import { OrgService } from '../org-service.js';
import { TaskWorker } from '../task-worker.js';
import type { Json, OrgTask } from '../types.js';
import { CronOrgScheduler } from './cron-scheduler.js';
import { goalRunKey } from './scheduler.js';

function taskByKey(service: OrgService, goalId: string, occurrence: Date, stepId: string): OrgTask {
  const key = goalRunKey(goalId, occurrence, stepId);
  const task = service
    .listTasks()
    .find(candidate => candidate.idempotencyKey === key);
  if (!task) throw new Error(`missing task for ${key}`);
  return task;
}

describe('goal template execution (F5.3)', () => {
  it('runs collect → summarize → human-review through claim and worker', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-template-exec-'));
    const db = openSqlite(join(dir, 'zeus.db'));
    migrate(db);
    const store = new SqliteOrgStore(db);
    let seq = 0;
    const service = new OrgService({
      store,
      clock: () => '2026-11-16T00:00:00.000Z',
      newId: prefix => `${prefix}-${++seq}`,
    });
    const executionOrder: string[] = [];
    const worker = new TaskWorker({
      org: service,
      executor: {
        async run(ctx): Promise<{ outcome: 'complete'; result: Json }> {
          const phase = (ctx.task.payload as { phase?: string } | undefined)?.phase;
          if (!phase) throw new Error('template task has no phase');
          executionOrder.push(phase);
          return { outcome: 'complete', result: { phase, taskId: ctx.task.id } };
        },
      },
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
      expect(executionOrder).toEqual(['collect']);
      expect(summarize.dependsOn).toEqual([collect.id]);
      expect(review.dependsOn).toEqual([summarize.id]);

      const second = scheduler.tick(at);
      expect(second.created).toHaveLength(0);
      expect(second.duplicates).toHaveLength(3);
      await worker.drain();
      expect(service.getTask(summarize.id).status).toBe('done');
      expect(service.getTask(review.id).status).toBe('pending');
      expect(executionOrder).toEqual(['collect', 'summarize']);

      scheduler.tick(at);
      await worker.drain();
      expect(service.getTask(review.id).status).toBe('done');
      expect(executionOrder).toEqual(['collect', 'summarize', 'human-review']);
      expect(service.getTask(review.id).result).toEqual({
        phase: 'human-review',
        taskId: review.id,
      });

      // Replaying the same window must neither create nor re-run anything.
      const replay = scheduler.tick(at);
      expect(replay.created).toHaveLength(0);
      expect(replay.duplicates).toHaveLength(3);
      expect(executionOrder).toEqual(['collect', 'summarize', 'human-review']);
      expect(service.listTasks(org.id).every(task => task.status === 'done')).toBe(true);
    } finally {
      worker.stop();
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
