import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { ConnectorCapabilities } from './types.js';

/**
 * Minimal MCP stdio client (no SDK): newline-delimited JSON-RPC 2.0 over a
 * spawned subprocess. Used for local-first MCP servers that expose no HTTP
 * face (work-learn stdio, Zeus's own dist/realm/mcp-stdio.js).
 *
 * One process is spawned per client and terminated on close(); matching the
 * HTTP client, Zeus never stays bound to an open connector channel beyond the
 * handshake/call it needs.
 */

const JSONRPC = '2.0' as const;
const PROTOCOL_VERSION = '2025-03-26';

export class McpStdioError extends Error {}

export interface StdioSpawnOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Injection seam for tests; defaults to node:child_process spawn. */
  spawnImpl?: typeof spawn;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

let requestCounter = 0;

export class McpStdioClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly pending = new Map<number, Pending>();
  private startError: Error | null = null;

  constructor(private readonly options: StdioSpawnOptions) {}

  private start(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const spawnImpl = this.options.spawnImpl ?? spawn;
    const child = spawnImpl(this.options.command, this.options.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(this.options.env ?? {}) },
    });
    this.child = child;

    const rl = createInterface({ input: child.stdout });
    rl.on('line', line => {
      if (!line.trim()) return;
      let message: { id?: number; result?: unknown; error?: { code: number; message: string } };
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (typeof message.id !== 'number') return;
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new McpStdioError(`MCP error ${message.error.code}: ${message.error.message}`));
      else waiter.resolve(message.result);
    });

    child.on('error', error => {
      this.startError = error;
      for (const { reject } of this.pending.values()) reject(error);
      this.pending.clear();
    });
    child.stderr.on('data', () => {
      // Diagnostics only; stdout is the sole JSON-RPC channel.
    });
    child.on('exit', code => {
      const error = this.startError ?? new McpStdioError(`stdio MCP process exited early (code ${code})`);
      for (const { reject } of this.pending.values()) reject(error);
      this.pending.clear();
      this.child = undefined;
    });
    return child;
  }

  private call(method: string, params?: unknown): Promise<unknown> {
    const child = this.start();
    if (this.startError) return Promise.reject(this.startError);
    const id = ++requestCounter;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: JSONRPC, id, method, params })}\n`);
    });
  }

  private notify(method: string, params?: unknown): void {
    const child = this.start();
    child.stdin.write(`${JSON.stringify({ jsonrpc: JSONRPC, method, params })}\n`);
  }

  async initialize(): Promise<ConnectorCapabilities> {
    await this.call('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'zeus', version: '0.1.0' },
    });
    this.notify('notifications/initialized');
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
      const result = (await this.call(method)) as {
        tools?: Array<{ name: string }>;
        resources?: Array<{ name?: string; uri: string }>;
        prompts?: Array<{ name: string }>;
      };
      if (method === 'tools/list') return (result.tools ?? []).map(t => t.name);
      if (method === 'resources/list') return (result.resources ?? []).map(r => r.name ?? r.uri);
      return (result.prompts ?? []).map(p => p.name);
    } catch (error) {
      if (error instanceof McpStdioError) return [];
      throw error;
    }
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const result = await this.call('tools/call', { name, arguments: args });
    return result;
  }

  close(): void {
    if (!this.child) return;
    this.child.stdin.end();
    this.child.kill();
    this.child = undefined;
  }
}
