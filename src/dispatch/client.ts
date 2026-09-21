import type { A2AEvent, Task } from '../a2a/types.js';

export type SendTaskInput = {
  taskUrl: string;
  skill: string;
  params: Record<string, unknown>;
  runId: string;
  token?: string;
};

export type SubscribeHandlers = {
  onEvent?: (event: A2AEvent) => void;
  signal?: AbortSignal;
};

export class A2AClientError extends Error {
  constructor(message: string, readonly code: number) {
    super(message);
  }
}

function taskMessage(input: SendTaskInput) {
  return {
    role: 'user',
    metadata: { 'x-zeus-runId': input.runId },
    parts: [{ kind: 'data', data: { skill: input.skill, ...input.params } }],
  };
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export async function sendTask(input: SendTaskInput, fetchImpl: FetchLike = (url, init) => fetch(url, init)): Promise<Task> {
  const response = await fetchImpl(input.taskUrl, {
    method: 'POST',
    headers: jsonRpcHeaders(input.token),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tasks/send', params: { message: taskMessage(input) } }),
  });
  return unwrapTask(await response.json());
}

export async function sendTaskSubscribe(
  input: SendTaskInput,
  handlers: SubscribeHandlers,
  fetchImpl: FetchLike = (url, init) => fetch(url, init)
): Promise<Task> {
  const response = await fetchImpl(input.taskUrl, {
    method: 'POST',
    headers: { ...jsonRpcHeaders(input.token), Accept: 'text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tasks/sendSubscribe', params: { message: taskMessage(input) } }),
    signal: handlers.signal,
  });
  if (!response.ok || !response.body) throw new A2AClientError(`subscribe failed: HTTP ${response.status}`, -32000);
  return consumeSseStream(response.body, handlers.onEvent);
}

export async function cancelTask(taskUrl: string, taskId: string, token?: string, fetchImpl: FetchLike = (url, init) => fetch(url, init)): Promise<Task> {
  const response = await fetchImpl(taskUrl, {
    method: 'POST',
    headers: jsonRpcHeaders(token),
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tasks/cancel', params: { id: taskId } }),
  });
  return unwrapTask(await response.json());
}

function jsonRpcHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function unwrapTask(payload: unknown): Task {
  const body = payload as { result?: Task; error?: { code: number; message: string } };
  if (body?.error) throw new A2AClientError(body.error.message, body.error.code);
  if (!body?.result || (body.result as Task).kind !== 'task') throw new A2AClientError('malformed task response', -32000);
  return body.result;
}

async function consumeSseStream(body: ReadableStream<Uint8Array>, onEvent?: (event: A2AEvent) => void): Promise<Task> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalTask: Task | undefined;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of rawEvent.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          let payload: unknown;
          try {
            payload = JSON.parse(line.slice(6));
          } catch {
            continue;
          }
          const rpc = payload as { result?: unknown };
          if ((rpc.result as A2AEvent | Task | undefined)?.kind === 'task') {
            finalTask = rpc.result as Task;
          } else if (rpc.result) {
            onEvent?.(rpc.result as A2AEvent);
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (!finalTask) throw new A2AClientError('stream ended without a final task snapshot', -32000);
  return finalTask;
}
