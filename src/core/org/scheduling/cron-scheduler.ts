/**
 * F5.2/F5.3 in-process scheduler. Scans active daily/weekly goals, computes
 * their latest UTC window, and creates one org task per window — or one task
 * per step when the goal references a built-in F5.3 template. The idempotency
 * key is `goal:<id>:<window ISO>` for the legacy single-task path and
 * `goal:<id>:<window ISO>:<stepId>` for template steps, so replaying a tick
 * (including after a restart) returns existing tasks instead of duplicates.
 *
 * Optional `deliver` hands a task to the async worker. Template steps are only
 * delivered when all their dependencies are `done`; a blocked step stays
 * pending and is retried on the next tick. Without an executor the scheduler
 * still registers tasks and leaves them pending.
 */
import type { OrgService } from '../org-service.js';
import type { Json, OrgGoal, OrgTask } from '../types.js';
import { expandGoalSteps, type ExpandedGoalStep } from '../goal-templates.js';
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

      let steps: ExpandedGoalStep[];
      try {
        steps = expandGoalSteps(goal);
      } catch (error) {
        this.reportFailure(goal, error, result);
        continue;
      }

      const taskByStep = new Map<string, OrgTask>();
      const createdIds = new Set<string>();
      let creationError: unknown;
      for (const step of steps) {
        const stepKey = step.stepId ?? '';
        const key = goalRunKey(goal.id, occurrence, step.stepId);
        const existing = this.org
          .listTasks(goal.organizationId)
          .find(task => task.idempotencyKey === key);
        if (existing) {
          result.duplicates.push(existing.id);
          taskByStep.set(stepKey, existing);
          continue;
        }
        if (creationError) break;
        try {
          const dependsOn = step.dependsOn.map((dependency) => {
            const dependencyTask = taskByStep.get(dependency);
            if (!dependencyTask) {
              throw new Error(
                `template step ${step.stepId ?? '(legacy)'} depends on unresolved step ${dependency}`,
              );
            }
            return dependencyTask.id;
          });
          const task = this.org.createTask(
            this.taskInput(goal, occurrence, key, step, dependsOn),
          );
          result.created.push(task.id);
          createdIds.add(task.id);
          taskByStep.set(stepKey, task);
        } catch (error) {
          creationError = error;
        }
      }

      for (const step of steps) {
        const task = taskByStep.get(step.stepId ?? '');
        if (!task || task.status !== 'pending') continue;
        if (!this.dependenciesDone(task)) continue;
        // Legacy F5.2 goals hand off only a freshly created task, preserving
        // the old "no re-delivery of existing pending tasks" behaviour.
        if (goal.templateRef === undefined && !createdIds.has(task.id)) continue;
        try {
          this.deliver?.({ goal, taskId: task.id, occurrence: occurrence.toISOString() });
        } catch (error) {
          this.reportFailure(goal, error, result);
        }
      }

      if (creationError) this.reportFailure(goal, creationError, result);
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

  private taskInput(
    goal: OrgGoal,
    occurrence: Date,
    idempotencyKey: string,
    step: ExpandedGoalStep,
    dependsOn: string[],
  ) {
    const basePayload: Json = {
      goalId: goal.id,
      goalTitle: goal.title,
      period: goal.period,
      scheduledFor: occurrence.toISOString(),
      ...(goal.projectId ? { projectId: goal.projectId } : {}),
      ...(goal.templateRef ? { templateRef: goal.templateRef } : {}),
      ...(step.stepId ? { stepId: step.stepId } : {}),
    };
    // Template steps merge their declared payload over the run metadata so
    // every expanded task carries goal/period/step provenance. The legacy
    // single-task template keeps its payload byte-for-byte (F5.2 contract).
    const payload: Json =
      step.payload === undefined
        ? basePayload
        : goal.templateRef !== undefined && isJsonObject(step.payload)
          ? { ...basePayload, ...step.payload }
          : step.payload;
    return {
      organizationId: goal.organizationId,
      title: step.title,
      payload,
      ...(step.requiredSkill ? { requiredSkill: step.requiredSkill } : {}),
      ...(step.positionId ? { positionId: step.positionId } : {}),
      ...(dependsOn.length ? { dependsOn } : {}),
      idempotencyKey,
    };
  }

  /** A dependency that is missing or not `done` blocks the handoff (fail-closed). */
  private dependenciesDone(task: OrgTask): boolean {
    for (const dependencyId of task.dependsOn ?? []) {
      const dependency = this.org.getTask(dependencyId);
      if (dependency.status !== 'done') return false;
    }
    return true;
  }

  private reportFailure(goal: OrgGoal, error: unknown, result: OrgScheduleTickResult): void {
    const message = error instanceof Error ? error.message : String(error);
    result.failed.push({ goalId: goal.id, error: message });
    this.onError?.(goal.id, error);
  }
}

function isJsonObject(value: Json): value is { [key: string]: Json } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
