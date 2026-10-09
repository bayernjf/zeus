import type { A2AEvent, Task } from '../a2a/types.js';
import { guardedFetch } from '../util/outbound-dns.js';

export type SendTaskInput = {
  taskUrl: string;
  skill: string;
  params: Record<string, unknown>;
  runId: string;
  token?: string;
  /**
   * S6 V2 (design-observability §5): W3C-shaped trace context propagated to
   * the execution agent as optional protocol metadata. The kernel derives it
   * from its own runId lineage; a peer that ignores it stays interoperable
   * (observation field, never an authorization field).
   */
  traceparent?: string;
};

export type SubscribeHandlers = {
  onEvent?: (event: A2AEvent) => void;
  signal?: AbortSignal;
  /**
   * S15 V2 (design-streaming §5): a working frame carrying an incremental
   * payload is surfaced through this narrow callback instead of being dropped
   * at the transport edge. `runId` is supplied by the caller (the dispatcher
   * owns the branch lineage); the client maintains the per-stream sequence.
   * Preview content stays preview: it never enters a settled outcome, memory
   * or any decision path (design-streaming §2).
   */
  onBranchDelta?: (delta: { runId: string; seq: number; preview: string; at: string }) => void;
};

/** Transport knobs shared by every outbound A2A call. */
export type ClientRequestOptions = {
  /**
   * Ceiling on the wait for a response. Default {@link DEFAULT_REQUEST_TIMEOUT_MS};
   * pass `Infinity` to wait forever. For `sendTaskSubscribe` it bounds the wait
   * for response headers only: a healthy stream is long-lived and must not be cut
   * off mid-flight once the peer has answered.
   */
  timeoutMs?: number;
  /**
   * Ceiling for a single SSE event before its blank-line terminator arrives.
   * A peer that streams bytes forever without ever ending an event would
   * otherwise grow the buffer until the process runs out of memory. Default
   * {@link DEFAULT_SSE_EVENT_BYTES}.
   */
  maxEventBytes?: number;
};

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_SSE_EVENT_BYTES = 8 * 1024 * 1024;

export class A2AClientError extends Error {
  constructor(
    message: string,
    readonly code: number,
    /**
     * HTTP status of the offending response, when the failure came from one.
     * Without it a stale credential (401) and a crashed peer (500) are both just
     * "the call failed", which is the distinction a caller needs to recover.
     */
    readonly httpStatus?: number,
  ) {
    super(message);
  }
}

