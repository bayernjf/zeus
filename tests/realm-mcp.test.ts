import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsRealmStore } from '../src/realm/store.js';
import {
  createRealmMcpHandler,
  JSON_RPC_CODES,
  SUPPORTED_PROTOCOL_VERSIONS,
  type JsonRpcResponse,
} from '../src/realm/mcp.js';

type Handle = (message: unknown) => Promise<JsonRpcResponse | null>;

function rpc(id: number | string, method: string, params?: unknown) {
  return { jsonrpc: '2.0' as const, id, method, ...(params ? { params } : {}) };
}
function notify(method: string) {
  return { jsonrpc: '2.0' as const, method };
}

describe('Realm MCP stdio surface (read-only scaffold)', () => {
  let sandbox: string;
  let root: string;
  let store: FsRealmStore;
  let realmId: string;
  let handle: Handle;

  beforeEach(async () => {
    sandbox = mkdtempSync(join(tmpdir(), 'zeus-realm-mcp-'));
    root = join(sandbox, 'realm');
    mkdirSync(join(root, 'notes'), { recursive: true });
    writeFileSync(join(root, 'notes', 'diary.md'), '# Diary\nhello world secret zeus\n');
    writeFileSync(join(root, 'notes', 'todo.txt'), 'buy milk\n');
    writeFileSync(join(root, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(join(sandbox, 'outside.md'), 'outside secret\n');
    symlinkSync('../outside.md', join(root, 'link.md'));

    store = new FsRealmStore();
    const manifest = await store.connect(root, 'personal', { readOnly: true });
    realmId = manifest.realmId;
    handle = createRealmMcpHandler({ store, realmIds: [realmId] });
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('initialize negotiates protocol version and advertises resources only (no tools)', async () => {
    const res = await handle(rpc(1, 'initialize', { protocolVersion: '2024-11-05' }));
    expect(res?.error).toBeUndefined();
    const result = res!.result as { protocolVersion: string; capabilities: { resources?: unknown; tools?: unknown }; serverInfo: unknown };
    expect(result.protocolVersion).toBe('2024-11-05');
    expect(result.capabilities.resources).toBeDefined();
    expect(result.capabilities.tools).toBeUndefined();
    expect(result.serverInfo).toEqual({ name: 'zeus-realm', version: '0.1.0' });

    // Unknown client version -> server proposes its newest supported version.
    const fallback = await handle(rpc(2, 'initialize', { protocolVersion: '1999-01-01' }));
    expect((fallback!.result as { protocolVersion: string }).protocolVersion).toBe(SUPPORTED_PROTOCOL_VERSIONS[0]);
  });

  it('notifications (no id) produce no response', async () => {
    expect(await handle(notify('notifications/initialized'))).toBeNull();
    expect(await handle(notify('notifications/cancelled'))).toBeNull();
  });

  it('resources/list exposes manifest + search per connected realm, never absolute paths', async () => {
    const res = await handle(rpc(1, 'resources/list'));
    const resources = (res!.result as { resources: Array<{ uri: string; name: string; mimeType: string }> }).resources;
    expect(resources.map(r => r.uri).sort()).toEqual(
      [`zeus-realm://${realmId}/manifest`, `zeus-realm://${realmId}/search`].sort()
    );
    expect(JSON.stringify(res)).not.toContain(root);
    expect(JSON.stringify(res)).not.toContain(realpathSync(root));
  });

  it('resources/templates/list advertises manifest/search/item templates', async () => {
    const res = await handle(rpc(1, 'resources/templates/list'));
    const templates = (res!.result as { resourceTemplates: Array<{ uriTemplate: string }> }).resourceTemplates;
    expect(templates).toHaveLength(3);
    expect(templates.map(t => t.uriTemplate)).toEqual(
      expect.arrayContaining([
        'zeus-realm://{realmId}/manifest',
        expect.stringContaining('zeus-realm://{realmId}/search'),
        'zeus-realm://{realmId}/item?path={path}',
      ])
    );
  });

  it('reads manifest with the absolute root stripped', async () => {
    const res = await handle(rpc(1, 'resources/read', { uri: `zeus-realm://${realmId}/manifest` }));
    const text = (res!.result as { contents: Array<{ text: string }> }).contents[0].text;
    const manifest = JSON.parse(text);
    expect(manifest.realmId).toBe(realmId);
    expect(manifest.root).toBeUndefined();
    expect(manifest.itemCount).toBe(2);
    expect(manifest.contentDigest).toMatch(/^[0-9a-f]{64}$/);
    // Whole-response non-disclosure.
    expect(text).not.toContain(root);
    expect(text).not.toContain(realpathSync(root));
  });

  it('searches items by text and returns root-relative hits only', async () => {
    const res = await handle(
      rpc(1, 'resources/read', { uri: `zeus-realm://${realmId}/search?text=secret%20zeus&limit=5` })
    );
    const text = (res!.result as { contents: Array<{ text: string }> }).contents[0].text;
    const hits = JSON.parse(text) as Array<{ itemId: string; snippet: string }>;
    expect(hits).toHaveLength(1);
    expect(hits[0].itemId).toBe('notes/diary.md');
    expect(text).not.toContain(root);
    expect(text).not.toContain(realpathSync(root));
  });

  it('reads a single item by root-relative path', async () => {
    const res = await handle(
      rpc(1, 'resources/read', { uri: `zeus-realm://${realmId}/item?path=notes%2Fdiary.md` })
    );
    const text = (res!.result as { contents: Array<{ text: string }> }).contents[0].text;
    expect(text).toContain('hello world');
    expect(text).not.toContain(root);
  });

  it('blocks path traversal itemIds with an application error (no root in message)', async () => {
    const res = await handle(
      rpc(1, 'resources/read', { uri: `zeus-realm://${realmId}/item?path=..%2Foutside.md` })
    );
    expect(res?.error).toBeDefined();
    expect(res!.error!.code).toBe(JSON_RPC_CODES.INVALID_ITEM);
    expect(JSON.stringify(res)).not.toContain(root);
    expect(JSON.stringify(res)).not.toContain(realpathSync(root));
  });

  it('rejects an unknown realm id as not-connected', async () => {
    const res = await handle(rpc(1, 'resources/read', { uri: 'zeus-realm://realm-doesnotexist/manifest' }));
    expect(res!.error!.code).toBe(JSON_RPC_CODES.REALM_NOT_CONNECTED);
  });

  it('rejects bad scheme, missing params, and non-numeric limit', async () => {
    const badScheme = await handle(rpc(1, 'resources/read', { uri: `http://${realmId}/manifest` }));
    expect(badScheme!.error!.code).toBe(JSON_RPC_CODES.INVALID_PARAMS);

    const noUri = await handle(rpc(2, 'resources/read', {}));
    expect(noUri!.error!.code).toBe(JSON_RPC_CODES.INVALID_PARAMS);

    const itemWithoutPath = await handle(rpc(3, 'resources/read', { uri: `zeus-realm://${realmId}/item` }));
    expect(itemWithoutPath!.error!.code).toBe(JSON_RPC_CODES.INVALID_PARAMS);

    const badLimit = await handle(rpc(4, 'resources/read', { uri: `zeus-realm://${realmId}/search?limit=abc` }));
    expect(badLimit!.error!.code).toBe(JSON_RPC_CODES.INVALID_PARAMS);
  });

  it('returns method-not-found for unknown methods and invalid-request for malformed messages', async () => {
    const unknown = await handle(rpc(1, 'tools/list')); // read-only server exposes no tools
    expect(unknown!.error!.code).toBe(JSON_RPC_CODES.METHOD_NOT_FOUND);

    const noMethod = await handle({ jsonrpc: '2.0', id: 2 });
    expect(noMethod!.error!.code).toBe(JSON_RPC_CODES.INVALID_REQUEST);

    const notObject = await handle('nope');
    expect(notObject!.id).toBeNull();
    expect(notObject!.error!.code).toBe(JSON_RPC_CODES.INVALID_REQUEST);
  });

  it('ping returns an empty result', async () => {
    const res = await handle(rpc(1, 'ping'));
    expect(res!.result).toEqual({});
  });
});
