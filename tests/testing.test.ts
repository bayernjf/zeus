// design-agent-testing (tech map S17) V1: recording (frame log, immutable
// append, redaction, fetch assembly) and chaos (scripted failure modes over a
// working port). Acceptance (design-agent-testing §5): a redacted recording
// carries no realm data (params are emptied, reasons dropped) while the flow
// shape survives; replay honours frame order; chaos entries fire once, at the
// scripted call index; failure modes fail loudly and deterministically; the
// input recording is never mutated; zero runtime behaviour change (V1 is the
// pure layer only).

import { describe, expect, it } from 'vitest';
import { emptyRecording, recordFrame, redactRecording, recordingToFetch, withChaos } from '../src/testing/recording.js';
import type { DispatchPort } from '../src/orchestrator/types.js';
import type { DispatchRequest } from '../src/dispatch/dispatcher.js';

const okResult = (req: DispatchRequest) => ({
  ok: true as const,
  task: { kind: 'task' as const, id: `${req.runId ?? 'r1'}-task`, contextId: req.runId ?? 'r1', status: { state: 'completed' as const, timestamp: 't0' }, artifacts: [] },
  events: [],
  injectedHits: [],
});

const request = (overrides: Partial<DispatchRequest> = {}): DispatchRequest => ({
  skill: 'research', params: { query: 'sensitive payload' }, realm: 'personal', runId: 'r1', ...overrides,
});

describe('recording (S17 V1)', () => {
  it('appends frames in seq order and never mutates the input', () => {
    const rec = emptyRecording('intent-1');
    const r1 = recordFrame(rec, { type: 'request', seq: 1, request: request(), at: 't0' });
    const r2 = recordFrame(r1, { type: 'response', seq: 2, ok: true, at: 't1' });
    expect(rec.frames).toHaveLength(0);
    expect(r2.frames).toHaveLength(2);
    expect(r2.frames.map((f) => f.seq)).toEqual([1, 2]);
  });

  it('refuses an out-of-order frame', () => {
    let rec = emptyRecording('intent-1');
    rec = recordFrame(rec, { type: 'request', seq: 2, request: request(), at: 't0' });
    const before = rec;
    rec = recordFrame(rec, { type: 'request', seq: 1, request: request(), at: 't0' });
    expect(rec).toBe(before);
  });

  it('redaction empties params and drops reasons but keeps the flow shape', () => {
    const rec = emptyRecording('intent-1');
    const full = recordFrame(
      recordFrame(rec, { type: 'request', seq: 1, request: request({ params: { query: 'secret' } }), at: 't0' }),
      { type: 'response', seq: 2, ok: false, decision: 'refused-realm-policy', reason: 'domain mismatch for secret', at: 't1' },
    );
    const redacted = redactRecording(full);
    const req = redacted.frames.find((f): f is Extract<typeof f, { type: 'request' }> => f.type === 'request');
    const res = redacted.frames.find((f): f is Extract<typeof f, { type: 'response' }> => f.type === 'response');
    expect(req!.request.params).toEqual({});
    expect(JSON.stringify(redacted)).not.toContain('secret');
    expect(res).toMatchObject({ ok: false, decision: 'refused-realm-policy' });
    expect(res!.reason).toBeUndefined();
    expect(redacted.frames.map((f) => f.seq)).toEqual([1, 2]);
  });

  it('replays recorded responses in frame order via recordingToFetch', async () => {
    const rec = emptyRecording('intent-1');
    const full = recordFrame(
      recordFrame(rec, { type: 'request', seq: 1, request: request(), at: 't0' }),
      { type: 'response', seq: 2, ok: true, at: 't1' },
    );
    const fetch = recordingToFetch(full);
    const first = await fetch(request());
    const second = await fetch(request());
    expect(first?.ok).toBe(true);
    expect(second).toBeUndefined(); // recording exhausted — nothing invented
  });

  it('honours a recorded failure with its decision and reason', async () => {
    const rec = emptyRecording('intent-1');
    const full = recordFrame(
      recordFrame(rec, { type: 'request', seq: 1, request: request(), at: 't0' }),
      { type: 'response', seq: 2, ok: false, decision: 'refused-realm-policy', reason: 'policy', at: 't1' },
    );
    const fetch = recordingToFetch(full);
    const result = await fetch(request());
    expect(result).toMatchObject({ ok: false, reason: 'policy' });
    if (result !== undefined && !result.ok) expect(result.audit.decision).toBe('refused-realm-policy');
  });
});

describe('withChaos (S17 V1)', () => {
  function workingPort(): DispatchPort {
    return {
      dispatch: async (req) => okResult(req),
      cancel: async () => undefined,
    };
  }

  it('passes through calls that the script does not target', async () => {
    const port = withChaos(workingPort(), { name: 'empty', entries: [], seed: 1 });
    const r = await port.dispatch(request());
    expect(r.ok).toBe(true);
  });

  it('fails the scripted call with an injected error and only once', async () => {
    const port = withChaos(workingPort(), { name: 'fail-once', entries: [{ kind: 'fail', at: 0, error: 'boom' }], seed: 1 });
    const r0 = await port.dispatch(request());
    expect(r0).toMatchObject({ ok: false, reason: 'boom' });
    const r1 = await port.dispatch(request());
    expect(r1.ok).toBe(true);
  });

  it('injects delay before the scripted call', async () => {
    let innerCalledAt = 0;
    const inner: DispatchPort = {
      dispatch: async (req) => {
        innerCalledAt = Date.now();
        return okResult(req);
      },
      cancel: async () => undefined,
    };
    const port = withChaos(inner, { name: 'delay', entries: [{ kind: 'delay', at: 0, delayMs: 30 }], seed: 1 });
    const started = Date.now();
    await port.dispatch(request());
    expect(innerCalledAt - started).toBeGreaterThanOrEqual(28);
  });

  it('never-respond hangs the scripted call (and only that call)', async () => {
    const port = withChaos(workingPort(), { name: 'hang', entries: [{ kind: 'never-respond', at: 1 }], seed: 1 });
    const first = await port.dispatch(request());
    expect(first.ok).toBe(true);
    let hung = false;
    await Promise.race([
      port.dispatch(request()).then(() => undefined),
      new Promise((resolve) => setTimeout(() => { hung = true; resolve(undefined); }, 30)),
    ]);
    expect(hung).toBe(true);
  });

  it('throws a malformed-frame error loudly', async () => {
    const port = withChaos(workingPort(), { name: 'malformed', entries: [{ kind: 'malformed-frame', at: 0, error: 'bad envelope' }], seed: 1 });
    await expect(port.dispatch(request())).rejects.toThrow('bad envelope');
  });
});
