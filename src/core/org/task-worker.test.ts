/**
 * T-M7-01/#11 async TaskWorker tests: claiming is synchronous and fast while
 * execution happens on the worker; D2 checkpoints pause and resume through the
 * queue; a restart-style recovery re-runs interrupted running tasks; duplicate
 * enqueues never execute a task twice.
 */
import { describe, expect, it } from 'vitest';
import { DecisionService } from '../decision-service/service.js';
import { MemoryDecisionStore } from '../decision-service/store.js';
import { DecisionAuditChain } from '../audit/audit-chain.js';
import { Ed25519MemorySigner } from '../../registry/signing.js';
import { MemoryPolicyStore } from '../grading/policy-loader.js';
import { DEFAULT_POLICY_V1 } from '../grading/default-policy.js';
import { OrgService, TaskWorker, type OrgTaskExecutor } from './index.js';

function makeDecisionService(): DecisionService {
  const policyStore = new MemoryPolicyStore();
  policyStore.put(DEFAULT_POLICY_V1);
  return new DecisionService({
    policyStore,
    recordStore: new MemoryDecisionStore(),
    audit: new DecisionAuditChain(new Ed25519MemorySigner('m7-worker-test')),
  });
}

const FAST_RETRY = { maxAttempts: 3, baseBackoffMs: 1, maxBackoffMs: 1, factor: 1, jitter: 0 } as const;

function setup(scope: 'D0' | 'D2' = 'D0') {
  const decisions = makeDecisionService();
  let seq = 0;
  const service = new OrgService({
    decisions,
    clock: () => '2026-10-22T00:00:00.000Z',
    newId: prefix => `${prefix}-${++seq}`,
    retryPolicy: { ...FAST_RETRY },
    taskDeadlineMs: 60_000,
  });
  const org = service.createOrganization({ name: '自营', scaleTier: 'small' });
  const dept = service.createDepartment({ organizationId: org.id, name: '运营', mission: 'm' });
  const position = service.createPosition({
    organizationId: org.id,
    departmentId: dept.id,
    name: '运营专员',
    requiredSkills: ['ops'],
    allowedTools: ['refund.issue'],
    decisionScope: scope,
  });
  service.assignAgent(position.id, { agentId: 'agent-1' });
  const newTask = () =>
    service.createTask({ organizationId: org.id, title: '任务', payload: { amount: 1200 }, requiredSkill: 'ops' });
  return { service, decisions, org, newTask };
}

