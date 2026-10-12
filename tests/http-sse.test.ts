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

  it('replays what the intent published before the client attached', () => {
    // A subscriber that arrives mid-run is the normal case, not the edge case:
    // without the backlog it sees nothing about the branches that already
    // settled, and the thinking-state view starts from a false "no branches".
    const hub = new ProgressHub();
    const pastEnd: ProgressEvent = {
      type: 'branch-ended', intentId: 'i', runId: 'r', vassal: 'v', outcome: 'completed', state: 'completed',
      at: '2026-10-01T00:00:00.500Z',
    };
    hub.publish(started);
    hub.publish(pastEnd);
    const socket = socketOf();
    streamIntentProgress(socket, hub, 'i');
    const buffer = socket.chunks.join('');
    expect(buffer).toContain('event: branch-started');
    expect(buffer).toContain('event: branch-ended');
    expect(buffer).toContain('"state":"completed"');
    // Live events keep flowing after the replay, in order and without duplication.
    hub.publish(finished);
    expect(socket.chunks.filter(c => c.includes('event: branch-started'))).toHaveLength(1);
    expect(socket.chunks.join('')).toContain('event: intent-finished');
    expect(socket.ended).toBe(true);
  });

  it('ends the stream at once when the backlog already holds the terminal event', () => {
    const hub = new ProgressHub();
    hub.publish(started);
    hub.publish(finished);
    const socket = socketOf();
    streamIntentProgress(socket, hub, 'i');
    expect(socket.chunks.join('')).toContain('event: intent-finished');
    expect(socket.ended).toBe(true);
    // Nothing is written after teardown, so a late publish cannot reach this socket.
    const before = socket.chunks.length;
    hub.publish(started);
    expect(socket.chunks.length).toBe(before);
  });

  it('closes with an error event when nothing arrives within the attach grace', async () => {
    const hub = new ProgressHub();
    const socket = socketOf();
    streamIntentProgress(socket, hub, 'i', { attachGraceMs: 20 });
    expect(socket.ended).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 45));
    const buffer = socket.chunks.join('');
    expect(buffer).toContain('event: error');
    expect(socket.ended).toBe(true);
    // The subscription is released: a late publish writes nothing.
    const before = socket.chunks.length;
    hub.publish(started);
    expect(socket.chunks.length).toBe(before);
  });

  it('cancels the attach grace once a live event arrives', async () => {
    const hub = new ProgressHub();
    const socket = socketOf();
    streamIntentProgress(socket, hub, 'i', { attachGraceMs: 30 });
    hub.publish(started);
    await new Promise(resolve => setTimeout(resolve, 55));
    expect(socket.ended).toBe(false);
    expect(socket.chunks.join('')).not.toContain('event: error');
    hub.publish(finished);
    expect(socket.ended).toBe(true);
  });

  it('does not arm the attach grace when a backlog already proves the intent exists', async () => {
    const hub = new ProgressHub();
    hub.publish(started);
    const socket = socketOf();
    streamIntentProgress(socket, hub, 'i', { attachGraceMs: 15 });
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(socket.chunks.join('')).not.toContain('event: error');
    expect(socket.ended).toBe(false);
    socket.emit('close');
  });

  it('runs onTeardown exactly once across terminal end, expiry and peer reset', async () => {
    let torn = 0;

    const hubEnd = new ProgressHub();
    const socketEnd = socketOf();
    streamIntentProgress(socketEnd, hubEnd, 'i', { onTeardown: () => { torn += 1; } });
    hubEnd.publish(finished);
    socketEnd.emit('close');
    expect(torn).toBe(1);

    const hubGrace = new ProgressHub();
    const socketGrace = socketOf();
    streamIntentProgress(socketGrace, hubGrace, 'i', { attachGraceMs: 15, onTeardown: () => { torn += 1; } });
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(torn).toBe(2);

    const hubReset = new ProgressHub();
    const socketReset = socketOf();
    streamIntentProgress(socketReset, hubReset, 'i', { onTeardown: () => { torn += 1; } });
    socketReset.emit('close');
    socketReset.emit('error', new Error('ECONNRESET'));
    expect(torn).toBe(3);
  });
});

describe('live SSE stream cap', () => {
  async function cappedServer(maxStreams: number, attachGraceMs?: number): Promise<FastifyInstance> {
    const hub = new ProgressHub();
    const metrics = new ConcurrencyMetrics();
    const orchestrator = new Orchestrator(
      { findBySkill: () => [{ name: 'v1' }] },
      { async dispatch() { return completed(); }, async cancel() {} },
      {
        newIntentId: () => 'intent-1', newRunId: () => 'run-1', metrics, onProgress: e => hub.publish(e),
      }
    );
    return createHttpServer({
      registry: new VassalRegistry(),
      signer: new Ed25519MemorySigner('zeus-rsk-test'),
      internalToken: TOKEN,
      orchestrator,
      metrics,
      progressHub: hub,
      sseMaxStreams: maxStreams,
      ...(attachGraceMs !== undefined ? { sseAttachGraceMs: attachGraceMs } : {}),
    });
  }

  it('answers 503 past the cap for live streams but still replays stored intents', async () => {
    const app = await cappedServer(0);
    const blocked = await app.inject({
      method: 'GET', url: '/api/intents/ghost/events', headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(blocked.statusCode).toBe(503);
    expect((await blocked.json()).error).toBe('sse_unavailable');

    // A finished intent is replayed inline and never occupies a live slot.
    await app.inject({
      method: 'POST', url: '/api/intents', headers: { authorization: `Bearer ${TOKEN}` },
      payload: { skill: 'research', realm: 'personal' },
    });
    const replay = await app.inject({
      method: 'GET', url: '/api/intents/intent-1/events', headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toContain('event: intent');
    await app.close();
  });

  it('releases the slot once a capped-out stream expires', async () => {
    const app = await cappedServer(1, 40);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const base = `http://127.0.0.1:${port}`;

    const first = await fetch(`${base}/api/intents/ghost-1/events`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(first.status).toBe(200);
    const reader = first.body!.getReader();

    const second = await fetch(`${base}/api/intents/ghost-2/events`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(second.status).toBe(503);

    // Drain until the grace expiry closes the first stream.
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += new TextDecoder().decode(value);
    }
    expect(buffer).toContain('event: error');

    const third = await fetch(`${base}/api/intents/ghost-3/events`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(third.status).toBe(200);
    expect(await third.text()).toContain('event: error');

    await app.close();
  }, 10_000);
});
