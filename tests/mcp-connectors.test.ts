import { describe, expect, it } from 'vitest';
import { ConnectorRegistry, ConnectorError, type ConnectorAuditEntry } from '../src/mcp/connectors.js';
import type { ConnectorDeclaration } from '../src/mcp/types.js';

const ENDPOINT = 'https://mcp.example/mcp';
const now = () => new Date('2026-09-22T00:00:00.000Z');

function declaration(overrides: Partial<ConnectorDeclaration> = {}): ConnectorDeclaration {
  return {
    id: 'knowledge',
    name: 'Knowledge Base',
    endpoint: ENDPOINT,
    permissions: ['mcp'],
    ...overrides,
  };
}

function mcpFetch(options: { sse?: boolean; fail?: boolean } = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
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
});
