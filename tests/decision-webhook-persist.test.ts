/**
 * Durable decision-webhook subscriptions (Active work 276): the registry used
 * to live in memory and lost every subscription on restart. This covers the
 * SQLite store (migration 0005, add/list/remove roundtrip, restart recovery,
 * env-seed upsert idempotency) and the bearer DELETE route (401, 204, 404 on
 * repeat delete, secret never in any response).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { openSqlite, migrate, appliedMigrations } from '../src/core/persistence/index.js';
import {
  SqliteDecisionWebhookStore,
  ENV_SEED_WEBHOOK_ID,
} from '../src/core/persistence/sqlite-webhook-store.js';
import { MIGRATION_0005_DECISION_WEBHOOKS } from '../src/core/persistence/schema.js';
import type { DatabaseSync } from 'node:sqlite';
import { createHttpServer } from '../src/http/server.js';
import { VassalRegistry } from '../src/registry/registry.js';
import { Ed25519MemorySigner } from '../src/registry/signing.js';
import {
  DecisionAuditChain,
  DecisionService,
  MemoryDecisionStore,
} from '../src/core/index.js';
import { MemoryPolicyStore } from '../src/core/grading/policy-loader.js';
import { DEFAULT_POLICY_V1 } from '../src/core/grading/default-policy.js';
import { DecisionWebhookDispatcher } from '../src/core/decision-service/webhook.js';
import type { DecisionEvent } from '../src/core/decision-service/events.js';

const TOKEN = 'driver-secret';
const AUTH = { authorization: `Bearer ${TOKEN}` };
const SECRET = 'persisted-webhook-secret-16chars';

let tempDir: string | undefined;
async function freshFile(): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), 'zeus-webhook-persist-'));
  return join(tempDir, 'zeus.db');
}

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function event(): DecisionEvent {
  return {
    type: 'approved',
    decisionId: 'dec_persist_1',
    at: '2026-10-27T00:00:00.000Z',
    domain: 'commerce',
    intent: 'refund',
    grade: 'D2',
    mode: 'approve-sync',
    status: 'decided',
    ruleId: 'd2-amount',
  };
}

describe('SqliteDecisionWebhookStore (migration 0005)', () => {
  it('records the migration and creates the table on a fresh database', async () => {
    const file = await freshFile();
    const db = openSqlite(file);
    expect(migrate(db)).toBe(true);
    expect(appliedMigrations(db)).toContain(MIGRATION_0005_DECISION_WEBHOOKS);
    expect(migrate(db)).toBe(false); // idempotent re-run
    db.close();
  });

  it('upgrades a pre-0005 database in place (the migration is idempotent)', async () => {
    const file = await freshFile();
    const db = openSqlite(file);
    // Simulate a database from before 0005: only the baseline migration recorded.
    db.exec(`
      CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations (id, applied_at) VALUES
        ('0001_init_decision_org', '2026-10-23T00:00:00.000Z'),
        ('0002_org_task_execution', '2026-10-23T00:00:00.000Z'),
        ('0003_org_task_actions', '2026-10-23T00:00:00.000Z'),
        ('0004_position_credentials', '2026-10-23T00:00:00.000Z');
    `);
    migrate(db);
    expect(appliedMigrations(db)).toContain(MIGRATION_0005_DECISION_WEBHOOKS);
    const store = new SqliteDecisionWebhookStore(db);
    // The just-created table is immediately usable.
    await store.add({ id: 'wh-upgraded', url: 'https://ops.example.invalid/hook', secret: SECRET, active: true });
    expect((await store.list())).toHaveLength(1);
    db.close();
  });

  it('adds, lists and removes a subscription; roundtrips the secret for signing', async () => {
    const file = await freshFile();
    const db = openSqlite(file);
    migrate(db);
    const store = new SqliteDecisionWebhookStore(db);
    await store.add({ id: 'wh-1', url: 'https://ops.example.invalid/hook', secret: SECRET, active: true });
    const rows = await store.list();
    expect(rows).toEqual([{ id: 'wh-1', url: 'https://ops.example.invalid/hook', secret: SECRET, active: true }]);
    expect(await store.remove('wh-1')).toBe(true);
    expect(await store.list()).toEqual([]);
    db.close();
  });

  it('restart recovery: a subscription added in one boot survives close + reopen', async () => {
    const file = await freshFile();
    let db: DatabaseSync = openSqlite(file);
    migrate(db);
    await new SqliteDecisionWebhookStore(db).add({
      id: 'wh-persisted',
      url: 'https://ops.example.invalid/hook',
      secret: SECRET,
      active: true,
    });
    db.close();

    // Reopen as a new process: no env re-seed, the row must still be there.
    db = openSqlite(file);
    migrate(db);
    const rows = await new SqliteDecisionWebhookStore(db).list();
    expect(rows).toEqual([
      { id: 'wh-persisted', url: 'https://ops.example.invalid/hook', secret: SECRET, active: true },
    ]);
    db.close();
  });

  it('env-seed upsert is idempotent: re-seeding the same id keeps one row', async () => {
    const file = await freshFile();
    const db = openSqlite(file);
    migrate(db);
    const store = new SqliteDecisionWebhookStore(db);
    await store.add({ id: ENV_SEED_WEBHOOK_ID, url: 'https://old.example.invalid/hook', secret: SECRET, active: true });
    await store.add({ id: ENV_SEED_WEBHOOK_ID, url: 'https://new.example.invalid/hook', secret: `${SECRET}-rotated`, active: true });
    const rows = await store.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: ENV_SEED_WEBHOOK_ID, url: 'https://new.example.invalid/hook' });
    db.close();
  });

  it('remove returns false for an unknown id and never touches the other row', async () => {
    const file = await freshFile();
    const db = openSqlite(file);
    migrate(db);
    const store = new SqliteDecisionWebhookStore(db);
    await store.add({ id: 'wh-keep', url: 'https://ops.example.invalid/hook', secret: SECRET, active: true });
    expect(await store.remove('wh-never-existed')).toBe(false);
    expect((await store.list())).toHaveLength(1);
    db.close();
  });
});

describe('DELETE /api/v1/decision-webhooks/:id routes', () => {
  async function server(): Promise<{ app: FastifyInstance; db: DatabaseSync }> {
    const file = await freshFile();
    const db = openSqlite(file);
    migrate(db);
    const signer = new Ed25519MemorySigner('zeus-rsk-test');
    const audit = new DecisionAuditChain(signer, () => '2026-10-27T00:00:00.000Z');
    const policyStore = new MemoryPolicyStore();
    policyStore.put(DEFAULT_POLICY_V1);
    const decisionService = new DecisionService({
      policyStore,
      recordStore: new MemoryDecisionStore(),
      audit,
    });
    const app = await createHttpServer({
      registry: new VassalRegistry(),
      signer,
      internalToken: TOKEN,
      decisionService,
      decisionWebhookStore: new SqliteDecisionWebhookStore(db),
    });
    return { app, db };
  }

  it('is 401 without a bearer token', async () => {
    const { app, db } = await server();
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/decision-webhooks/wh-x' });
    expect(res.statusCode).toBe(401);
    await app.close();
    db.close();
  });

  it('add → delete is 204; the repeat delete and an unknown id are both 404', async () => {
    const { app, db } = await server();
    const added = await app.inject({
      method: 'POST',
      url: '/api/v1/decision-webhooks',
      headers: AUTH,
      payload: { url: 'https://ops.example.invalid/hook', secret: SECRET },
    });
    expect(added.statusCode).toBe(201);
    const id = (await added.json()).id as string;

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/decision-webhooks/${id}`,
      headers: AUTH,
    });
    expect(removed.statusCode).toBe(204);

    const again = await app.inject({
      method: 'DELETE',
      url: `/api/v1/decision-webhooks/${id}`,
      headers: AUTH,
    });
    expect(again.statusCode).toBe(404);
    expect((await again.json()).code).toBe('WEBHOOK_NOT_FOUND');

    const unknown = await app.inject({
      method: 'DELETE',
      url: '/api/v1/decision-webhooks/wh-nope',
      headers: AUTH,
    });
    expect(unknown.statusCode).toBe(404);
    await app.close();
    db.close();
  });

  it('secret never appears in any add/list/delete response', async () => {
    const { app, db } = await server();
    const added = await app.inject({
      method: 'POST',
      url: '/api/v1/decision-webhooks',
      headers: AUTH,
      payload: { url: 'https://ops.example.invalid/hook', secret: SECRET },
    });
    expect(JSON.stringify(await added.json())).not.toContain(SECRET);
    const listed = await app.inject({ method: 'GET', url: '/api/v1/decision-webhooks', headers: AUTH });
    expect(JSON.stringify(await listed.json())).not.toContain(SECRET);
    const id = (await added.json()).id as string;
    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/decision-webhooks/${id}`,
      headers: AUTH,
    });
    expect(removed.body).toBe(''); // 204 No Content
    await app.close();
    db.close();
  });

  it('a deleted row is gone from disk after a close + reopen', async () => {
    const dbFile = await freshFile();
    let db: DatabaseSync = openSqlite(dbFile);
    migrate(db);
    const app = await createHttpServer({
      registry: new VassalRegistry(),
      signer: new Ed25519MemorySigner('zeus-rsk-test'),
      internalToken: TOKEN,
      decisionService: new DecisionService({
        policyStore: new MemoryPolicyStore(),
        recordStore: new MemoryDecisionStore(),
        audit: new DecisionAuditChain(new Ed25519MemorySigner('audit-seal-test')),
      }),
      decisionWebhookStore: new SqliteDecisionWebhookStore(db),
    });
    const added = await app.inject({
      method: 'POST',
      url: '/api/v1/decision-webhooks',
      headers: AUTH,
      payload: { url: 'https://ops.example.invalid/hook', secret: SECRET },
    });
    const id = (await added.json()).id as string;
    await app.inject({ method: 'DELETE', url: `/api/v1/decision-webhooks/${id}`, headers: AUTH });
    await app.close();
    db.close();

    // Second boot reads the same file: the deleted subscription must not return.
    db = openSqlite(dbFile);
    const rows = await new SqliteDecisionWebhookStore(db).list();
    expect(rows).toEqual([]);
    db.close();
  });

  it('reverse gate: the dispatcher stops delivering once the row is removed', async () => {
    const file = await freshFile();
    const db = openSqlite(file);
    migrate(db);
    const store = new SqliteDecisionWebhookStore(db);
    await store.add({ id: 'wh-1', url: 'http://127.0.0.1:9/hook', secret: SECRET, active: true });
    let calls = 0;
    const dispatcher = new DecisionWebhookDispatcher({
      store,
      fetch: (async () => {
        calls += 1;
        return { ok: true } as Response;
      }) as unknown as typeof fetch,
    });
    await dispatcher.emit(event());
    expect(calls).toBe(1);
    await store.remove('wh-1');
    await dispatcher.emit(event());
    expect(calls).toBe(1); // no second delivery: the row is gone
    db.close();
  });
});
