import { describe, expect, it } from 'vitest';
import { ConnectorRegistry, ConnectorError, type ConnectorAuditEntry } from '../src/mcp/connectors.js';
import { McpClient } from '../src/mcp/client.js';
import type { ConnectorDeclaration } from '../src/mcp/types.js';

const ENDPOINT = 'https://mcp.example/mcp';
const now = () => new Date('2026-09-22T00:00:00.000Z');

function declaration(
  overrides: Omit<Partial<ConnectorDeclaration>, 'endpoint'> & { endpoint?: string | undefined } = {},
): ConnectorDeclaration {
  const { endpoint, ...rest } = overrides;
  const hasEndpoint = Object.prototype.hasOwnProperty.call(overrides, 'endpoint');
  return {
    id: 'knowledge',
    name: 'Knowledge Base',
    ...(hasEndpoint ? (endpoint !== undefined ? { endpoint } : {}) : { endpoint: ENDPOINT }),
    permissions: ['mcp'],
    ...rest,
  };
}

function mcpFetch(options: { sse?: boolean; fail?: boolean } = {}): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; id?: number };
    const json = (value: unknown): Response =>
      options.sse
        ? new Response(`data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: value })}\n\n`, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          })
        : new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: value }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });

    if (options.fail) return new Response('boom', { status: 500 });

    switch (body.method) {
      case 'initialize':
        return json({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'kb' } });
      case 'notifications/initialized':
        return new Response(null, { status: 202 });
      case 'tools/list':
        return json({ tools: [{ name: 'search' }, { name: 'danger' }] });
      case 'tools/call':
        return json({ content: [{ type: 'text', text: `called:${(body as { params?: { name?: string } }).params?.name}` }] });
      case 'resources/list':
        return json({ resources: [{ uri: 'res://a', name: 'docs' }] });
      case 'prompts/list':
        return json({ prompts: [{ name: 'brief' }] });
      default:
        return new Response('not found', { status: 404 });
    }
  }) as typeof fetch;
}

