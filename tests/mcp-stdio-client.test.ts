import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { McpStdioClient, McpStdioError } from '../src/mcp/stdio-client.js';

interface FakeChild {
  child: ChildProcessWithoutNullStreams;
  sent: string[];
  emitLine: (line: string) => void;
  emitStderr: (text: string) => void;
  kills: string[];
  spawnOptions: Record<string, unknown>;
}

function fakeSpawn(
  opts: { errorOn?: string; hangOn?: string; stdinError?: Error; stringIds?: boolean } = {},
): { spawnImpl: typeof import('node:child_process').spawn; take: () => FakeChild } {
  let current: FakeChild | undefined;
  let spawnSeq = 0;
  const spawnImpl = (() => {
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    const sent: string[] = [];
    const kills: string[] = [];
    const respond = (request: { id?: number | string; method: string }) => {
      if (request.id === undefined) return; // notifications get no response
      if (opts.hangOn === request.method) return; // a wedged server never answers
      // Some servers echo our numeric id as a string; correlation must be id-type agnostic.
      const responseId = opts.stringIds ? String(request.id) : request.id;
      let result: unknown;
      switch (request.method) {
        case 'initialize':
          result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fake' } };
          break;
        case 'tools/list':
          result = { tools: [{ name: 'realm.search' }, { name: 'realm.read' }] };
          break;
        case 'resources/list':
          result = { resources: [{ uri: 'zeus-realm://r/manifest', name: 'manifest' }] };
          break;
        case 'prompts/list':
          result = { prompts: [] };
          break;
        case 'tools/call':
          if (opts.errorOn === 'tools/call') {
            stdout.push(`${JSON.stringify({ jsonrpc: '2.0', id: responseId, error: { code: -32002, message: 'not connected' } })}\n`);
            return;
          }
          result = { content: [{ type: 'text', text: 'ok' }] };
          break;
        default:
          result = {};
      }
      stdout.push(`${JSON.stringify({ jsonrpc: '2.0', id: responseId, result })}\n`);
    };
    const stdin = new Writable({
      write(chunk, _enc, cb) {
        const text = chunk.toString();
        if (opts.stdinError) {
          cb(opts.stdinError);
          return;
        }
        sent.push(text);
        try {
          respond(JSON.parse(text) as { id?: number | string; method: string });
        } catch {
          // non-JSON line; ignore in the fake
        }
        cb();
      },
    });
    const child = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
    Object.assign(child, {
      pid: 4242 + spawnSeq++,
      stdin,
      stdout,
      stderr,
      killed: false,
      kill(signal?: string) {
        this.killed = true;
        kills.push(signal ?? 'SIGTERM');
      },
    });
    current = {
      child,
      sent,
      kills,
      spawnOptions: {},
      emitLine: (line: string) => stdout.push(`${line}\n`),
      emitStderr: (text: string) => stderr.push(Buffer.from(text)),
    };
    return child;
  }) as unknown as typeof import('node:child_process').spawn;
  // Wrap so spawn options are captured for assertions.
  const capturing = ((command: string, args: string[], options: Record<string, unknown>) => {
    const child = spawnImpl(command, args, options as never);
    current!.spawnOptions = options;
    return child;
  }) as unknown as typeof import('node:child_process').spawn;
  return { spawnImpl: capturing, take: () => current! };
}