function taskMessage(input: SendTaskInput) {
  return {
    role: 'user',
    metadata: {
      'x-zeus-runId': input.runId,
      ...(input.traceparent === undefined ? {} : { traceparent: input.traceparent }),
    },
    parts: [{ kind: 'data', data: { skill: input.skill, ...input.params } }],
  };
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const defaultFetch: FetchLike = guardedFetch;

type Deadline = {
  /** Pass to `fetch` so a signal-honoring implementation aborts at the deadline. */
  signal: AbortSignal;
  /** Rejects with the timeout error; raced against the request itself so a stub
   *  that ignores the signal still cannot hang the caller. */
  expired: Promise<never>;
  /** True when the deadline - not the caller - fired. */
  fired: () => boolean;
  /** Stop the deadline but keep forwarding the caller's aborts (stream case). */
  disarm: () => void;
  /** Stop everything; call once the operation is over. */
  dispose: () => void;
};

function startDeadline(external: AbortSignal | undefined, timeoutMs: number, label: string): Deadline {
  const controller = new AbortController();
  const forward = () => controller.abort(external?.reason);
  if (external) {
    if (external.aborted) forward();
    else external.addEventListener('abort', forward, { once: true });
  }

  let fired = false;
  let rejectExpired: (error: unknown) => void = () => {};
  const expired = new Promise<never>((_, reject) => {
    rejectExpired = reject;
  });
  const timer = Number.isFinite(timeoutMs)
    ? setTimeout(() => {
        fired = true;
        const error = new A2AClientError(`${label} timed out after ${timeoutMs}ms`, -32000);
        controller.abort(error);
        rejectExpired(error);
      }, timeoutMs)
    : undefined;

  const clear = () => {
    if (timer !== undefined) clearTimeout(timer);
  };
  return {
    signal: controller.signal,
    expired,
    fired: () => fired,
    disarm: clear,
    dispose: () => {
      clear();
      external?.removeEventListener('abort', forward);
    },
  };
}

/** Race a request against its deadline, folding both abort paths into one error. */
async function guard<T>(work: Promise<T>, deadline: Deadline, label: string, timeoutMs: number): Promise<T> {
  try {
    return await Promise.race([work, deadline.expired]);
  } catch (error) {
    // A signal-honoring fetch rejects with its own AbortError; a stub that
    // ignores the signal lets `expired` reject instead. Same outcome either way.
    if (deadline.fired()) throw new A2AClientError(`${label} timed out after ${timeoutMs}ms`, -32000);
    throw error;
  }
}

export async function sendTask(
  input: SendTaskInput,
  fetchImpl: FetchLike = defaultFetch,
  options: ClientRequestOptions = {},
): Promise<Task> {
  const label = `tasks/send to ${input.taskUrl}`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const deadline = startDeadline(undefined, timeoutMs, label);
  try {
    const response = await guard(
      fetchImpl(input.taskUrl, {
        method: 'POST',
        headers: jsonRpcHeaders(input.token),
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tasks/send', params: { message: taskMessage(input) } }),
        signal: deadline.signal,
      }),
      deadline,
      label,
      timeoutMs,
    );
    return unwrapTask(await readJson(response, label));
  } finally {
    deadline.dispose();
  }
}

export async function sendTaskSubscribe(
  input: SendTaskInput,
  handlers: SubscribeHandlers,
  fetchImpl: FetchLike = defaultFetch,
  options: ClientRequestOptions = {},
): Promise<Task> {
  const label = `tasks/sendSubscribe to ${input.taskUrl}`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const maxEventBytes = options.maxEventBytes ?? DEFAULT_SSE_EVENT_BYTES;
  const deadline = startDeadline(handlers.signal, timeoutMs, label);
  try {
    const response = await guard(
      fetchImpl(input.taskUrl, {
        method: 'POST',
        headers: { ...jsonRpcHeaders(input.token), Accept: 'text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tasks/sendSubscribe', params: { message: taskMessage(input) } }),
        signal: deadline.signal,
      }),
      deadline,
      label,
      timeoutMs,
    );
    if (!response.ok || !response.body) {
      throw new A2AClientError(`${label} failed: HTTP ${response.status}`, -32000, response.status);
    }
    // Headers are in: the peer answered. Drop the deadline so a long-lived stream
    // is not cut off mid-flight; the caller's signal still cancels it.
    deadline.disarm();
    return await consumeSseStream(
      response.body,
      handlers.onEvent,
      maxEventBytes,
      label,
      handlers.onBranchDelta === undefined
        ? undefined
        : delta => handlers.onBranchDelta!({ runId: input.runId ?? '', ...delta }),
    );
  } finally {
    deadline.dispose();
  }
}

export async function cancelTask(
  taskUrl: string,
  taskId: string,
  token?: string,
  fetchImpl: FetchLike = defaultFetch,
  options: ClientRequestOptions = {},
): Promise<Task> {
  const label = `tasks/cancel of ${taskId} at ${taskUrl}`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const deadline = startDeadline(undefined, timeoutMs, label);
  try {
    const response = await guard(
      fetchImpl(taskUrl, {
        method: 'POST',
        headers: jsonRpcHeaders(token),
        body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tasks/cancel', params: { id: taskId } }),
        signal: deadline.signal,
      }),
      deadline,
      label,
      timeoutMs,
    );
    return unwrapTask(await readJson(response, label));
  } finally {
    deadline.dispose();
  }
}

function jsonRpcHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/**
 * Reject any non-2xx before touching the body. Error responses are frequently
 * HTML (proxy pages, crash dumps), and `response.json()` on one throws a bare
 * `SyntaxError` that names neither the status nor the endpoint - the caller sees
 * "unexpected token <" and cannot tell an expired token from a dead peer.
 */
