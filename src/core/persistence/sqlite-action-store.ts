/**
 * Durable per-task idempotent action store (T-M7-01/#11). Backs the runner's
 * at-most-once action guard (ctx.action) so that side effects already
 * performed are not replayed after a retry or a process restart. One instance
 * is bound to a task id; the underlying table is shared across tasks.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { ActionResultStore, EffectResult } from '../org/execution/index.js';

export class SqliteActionStore implements ActionResultStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly taskId: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  get(key: string): { ok: true; value: EffectResult } | { ok: false } {
    const row = this.db
      .prepare('SELECT result_json FROM org_task_actions WHERE task_id = ? AND action_key = ?')
      .get(this.taskId, key) as { result_json?: string } | undefined;
    if (!row?.result_json) return { ok: false };
    return { ok: true, value: JSON.parse(row.result_json) as EffectResult };
  }

  put(key: string, value: EffectResult): void {
    this.db
      .prepare(
        `INSERT INTO org_task_actions (task_id, action_key, result_json, created_at)
         VALUES (@task_id, @action_key, @result_json, @created_at)
         ON CONFLICT(task_id, action_key) DO UPDATE SET result_json = @result_json`,
      )
      .run({
        task_id: this.taskId,
        action_key: key,
        result_json: JSON.stringify(value),
        created_at: this.now(),
      });
  }
}