describe('E7 MCP connectors', () => {
  it('E7.2 declares a connector with a permission boundary', () => {
    const registry = new ConnectorRegistry(now);
    const record = registry.declare(declaration());
    expect(record.status).toBe('declared');
    expect(record.permissions).toEqual(['mcp']);
    expect(registry.list('declared')).toHaveLength(1);
  });

  it('rejects invalid declared permissions and duplicate declarations', () => {
    const registry = new ConnectorRegistry(now);
    expect(() => registry.declare(declaration({ permissions: ['root:all'] }))).toThrowError();
    registry.declare(declaration());
    expect(() => registry.declare(declaration())).toThrowError(ConnectorError);
  });

  it('E7.1 connects: MCP handshake discovers tools, resources and prompts', async () => {
    const registry = new ConnectorRegistry(now);
    registry.declare(declaration());
    const connected = await registry.connect('knowledge', mcpFetch());
    expect(connected.status).toBe('connected');
    expect(connected.capabilities).toEqual({
      tools: ['search', 'danger'],
      resources: ['docs'],
      prompts: ['brief'],
    });
  });

  it('also accepts SSE-framed JSON-RPC responses', async () => {
    const registry = new ConnectorRegistry(now);
    registry.declare(declaration());
    const connected = await registry.connect('knowledge', mcpFetch({ sse: true }));
    expect(connected.capabilities!.tools).toEqual(['search', 'danger']);
  });

  it('minimum privilege: tools outside the declared boundary are not exposed', async () => {
    const registry = new ConnectorRegistry(now);
    registry.declare(declaration({ permissions: ['mcp:search'] }));
    const connected = await registry.connect('knowledge', mcpFetch());
    expect(connected.capabilities!.tools).toEqual(['search']);
  });

  it('deferred #30: binds minimum privilege to upstream tool names verbatim (underscore/dot/capital)', async () => {
    const registry = new ConnectorRegistry(now);
    registry.declare(
      declaration({
        id: 'upstream',
        permissions: ['mcp:fetch_html', 'mcp:notion.search', 'mcp:Search'],
      }),
    );
    const upstreamFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string; id?: number };
      const json = (value: unknown): Response =>
        new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: value }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      switch (body.method) {
        case 'initialize':
          return json({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'up' } });
        case 'notifications/initialized':
          return new Response(null, { status: 202 });
        case 'tools/list':
          return json({
            tools: [{ name: 'fetch_html' }, { name: 'notion.search' }, { name: 'Search' }, { name: 'drop_table' }],
          });
        case 'resources/list':
          return json({ resources: [] });
        case 'prompts/list':
          return json({ prompts: [] });
        default:
          return new Response('not found', { status: 404 });
      }
    }) as typeof fetch;
    const connected = await registry.connect('upstream', upstreamFetch);
    expect(connected.capabilities!.tools).toEqual(['fetch_html', 'notion.search', 'Search']);
    await expect(registry.callTool('upstream', 'drop_table')).rejects.toThrowError(/does not expose tool/);
  });

  it('deferred #30: audits granted mcp tools the handshake did not discover (upstream rename is visible, not silent)', async () => {
    const audits: ConnectorAuditEntry[] = [];
    const registry = new ConnectorRegistry(now, entry => audits.push(entry));
    registry.declare(declaration({ permissions: ['mcp:search', 'mcp:fetch_html'] }));
    await registry.connect('knowledge', mcpFetch());
    const unmatched = audits.filter(a => a.action === 'boundary-unmatched');
    expect(unmatched).toHaveLength(1);
    expect(unmatched[0]!.detail).toContain('fetch_html');
    // The one that did match stays usable.
    const connected = registry.get('knowledge')!;
    expect(connected.capabilities!.tools).toEqual(['search']);
  });

  it('refuses connection when the server is unreachable and audits it', async () => {
    const audits: ConnectorAuditEntry[] = [];
    const registry = new ConnectorRegistry(now, entry => audits.push(entry));
    registry.declare(declaration());
    await expect(registry.connect('knowledge', mcpFetch({ fail: true }))).rejects.toThrow();
    expect(audits.some(a => a.action === 'refused')).toBe(true);
    expect(registry.get('knowledge')!.status).toBe('declared');
  });

  it('revokes immediately: a revoked connector drops out of active lookups', async () => {
    const registry = new ConnectorRegistry(now);
    registry.declare(declaration());
    await registry.connect('knowledge', mcpFetch());
    registry.revoke('knowledge');
    expect(registry.list('connected')).toEqual([]);
    await expect(registry.connect('knowledge')).rejects.toThrowError(/revoked/);
  });

  it('E7.4 (Active work 47) calls a discovered tool, bounded by the capability list', async () => {
    const registry = new ConnectorRegistry(now);
    registry.declare(declaration());
    await registry.connect('knowledge', mcpFetch());
    const result = await registry.callTool('knowledge', 'search', { q: 1 }, mcpFetch());
    expect(result).toEqual({ content: [{ type: 'text', text: 'called:search' }] });
  });

  it('refuses to call a tool the handshake never discovered (or the boundary dropped)', async () => {
    const registry = new ConnectorRegistry(now);
    registry.declare(declaration({ permissions: ['mcp:search'] }));
    await registry.connect('knowledge', mcpFetch());
    // 'danger' was advertised upstream but the declaration's boundary removed it.
    await expect(registry.callTool('knowledge', 'danger')).rejects.toThrowError(/does not expose tool 'danger'/);
    // 'unknown-tool' was never advertised at all.
    await expect(registry.callTool('knowledge', 'unknown-tool')).rejects.toThrowError(/does not expose tool/);
  });

  it('refuses tool calls on revoked or never-connected connectors', async () => {
    const registry = new ConnectorRegistry(now);
    registry.declare(declaration());
    // Never connected: no capability list to bound against.
    await expect(registry.callTool('knowledge', 'search')).rejects.toThrowError(/not connected/);

    await registry.connect('knowledge', mcpFetch());
    registry.revoke('knowledge');
    await expect(registry.callTool('knowledge', 'search')).rejects.toThrowError(/revoked/);
  });

  it('survives export/import', () => {
    const registry = new ConnectorRegistry(now);
    registry.declare(declaration());
    const restored = new ConnectorRegistry(now);
    restored.importState(registry.exportState());
    expect(restored.get('knowledge')!.endpoint).toBe(ENDPOINT);
  });

  it('declares a stdio connector (command, no endpoint) and records it', () => {
    const registry = new ConnectorRegistry(now);
    registry.declare(declaration({
      id: 'local-notes',
      name: 'Local notes',
      endpoint: undefined,
      command: 'node',
      args: ['dist/realm/mcp-stdio.js', '/tmp/notes'],
      env: { ZEUS_REALM_ROOTS: '/tmp/notes' },
      permissions: ['mcp:realm.search'],
    }));
    const record = registry.get('local-notes')!;
    expect(record.command).toBe('node');
    expect(record.endpoint).toBeUndefined();
    expect(record.args).toEqual(['dist/realm/mcp-stdio.js', '/tmp/notes']);
  });

  it('rejects a declaration with neither endpoint nor command', () => {
    const registry = new ConnectorRegistry(now);
    expect(() => registry.declare(declaration({ endpoint: undefined }))).toThrowError(/endpoint|command/);
  });
});

