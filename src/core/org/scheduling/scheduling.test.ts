/**
 * F5.2 scheduler acceptance: daily/weekly UTC windows, one task per window
 * (including repeated ticks), idle-goal filtering, and restart recovery over
 * both memory and SQLite stores.
 */
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqlite } from '../../persistence/sqlite-db.js';
import { migrate } from '../../persistence/schema.js';
import { SqliteOrgStore } from '../../persistence/sqlite-org-store.js';
import type { OrgStore } from '../store.js';
import { OrgService } from '../org-service.js';
import { CronOrgScheduler } from './cron-scheduler.js';
import { goalOccurrence } from './scheduler.js';

let reopenSeq = 0;

function makeService(store?: OrgStore) {
  let seq = 0;
  const service = new OrgService({
    ...(store ? { store } : {}),
    clock: () => '2026-11-16T00:00:00.000Z',
    newId: prefix => `${prefix}-${++seq}`,
  });
  const org = service.createOrganization({ name: '排班验收', scaleTier: 'small' });
  return { service, org };
}

describe('CronOrgScheduler (F5.2)', () => {
  it('fires a daily goal once per UTC window and suppresses the same window', () => {
    const { service, org } = makeService();
    const goal = service.createGoal({
      organizationId: org.id,
      title: '每日库存巡检',
      period: 'daily',
      schedule: { hourUtc: 1, minuteUtc: 0 },
      taskTemplate: { title: '巡检库存', payload: { kind: 'inventory-check' }, requiredSkill: 'ops' },
    });
    const deliveries: string[] = [];
    const scheduler = new CronOrgScheduler({
      org: service,
      clock: () => new Date('2026-11-16T01:00:00.000Z'),
      deliver: delivery => deliveries.push(delivery.taskId),
    });

    const first = scheduler.tick(new Date('2026-11-16T01:00:00.000Z'));
    expect(first.created).toHaveLength(1);
    expect(first.duplicates).toHaveLength(0);

    const sameWindow = scheduler.tick(new Date('2026-11-16T01:30:00.000Z'));
    expect(sameWindow.created).toHaveLength(0);
    expect(sameWindow.duplicates).toEqual([first.created[0]]);

    const nextWindow = scheduler.tick(new Date('2026-11-17T01:00:00.000Z'));
    expect(nextWindow.created).toHaveLength(1);
    expect(service.listTasks(org.id)).toHaveLength(2);
    expect(deliveries).toEqual([first.created[0], nextWindow.created[0]]);

    const task = service.getTask(first.created[0]!);
    expect(task.idempotencyKey).toBe(`goal:${goal.id}:2026-11-16T01:00:00.000Z`);
    expect(task.payload).toEqual({ kind: 'inventory-check' });
    expect(task.title).toBe('巡检库存');
    expect(task.requiredSkill).toBe('ops');
  });

  it('recovers a new scheduler instance over the same memory store without duplicates', () => {
    const { service, org } = makeService();
    const goal = service.createGoal({
      organizationId: org.id,
      title: '日报',
      period: 'daily',
      schedule: { hourUtc: 2, minuteUtc: 0 },
    });
    const first = new CronOrgScheduler({ org: service });
    first.tick(new Date('2026-11-16T02:00:00.000Z'));

    const restarted = new CronOrgScheduler({ org: service });
    const replay = restarted.tick(new Date('2026-11-16T02:00:00.000Z'));
    expect(replay.created).toHaveLength(0);
    expect(replay.duplicates).toHaveLength(1);

    const next = restarted.tick(new Date('2026-11-17T02:00:00.000Z'));
    expect(next.created).toHaveLength(1);
    expect(service.listTasks(org.id)).toHaveLength(2);
    expect(service.listTasks(org.id)[1]!.idempotencyKey).toBe(
      `goal:${goal.id}:2026-11-17T02:00:00.000Z`,
    );
  });

  it('keeps delivery state across a real SQLite reopen', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-scheduler-'));
    const file = join(dir, 'zeus.db');
    try {
      const db = openSqlite(file);
      migrate(db);
      const store = new SqliteOrgStore(db);
      const { service, org } = makeService(store);
      const goal = service.createGoal({
        organizationId: org.id,
        title: 'SQLite 排班',
        period: 'daily',
        schedule: { hourUtc: 3, minuteUtc: 0 },
      });
      const first = new CronOrgScheduler({ org: service });
      expect(first.tick(new Date('2026-11-16T03:00:00.000Z')).created).toHaveLength(1);
      db.close();

      const reopened = openSqlite(file);
      migrate(reopened);
      const service2 = new OrgService({
        store: new SqliteOrgStore(reopened),
        clock: () => '2026-11-17T04:00:00.000Z',
        newId: prefix => `${prefix}-r-${++reopenSeq}`,
      });
      const replay = new CronOrgScheduler({ org: service2 }).tick(
        new Date('2026-11-16T03:00:00.000Z'),
      );
      expect(replay.created).toHaveLength(0);
      expect(replay.duplicates).toHaveLength(1);

      const next = new CronOrgScheduler({ org: service2 }).tick(
        new Date('2026-11-17T03:00:00.000Z'),
      );
      expect(next.created).toHaveLength(1);
      expect(service2.listTasks(org.id)).toHaveLength(2);
      expect(service2.listTasks(org.id)[1]!.idempotencyKey).toBe(
        `goal:${goal.id}:2026-11-17T03:00:00.000Z`,
      );
      reopened.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('selects the most recent weekly UTC window and ignores inactive/manual goals', () => {
    const { service, org } = makeService();
    const weekly = service.createGoal({
      organizationId: org.id,
      title: '周报生成',
      period: 'weekly',
      schedule: { hourUtc: 9, minuteUtc: 0, weekdayUtc: 1 },
    });
    service.createGoal({
      organizationId: org.id,
      title: '暂停目标',
      period: 'daily',
      status: 'paused',
      schedule: { hourUtc: 9, minuteUtc: 0 },
    });
    service.createGoal({
      organizationId: org.id,
      title: '手动目标',
      period: 'daily',
    });

    const scheduler = new CronOrgScheduler({ org: service });
    const tick = scheduler.tick(new Date('2026-11-17T10:00:00.000Z'));
    expect(tick.scanned).toBe(3);
    expect(tick.created).toHaveLength(1);
    expect(service.getTask(tick.created[0]!).payload).toMatchObject({
      goalId: weekly.id,
      scheduledFor: '2026-11-16T09:00:00.000Z',
    });
    expect(
      goalOccurrence(weekly, new Date('2026-11-17T10:00:00.000Z'))?.toISOString(),
    ).toBe('2026-11-16T09:00:00.000Z');
  });

  it('records a handoff failure but keeps the created task', () => {
    const { service, org } = makeService();
    service.createGoal({
      organizationId: org.id,
      title: '交接失败',
      period: 'daily',
      schedule: { hourUtc: 4, minuteUtc: 0 },
    });
    const failures: string[] = [];
    const scheduler = new CronOrgScheduler({
      org: service,
      deliver: () => {
        throw new Error('no worker');
      },
      onError: goalId => failures.push(goalId),
    });
    const tick = scheduler.tick(new Date('2026-11-16T04:00:00.000Z'));
    expect(tick.created).toHaveLength(1);
    expect(tick.failed).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(service.listTasks(org.id)).toHaveLength(1);
  });
});
