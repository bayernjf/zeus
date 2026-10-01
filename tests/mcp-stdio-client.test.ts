import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { McpStdioClient, McpStdioError } from '../src/mcp/stdio-client.js';

interface FakeChild {
  child: ChildProcessWithoutNullStreams;
  sent: string[];
  emitLine: (line: string) => void;
}

function fakeSpawn(opts: { errorOn?: string } = {}): { spawnImpl: typeof import('node:child_process').spawn; take: () => FakeChild } {
  let current: FakeChild | undefined;
  const spawnImpl = (() => {
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    const sent: string[] = [];
    const respond = (request: { id?: number; method: string }) => {
      if (request.id === undefined) return; // notifications get no response
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
            stdout.push(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32002, message: 'not connected' } })}\n`);
            return;
          }
          result = { content: [{ type: 'text', text: 'ok' }] };
          break;
        default:
          result = {};
      }
      stdout.push(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
    };
    const stdin = new Writable({
      write(chunk, _enc, cb) {
        const text = chunk.toString();
        sent.push(text);
        try {
          respond(JSON.parse(text) as { id?: number; method: string });
        } catch {
          // non-JSON line; ignore in the fake
        }
        cb();
      },
    });
    const child = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
    Object.assign(child, { stdin, stdout, stderr, killed: false, kill() { this.killed = true; } });
    current = {
      child,
      sent,
      emitLine: (line: string) => stdout.push(`${line}\n`),
    };
    return child;
  }) as unknown as typeof import('node:child_process').spawn;
  return { spawnImpl, take: () => current! };
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
});
