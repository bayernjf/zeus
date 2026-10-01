import { describe, expect, it } from 'vitest';
import { A2AClientError, cancelTask, sendTask, sendTaskSubscribe } from '../src/dispatch/client.js';
import type { A2AEvent, Task } from '../src/a2a/types.js';

const TASK_URL = 'http://vassal.internal/api/a2a/tasks';

const input = { taskUrl: TASK_URL, skill: 'report', params: {}, runId: 'r1' };

const finalTask: Task = { kind: 'task', id: 'task-1', contextId: 'ctx', status: { state: 'completed' }, artifacts: [] };

function sseResponse(chunks: string[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
  );
}

function frame(result: unknown): string {
  return `data: ${JSON.stringify({ jsonrpc: '2.0', id: 2, result })}\n\n`;
}

describe('A2A client HTTP error classification', () => {
  it('surfaces the HTTP status instead of a bare JSON SyntaxError on an HTML error page', async () => {
    const fetchImpl = async () =>
      new Response('<html><body>401 Unauthorized</body></html>', {
        status: 401,
        headers: { 'Content-Type': 'text/html' },
      });

    await expect(sendTask(input, fetchImpl)).rejects.toMatchObject({ code: -32000, httpStatus: 401 });
    await expect(sendTask(input, fetchImpl)).rejects.toThrow(/HTTP 401/);
  });

  it('distinguishes a crashed peer (500) from a stale credential (401) for cancel', async () => {
    const fetchImpl = async () => new Response('boom', { status: 500 });
    await expect(cancelTask(TASK_URL, 'task-9', 'tok', fetchImpl)).rejects.toMatchObject({ httpStatus: 500 });
    await expect(cancelTask(TASK_URL, 'task-9', 'tok', fetchImpl)).rejects.toThrow(/HTTP 500/);
  });

  it('rejects a non-2xx subscribe before parsing the body', async () => {
    const fetchImpl = async () => new Response('gateway down', { status: 503 });
    await expect(sendTaskSubscribe(input, {}, fetchImpl)).rejects.toMatchObject({ code: -32000, httpStatus: 503 });
  });

  it('still maps a JSON-RPC error body on a 2xx response to its application code', async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 3, error: { code: -32002, message: 'not cancelable' } }), {
        status: 200,
      });
    await expect(cancelTask(TASK_URL, 'task-9', undefined, fetchImpl)).rejects.toMatchObject({ code: -32002 });
  });
});

describe('A2A client SSE framing', () => {
  it('parses events terminated with CRLF, not only LF', async () => {
    const event = {
      kind: 'status-update',
      taskId: 'task-1',
      contextId: 'ctx',
      status: { state: 'working' },
      final: false,
    } as A2AEvent;
    const body =
      `data: ${JSON.stringify({ jsonrpc: '2.0', id: 2, result: event })}\r\n\r\n` +
      `data: ${JSON.stringify({ jsonrpc: '2.0', id: 2, result: finalTask })}\r\n\r\n`;

    const streamed: A2AEvent[] = [];
    const task = await sendTaskSubscribe(input, { onEvent: e => streamed.push(e) }, async () =>
      sseResponse([body])
    );

    expect(streamed.map(e => e.kind)).toEqual(['status-update']);
    expect(task.id).toBe('task-1');
  });

  it('assembles an event split across two chunks', async () => {
    const first = frame({ kind: 'status-update', taskId: 'task-1', contextId: 'ctx', status: { state: 'working' }, final: false });
    const second = frame(finalTask);
    const split = Math.floor((first + second).length / 2);
    const whole = first + second;

    const task = await sendTaskSubscribe(input, {}, async () =>
      sseResponse([whole.slice(0, split), whole.slice(split)])
    );

    expect(task.id).toBe('task-1');
  });

  it('bounds the buffer when a peer streams forever without an event terminator', async () => {
    const fetchImpl = async () => sseResponse(['data: ' + 'x'.repeat(4096)]);

    await expect(sendTaskSubscribe(input, {}, fetchImpl, { maxEventBytes: 256 })).rejects.toMatchObject({
      code: -32000,
    });
    await expect(sendTaskSubscribe(input, {}, fetchImpl, { maxEventBytes: 256 })).rejects.toThrow(
      /no event terminator/
    );
  });
});

describe('A2A client timeout and cancellation', () => {
  it('times out a peer that ignores the abort signal and never answers', async () => {
    const hung = () => new Promise<Response>(() => {});
    const started = Date.now();

    await expect(sendTask(input, hung, { timeoutMs: 20 })).rejects.toBeInstanceOf(A2AClientError);
    await expect(sendTask(input, hung, { timeoutMs: 20 })).rejects.toThrow(/timed out after 20ms/);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('bounds only the header wait of a subscription, not the whole stream', async () => {
    let signaled: AbortSignal | undefined;
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      signaled = init?.signal ?? undefined;
      return sseResponse([frame(finalTask)]);
    };

    const task = await sendTaskSubscribe(input, {}, fetchImpl, { timeoutMs: 20 });
    expect(task.id).toBe('task-1');
    // the deadline was disarmed once headers arrived, so the stream signal is not aborted
    expect(signaled?.aborted).toBe(false);
  });

  it('cancels a subscription when the caller aborts', async () => {
    const controller = new AbortController();
    const fetchImpl = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });

    const pending = sendTaskSubscribe(input, { signal: controller.signal }, fetchImpl, { timeoutMs: 5000 });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