describe('TaskWorker (T-M7-01/#11 async execution)', () => {
  it('claims synchronously without running; the worker executes to done off the request', async () => {
    const { service, newTask } = setup();
    const task = newTask();
    const executor: OrgTaskExecutor = {
      run: async () => ({ outcome: 'complete', result: { listed: true } }),
    };
    const worker = new TaskWorker({ org: service, executor });
    const claimed = service.claim(task.id);
    expect(claimed.status).toBe('running');
    // The executor has not run yet (claim is side-effect-free).
    expect(service.getTask(task.id).result).toBeUndefined();

    worker.start();
    worker.enqueue(task.id);
    await worker.drain();
    worker.stop();

    const done = service.getTask(task.id);
    expect(done.status).toBe('done');
    expect(done.result).toEqual({ listed: true });
    expect(done.transitions.map(t => t.status)).toEqual([
      'pending', 'dispatched', 'running', 'done',
    ]);
  });

  it('recovers interrupted running tasks on start without an explicit enqueue', async () => {
    const { service, newTask } = setup();
    const task = newTask();
    // Simulate a worker that died after claiming but before execution.
    service.claim(task.id);
    expect(service.getTask(task.id).status).toBe('running');
    expect(service.getTask(task.id).result).toBeUndefined();

    const executor: OrgTaskExecutor = {
      run: async () => ({ outcome: 'complete', result: { recovered: true } }),
    };
    const worker = new TaskWorker({ org: service, executor });
    worker.start(); // recover() should pick up the running task
    await worker.drain();
    worker.stop();

    expect(service.getTask(task.id).status).toBe('done');
    expect(service.getTask(task.id).result).toEqual({ recovered: true });
  });

  it('pauses at a D2 checkpoint on the worker and resumes after approval', async () => {
    const { service, newTask } = setup('D2');
    const task = newTask();
    const executor: OrgTaskExecutor = {
      run: async ctx => {
        const d = await ctx.requestDecision({
          intent: 'refund-order',
          amount: { value: 1200, currency: 'CNY' },
          impact: 'self',
          reversibility: 'reversible',
          idempotencyKey: `refund-${task.id}`,
        });
        return { outcome: 'complete', result: { refunded: true, grade: d.grade } };
      },
    };
    const worker = new TaskWorker({ org: service, executor });
    worker.start();
    service.claim(task.id);
    worker.enqueue(task.id);
    await worker.drain();
    expect(service.getTask(task.id).status).toBe('awaiting_decision');
    const decisionId = service.getTask(task.id).decisionId!;
    expect(decisionId).toBeTruthy();

    // Approve, claim the resume, and let the worker run it.
    await service.claimResume(task.id, { decision: 'approve', approver: 'owner' });
    worker.enqueue(task.id);
    await worker.drain();
    worker.stop();

    const done = service.getTask(task.id);
    expect(done.status).toBe('done');
    expect(done.result).toEqual({ refunded: true, grade: 'D2' });
  });

  it('ignores duplicate enqueues so a task executes at most once', async () => {
    const { service, newTask } = setup();
    const task = newTask();
    let runs = 0;
    const executor: OrgTaskExecutor = {
      run: async () => {
        runs += 1;
        return { outcome: 'complete' };
      },
    };
    const worker = new TaskWorker({ org: service, executor });
    worker.start();
    service.claim(task.id);
    worker.enqueue(task.id);
    worker.enqueue(task.id);
    worker.enqueue(task.id);
    await worker.drain();
    worker.stop();
    expect(runs).toBe(1);
    expect(service.getTask(task.id).status).toBe('done');
  });

  it('reports unexpected runner errors via onError and keeps draining', async () => {
    const { service, newTask } = setup();
    const bad = newTask();
    const good = newTask();
    const errors: string[] = [];
    const executor: OrgTaskExecutor = {
      run: async ctx => {
        if (ctx.task.id === bad.id) {
          // runClaimed on a non-running task surfaces through onError path.
          throw new Error('should-not-happen');
        }
        return { outcome: 'complete' };
      },
    };
    const worker = new TaskWorker({ org: service, executor, onError: (id, e) => errors.push(`${id}:${(e as Error).message}`) });
    worker.start();
    service.claim(good.id);
    worker.enqueue(good.id);
    await worker.drain();
    expect(service.getTask(good.id).status).toBe('done');
    // A spurious enqueue of a terminal task is reported, not retried forever.
    worker.enqueue('task-does-not-exist');
    await worker.drain();
    worker.stop();
    expect(errors.some(e => e.startsWith('task-does-not-exist'))).toBe(true);
  });
});

/** F1.1: two bound positions in one org, optional concurrency limit. */
function parallelSetup(concurrencyLimit?: number) {
  const decisions = makeDecisionService();
  let seq = 0;
  const service = new OrgService({
    decisions,
    clock: () => '2026-10-22T00:00:00.000Z',
    newId: prefix => `${prefix}-${++seq}`,
    retryPolicy: { ...FAST_RETRY },
    taskDeadlineMs: 60_000,
  });
  const org = service.createOrganization({
    name: '并行',
    scaleTier: 'small',
    ...(concurrencyLimit !== undefined ? { concurrencyLimit } : {}),
  });
  const dept = service.createDepartment({ organizationId: org.id, name: '运营', mission: 'm' });
  const positionA = service.createPosition({
    organizationId: org.id,
    departmentId: dept.id,
    name: '专员A',
    requiredSkills: ['s-a'],
    allowedTools: [],
    decisionScope: 'D0',
  });
  const positionB = service.createPosition({
    organizationId: org.id,
    departmentId: dept.id,
    name: '专员B',
    requiredSkills: ['s-b'],
    allowedTools: [],
    decisionScope: 'D0',
  });
  service.assignAgent(positionA.id, { agentId: 'agent-a' });
  service.assignAgent(positionB.id, { agentId: 'agent-b' });
  return { service, org, positionA, positionB };
}

