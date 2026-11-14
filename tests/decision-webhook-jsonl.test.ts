/**
 * JSONL persistence for decision webhook subscriptions in memory/demo mode
 * (ZEUS_WEBHOOK_SUBSCRIPTIONS_FILE, Active work 279): the durable mode keeps
 * the registry in SQLite (covered by decision-webhook-persist.test.ts) and the
 * plain in-memory registry is covered by decision-webhook.test.ts. This file
 * covers the opt-in middle ground: persist → restart → readBack roundtrip,
 * the DELETE route writing the deletion through to the file, the dispatcher
 * stopping after a delete, the fail-closed malformed line, permissions, and
 * the bearer route semantics over a JSONL-backed registry.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { chmod, mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { JsonlDecisionWebhookStore } from '../src/core/decision-service/webhook-jsonl.js';
import { DecisionWebhookDispatcher } from '../src/core/decision-service/webhook.js';
import type { DecisionEvent } from '../src/core/decision-service/events.js';
import { createHttpServer } from '../src/http/server.js';
import { ExecutorRegistry } from '../src/registry/registry.js';
import { Ed25519MemorySigner } from '../src/registry/signing.js';
import {
  DecisionAuditChain,
  DecisionService,
  MemoryDecisionStore,
} from '../src/core/index.js';
import { MemoryPolicyStore } from '../src/core/grading/policy-loader.js';

const TOKEN = 'operator-secret';
const AUTH = { authorization: `Bearer ${TOKEN}` };
const SECRET = 'jsonl-webhook-secret-16ch';

let tempDir: string | undefined;
async function freshPath(name: string): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), `zeus-webhook-jsonl-${name}-`));
  return join(tempDir, 'webhook-subscriptions.jsonl');
}

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function event(): DecisionEvent {
  return {
    type: 'approved',
    decisionId: 'dec_jsonl_1',
    at: '2026-11-10T00:00:00.000Z',
    domain: 'commerce',
    intent: 'refund',
    grade: 'D2',
    mode: 'approve-sync',
    status: 'decided',
    ruleId: 'd2-amount',
  };
}

describe('JsonlDecisionWebhookStore', () => {
  it('treats a missing file as a first boot: empty registry, no throw', async () => {
    const store = new JsonlDecisionWebhookStore(await freshPath('first-boot'));
    expect(await store.readBack()).toEqual([]);
    expect(await store.list()).toEqual([]);
  });

  it('persists → restart → readBack: subscriptions added in one boot survive a new instance', async () => {
    const file = await freshPath('restart');
    const firstBoot = new JsonlDecisionWebhookStore(file);
    await firstBoot.readBack();
    await firstBoot.add({ id: 'wh-1', url: 'https://ops.example.invalid/hook', secret: SECRET, active: true });
    await firstBoot.add({ id: 'wh-2', url: 'https://ops2.example.invalid/hook', secret: `${SECRET}-2`, active: false });

    // A "new process": nothing in memory, only the file on disk.
    const restarted = new JsonlDecisionWebhookStore(file);
    expect(await restarted.readBack()).toEqual([
      { id: 'wh-1', url: 'https://ops.example.invalid/hook', secret: SECRET, active: true },
      { id: 'wh-2', url: 'https://ops2.example.invalid/hook', secret: `${SECRET}-2`, active: false },
    ]);
    // list() never hands out the internal rows (defensive copies).
    const listed = await restarted.list();
    listed[0]!.active = false;
    expect((await restarted.list())[0]!.active).toBe(true);
  });

  it('add is an upsert by id: re-applying the env seed keeps one line on disk', async () => {
    const file = await freshPath('upsert');
    const store = new JsonlDecisionWebhookStore(file);
    await store.add({ id: 'env-seed', url: 'https://old.example.invalid/hook', secret: SECRET, active: true });
    await store.add({ id: 'env-seed', url: 'https://new.example.invalid/hook', secret: `${SECRET}-rot`, active: true });
    const lines = (await readFile(file, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ id: 'env-seed', url: 'https://new.example.invalid/hook' });
  });

  it('remove deletes the row from disk; removing an unknown id leaves the file byte-identical', async () => {
    const file = await freshPath('remove');
    const store = new JsonlDecisionWebhookStore(file);
    await store.readBack();
    await store.add({ id: 'wh-keep', url: 'https://ops.example.invalid/hook', secret: SECRET, active: true });
    await store.add({ id: 'wh-drop', url: 'https://ops2.example.invalid/hook', secret: `${SECRET}-2`, active: true });
    const before = await readFile(file, 'utf8');

    expect(await store.remove('wh-never-existed')).toBe(false);
    expect(await readFile(file, 'utf8')).toBe(before); // no rewrite on a no-op

    expect(await store.remove('wh-drop')).toBe(true);
    const restarted = new JsonlDecisionWebhookStore(file);
    expect(await restarted.readBack()).toEqual([
      { id: 'wh-keep', url: 'https://ops.example.invalid/hook', secret: SECRET, active: true },
    ]);
  });

  it('keeps the file 0600 and the directory 0700, including a replace over a lax pre-existing file', async () => {
    const file = await freshPath('perms');
    const store = new JsonlDecisionWebhookStore(file);
    await store.add({ id: 'wh-1', url: 'https://ops.example.invalid/hook', secret: SECRET, active: true });
    expect((await stat0(file)) & 0o777).toBe(0o600);
    expect((await stat0(tempDir!)) & 0o777).toBe(0o700);

    // An operator hand-created the file before the store ever ran (or an old
    // copy was restored lax): the next rewrite replaces the file, and the
    // replacement must not inherit the lax mode.
    await chmod(file, 0o644);
    await store.add({ id: 'wh-2', url: 'https://ops2.example.invalid/hook', secret: `${SECRET}-2`, active: true });
    expect((await stat0(file)) & 0o777).toBe(0o600);
  });

  it('refuses to open a registry with a malformed line (fail-closed, with the line number)', async () => {
    const file = await freshPath('malformed');
    await mkdir(tempDir!, { recursive: true });
    await writeFile(file, '{"id":"wh-1","url":"https://ops.example.invalid/hook","secret":"x","active":true}\nnot-json\n', 'utf8');
    const store = new JsonlDecisionWebhookStore(file);
    await expect(store.readBack()).rejects.toThrow(/line 2/);
    await expect(new JsonlDecisionWebhookStore(file).readBack()).rejects.toThrow(/line 2/);
  });

  it('serializes concurrent mutations: the file settles on the final registry', async () => {
    const file = await freshPath('concurrent');
    const store = new JsonlDecisionWebhookStore(file);
    await store.readBack();
    await store.add({ id: 'wh-1', url: 'https://ops.example.invalid/hook', secret: SECRET, active: true });
    await Promise.all([
      store.add({ id: 'wh-2', url: 'https://ops2.example.invalid/hook', secret: `${SECRET}-2`, active: true }),
      store.remove('wh-1'),
      store.add({ id: 'wh-3', url: 'https://ops3.example.invalid/hook', secret: `${SECRET}-3`, active: true }),
    ]);
    const ids = (await new JsonlDecisionWebhookStore(file).readBack()).map(s => s.id);
    expect(ids).toEqual(['wh-2', 'wh-3']);
  });

  it('reverse gate: the dispatcher stops delivering once the row is removed', async () => {
    const file = await freshPath('dispatcher');
    const store = new JsonlDecisionWebhookStore(file);
    await store.readBack();
    await store.add({ id: 'wh-1', url: 'http://127.0.0.1:9/hook', secret: SECRET, active: true });
    let calls = 0;
    const dispatcher = new DecisionWebhookDispatcher({
      store,
      fetch: async () => {
        calls += 1;
        return { ok: true } as Response;
      },
    });
    await dispatcher.emit(event());
    expect(calls).toBe(1);
    await store.remove('wh-1');
    await dispatcher.emit(event());
    expect(calls).toBe(1); // no second delivery: the row is gone (from memory and disk)
  });
});

describe('DELETE /api/v1/decision-webhooks/:id over a JSONL-backed registry', () => {
  async function server(file: string): Promise<FastifyInstance> {
    return createHttpServer({
      registry: new ExecutorRegistry(),
      signer: new Ed25519MemorySigner('zeus-rsk-test'),
      internalToken: TOKEN,
      decisionService: new DecisionService({
        policyStore: new MemoryPolicyStore(),
        recordStore: new MemoryDecisionStore(),
        audit: new DecisionAuditChain(new Ed25519MemorySigner('audit-seal-test')),
      }),
      decisionWebhookStore: new JsonlDecisionWebhookStore(file),
    });
  }

  it('is 401 without a bearer token', async () => {
    const file = await freshPath('http-401');
    const app = await server(file);
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/decision-webhooks/wh-x' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('add → delete is 204; the repeat delete and an unknown id are both 404; the secret never leaves the process', async () => {
    const file = await freshPath('http-roundtrip');
    const app = await server(file);
    const added = await app.inject({
      method: 'POST',
      url: '/api/v1/decision-webhooks',
      headers: AUTH,
      payload: { url: 'https://ops.example.invalid/hook', secret: SECRET },
    });
    expect(added.statusCode).toBe(201);
    const id = (await added.json()).id as string;

    const listed = await app.inject({ method: 'GET', url: '/api/v1/decision-webhooks', headers: AUTH });
    expect(JSON.stringify(await listed.json())).not.toContain(SECRET);

    const removed = await app.inject({ method: 'DELETE', url: `/api/v1/decision-webhooks/${id}`, headers: AUTH });
    expect(removed.statusCode).toBe(204);
    expect(removed.body).toBe(''); // 204 No Content

    const again = await app.inject({ method: 'DELETE', url: `/api/v1/decision-webhooks/${id}`, headers: AUTH });
    expect(again.statusCode).toBe(404);
    expect((await again.json()).code).toBe('WEBHOOK_NOT_FOUND');

    const unknown = await app.inject({ method: 'DELETE', url: '/api/v1/decision-webhooks/wh-nope', headers: AUTH });
    expect(unknown.statusCode).toBe(404);
    await app.close();
  });

  it('restart recovery: a subscription added over the API survives into a second server; the deleted one does not', async () => {
    const file = await freshPath('http-restart');
    const firstBoot = await server(file);
    const kept = await firstBoot.inject({
      method: 'POST',
      url: '/api/v1/decision-webhooks',
      headers: AUTH,
      payload: { url: 'https://ops.example.invalid/hook', secret: SECRET },
    });
    const dropped = await firstBoot.inject({
      method: 'POST',
      url: '/api/v1/decision-webhooks',
      headers: AUTH,
      payload: { url: 'https://ops2.example.invalid/hook', secret: `${SECRET}-2` },
    });
    const keptId = (await kept.json()).id as string;
    const droppedId = (await dropped.json()).id as string;
    await firstBoot.inject({ method: 'DELETE', url: `/api/v1/decision-webhooks/${droppedId}`, headers: AUTH });
    await firstBoot.close();

    // Second boot over the same file: the operator row is back, the deleted
    // one stays gone, and the secrets roundtrip for signing.
    const secondBoot = await server(file);
    const listed = (await (
      await secondBoot.inject({ method: 'GET', url: '/api/v1/decision-webhooks', headers: AUTH })
    ).json()) as { webhooks: Array<{ id: string; url: string; active: boolean }> };
    expect(listed.webhooks).toEqual([
      { id: keptId, url: 'https://ops.example.invalid/hook', active: true },
    ]);
    expect(JSON.stringify(listed)).not.toContain(SECRET);
    await secondBoot.close();
  });
});

async function stat0(path: string): Promise<number> {
  return (await stat(path)).mode;
}
