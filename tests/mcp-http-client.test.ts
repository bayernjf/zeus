import { describe, expect, it } from 'vitest';
import { McpClient } from '../src/mcp/client.js';

const ENDPOINT = 'https://mcp.example/mcp';
const SESSION_ID = 'sess-123';

/**
 * A streamable-HTTP server that issues Mcp-Session-Id on initialize and
 * rejects every later request that does not echo it.
 */
function sessionServer(): { fetchImpl: typeof fetch; seen: string[] } {
  const seen: string[] = [];
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; id?: number };
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push(body.method);
    if (body.method !== 'initialize' && headers['mcp-session-id'] !== SESSION_ID) {
      return new Response('session required', { status: 400 });
    }
    const json = (value: unknown, extra: HeadersInit = {}): Response =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: value }), {
        status: 200,
        headers: { 'content-type': 'application/json', ...extra },
      });
    switch (body.method) {
      case 'initialize':
        return json(
          { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'kb' } },
          { 'mcp-session-id': SESSION_ID },
        );
      case 'notifications/initialized':
        return new Response(null, { status: 202, headers: { 'mcp-session-id': SESSION_ID } });
      case 'tools/list':
        return json({ tools: [{ name: 'search' }] });
      case 'resources/list':
        return json({ resources: [] });
      case 'prompts/list':
        return json({ prompts: [] });
      case 'tools/call':
        return json({ content: [{ type: 'text', text: 'ok' }] });
      default:
        return new Response('not found', { status: 404 });
    }
  }) as typeof fetch;
  return { fetchImpl, seen };
}

describe('McpClient (streamable HTTP)', () => {
  it('M-07: stores Mcp-Session-Id from initialize and echoes it on every later request', async () => {
    const { fetchImpl, seen } = sessionServer();
    const client = new McpClient(ENDPOINT, { fetchImpl });
    const capabilities = await client.initialize();
    expect(capabilities.tools).toEqual(['search']);
    expect(seen.slice(0, 5)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/list',
      'resources/list',
      'prompts/list',
    ]);
    // A session-requiring server 400s any later POST that does not echo the id.
    await client.callTool('search', {});
    expect(seen.at(-1)).toBe('tools/call');
  });

  it('M-07: aborts a hung request when the per-call timeout elapses', async () => {
    let signal: AbortSignal | null | undefined;
    const hang = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        signal = init?.signal;
        // Mimic undici: aborting the signal rejects the in-flight fetch so the
        // socket is actually released, not just abandoned.
        init?.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      })) as typeof fetch;
    const client = new McpClient(ENDPOINT, { fetchImpl: hang, callTimeoutSeconds: 0.02 });
    await expect(client.callTool('search')).rejects.toThrow(/timed out/);
    expect(signal?.aborted).toBe(true);
  });

  it('M-07: rejects a response body larger than the byte ceiling', async () => {
    const fetchImpl = (async () =>
      new Response('x'.repeat(2048), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const client = new McpClient(ENDPOINT, { fetchImpl, maxResponseBytes: 1024 });
    await expect(client.initialize()).rejects.toThrow(/byte/);
  });
});