describe('A-08 MCP client response correlation', () => {
  it('fails loud when no frame carries the request id', async () => {
    const strayId: typeof fetch = (async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { id: number };
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: body.id + 100, result: { tools: [] } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    const client = new McpClient(ENDPOINT, { fetchImpl: strayId });
    await expect(client.initialize()).rejects.toThrowError(/request id/);
  });

  it('picks the frame whose id matches, ignoring an earlier stale result', async () => {
    const frames: typeof fetch = (async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { id: number };
      // A notification (no id) and a stale response precede the real one, which
      // is exactly the SSE shape the old "first frame with a result" lookup got
      // wrong.
      const sse = [
        `data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message' })}`,
        `data: ${JSON.stringify({ jsonrpc: '2.0', id: 999, result: { tools: [{ name: 'stale' }] } })}`,
        `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'fresh' }] } })}`,
      ].join('\n\n') + '\n\n';
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;
    const client = new McpClient(ENDPOINT, { fetchImpl: frames });
    const capabilities = await client.initialize();
    expect(capabilities.tools).toEqual(['fresh']);
  });
});

describe('A-09 connector minimum privilege is fail-closed', () => {
  it('bounds resources and prompts by the same declaration as tools', async () => {
    const registry = new ConnectorRegistry(now);
    registry.declare(declaration({ permissions: ['mcp:search'] }));
    const connected = await registry.connect('knowledge', mcpFetch());
    // The handshake advertises `docs` and `brief` as well; neither was granted,
    // so neither may cross the boundary. The bound used to stop at tools, which
    // left the whole resource and prompt surface exposed behind a one-tool grant.
    expect(connected.capabilities).toEqual({ tools: ['search'], resources: [], prompts: [] });

    // A bare `mcp` grant is the only thing that covers the discovered surface.
    const open = new ConnectorRegistry(now);
    open.declare(declaration());
    expect((await open.connect('knowledge', mcpFetch())).capabilities).toEqual({
      tools: ['search', 'danger'],
      resources: ['docs'],
      prompts: ['brief'],
    });
  });

  it('exposes no tool when the declaration grants no permission', async () => {
    const registry = new ConnectorRegistry(now);
    registry.declare(declaration({ permissions: [] }));
    const connected = await registry.connect('knowledge', mcpFetch());
    expect(connected.capabilities!.tools).toEqual([]);
    await expect(registry.callTool('knowledge', 'search')).rejects.toThrowError(/not granted|does not expose tool/);
  });

  it('re-narrows imported capabilities to the declared boundary', async () => {
    const registry = new ConnectorRegistry(now);
    registry.declare(declaration({ permissions: ['mcp:search'] }));
    const tampered = registry.exportState();
    tampered[0]!.status = 'connected';
    tampered[0]!.capabilities = {
      tools: ['search', 'danger', 'exfiltrate'],
      resources: ['docs', 'payroll'],
      prompts: ['brief', 'exfiltrate'],
    };

    registry.importState(tampered);

    expect(registry.get('knowledge')!.capabilities).toEqual({ tools: ['search'], resources: [], prompts: [] });
    await expect(registry.callTool('knowledge', 'danger')).rejects.toThrowError(/not granted|does not expose tool/);
  });
});

describe('E7 connector credentials do not cross into the persisted state', () => {
  it('keeps the bearer token in memory and out of every export', () => {
    const registry = new ConnectorRegistry(now);
    registry.declare(declaration({ token: 'upstream-credential' }));

    // The state file - and every backup bundle drawn from it - is plaintext, so
    // the token must not appear in the record that is written there.
    const exported = registry.exportState();
    expect(exported[0]).not.toHaveProperty('token');
    expect(JSON.stringify(exported)).not.toContain('upstream-credential');
    // It is still held where the outbound request needs it.
    expect(registry.get('knowledge')!.token).toBe('upstream-credential');

    // A restore brings the declaration back, not the credential.
    const restored = new ConnectorRegistry(now);
    restored.importState(registry.exportState());
    expect(restored.get('knowledge')).toMatchObject({ endpoint: ENDPOINT, permissions: ['mcp'] });
    expect(restored.get('knowledge')!.token).toBeUndefined();
  });
});
