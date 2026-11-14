import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsDataDomainStore } from '../src/dataDomain/store.js';
import {
  createDataDomainMcpHandler,
  JSON_RPC_CODES,
  SUPPORTED_PROTOCOL_VERSIONS,
  type JsonRpcResponse,
} from '../src/dataDomain/mcp.js';
import type { DataDomainStore } from '../src/dataDomain/types.js';

type Handle = (message: unknown) => Promise<JsonRpcResponse | null>;

function rpc(id: number | string, method: string, params?: unknown) {
  return { jsonrpc: '2.0' as const, id, method, ...(params ? { params } : {}) };
}
function notify(method: string) {
  return { jsonrpc: '2.0' as const, method };
}

describe('DataDomain MCP stdio surface (read tools + grant-gated write)', () => {
  let sandbox: string;
  let root: string;
  let store: FsDataDomainStore;
  let dataDomainId: string;
  let handle: Handle;

  beforeEach(async () => {
    sandbox = mkdtempSync(join(tmpdir(), 'zeus-dataDomain-mcp-'));
    root = join(sandbox, 'dataDomain');
    mkdirSync(join(root, 'notes'), { recursive: true });
    writeFileSync(join(root, 'notes', 'diary.md'), '# Diary\nhello world secret zeus\n');
    writeFileSync(join(root, 'notes', 'todo.txt'), 'buy milk\n');
    writeFileSync(join(root, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(join(sandbox, 'outside.md'), 'outside secret\n');
    // Windows denies symlink creation without admin rights / Developer Mode;
    // link.md only feeds the skip-list boundary, which dataDomain.test.ts asserts.
    try {
      symlinkSync('../outside.md', join(root, 'link.md'));
    } catch {
      /* symlinks unavailable on this host */
    }

    store = new FsDataDomainStore();
    const manifest = await store.connect(root, 'personal', { readOnly: true });
    dataDomainId = manifest.dataDomainId;
    handle = createDataDomainMcpHandler({ store, dataDomainIds: [dataDomainId] });
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('initialize negotiates protocol version and advertises resources + the dataDomain tools', async () => {
    const res = await handle(rpc(1, 'initialize', { protocolVersion: '2024-11-05' }));
    expect(res?.error).toBeUndefined();
    const result = res!.result as { protocolVersion: string; capabilities: { resources?: unknown; tools?: unknown }; serverInfo: unknown };
    expect(result.protocolVersion).toBe('2024-11-05');
    expect(result.capabilities.resources).toBeDefined();
    expect(result.capabilities.tools).toEqual({ listChanged: false });
    expect(result.serverInfo).toEqual({ name: 'zeus-dataDomain', version: '0.1.0' });

    // Unknown client version -> server proposes its newest supported version.
    const fallback = await handle(rpc(2, 'initialize', { protocolVersion: '1999-01-01' }));
    expect((fallback!.result as { protocolVersion: string }).protocolVersion).toBe(SUPPORTED_PROTOCOL_VERSIONS[0]);
  });

  it('notifications (no id) produce no response', async () => {
    expect(await handle(notify('notifications/initialized'))).toBeNull();
    expect(await handle(notify('notifications/cancelled'))).toBeNull();
  });

  it('resources/list exposes manifest + search per connected dataDomain, never absolute paths', async () => {
    const res = await handle(rpc(1, 'resources/list'));
    const resources = (res!.result as { resources: Array<{ uri: string; name: string; mimeType: string }> }).resources;
    expect(resources.map(r => r.uri).sort()).toEqual(
      [`zeus-data-domain://${dataDomainId}/manifest`, `zeus-data-domain://${dataDomainId}/search`].sort()
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
        'zeus-data-domain://{dataDomainId}/manifest',
        expect.stringContaining('zeus-data-domain://{dataDomainId}/search'),
        'zeus-data-domain://{dataDomainId}/item?path={path}',
      ])
    );
  });

  it('reads manifest with the absolute root stripped', async () => {
    const res = await handle(rpc(1, 'resources/read', { uri: `zeus-data-domain://${dataDomainId}/manifest` }));
    const text = (res!.result as { contents: Array<{ text: string }> }).contents[0]!.text;
    const manifest = JSON.parse(text);
    expect(manifest.dataDomainId).toBe(dataDomainId);
    expect(manifest.root).toBeUndefined();
    expect(manifest.itemCount).toBe(2);
    expect(manifest.contentDigest).toMatch(/^[0-9a-f]{64}$/);
    // Whole-response non-disclosure.
    expect(text).not.toContain(root);
    expect(text).not.toContain(realpathSync(root));
  });

  it('searches items by text and returns root-relative hits only', async () => {
    const res = await handle(
      rpc(1, 'resources/read', { uri: `zeus-data-domain://${dataDomainId}/search?text=secret%20zeus&limit=5` })
    );
    const text = (res!.result as { contents: Array<{ text: string }> }).contents[0]!.text;
    const hits = JSON.parse(text) as Array<{ itemId: string; snippet: string }>;
    expect(hits).toHaveLength(1);
    expect(hits[0]!.itemId).toBe('notes/diary.md');
    expect(text).not.toContain(root);
    expect(text).not.toContain(realpathSync(root));
  });

  it('reads a single item by root-relative path', async () => {
    const res = await handle(
      rpc(1, 'resources/read', { uri: `zeus-data-domain://${dataDomainId}/item?path=notes%2Fdiary.md` })
    );
    const text = (res!.result as { contents: Array<{ text: string }> }).contents[0]!.text;
    expect(text).toContain('hello world');
    expect(text).not.toContain(root);
  });

  it('blocks path traversal itemIds with an application error (no root in message)', async () => {
    const res = await handle(
      rpc(1, 'resources/read', { uri: `zeus-data-domain://${dataDomainId}/item?path=..%2Foutside.md` })
    );
    expect(res?.error).toBeDefined();
    expect(res!.error!.code).toBe(JSON_RPC_CODES.INVALID_ITEM);
    expect(JSON.stringify(res)).not.toContain(root);
    expect(JSON.stringify(res)).not.toContain(realpathSync(root));
  });

  it('rejects an unknown dataDomain id as not-connected', async () => {
    const res = await handle(rpc(1, 'resources/read', { uri: 'zeus-data-domain://dataDomain-doesnotexist/manifest' }));
    expect(res!.error!.code).toBe(JSON_RPC_CODES.DATA_DOMAIN_NOT_CONNECTED);
  });

  it('rejects bad scheme, missing params, and non-numeric limit', async () => {
    const badScheme = await handle(rpc(1, 'resources/read', { uri: `http://${dataDomainId}/manifest` }));
    expect(badScheme!.error!.code).toBe(JSON_RPC_CODES.INVALID_PARAMS);

    const noUri = await handle(rpc(2, 'resources/read', {}));
    expect(noUri!.error!.code).toBe(JSON_RPC_CODES.INVALID_PARAMS);

    const itemWithoutPath = await handle(rpc(3, 'resources/read', { uri: `zeus-data-domain://${dataDomainId}/item` }));
    expect(itemWithoutPath!.error!.code).toBe(JSON_RPC_CODES.INVALID_PARAMS);

    const badLimit = await handle(rpc(4, 'resources/read', { uri: `zeus-data-domain://${dataDomainId}/search?limit=abc` }));
    expect(badLimit!.error!.code).toBe(JSON_RPC_CODES.INVALID_PARAMS);
  });

  it('fails loud on search params the P0 backend drops or never declared (deferred #31)', async () => {
    // tags is forwarded to the store, which rejects tag search explicitly rather
    // than silently returning the unfiltered full result set.
    const tags = await handle(rpc(1, 'resources/read', { uri: `zeus-data-domain://${dataDomainId}/search?tags=important` }));
    expect(tags!.error!.code).toBe(JSON_RPC_CODES.INVALID_PARAMS);
    expect(tags!.error!.message).toMatch(/tag/i);

    // A parameter the resource template never declared is refused by name.
    const unknown = await handle(rpc(2, 'resources/read', { uri: `zeus-data-domain://${dataDomainId}/search?bogus=1` }));
    expect(unknown!.error!.code).toBe(JSON_RPC_CODES.INVALID_PARAMS);
    expect(unknown!.error!.message).toMatch(/unsupported search parameter: bogus/);

    // Declared params still work, proving the gate rejects by name not wholesale.
    const ok = await handle(rpc(3, 'resources/read', { uri: `zeus-data-domain://${dataDomainId}/search?text=secret&limit=2` }));
    expect(ok?.error).toBeUndefined();
  });

  it('returns method-not-found for unknown methods and invalid-request for malformed messages', async () => {
    const unknown = await handle(rpc(1, 'prompts/list')); // read-only server exposes no prompts
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

  it('tools/list exposes dataDomain.search, dataDomain.read and dataDomain.write with schemas', async () => {
    const res = await handle(rpc(1, 'tools/list'));
    expect(res?.error).toBeUndefined();
    const tools = (res!.result as { tools: Array<{ name: string; inputSchema: { required?: string[] } }> }).tools;
    // dataDomain.write joined the list with E3.4's remaining write step (Active work
    // 238); its grant boundary is pinned in tests/dataDomain-mcp-write.test.ts.
    // The read-only runtime face (zeus.skills/plan/status, design P1-1) joins the
    // same list; its fail-closed contract is pinned in tests/personal-mcp-runtime.test.ts.
    expect(tools.map(tool => tool.name).sort()).toEqual([
      'dataDomain.read',
      'dataDomain.search',
      'dataDomain.write',
      'zeus.plan',
      'zeus.skills',
      'zeus.status',
    ]);
    const read = tools.find(tool => tool.name === 'dataDomain.read')!;
    expect(read.inputSchema.required).toContain('dataDomainId');
    expect(read.inputSchema.required).toContain('itemId');
  });

  it('tools/call searches and reads only whitelisted dataDomains, never absolute paths', async () => {
    const search = await handle(rpc(1, 'tools/call', { name: 'dataDomain.search', arguments: { dataDomainId, text: 'hello' } }));
    expect(search?.error).toBeUndefined();
    const text = (search!.result as { content: Array<{ type: string; text: string }> }).content[0]!.text;
    expect(JSON.parse(text).length).toBeGreaterThan(0);
    expect(text).not.toContain(root);
    expect(text).not.toContain(realpathSync(root));

    const read = await handle(rpc(2, 'tools/call', { name: 'dataDomain.read', arguments: { dataDomainId, itemId: 'notes/diary.md' } }));
    expect(read?.error).toBeUndefined();
    expect((read!.result as { content: Array<{ type: string; text: string }> }).content[0]!.text).toContain('secret zeus');
  });

  it('tools/call refuses unknown tools, non-whitelisted dataDomains, and malformed arguments', async () => {
    // A name that is not declared at all. It used to be dataDomain.write, back when
    // the face had no write tool; that name is now real (E3.4 remaining 1), so
    // sampling it here would assert nothing.
    const unknownTool = await handle(rpc(1, 'tools/call', { name: 'dataDomain.rename', arguments: {} }));
    expect(unknownTool!.error!.code).toBe(JSON_RPC_CODES.INVALID_PARAMS);
    expect(unknownTool!.error!.message).toMatch(/unknown tool/);

    const outside = await handle(rpc(2, 'tools/call', { name: 'dataDomain.search', arguments: { dataDomainId: 'not-connected' } }));
    expect(outside!.error!.code).toBe(JSON_RPC_CODES.DATA_DOMAIN_NOT_CONNECTED);

    const noArgs = await handle(rpc(3, 'tools/call', { name: 'dataDomain.search' }));
    expect(noArgs!.error!.code).toBe(JSON_RPC_CODES.INVALID_PARAMS);

    const noItem = await handle(rpc(4, 'tools/call', { name: 'dataDomain.read', arguments: { dataDomainId } }));
    expect(noItem!.error!.code).toBe(JSON_RPC_CODES.INVALID_PARAMS);
  });

  it('tools/call fails loud on tag search and undeclared arguments (deferred #31)', async () => {
    const tags = await handle(
      rpc(1, 'tools/call', { name: 'dataDomain.search', arguments: { dataDomainId, tags: 'important' } }),
    );
    expect(tags!.error!.code).toBe(JSON_RPC_CODES.INVALID_PARAMS);
    expect(tags!.error!.message).toMatch(/tag/i);

    const bogus = await handle(
      rpc(2, 'tools/call', { name: 'dataDomain.search', arguments: { dataDomainId, bogus: 1 } }),
    );
    expect(bogus!.error!.code).toBe(JSON_RPC_CODES.INVALID_PARAMS);
    expect(bogus!.error!.message).toMatch(/unsupported search parameter: bogus/);

    const badTags = await handle(
      rpc(3, 'tools/call', { name: 'dataDomain.search', arguments: { dataDomainId, tags: 123 } }),
    );
    expect(badTags!.error!.code).toBe(JSON_RPC_CODES.INVALID_PARAMS);
  });
});

describe('DataDomain MCP unexpected store errors (m-15 path non-disclosure)', () => {
  // A backend failure (EACCES/EIO/...) carries the dataDomain-local absolute root in
  // its raw message. The JSON-RPC surface must answer with a fixed generic
  // message: the path non-disclosure invariant holds for failures too.
  function throwingStore(root: string): DataDomainStore {
    const boom: () => Promise<never> = () =>
      Promise.reject(new Error(`EACCES: permission denied, open '${root}/notes/diary.md'`));
    return {
      connect: boom,
      manifest: boom,
      search: boom,
      read: boom,
      connections: () => [],
      disconnect: boom,
      retargetTenant: boom,
      entries: boom,
    };
  }

  it('maps an unexpected error to a generic DATA_DOMAIN_ERROR message without the absolute root', async () => {
    const root = '/srv/zeus/dataDomains/personal-secret-root';
    const handle = createDataDomainMcpHandler({ store: throwingStore(root), dataDomainIds: ['personal'] });
    const calls = [
      rpc(1, 'tools/call', { name: 'dataDomain.read', arguments: { dataDomainId: 'personal', itemId: 'notes/diary.md' } }),
      rpc(2, 'tools/call', { name: 'dataDomain.search', arguments: { dataDomainId: 'personal' } }),
    ];
    for (const call of calls) {
      const res = await handle(call);
      expect(res?.error).toBeDefined();
      expect(res!.error!.code).toBe(JSON_RPC_CODES.DATA_DOMAIN_ERROR);
      expect(res!.error!.message).toBe('dataDomain error');
      expect(JSON.stringify(res)).not.toContain(root);
    }
  });
});
