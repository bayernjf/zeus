import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import type { FastifyInstance } from 'fastify';
import { createHttpServer, streamIntentProgress, type EventStreamSocket } from '../src/http/server.js';
import { VassalRegistry } from '../src/registry/registry.js';
import { Ed25519MemorySigner } from '../src/registry/signing.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { ConcurrencyMetrics } from '../src/orchestrator/metrics.js';
import { ProgressHub, type ProgressEvent } from '../src/orchestrator/progress.js';
import type { DispatchPort, TargetLookup } from '../src/orchestrator/types.js';
import type { DispatchResult } from '../src/dispatch/dispatcher.js';
import type { A2AEvent, Task } from '../src/a2a/types.js';

const TOKEN = 'driver-secret';

function completed(): DispatchResult {
  const taskId = 't1';
  const events: A2AEvent[] = [
    { kind: 'status-update', taskId, contextId: 'ctx', status: { state: 'completed' }, final: true },
  ];
  const task: Task = {
    kind: 'task', id: taskId, contextId: 'ctx', status: { state: 'completed' },
    artifacts: [{ artifactId: 'a1', name: 'verdict', parts: [{ kind: 'data', data: { stance: 'yes' } }] }],
  };
  return { ok: true, task, events, injectedHits: [] };
}

type Harness = { app: FastifyInstance; hub: ProgressHub };

async function harness(delayedMs = 0): Promise<Harness> {
  const hub = new ProgressHub();
  const metrics = new ConcurrencyMetrics();
  const port: DispatchPort = {
    async dispatch() {
      if (delayedMs > 0) await new Promise(resolve => setTimeout(resolve, delayedMs));
      return completed();
    },
    async cancel() {},
  };
  const lookup: TargetLookup = { findBySkill: () => [{ name: 'v1' }] };
  const orchestrator = new Orchestrator(lookup, port, {
    newIntentId: () => 'intent-1', newRunId: () => 'run-1', metrics, onProgress: e => hub.publish(e),
  });
  const app = await createHttpServer({
    registry: new VassalRegistry(),
    signer: new Ed25519MemorySigner('zeus-rsk-test'),
    internalToken: TOKEN,
    orchestrator,
    metrics,
    progressHub: hub,
  });
  return { app, hub };
}

describe('H3 SSE intent events', () => {
  it('replays a finished intent as one event then closes', async () => {
    const seeded = await harness();
    await seeded.app.inject({
      method: 'POST', url: '/api/intents', headers: { authorization: `Bearer ${TOKEN}` },
      payload: { skill: 'research', realm: 'personal' },
    });
    const res = await seeded.app.inject({
      method: 'GET', url: '/api/intents/intent-1/events', headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.body).toContain('event: intent');
    expect(res.body).toContain('"intentId":"intent-1"');
    await seeded.app.close();
  });

  it('404s an unknown intent when no hub is configured', async () => {
    const { app } = await harness();
    const resNoHub = await createHttpServer({
      registry: new VassalRegistry(),
      signer: new Ed25519MemorySigner('zeus-rsk-test'),
      internalToken: TOKEN,
      orchestrator: new Orchestrator(
        { findBySkill: () => [] },
        { async dispatch() { return completed(); }, async cancel() {} }
      ),
    }).then(a =>
      a.inject({
        method: 'GET', url: '/api/intents/nope/events', headers: { authorization: `Bearer ${TOKEN}` },
      }).then(r => [a, r] as const)
    );
    expect(resNoHub[1].statusCode).toBe(404);
    await resNoHub[0].close();
    await app.close();
  });

  it('streams live progress while an intent is running', async () => {
    const { app } = await harness(150);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const base = `http://127.0.0.1:${port}`;

    const response = await fetch(`${base}/api/intents/live-1/events`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.headers.get('content-type')).toMatch(/text\/event-stream/);
    const reader = response.body!.getReader();

    // Kick the fan-out off under the idempotency key the SSE stream awaits.
    const done = fetch(`${base}/api/intents`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ skill: 'research', realm: 'personal', intentId: 'live-1' }),
    });

    let buffer = '';
    let sawFinished = false;
    while (!sawFinished) {
      const { value, done: streamDone } = await reader.read();
      if (streamDone) break;
      buffer += new TextDecoder().decode(value);
      sawFinished = buffer.includes('event: intent-finished');
    }
    expect(buffer).toContain('event: branch-started');
    expect(buffer).toContain('event: branch-ended');
    expect(buffer).toContain('event: intent-finished');
    reader.cancel();
    await done;
    await app.close();
  }, 30000);
});

/** A hijacked response socket, minus the network: an EventEmitter plus the
 *  handful of members the SSE wiring touches. */
class FakeSocket extends EventEmitter {
  chunks: string[] = [];
  ended = false;
  destroyed = false;
  writableEnded = false;
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
  end(): void {
    this.ended = true;
    this.writableEnded = true;
  }
  destroy(): void {
    this.destroyed = true;
  }
}

const started: ProgressEvent = {
  type: 'branch-started', intentId: 'i', runId: 'r', vassal: 'v', skill: 's', at: '2026-10-01T00:00:00.000Z',
};
const finished: ProgressEvent = {
  type: 'intent-finished', intentId: 'i', runId: 'r', status: 'completed', at: '2026-10-01T00:00:01.000Z',
};

describe('hijacked SSE stream lifecycle', () => {
  const socketOf = (): FakeSocket & EventStreamSocket => new FakeSocket() as FakeSocket & EventStreamSocket;

  it('survives a peer reset without an unhandled error event', () => {
    const hub = new ProgressHub();
    const socket = socketOf();
    streamIntentProgress(socket, hub, 'i');
    // Once hijacked there is no other listener for this socket: an 'error' with
    // no handler is rethrown by EventEmitter and kills the process.
    expect(() => socket.emit('error', new Error('ECONNRESET'))).not.toThrow();
    expect(socket.destroyed).toBe(true);
    // Writes after teardown are dropped, not thrown.
    socket.emit('close');
    hub.publish(started);
    expect(socket.chunks).toEqual([]);
  });

  it('streams progress and tears down on the terminal event', () => {
    const hub = new ProgressHub();
    const socket = socketOf();
    streamIntentProgress(socket, hub, 'i');
    hub.publish(started);
    expect(socket.chunks.join('')).toContain('event: branch-started');
    hub.publish(finished);
    expect(socket.chunks.join('')).toContain('event: intent-finished');
    expect(socket.ended).toBe(true);
    // The subscription is released: a later publish writes nothing further.
    const before = socket.chunks.length;
    hub.publish(started);
    expect(socket.chunks.length).toBe(before);
  });

  it('drops writes once the socket is no longer writable', () => {
    const hub = new ProgressHub();
    const socket = socketOf();
    socket.writableEnded = true;
    streamIntentProgress(socket, hub, 'i');
    hub.publish(started);
    expect(socket.chunks).toEqual([]);
    socket.emit('close');
  });
});