describe('McpStdioClient', () => {
  it('completes the handshake and discovers capabilities', async () => {
    const { spawnImpl } = fakeSpawn();
    const client = new McpStdioClient({ command: 'node', spawnImpl });
    const caps = await client.initialize();
    expect(caps.tools).toEqual(['realm.search', 'realm.read']);
    expect(caps.resources).toEqual(['manifest']);
    expect(caps.prompts).toEqual([]);
    client.close();
  });

  it('calls a tool with arguments over stdio', async () => {
    const { spawnImpl, take } = fakeSpawn();
    const client = new McpStdioClient({ command: 'node', spawnImpl });
    const result = await client.callTool('realm.search', { realmId: 'r', text: 'auth' });
    expect(result).toEqual({ content: [{ type: 'text', text: 'ok' }] });
    const callLine = take().sent.map(line => JSON.parse(line) as { method: string; params?: unknown }).find(m => m.method === 'tools/call');
    expect(callLine?.params).toMatchObject({ name: 'realm.search', arguments: { realmId: 'r', text: 'auth' } });
    client.close();
  });

  it('surfaces a JSON-RPC error from the upstream server', async () => {
    const { spawnImpl } = fakeSpawn({ errorOn: 'tools/call' });
    const client = new McpStdioClient({ command: 'node', spawnImpl });
    await expect(client.callTool('realm.read', { realmId: 'r', itemId: 'missing' })).rejects.toBeInstanceOf(McpStdioError);
    client.close();
  });

  it('rejects pending calls when the process exits early', async () => {
    const { spawnImpl, take } = fakeSpawn();
    const client = new McpStdioClient({ command: 'node', spawnImpl });
    const promise = client.callTool('realm.read', { realmId: 'r', itemId: 'a' });
    take().child.emit('exit', 1);
    await expect(promise).rejects.toThrow(/exited early/);
  });

  it('rejects a call that is never answered within the per-request timeout and kills the process group', async () => {
    vi.useFakeTimers();
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const { spawnImpl, take } = fakeSpawn({ hangOn: 'tools/call' });
    const client = new McpStdioClient({ command: 'node', spawnImpl, callTimeoutSeconds: 1 });
    try {
      const promise = client.callTool('realm.search', {});
      // The rejection fires inside the clock advance, before the await below
      // attaches its reaction; mark the promise handled so the fake clock does
      // not report a test-only unhandled rejection.
      promise.catch(() => {});
      await vi.advanceTimersByTimeAsync(1000);
      // Assert the group signal before awaiting the rejection so the old
      // implementation (no per-request timeout at all) fails fast instead of
      // hanging for the full test timeout and leaking fake timers.
      expect(killSpy).toHaveBeenCalledWith(-take().child.pid!, 'SIGTERM');
      await expect(promise).rejects.toThrow(/timed out/);
      // The wedged process is signalled as a group so grandchildren die with it.
      await vi.advanceTimersByTimeAsync(2000);
      expect(killSpy).toHaveBeenCalledWith(-take().child.pid!, 'SIGKILL');
    } finally {
      client.close();
      killSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('rejects every pending call immediately on close without waiting for process exit', async () => {
    const { spawnImpl } = fakeSpawn({ hangOn: 'tools/call' });
    const client = new McpStdioClient({ command: 'node', spawnImpl });
    const promise = client.callTool('realm.search', {});
    let settled = false;
    promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    client.close();
    // The fake child never emits 'exit': close() must reject pending calls on
    // its own. Assert settlement first so the old implementation fails fast
    // instead of awaiting a rejection that never comes.
    await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(true);
    await expect(promise).rejects.toThrow(/closed/);
  });

  it('enforces the wall-clock bound with SIGTERM then SIGKILL escalation on the process group', async () => {
    vi.useFakeTimers();
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const { spawnImpl, take } = fakeSpawn({ hangOn: 'tools/call' });
    const client = new McpStdioClient({ command: 'node', spawnImpl, maxWallSeconds: 1 });
    try {
      const promise = client.callTool('realm.search', {});
      promise.catch(() => {}); // handled below; keep the fake-clock rejection off the unhandled channel
      expect(take().spawnOptions.detached).toBe(true);
      await vi.advanceTimersByTimeAsync(1000);
      await expect(promise).rejects.toThrow(/wall-clock/);
      expect(killSpy).toHaveBeenCalledWith(-take().child.pid!, 'SIGTERM');
      await vi.advanceTimersByTimeAsync(2000);
      expect(killSpy).toHaveBeenCalledWith(-take().child.pid!, 'SIGKILL');
    } finally {
      client.close();
      killSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('clears the wall timer when the process exits, so a respawned process cannot be killed by the old timer', async () => {
    vi.useFakeTimers();
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const { spawnImpl, take } = fakeSpawn({ hangOn: 'tools/call' });
    const client = new McpStdioClient({ command: 'node', spawnImpl, maxWallSeconds: 1 });
    try {
      const first = client.callTool('realm.search', {});
      take().child.emit('exit', 0);
      await expect(first).rejects.toThrow(/exited early/);
      // The client is reused after the natural exit: advance partway into the
      // bound, then a new process starts. The dead process's stale timer would
      // fire at t=1000ms against whatever child is current; it must have been
      // cleared at exit instead.
      await vi.advanceTimersByTimeAsync(100);
      const second = client.callTool('realm.search', {});
      second.catch(() => {}); // handled below; keep the fake-clock rejection off the unhandled channel
      const respawnedPid = take().child.pid!;
      await vi.advanceTimersByTimeAsync(900);
      // t=1000ms: only the stale timer could be due now; the new process's own
      // bound does not expire until t=1100ms, so it must not be signalled.
      // The old implementation called child.kill() directly from the stale
      // timer, which lands in the fake child's kills list; assert that first
      // so it fails fast rather than hanging on the later rejection await.
      expect(take().kills).toEqual([]);
      expect(killSpy).not.toHaveBeenCalledWith(-respawnedPid, expect.anything());
      await vi.advanceTimersByTimeAsync(200);
      // The respawned process gets its own fresh bound and is killed when it expires.
      await expect(second).rejects.toThrow(/wall-clock/);
      expect(killSpy).toHaveBeenCalledWith(-respawnedPid, 'SIGTERM');
      await vi.advanceTimersByTimeAsync(2000);
      client.close();
    } finally {
      killSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it(
    'rejects the call when writing to stdin fails (EPIPE after the child died)',
    async () => {
      const { spawnImpl } = fakeSpawn({ stdinError: new Error('write EPIPE') });
      const client = new McpStdioClient({ command: 'node', spawnImpl });
      await expect(client.callTool('realm.search', {})).rejects.toThrow(/EPIPE/);
      client.close();
    },
    // On the old implementation the callback-less write surfaces as an uncaught
    // error and the promise never settles; bound the red wait to 3s.
    3000,
  );

  it('never throws or respawns when a notification is sent after close', async () => {
    const { spawnImpl, take } = fakeSpawn();
    const client = new McpStdioClient({ command: 'node', spawnImpl });
    await client.initialize();
    client.close();
    const spawnsAfterClose = take().kills.length;
    expect(() => (client as unknown as { notify: (m: string) => void }).notify('notifications/initialized')).not.toThrow();
    // A post-close notification must not start a second subprocess.
    expect(take().kills.length).toBe(spawnsAfterClose);
  });

  it('correlates JSON-RPC responses when the server echoes the id as a string', async () => {
    const { spawnImpl, take } = fakeSpawn({ stringIds: true });
    const client = new McpStdioClient({ command: 'node', spawnImpl });
    let correlated = false;
    const ready = client.initialize().then(caps => {
      correlated = true;
      return caps;
    });
    // The old code only matched numeric ids, so a string-echoing server left
    // every call pending. Probe settlement first so red fails fast instead of
    // waiting for the full test timeout.
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(correlated).toBe(true);
    const caps = await ready;
    expect(caps.tools).toEqual(['realm.search', 'realm.read']);
    // An unsolicited frame with a server-owned string id must be ignored
    // without disturbing the channel.
    take().emitLine(JSON.stringify({ jsonrpc: '2.0', id: 'some-server-id', result: {} }));
    client.close();
  });

  it('keeps a bounded stderr tail on the early-exit error for local diagnostics', async () => {
    const { spawnImpl, take } = fakeSpawn({ hangOn: 'tools/call' });
    const client = new McpStdioClient({ command: 'node', spawnImpl });
    const promise = client.callTool('realm.read', {});
    take().emitStderr('fatal: connector boot failed\n');
    await new Promise(resolve => setImmediate(resolve));
    take().child.emit('exit', 1);
    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McpStdioError);
    expect((error as McpStdioError).stderrTail).toContain('fatal: connector boot failed');
  });

  it('numbers requests per client instance, never from a module-shared counter', async () => {
    const first = fakeSpawn();
    const firstClient = new McpStdioClient({ command: 'node', spawnImpl: first.spawnImpl });
    await firstClient.initialize();
    firstClient.close();
    expect(JSON.parse(first.take().sent[0]!).id).toBe(1);

    const second = fakeSpawn();
    const secondClient = new McpStdioClient({ command: 'node', spawnImpl: second.spawnImpl });
    await secondClient.initialize();
    secondClient.close();
    expect(JSON.parse(second.take().sent[0]!).id).toBe(1);
  });
});
