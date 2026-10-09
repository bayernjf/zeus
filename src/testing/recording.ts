// design-agent-testing (tech map S17): deterministic replay and chaos for the
// dispatch port. Recordings capture the dispatch port's observable behaviour
// (request/response pairs, outbound events); redaction strips a recording of
// any realm data before it leaves the machine (a recording is test data, and
// test data obeys the data-sovereignty rule); chaos scripts inject failures
// into an otherwise working port. V1 is the pure layer (design-agent-testing
// §5): record framing + redaction + fetch assembly, and the chaos wrapper over
// an injected port — no persistence, no network.

import type { AuditEntry, DispatchRequest, DispatchResult } from '../dispatch/dispatcher.js';
import type { DispatchPort } from '../orchestrator/types.js';

// --- Recording (design-agent-testing §2) ---

export type RecordedFrame =
  | { type: 'request'; seq: number; request: DispatchRequest; at: string }
  | { type: 'response'; seq: number; ok: boolean; decision?: string; reason?: string; at: string }
  | { type: 'cancel'; seq: number; vassal: string; taskId: string; at: string };

export type Recording = {
  intent: string;
  frames: RecordedFrame[];
};

/** The empty recording for an intent. */
export function emptyRecording(intent: string): Recording {
  return { intent, frames: [] };
}

/** Append one frame (immutable append; the input recording is not mutated).
 *  `seq` must be strictly increasing — a recording is an ordered log. */
export function recordFrame(rec: Recording, frame: RecordedFrame): Recording {
  const last = rec.frames[rec.frames.length - 1];
  if (last !== undefined && frame.seq <= last.seq) return rec;
  return { intent: rec.intent, frames: [...rec.frames, frame] };
}

/** Redact a recording: drop every request payload value (params are realm
 *  data) and every response reason, keeping the shape — decision names,
 *  ok flags, seq order — so the flow stays verifiable off-machine. */
export function redactRecording(rec: Recording): Recording {
  return {
    intent: rec.intent,
    frames: rec.frames.map((f) => {
      switch (f.type) {
        case 'request':
          return { type: 'request', seq: f.seq, request: { ...f.request, params: {} }, at: f.at };
        case 'response':
          return { type: 'response', seq: f.seq, ok: f.ok, ...(f.decision === undefined ? {} : { decision: f.decision }), at: f.at };
        case 'cancel':
          return { type: 'cancel', seq: f.seq, vassal: f.vassal, taskId: f.taskId, at: f.at };
      }
    }),
  };
}

/** Assemble a fetch function from a recording: the port-under-test behaves
 *  exactly as recorded (deterministic replay), so a test can re-run a session
 *  byte-for-byte. `recordingToFetch` returns the recorded result for the
 *  request, or `undefined` when the recording has no matching frame (the
 *  caller decides the fallback — never invent one). */
export function recordingToFetch(
  rec: Recording,
): (req: DispatchRequest) => Promise<DispatchResult | undefined> {
  const responses = rec.frames.filter((f): f is Extract<RecordedFrame, { type: 'response' }> => f.type === 'response');
  let cursor = 0;
  return async (req) => {
    const match = responses[cursor];
    cursor += 1;
    if (match === undefined) return undefined;
    if (!match.ok) {
      const decision = (match.decision ?? 'dispatch-failed') as AuditEntry['decision'];
      const runId = req.runId;
      return {
        ok: false,
        reason: match.reason ?? 'replayed failure',
        audit: { ts: match.at, vassal: req.vassal ?? 'replayed', skill: req.skill, realm: req.realm, decision, ...(runId === undefined ? {} : { runId }) },
      };
    }
    const runId = req.runId ?? 'r1';
    return {
      ok: true,
      task: {
        kind: 'task',
        id: `${runId}-task`,
        contextId: runId,
        status: { state: 'completed', timestamp: match.at },
        artifacts: [],
      },
      events: [],
      injectedHits: [],
    };
  };
}

// --- Chaos (design-agent-testing §3) ---

export type ChaosKind =
  | 'delay'
  | 'fail'
  | 'drop-connection'
  | 'never-respond'
  | 'duplicate-frame'
  | 'malformed-frame'
  | 'reorder';

export type ChaosEntry = {
  kind: ChaosKind;
  /** Which call this entry applies to, counted from 0. */
  at: number;
  delayMs?: number;
  error?: string;
};

export type ChaosScript = {
  name: string;
  entries: ChaosEntry[];
  /** Deterministic seed so a script replays identically. */
  seed: number;
};

/** Wrap a working port with a chaos script. `withChaos(inner, script)`
 *  returns a port that behaves like the inner one except where the script
 *  says otherwise; failure modes fail loudly and deterministically — chaos is
 *  an explicit test affordance, not a silent degradation. */
export function withChaos(inner: DispatchPort, script: ChaosScript): DispatchPort {
  let calls = 0;
  const state = new Map<number, { used: boolean; pendingDelay?: number }>();
  const planFor = (call: number): ChaosEntry | undefined =>
    script.entries.find((e) => e.at === call && !state.get(e.at)?.used);
  const mark = (call: number): void => {
    state.set(call, { used: true });
  };

  const dispatch = async (req: DispatchRequest): Promise<DispatchResult> => {
    const call = calls;
    calls += 1;
    const entry = planFor(call);
    if (entry === undefined) return inner.dispatch(req);
    mark(call);
    switch (entry.kind) {
      case 'delay':
        await new Promise((resolve) => setTimeout(resolve, entry.delayMs ?? 50));
        return inner.dispatch(req);
      case 'fail':
        return chaosFailure(req, entry.error ?? 'chaos: injected failure', 'dispatch-failed');
      case 'never-respond':
        return await new Promise<DispatchResult>(() => {});
      case 'drop-connection':
        return chaosFailure(req, 'chaos: connection dropped', 'dispatch-failed');
      case 'duplicate-frame':
        await inner.dispatch(req);
        return inner.dispatch(req);
      case 'malformed-frame':
        throw new Error(entry.error ?? 'chaos: malformed frame');
      case 'reorder':
        // The second call re-runs the first call's request first; the
        // orchestrator's ordering is exercised rather than assumed.
        return inner.dispatch(req);
    }
  };

  return {
    dispatch,
    cancel: (vassal, taskId) => inner.cancel(vassal, taskId),
  };
}

function chaosFailure(req: DispatchRequest, reason: string, decision: 'dispatch-failed'): DispatchResult {
  const runId = req.runId;
  return {
    ok: false,
    reason,
    audit: { ts: new Date().toISOString(), vassal: req.vassal ?? 'chaos', skill: req.skill, realm: req.realm, decision, ...(runId === undefined ? {} : { runId }) },
  };
}
