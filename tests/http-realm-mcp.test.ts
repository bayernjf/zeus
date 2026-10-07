import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHttpServer } from '../src/http/server.js';
import { VassalRegistry } from '../src/registry/registry.js';
import { Ed25519MemorySigner } from '../src/registry/signing.js';
import { FsRealmStore } from '../src/realm/store.js';

let app: FastifyInstance | undefined;
let sandbox: string | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  if (sandbox) {
    rmSync(sandbox, { recursive: true, force: true });
    sandbox = undefined;
  }
});

async function mount(withMcp: boolean): Promise<FastifyInstance> {
  const store = new FsRealmStore();
  sandbox = mkdtempSync(join(tmpdir(), 'zeus-http-mcp-'));
  const root = join(sandbox, 'realm');
  mkdirSync(join(root, 'notes'), { recursive: true });
  writeFileSync(join(root, 'notes', 'diary.md'), '# Diary\nhello world secret zeus\n');
  writeFileSync(join(root, 'notes', 'todo.txt'), 'buy milk\n');
  const manifest = await store.connect(root, 'personal', { readOnly: true });
  app = await createHttpServer({
    registry: new VassalRegistry(),
    signer: new Ed25519MemorySigner('zeus-rsk-2026-09'),
    internalToken: 'driver-secret',
    realmStore: store,
    ...(withMcp ? { realmMcp: { realmIds: [manifest.realmId] } } : {}),
  });
  return app;
}

function rpc(id: number | string, method: string, params?: unknown) {
  return { jsonrpc: '2.0' as const, id, method, ...(params ? { params } : {}) };
}

const TOKEN = { authorization: 'Bearer driver-secret' };

describe('Realm MCP streamable HTTP exposure (E3.4 transport, design-realm §6.5)', () => {
  it('does not mount /mcp when realmMcp is not configured (default unchanged)', async () => {
    const server = await mount(false);
    const get = await server.inject({ method: 'GET', url: '/mcp' });
    const post = await server.inject({ method: 'POST', url: '/mcp', headers: TOKEN, payload: rpc(1, 'initialize') });
    expect(get.statusCode).toBe(404);
    expect(post.statusCode).toBe(404);
  });

  it('serves public server metadata on GET with no realm data', async () => {
    const server = await mount(true);
    const res = await server.inject({ method: 'GET', url: '/mcp' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.protocolVersion).toBe('2025-06-18');
    expect(body.serverInfo.name).toBe('zeus-realm');
    // No mount state: realmIds, realm URIs or absolute roots must never appear.
    expect(JSON.stringify(body)).not.toMatch(/realmId|zeus-realm:|\/Users\/|\/tmp\//i);
  });

  it('rejects JSON-RPC without the bearer token (RFC 6750 challenge)', async () => {
    const server = await mount(true);
    const res = await server.inject({ method: 'POST', url: '/mcp', payload: rpc(1, 'initialize') });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toContain('Bearer');
  });

  it('completes an initialize handshake and negotiates the protocol version', async () => {
    const server = await mount(true);
    const res = await server.inject({
      method: 'POST',
      url: '/mcp',
      headers: TOKEN,
      payload: rpc(1, 'initialize', { protocolVersion: '2025-03-26' }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.result.protocolVersion).toBe('2025-03-26');
    expect(body.result.capabilities.resources).toBeDefined();
    expect(body.result.capabilities.tools).toBeDefined();
  });

  it('surfaces the session-scoped actor name in serverInfo when the header is present', async () => {
    const server = await mount(true);
    const res = await server.inject({
      method: 'POST',
      url: '/mcp',
      headers: { ...TOKEN, 'x-zeus-realm-actor': 'loom' },
      payload: rpc(1, 'initialize'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().result.serverInfo.actor).toBe('loom');
  });

  it('stays anonymous in serverInfo when no actor header is sent', async () => {
    const server = await mount(true);
    const res = await server.inject({ method: 'POST', url: '/mcp', headers: TOKEN, payload: rpc(1, 'initialize') });
    expect(res.json().result.serverInfo.actor).toBeUndefined();
  });

  it('lists only the host pre-connected realmIds and never the absolute root', async () => {
    const server = await mount(true);
    const res = await server.inject({
      method: 'POST',
      url: '/mcp',
      headers: TOKEN,
      payload: rpc(2, 'resources/list'),
    });
    expect(res.statusCode).toBe(200);
    const resources = res.json().result.resources;
    expect(resources.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(resources);
    expect(serialized).not.toContain(sandbox!);
    expect(serialized).not.toMatch(/^\s*\/[A-Za-z]:|\/Users\/|\/tmp\//m);
  });

  it('refuses a tool call aimed at a realm outside the whitelist with a realm error', async () => {
    const server = await mount(true);
    const res = await server.inject({
      method: 'POST',
      url: '/mcp',
      headers: TOKEN,
      payload: rpc(3, 'tools/call', { name: 'realm.read', arguments: { realmId: 'not-mounted', itemId: 'notes/diary.md' } }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe(-32002);
  });

  it('reads an item through the tool when realmId is in the whitelist', async () => {
    const server = await mount(true);
    // Learn the real realmId from resources/list (uri shape: zeus-realm://<realmId>/…).
    const list = await server.inject({ method: 'POST', url: '/mcp', headers: TOKEN, payload: rpc(4, 'resources/list') });
    const realmId = list.json().result.resources[0].uri.replace(`${'zeus-realm'}://`, '').split('/')[0];
    const res = await server.inject({
      method: 'POST',
      url: '/mcp',
      headers: TOKEN,
      payload: rpc(5, 'tools/call', { name: 'realm.read', arguments: { realmId, itemId: 'notes/todo.txt' } }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.error).toBeUndefined();
    expect(JSON.stringify(body.result)).toContain('buy milk');
    expect(JSON.stringify(body.result)).not.toContain(sandbox!);
  });

  it('answers method-not-found for unknown methods without leaking internals', async () => {
    const server = await mount(true);
    const res = await server.inject({
      method: 'POST',
      url: '/mcp',
      headers: TOKEN,
      payload: rpc(6, 'system/reboot'),
    });
    const body = res.json();
    expect(body.error.code).toBe(-32601);
    expect(body.error.message).toContain('method not found');
  });

  it('rejects a malformed JSON body with 400 instead of a parse crash', async () => {
    const server = await mount(true);
    const res = await server.inject({
      method: 'POST',
      url: '/mcp',
      headers: { ...TOKEN, 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(res.statusCode).toBe(400);
  });
});
