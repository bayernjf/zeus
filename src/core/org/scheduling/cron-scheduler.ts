/**
 * F5.2 in-process scheduler. Scans active daily/weekly goals, computes their
 * latest UTC window, and creates one org task per window through the same
 * `OrgService.createTask` path used by the HTTP API. The idempotency key is
 * `goal:<id>:<window ISO>`, so replaying a tick (including after a restart)
 * returns the existing task instead of creating a second one.
 *
 * Optional `deliver` hands a freshly created task to the async worker; without
 * an executor the scheduler still registers the task and leaves it pending,
 * which keeps scheduling independent from execution.
 */
import type { OrgService } from '../org-service.js';
import type { Json, OrgGoal } from '../types.js';
import {
  goalOccurrence,
  goalRunKey,
  type OrgScheduleDelivery,
  type OrgScheduleTickResult,
  type OrgScheduler,
} from './scheduler.js';

export interface CronOrgSchedulerDeps {
  org: OrgService;
  /** Scan cadence; default 60000 ms. */
  intervalMs?: number;
  /** Injectable clock, primarily for tests. */
  clock?: () => Date;
  /** Optional handoff after creation (e.g. claim + worker.enqueue). */
  deliver?: (delivery: OrgScheduleDelivery) => void;
  /** Called when a goal fails during creation or handoff. */
  onError?: (goalId: string, error: unknown) => void;
  setIntervalFn?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (handle: ReturnType<typeof setInterval>) => void;
}

const DEFAULT_INTERVAL_MS = 60_000;

export class CronOrgScheduler implements OrgScheduler {
  private readonly org: OrgService;
  private readonly intervalMs: number;
  private readonly clock: () => Date;
  private readonly deliver: ((delivery: OrgScheduleDelivery) => void) | undefined;
  private readonly onError: ((goalId: string, error: unknown) => void) | undefined;
  private readonly setIntervalFn: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  private readonly clearIntervalFn: (handle: ReturnType<typeof setInterval>) => void;
  private timer: ReturnType<typeof setInterval> | undefined;
  private started = false;

  constructor(deps: CronOrgSchedulerDeps) {
    this.org = deps.org;
    this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.clock = deps.clock ?? (() => new Date());
    this.deliver = deps.deliver;
    this.onError = deps.onError;
    this.setIntervalFn = deps.setIntervalFn ?? setInterval;
    this.clearIntervalFn = deps.clearIntervalFn ?? clearInterval;
  }

  get isStarted(): boolean {
    return this.started;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    // Catch up the current window immediately; this is the restart recovery
    // path when the process was down across a scheduled minute.
    this.safeTick();
    this.timer = this.setIntervalFn(() => {
      this.safeTick();
    }, this.intervalMs);
    // Do not keep the process alive solely for the scan timer.
    (this.timer as { unref?: () => void })?.unref?.();
  }

  stop(): void {
    this.started = false;
    if (this.timer) {
      this.clearIntervalFn(this.timer);
      this.timer = undefined;
    }
  }

  tick(now = this.clock()): OrgScheduleTickResult {
    const result: OrgScheduleTickResult = {
      scanned: 0,
      due: 0,
      created: [],
      duplicates: [],
      failed: [],
    };
    const goals = this.org.listGoals();
    result.scanned = goals.length;

    for (const goal of goals) {
      if (goal.status !== 'active') continue;
      const occurrence = goalOccurrence(goal, now);
      if (!occurrence) continue;
      result.due += 1;

      const key = goalRunKey(goal.id, occurrence);
      const existing = this.org
        .listTasks(goal.organizationId)
        .find(task => task.idempotencyKey === key);
      if (existing) {
        result.duplicates.push(existing.id);
        continue;
      }

      try {
        const task = this.org.createTask(this.taskInput(goal, occurrence, key));
        result.created.push(task.id);
        try {
          this.deliver?.({ goal, taskId: task.id, occurrence: occurrence.toISOString() });
        } catch (error) {
          this.reportFailure(goal, error, result);
        }
      } catch (error) {
        this.reportFailure(goal, error, result);
      }
    }

    return result;
  }

  private safeTick(): void {
    try {
      this.tick();
    } catch (error) {
      // A scanner failure must not crash the process; report it through the
      // same error channel used for per-goal delivery failures.
      try {
        this.onError?.('*', error);
      } catch {
        // An error reporter must never take down the scheduler loop.
      }
    }
  }

  private taskInput(goal: OrgGoal, occurrence: Date, idempotencyKey: string) {
    const template = goal.taskTemplate;
    const payload: Json = template?.payload ?? {
      goalId: goal.id,
      goalTitle: goal.title,
      period: goal.period,
      scheduledFor: occurrence.toISOString(),
      ...(goal.projectId ? { projectId: goal.projectId } : {}),
    };
    return {
      organizationId: goal.organizationId,
      title: template?.title ?? goal.title,
      payload,
      ...(template?.requiredSkill ? { requiredSkill: template.requiredSkill } : {}),
      ...(template?.positionId ? { positionId: template.positionId } : {}),
      idempotencyKey,
    };
  }

  private reportFailure(goal: OrgGoal, error: unknown, result: OrgScheduleTickResult): void {
    const message = error instanceof Error ? error.message : String(error);
    result.failed.push({ goalId: goal.id, error: message });
    this.onError?.(goal.id, error);
  }
}
