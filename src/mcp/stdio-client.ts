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
/** Bounded stderr ring kept on errors for local diagnostics (process memory only). */
const STDERR_TAIL_BYTES = 4000;
/** Grace period between SIGTERM and the SIGKILL escalation. */
const SIGKILL_ESCALATION_MS = 2000;

export class McpStdioError extends Error {
  constructor(
    message: string,
    /**
     * Bounded tail of the child's stderr for local diagnostics. It travels with
     * the error inside the process only; HTTP error responses must not echo it.
     */
    readonly stderrTail?: string,
  ) {
    super(message);
    this.name = 'McpStdioError';
  }
}

export interface StdioSpawnOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /**
   * S16 V2 (design-sandbox §5): when set, the child inherits nothing but the
   * listed variables — the allow-list from an IsolationManifest. Unset keeps
   * the historical full-environment behaviour.
   */
  envAllowList?: string[];
  /** S16 V2: wall-clock bound; the child is killed when exceeded. */
  maxWallSeconds?: number;
  /** Per-request bound: a wedged call rejects and the child process is killed. */
  callTimeoutSeconds?: number;
  /** Injection seam for tests; defaults to node:child_process spawn. */
  spawnImpl?: typeof spawn;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
}

/** Copy only the allow-listed variables that actually exist. */
function pickEnv(allowList: string[], source: NodeJS.ProcessEnv): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const key of allowList) {
    const value = source[key];
    if (value !== undefined) picked[key] = value;
  }
  return picked;
}

export class McpStdioClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly pending = new Map<string, Pending>();
  private startError: Error | null = null;
  private stderrTail = '';
  private wallTimer: NodeJS.Timeout | undefined;
  private killTimer: NodeJS.Timeout | undefined;
  private closed = false;
  private requestCounter = 0;

  constructor(private readonly options: StdioSpawnOptions) {}

  private start(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    if (this.closed) throw new McpStdioError('stdio MCP client is closed');
    const spawnImpl = this.options.spawnImpl ?? spawn;
    const env = this.options.envAllowList
      ? pickEnv(this.options.envAllowList, { ...process.env, ...(this.options.env ?? {}) })
      : { ...process.env, ...(this.options.env ?? {}) };
    // Detached: the child leads its own process group so signalling -pid takes
    // any grandchildren (MCP servers that spawn helpers) down with it.
    const child = spawnImpl(this.options.command, this.options.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      detached: true,
    });
    this.child = child;
    this.stderrTail = '';

    if (this.options.maxWallSeconds !== undefined && this.options.maxWallSeconds > 0) {
      const seconds = this.options.maxWallSeconds;
      this.wallTimer = setTimeout(() => {
        // Capture the target: a respawned process after a natural exit must not
        // be killed by the previous process's timer.
        if (this.child !== child) return;
        this.failAll(new McpStdioError(`stdio MCP process exceeded its wall-clock bound (${seconds}s)`, this.stderrTail || undefined));
        this.terminate(child);
      }, seconds * 1000);
      this.wallTimer.unref();
    }

    const rl = createInterface({ input: child.stdout });
    rl.on('line', line => {
      if (!line.trim()) return;
      let message: { id?: unknown; result?: unknown; error?: { code: number; message: string } };
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      // Correlate by the string form: some servers echo our numeric id as a string.
      if (typeof message.id !== 'number' && typeof message.id !== 'string') return;
      const key = String(message.id);
      const waiter = this.pending.get(key);
      if (!waiter) return;
      this.pending.delete(key);
      clearTimeout(waiter.timer);
      if (message.error) {
        waiter.reject(new McpStdioError(`MCP error ${message.error.code}: ${message.error.message}`, this.stderrTail || undefined));
      } else {
        waiter.resolve(message.result);
      }
    });

    child.on('error', error => {
      this.startError = error;
      this.failAll(error);
    });
    // A broken stdin kills the channel; reject every in-flight call instead of
    // letting an unhandled stream 'error' crash the process.
    child.stdin.on('error', error => {
      this.failAll(new McpStdioError(`stdio MCP stdin error: ${error.message}`));
    });
    child.stderr.on('data', chunk => {
      // Diagnostics only; stdout is the sole JSON-RPC channel. Keep a bounded
      // tail on the instance so an early-exit error can carry local evidence.
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-STDERR_TAIL_BYTES);
    });
    child.on('exit', code => {
      if (this.child === child) this.child = undefined;
      clearTimeout(this.wallTimer);
      clearTimeout(this.killTimer);
      const error =
        this.startError ??
        new McpStdioError(`stdio MCP process exited early (code ${code})`, this.stderrTail || undefined);
      this.failAll(error);
    });
    return child;
  }

  /** Signal the whole process group; fall back to the child when the group is already gone. */
  private signalGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
    if (child.pid === undefined) {
      child.kill(signal);
      return;
    }
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      try {
        child.kill(signal);
      } catch {
        // The child is already gone.
      }
    }
  }

  /** SIGTERM the group, then escalate to SIGKILL unless the process exits. */
  private terminate(child: ChildProcessWithoutNullStreams): void {
    this.signalGroup(child, 'SIGTERM');
    clearTimeout(this.killTimer);
    this.killTimer = setTimeout(() => {
      // Identity guard: never signal a different process that reused the slot.
      if (this.child === child) this.signalGroup(child, 'SIGKILL');
    }, SIGKILL_ESCALATION_MS);
    this.killTimer.unref();
  }

  private failAll(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  private writeLine(child: ChildProcessWithoutNullStreams, line: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // The callback receives write errors (e.g. EPIPE after the child died);
      // the stream also emits 'error', which the persistent listener in start()
      // turns into a channel-wide failure. Providing the callback here stops the
      // error from surfacing as an uncaught exception for this write.
      child.stdin.write(line, error => {
        if (error) {
          reject(new McpStdioError(`failed writing to the stdio MCP server: ${error.message}`));
          return;
        }
        resolve();
      });
    });
  }

  private call(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new McpStdioError('stdio MCP client was closed'));
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.start();
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.startError) return Promise.reject(this.startError);
    const id = ++this.requestCounter;
    const key = String(id);
    return new Promise((resolve, reject) => {
      const entry: Pending = { resolve, reject };
      this.pending.set(key, entry);
      const seconds = this.options.callTimeoutSeconds;
      if (seconds !== undefined && seconds > 0) {
        entry.timer = setTimeout(() => {
          if (!this.pending.delete(key)) return;
          reject(new McpStdioError(`stdio MCP request '${method}' timed out after ${seconds}s`, this.stderrTail || undefined));
          // The server is wedged: kill the group so a stuck subprocess cannot
          // outlive the request it serves.
          this.terminate(child);
        }, seconds * 1000);
        entry.timer.unref();
      }
      void this.writeLine(child, `${JSON.stringify({ jsonrpc: JSONRPC, id, method, params })}\n`).catch(error => {
        if (!this.pending.delete(key)) return;
        clearTimeout(entry.timer);
        reject(error);
      });
    });
  }

  private notify(method: string, params?: unknown): void {
    if (this.closed || !this.child) return;
    void this.writeLine(this.child, `${JSON.stringify({ jsonrpc: JSONRPC, method, params })}\n`).catch(() => {
      // Channel errors reject in-flight calls via the stdin listener; a
      // notification has no caller to reject.
    });
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
    if (this.closed) return;
    this.closed = true;
    const child = this.child;
    // Reject pending calls immediately; callers must not wait for process exit.
    this.failAll(new McpStdioError('stdio MCP client was closed'));
    clearTimeout(this.wallTimer);
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      // stdin already ended.
    }
    this.terminate(child);
  }
}
