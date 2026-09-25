import type { ConnectorCapabilities, McpClientDeps } from './types.js';

/**
 * Minimal MCP streamable-HTTP client (no SDK): JSON-RPC 2.0 over POST.
 * Responses may arrive as a single JSON body or as text/event-stream frames;
 * both are normalised. Used only for handshake and capability discovery —
 * Zeus never stays bound to an open connector channel.
 */

const JSONRPC = '2.0' as const;
const PROTOCOL_VERSION = '2025-03-26';

export class McpClientError extends Error {}

let requestCounter = 0;

interface RpcResponse {
  result?: unknown;
  error?: { code: number; message: string };
}

function parseSse(body: string): RpcResponse[] {
  const responses: RpcResponse[] = [];
  for (const frame of body.split(/\n\n+/)) {
    for (const line of frame.split('\n')) {
      if (line.startsWith('data:')) {
        try {
          responses.push(JSON.parse(line.slice(5).trim()) as RpcResponse);
        } catch {
          // ignore non-JSON keepalive/comment frames
        }
      }
    }
  }
  return responses;
}

export class McpClient {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private endpoint: string,
    deps: McpClientDeps = {},
  ) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.token = deps.token;
  }

  private token?: string;

  private async call(method: string, params?: unknown): Promise<unknown> {
    const id = ++requestCounter;
    const res = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: JSONRPC, id, method, params }),
    });
    if (!res.ok) throw new McpClientError(`MCP ${method} failed: HTTP ${res.status}`);

    const contentType = res.headers.get('content-type') ?? '';
    const body = await res.text();
    const responses = contentType.includes('text/event-stream')
      ? parseSse(body)
      : [JSON.parse(body) as RpcResponse];

    const match = responses.find(r => Object.prototype.hasOwnProperty.call(r, 'result') || r.error);
    if (match?.error) throw new McpClientError(`MCP ${method} error ${match.error.code}: ${match.error.message}`);
    return match?.result;
  }

  private async notify(method: string, params?: unknown): Promise<void> {
    const res = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: JSONRPC, method, params }),
    });
    // Notifications carry no id; 200 with empty body or 202 are both fine.
    if (res.status !== 200 && res.status !== 202 && res.status !== 204) {
      throw new McpClientError(`MCP notification ${method} failed: HTTP ${res.status}`);
    }
  }

  /** Full handshake and capability discovery; returns the summary. */
  async initialize(): Promise<ConnectorCapabilities> {
    await this.call('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'zeus', version: '0.1.0' },
    });
    await this.notify('notifications/initialized');

    const [tools, resources, prompts] = await Promise.all([
      this.safeList('tools/list'),
      this.safeList('resources/list'),
      this.safeList('prompts/list'),
    ]);
    return { tools, resources, prompts };
  }

  /** A capability the server does not implement simply lists empty. */
  private async safeList(method: string): Promise<string[]> {
    try {
      const result = (await this.call(method)) as { tools?: Array<{ name: string }>; resources?: Array<{ name?: string; uri: string }>; prompts?: Array<{ name: string }> };
      if (method === 'tools/list') return (result.tools ?? []).map(t => t.name);
      if (method === 'resources/list') return (result.resources ?? []).map(r => r.name ?? r.uri);
      return (result.prompts ?? []).map(p => p.name);
    } catch (error) {
      if (error instanceof McpClientError) return [];
      throw error;
    }
  }

  /**
   * Active work 47 §E-4: invoke one discovered tool. The caller (ConnectorRegistry)
   * is responsible for checking the name against the handshake's capability list;
   * this method is the wire call and nothing more.
   */
  async callTool(name: string, arguments_: Record<string, unknown> = {}): Promise<unknown> {
    return this.call('tools/call', { name, arguments: arguments_ });
  }
}