async function readJson(response: Response, label: string): Promise<unknown> {
  if (!response.ok) {
    throw new A2AClientError(`${label} failed: HTTP ${response.status}`, -32000, response.status);
  }
  try {
    return await response.json();
  } catch (error) {
    throw new A2AClientError(
      `${label} returned a body that is not JSON: ${error instanceof Error ? error.message : String(error)}`,
      -32000,
      response.status,
    );
  }
}

function unwrapTask(payload: unknown): Task {
  const body = payload as { result?: Task; error?: { code: number; message: string } };
  if (body?.error) throw new A2AClientError(body.error.message, body.error.code);
  if (!body?.result || (body.result as Task).kind !== 'task') throw new A2AClientError('malformed task response', -32000);
  return body.result;
}

/** Earliest SSE event terminator: the spec allows LF or CRLF line endings, so
 *  `\r\n\r\n` and `\n\n` both end an event. */
function findEventBoundary(buffer: string): { index: number; length: number } | undefined {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
  if (lf !== -1) return { index: lf, length: 2 };
  return undefined;
}

async function consumeSseStream(
  body: ReadableStream<Uint8Array>,
  onEvent: ((event: A2AEvent) => void) | undefined,
  maxEventBytes: number,
  label: string,
  onBranchDelta?: (delta: { seq: number; preview: string; at: string }) => void,
): Promise<Task> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalTask: Task | undefined;
  let deltaSeq = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (let boundary = findEventBoundary(buffer); boundary; boundary = findEventBoundary(buffer)) {
        const rawEvent = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        emitSseEvent(rawEvent, result => {
          if ((result as Task).kind === 'task') {
            finalTask = result as Task;
            return;
          }
          const event = result as A2AEvent;
          onEvent?.(event);
          // S15 V2: a working frame with an incremental payload surfaces
          // through the narrow delta callback; frames without one (agents that
          // do not stream increments) keep the branch-one-shot-at-settlement
          // behavior untouched. The caller supplies runId (branch lineage).
          if (onBranchDelta !== undefined && event.kind === 'status-update' && event.status.state === 'working') {
            const preview = previewOf(event.status.data);
            if (preview !== undefined) {
              deltaSeq += 1;
              onBranchDelta({ seq: deltaSeq, preview, at: event.status.timestamp ?? new Date().toISOString() });
            }
          }
        });
      }
      if (buffer.length > maxEventBytes) {
        throw new A2AClientError(
          `${label} streamed ${buffer.length} bytes with no event terminator (limit ${maxEventBytes})`,
          -32000,
        );
      }
    }
  } catch (error) {
    // Do not leave the peer connection open when we bail out early.
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (!finalTask) throw new A2AClientError('stream ended without a final task snapshot', -32000);
  return finalTask;
}

/** Extract a preview string from a working frame's optional payload: a plain
 *  string is used as-is; an object's `preview` string is preferred; anything
 *  else is serialized. Capped so a talkative peer cannot grow the buffer. */
function previewOf(data: unknown): string | undefined {
  if (data === undefined || data === null) return undefined;
  if (typeof data === 'string') return data.slice(0, 4000);
  if (typeof data === 'object') {
    const maybe = (data as { preview?: unknown }).preview;
    if (typeof maybe === 'string') return maybe.slice(0, 4000);
  }
  const serialized = JSON.stringify(data);
  return serialized === undefined ? undefined : serialized.slice(0, 4000);
}

function emitSseEvent(rawEvent: string, emit: (result: A2AEvent | Task) => void): void {
  for (const line of rawEvent.split(/\r\n|\n|\r/)) {
    if (!line.startsWith('data: ')) continue;
    try {
      const payload = JSON.parse(line.slice(6)) as { result?: unknown };
      const result = payload?.result as A2AEvent | Task | undefined;
      if (result) emit(result);
    } catch {
      continue;
    }
  }
}
