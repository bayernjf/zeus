/**
 * Durable decision-webhook subscription registry (Active work 276). Implements
 * the same DecisionWebhookStore port as the in-memory implementation, so
 * subscriptions survive a process restart instead of being re-seeded by hand.
 *
 * The secret column holds the HMAC key in plaintext on the operator's own disk:
 * it must be available at delivery time (the dispatcher signs every push with
 * it), and zeus has no at-rest key-management story yet. The DB file itself is
 * opened with 0600 permissions (sqlite-db.ts); the column is never selected into
 * an HTTP response and never logged.
 */
import type { DatabaseSync } from 'node:sqlite';
import type {
  DecisionWebhookStore,
  DecisionWebhookSubscription,
} from '../decision-service/webhook.js';

/** Mark for rows the boot seeder wrote from ZEUS_DECISION_WEBHOOK_URL/_SECRET. */
export const ENV_SEED_WEBHOOK_ID = 'env-seed';

interface WebhookRow {
  id: string;
  url: string;
  secret: string;
  active: number;
  seeded_from_env: number;
}

function rowToSubscription(row: WebhookRow): DecisionWebhookSubscription {
  return {
    id: row.id,
    url: row.url,
    secret: row.secret,
    active: row.active !== 0,
  };
}

export class SqliteDecisionWebhookStore implements DecisionWebhookStore {
  constructor(private readonly db: DatabaseSync) {}

  async list(): Promise<DecisionWebhookSubscription[]> {
    const rows = this.db
      .prepare('SELECT id, url, secret, active, seeded_from_env FROM decision_webhooks')
      .all() as unknown as WebhookRow[];
    return rows.map(rowToSubscription);
  }

  /** Upsert by id: the boot seeder calls this every start to re-apply the
   *  env-seeded subscription without duplicating the row. */
  async add(subscription: DecisionWebhookSubscription): Promise<void> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO decision_webhooks (id, url, secret, active, seeded_from_env, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           url=excluded.url, secret=excluded.secret, active=excluded.active,
           seeded_from_env=excluded.seeded_from_env, updated_at=excluded.updated_at`,
      )
      .run(
        subscription.id,
        subscription.url,
        subscription.secret,
        subscription.active ? 1 : 0,
        subscription.id === ENV_SEED_WEBHOOK_ID ? 1 : 0,
        now,
        now,
      );
  }

  /** Hard delete. Returns false when no row with that id existed (the HTTP
   *  layer maps that to 404), true on the single row removed. */
  async remove(id: string): Promise<boolean> {
    const result = this.db.prepare('DELETE FROM decision_webhooks WHERE id = ?').run(id);
    return result.changes > 0;
  }
}