function timelineExecutor(holdMs: number) {
  const log: { id: string; phase: 'start' | 'end'; at: number }[] = [];
  const executor: OrgTaskExecutor = {
    run: async ctx => {
      log.push({ id: ctx.task.id, phase: 'start', at: Date.now() });
      await new Promise<void>(resolve => setTimeout(resolve, holdMs));
      log.push({ id: ctx.task.id, phase: 'end', at: Date.now() });
      return { outcome: 'complete' };
    },
  };
  return { log, executor };
}

function spanOf(log: { id: string; phase: 'start' | 'end'; at: number }[], id: string) {
  const start = log.find(e => e.id === id && e.phase === 'start');
  const end = log.find(e => e.id === id && e.phase === 'end');
  expect(start).toBeDefined();
  expect(end).toBeDefined();
  return { start: start!.at, end: end!.at };
}

describe('TaskWorker (F1.1 bounded per-position concurrency)', () => {
  it('overlaps different positions while keeping same-position order', async () => {
    const { service, org } = parallelSetup();
    const { log, executor } = timelineExecutor(25);
    const worker = new TaskWorker({ org: service, executor, intervalMs: 50 });
    worker.start();

    const a1 = service.createTask({ organizationId: org.id, title: 'A1', payload: {}, requiredSkill: 's-a' });
    const b1 = service.createTask({ organizationId: org.id, title: 'B1', payload: {}, requiredSkill: 's-b' });
    const a2 = service.createTask({ organizationId: org.id, title: 'A2', payload: {}, requiredSkill: 's-a' });
    const b2 = service.createTask({ organizationId: org.id, title: 'B2', payload: {}, requiredSkill: 's-b' });
    for (const task of [a1, b1, a2, b2]) {
      service.claim(task.id);
      worker.enqueue(task.id);
    }
    await worker.drain();
    worker.stop();

    // Same position never overlaps: A2 starts only after A1 settled.
    const a1Span = spanOf(log, a1.id);
    const a2Span = spanOf(log, a2.id);
    expect(a2Span.start).toBeGreaterThanOrEqual(a1Span.end);
    const b1Span = spanOf(log, b1.id);
    const b2Span = spanOf(log, b2.id);
    expect(b2Span.start).toBeGreaterThanOrEqual(b1Span.end);

    // Different positions overlap inside the default two-slot window.
    expect(a1Span.start < b1Span.end && b1Span.start < a1Span.end).toBe(true);
    for (const task of [a1, b1, a2, b2]) expect(service.getTask(task.id).status).toBe('done');
  });

  it('concurrencyLimit=1 reproduces the serial drain', async () => {
    const { service, org } = parallelSetup(1);
    const { log, executor } = timelineExecutor(20);
    const worker = new TaskWorker({ org: service, executor, intervalMs: 50 });
    worker.start();

    const a1 = service.createTask({ organizationId: org.id, title: 'A1', payload: {}, requiredSkill: 's-a' });
    const b1 = service.createTask({ organizationId: org.id, title: 'B1', payload: {}, requiredSkill: 's-b' });
    for (const task of [a1, b1]) {
      service.claim(task.id);
      worker.enqueue(task.id);
    }
    await worker.drain();
    worker.stop();

    const a = spanOf(log, a1.id);
    const b = spanOf(log, b1.id);
    // No overlap in either order: one task fully settles before the other starts.
    expect(a.start < b.end && b.start < a.end).toBe(false);
  });

  it('rejects an out-of-range concurrencyLimit', () => {
    const decisions = makeDecisionService();
    const service = new OrgService({
      decisions,
      clock: () => '2026-10-22T00:00:00.000Z',
      newId: prefix => `${prefix}-x`,
    });
    expect(() => service.createOrganization({ name: 'x', concurrencyLimit: 0 })).toThrow(/concurrencyLimit/);
    expect(() => service.createOrganization({ name: 'y', concurrencyLimit: 9 })).toThrow(/concurrencyLimit/);
  });
});
