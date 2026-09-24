import { describe, expect, it, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createHttpServer } from '../src/http/server.js';
import { VassalRegistry } from '../src/registry/registry.js';
import { Ed25519MemorySigner } from '../src/registry/signing.js';
import { FsRealmStore } from '../src/realm/store.js';
import { MemoryStore } from '../src/memory/memory-store.js';
import type { MemoryEvent } from '../src/memory/types.js';

const TOKEN = 'driver-secret';
const AUTH = { authorization: `Bearer ${TOKEN}` };

let seq = 0;
function event(partial: Partial<MemoryEvent> & { occurredAt: string }): MemoryEvent {
  seq += 1;
  return {
    eventId: `evt-${String(seq).padStart(3, '0')}`,
    realmId: 'realm-test',
    runId: `run-${seq}`,
    source: { agentId: `agent-${seq}` },
    kind: 'observation',
    content: '',
    refs: [],
    confidence: 0.5,
    ...partial,
  };
}

let root: string;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

async function setup(): Promise<{
  app: FastifyInstance; realm: FsRealmStore; realmId: string;
}> {
  root = await mkdtemp(join(tmpdir(), 'zeus-diary-http-'));
  const realm = new FsRealmStore();
  const manifest = await realm.connect(root, 'personal');
  const memoryStore = new MemoryStore();
  memoryStore.append(event({
    realmId: manifest.realmId, eventId: 'evt-1',
    occurredAt: '2026-09-23T09:00:00.000Z', content: 'found 3 docs',
  }));
  memoryStore.append(event({
    realmId: manifest.realmId, eventId: 'evt-2', kind: 'decision',
    occurredAt: '2026-09-23T10:00:00.000Z', content: 'approve the report', confidence: 0.9,
  }));
  const registry = new VassalRegistry();
  const signer = new Ed25519MemorySigner('zeus-rsk-test');
  const app = await createHttpServer({
    registry, signer, internalToken: TOKEN, memoryStore, realmStore: realm,
  });
  return { app, realm, realmId: manifest.realmId };
}

describe('E8.3 diary HTTP read', () => {
  it('builds diary entries on demand with rendered markdown', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: '/api/diary', headers: AUTH });
    expect(res.statusCode).toBe(200);
    const { entries } = await res.json();
    expect(entries).toHaveLength(1);
    expect(entries[0].date).toBe('2026-09-23');
    expect(entries[0].markdown).toContain('found 3 docs');
    expect(entries[0].markdown).toContain('approve the report');
  });

  it('filters by date, 404s an empty date and 400s a bad date', async () => {
    const { app } = await setup();
    const hit = await app.inject({ method: 'GET', url: '/api/diary?date=2026-09-23', headers: AUTH });
    expect((await hit.json()).entries).toHaveLength(1);

    const missing = await app.inject({ method: 'GET', url: '/api/diary?date=2026-09-22', headers: AUTH });
    expect(missing.statusCode).toBe(404);

    const bad = await app.inject({ method: 'GET', url: '/api/diary?date=23-09', headers: AUTH });
    expect(bad.statusCode).toBe(400);
  });

  it('requires bearer auth', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: '/api/diary' });
    expect(res.statusCode).toBe(401);
  });
});

describe('E8.3 diary HTTP generate', () => {
  it('persists the diary through Realm.write and it lands on disk', async () => {
    const { app, realm, realmId } = await setup();
    const res = await app.inject({ method: 'POST', url: '/api/diary/generate', headers: AUTH, payload: {} });
    expect(res.statusCode).toBe(201);
    const { generated } = await res.json();
    expect(generated).toEqual([
      { realmId, date: '2026-09-23', itemId: 'diary/2026-09-23.md' },
    ]);
    const back = await realm.read(realmId, 'diary/2026-09-23.md');
    expect(back.content).toContain('# Diary · 2026-09-23');
    expect(back.content).toContain('event:evt-1');
  });

  it('409s when no writable realm is connected', async () => {
    const memoryStore = new MemoryStore();
    memoryStore.append(event({ occurredAt: '2026-09-23T09:00:00.000Z', content: 'x' }));
    const app = await createHttpServer({
      registry: new VassalRegistry(),
      signer: new Ed25519MemorySigner('zeus-rsk-test'),
      internalToken: TOKEN,
      memoryStore,
    });
    const res = await app.inject({ method: 'POST', url: '/api/diary/generate', headers: AUTH, payload: {} });
    expect(res.statusCode).toBe(409);
  });

  it('400s when there are no memory events', async () => {
    root = await mkdtemp(join(tmpdir(), 'zeus-diary-empty-'));
    const realm = new FsRealmStore();
    await realm.connect(root, 'personal');
    const app = await createHttpServer({
      registry: new VassalRegistry(),
      signer: new Ed25519MemorySigner('zeus-rsk-test'),
      internalToken: TOKEN,
      memoryStore: new MemoryStore(),
      realmStore: realm,
    });
    const res = await app.inject({ method: 'POST', url: '/api/diary/generate', headers: AUTH, payload: {} });
    expect(res.statusCode).toBe(400);
  });
});
