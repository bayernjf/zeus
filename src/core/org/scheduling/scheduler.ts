/**
 * F5.2 org scheduling contract. The first implementation is an in-process
 * cron scanner over registered goals; a future deployment can replace it with
 * an external scheduler behind the same interface.
 *
 * Time semantics: every window is UTC. A goal carries its own UTC trigger
 * (`schedule`), so the scheduler has no global timezone configuration.
 */
import type { OrgGoal } from '../types.js';

export interface OrgScheduleDelivery {
  goal: OrgGoal;
  taskId: string;
  /** UTC window this delivery belongs to (ISO-8601). */
  occurrence: string;
}

export interface OrgScheduleTickResult {
  /** Goals inspected in this tick. */
  scanned: number;
  /** Goals whose latest window is due at the tick instant. */
  due: number;
  /** Task ids created by this tick. */
  created: string[];
  /** Due windows whose idempotency key already has a task. */
  duplicates: string[];
  /** Goals that failed during task creation or handoff. */
  failed: { goalId: string; error: string }[];
}

export interface OrgScheduler {
  start(): void;
  stop(): void;
  /** Run one deterministic scan. Exposed for tests and operator tooling. */
  tick(now?: Date): OrgScheduleTickResult;
}

/**
 * Latest UTC occurrence at or before `now` for a daily/weekly goal.
 * Returns undefined when the goal has no recurrence, has no schedule, or the
 * window predates the goal (a goal created after today's window must not
 * backfill it).
 */
export function goalOccurrence(goal: OrgGoal, now: Date): Date | undefined {
  if (goal.period !== 'daily' && goal.period !== 'weekly') return undefined;
  const schedule = goal.schedule;
  if (!schedule) return undefined;

  let occurrence = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    schedule.hourUtc,
    schedule.minuteUtc,
    0,
    0,
  );
  if (occurrence > now.getTime()) occurrence -= 24 * 60 * 60 * 1000;

  if (goal.period === 'weekly') {
    const weekday = schedule.weekdayUtc;
    if (weekday === undefined) return undefined;
    while (new Date(occurrence).getUTCDay() !== weekday) {
      occurrence -= 24 * 60 * 60 * 1000;
    }
  }

  const created = Date.parse(goal.createdAt);
  if (Number.isFinite(created) && occurrence < created) return undefined;
  return new Date(occurrence);
}

/** Stable idempotency key: one goal window maps to exactly one task. */
export function goalRunKey(goalId: string, occurrence: Date): string {
  return `goal:${goalId}:${occurrence.toISOString()}`;
}
