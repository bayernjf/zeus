import type { ConnectorCapabilities, McpClientDeps } from './types.js';
import { guardedFetch } from '../util/outbound-dns.js';

/**
 * Minimal MCP streamable-HTTP client (no SDK): JSON-RPC 2.0 over POST.
 * Responses may arrive as a single JSON body or as text/event-stream frames;
 * both are normalised. Used only for handshake and capability discovery —
 * Zeus never stays bound to an open connector channel.
 */

const JSONRPC = '2.0' as const;
const PROTOCOL_VERSION = '2025-03-26';

// M-07: a peer that accepts a request but never answers must not hang the
// kernel forever; a peer must not be able to exhaust memory with one body.
const DEFAULT_CALL_TIMEOUT_SECONDS = 30;
const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

export class McpClientError extends Error {}

interface RpcResponse {
  id?: number | string;
  method?: string;
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
  private readonly callTimeoutSeconds: number;
  private readonly maxResponseBytes: number;
  private requestCounter = 0;
  private sessionId: string | undefined;

  constructor(
    private endpoint: string,
    deps: McpClientDeps = {},
  ) {
    this.fetchImpl = deps.fetchImpl ?? guardedFetch;
    this.callTimeoutSeconds = deps.callTimeoutSeconds ?? DEFAULT_CALL_TIMEOUT_SECONDS;
    this.maxResponseBytes = deps.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.token = deps.token;
  }

  private token: string | undefined;

  /**
   * One POST: session header (once the server issued one), an AbortSignal tied
   * to the per-call timeout, and a bounded body read covering the whole
   * exchange — headers arriving is not the end of the response.
   */
  private async post(method: string, payload: object): Promise<{ res: Response; body: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.callTimeoutSeconds * 1000);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      const res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
          // M-07: streamable-HTTP servers may bind the connection to a session
          // id issued on initialize; every later POST must echo it.
          ...(this.sessionId !== undefined ? { 'mcp-session-id': this.sessionId } : {}),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const body = await this.readBoundedBody(res);
      return { res, body };
    } catch (error) {
      if (controller.signal.aborted) {
        throw new McpClientError(`MCP ${method} timed out after ${this.callTimeoutSeconds} seconds`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async readBoundedBody(res: Response): Promise<string> {
    const reader = res.body?.getReader();
    if (!reader) return res.text();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > this.maxResponseBytes) {
        await reader.cancel().catch(() => {});
        throw new McpClientError(
          `MCP response body exceeded the ${this.maxResponseBytes}-byte limit (read ${total} bytes)`,
        );
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  private async call(method: string, params?: unknown, captureSession = false): Promise<unknown> {
    const id = ++this.requestCounter;
    const { res, body } = await this.post(method, { jsonrpc: JSONRPC, id, method, params });
    if (!res.ok) throw new McpClientError(`MCP ${method} failed: HTTP ${res.status}`);
    if (captureSession) {
      const issued = res.headers.get('mcp-session-id');
      if (issued) this.sessionId = issued;
    }

    const contentType = res.headers.get('content-type') ?? '';
    const responses = contentType.includes('text/event-stream')
      ? parseSse(body)
      : [JSON.parse(body) as RpcResponse];

    // A-08: correlate by JSON-RPC id. Matching on "the first frame carrying a
    // result" returned another call's payload whenever a server interleaved a
    // notification or a stale frame — a silent wrong answer, not an error. A
    // stream that never carries our id is a failure, not an empty result.
    const match = responses.find(r => r.id === id);
    if (!match) {
      throw new McpClientError(`MCP ${method} response did not match request id ${id} (${responses.length} frame(s) received)`);
    }
    if (match.error) throw new McpClientError(`MCP ${method} error ${match.error.code}: ${match.error.message}`);
    return match.result;
  }

  private async notify(method: string, params?: unknown): Promise<void> {
    const { res } = await this.post(method, { jsonrpc: JSONRPC, method, params });
    // Notifications carry no id; 200 with empty body or 202 are both fine.
    if (res.status !== 200 && res.status !== 202 && res.status !== 204) {
      throw new McpClientError(`MCP notification ${method} failed: HTTP ${res.status}`);
    }
  }

  /** Full handshake and capability discovery; returns the summary. */
  async initialize(): Promise<ConnectorCapabilities> {
    await this.call(
      'initialize',
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'zeus', version: '0.1.0' },
      },
      true,
    );
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
