/**
 * Tier0 M7 (T-M7-01) — hardened execution runner.
 *
 * Runs an OrgTaskExecutorV2 under framework-enforced limits and returns a
 * terminal settlement. The executor cannot bypass these limits because every
 * effect it produces goes through the context supplied here:
 *
 *   - tool authority: ctx.tool denies anything outside position.allowedTools
 *     (ToolDeniedError → failed/tool_denied, never retried);
 *   - deadline: a single task-level wall-clock budget races the run and is
 *     checked at every context hook; once elapsed, the abort controller fires
 *     and all further effects are refused (failed/timeout, never retried);
 *   - retry budget: only ExecutorError('retryable') and unknown throws are
 *     retried, with bounded exponential backoff; business failures, tool
 *     denials and timeouts settle immediately; exhausting the budget yields
 *     failed/retryable_exhausted;
 *   - idempotency: ctx.action caches by key and requestDecision requires a
 *     stable idempotency key, so retry / replay never repeats a channel effect
 *     or a decision;
 *   - decisions: an auto-decided record resolves and run continues; a blocked
 *     record suspends (awaiting_decision) and resume replays the resolved
 *     decision by key.
 *
 * Pure in-memory in this slice; timing is injected (the default timer is
 * unref'd and cancelled), which makes all five settlements deterministic
 * under test without dangling timers.
 */
import {
  CheckpointSuspension,
  ExecutorError,
  ExecutorTimeoutError,
  ToolDeniedError,
  type TaskFailureKind,
} from './errors.js';
import {
  DEFAULT_RETRY_POLICY,
  DEFAULT_TASK_DEADLINE_MS,
  backoffDelayMs,
  canRetry,
  deadlineExceeded,
  validateRetryPolicy,
} from './backoff.js';
import { assertToolGranted } from './tool-guard.js';
import {
  InMemoryActionStore,
  type ActionResultStore,
  type EffectResult,
  type ExecutorContext,
  type ExecutorDecisionRequest,
  type RunTaskParams,
  type StoredProgress,
  type TaskSettlement,
  type WaitHandle,
} from './contract.js';

type Failed = Extract<TaskSettlement, { outcome: 'failed' }>;

function failed(failureKind: TaskFailureKind, error: string, attempts: number): Failed {
  return { outcome: 'failed', failureKind, error, attempts };
}

/** Default cancellable timer: unref'd so an escaped timer never blocks exit. */
function defaultWait(ms: number): WaitHandle {
  let handle: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  const promise = new Promise<void>(resolve => {
    handle = setTimeout(() => {
      if (!cancelled) resolve();
    }, ms);
    handle.unref?.();
  });
  return {
    promise,
    cancel() {
      cancelled = true;
      if (handle !== undefined) clearTimeout(handle);
    },
  };
}

export async function runTask(params: RunTaskParams): Promise<TaskSettlement> {
  const { task, position, agentId, executor, decisions } = params;
  const retryPolicy = params.retryPolicy ?? DEFAULT_RETRY_POLICY;
  const policyProblem = validateRetryPolicy(retryPolicy);
  if (policyProblem) throw new Error(`invalid retry policy: ${policyProblem}`);

  const deadlineMs = params.deadlineMs ?? DEFAULT_TASK_DEADLINE_MS;
  const nowMs = params.nowMs ?? (() => Date.now());
  const iso = params.iso ?? (() => new Date().toISOString());
  const wait = params.wait ?? defaultWait;
  const rng = params.rng ?? Math.random;
  const actionStore: ActionResultStore = params.actionStore ?? new InMemoryActionStore();
  const grantedTools = position.allowedTools;
  const credentialRefs = params.credentialRefs ?? [];

  const startedAt = nowMs();
  const elapsed = () => nowMs() - startedAt;
  const remaining = () => Math.max(0, deadlineMs - elapsed());

  const controller = new AbortController();
  const externalAbort = params.abort;
  if (externalAbort) {
    if (externalAbort.aborted) controller.abort();
    else externalAbort.addEventListener('abort', () => controller.abort(), { once: true });
  }

  const assertLive = (): void => {
    if (controller.signal.aborted || externalAbort?.aborted) {
      throw new ExecutorTimeoutError(deadlineMs, elapsed());
    }
    if (deadlineExceeded(startedAt, nowMs(), deadlineMs)) {
      controller.abort();
      throw new ExecutorTimeoutError(deadlineMs, elapsed());
    }
  };

  // Decisions already resolved within this run (auto-decided or the resume
  // decision), keyed by idempotencyKey for replay.
  const resolvedDecisions = new Map<string, import('../../decision-service/types.js').DecisionRecord>();
  if (params.lastDecision?.idempotencyKey) {
    resolvedDecisions.set(params.lastDecision.idempotencyKey, params.lastDecision);
  }

  // Progress accumulates across attempts (a recovery point survives a retry).
  const allProgress: StoredProgress[] = [];

  let attempts = 0;
  for (let attempt = 0; attempt < retryPolicy.maxAttempts; attempt++) {
    attempts = attempt + 1;
    assertLive();

    let ctx!: ExecutorContext;
    ctx = {
      task,
      position,
      agentId,
      resumed: (params.resumed ?? false) || attempt > 0,
      allowedTools: grantedTools,
      credentialRefs,
      signal: controller.signal,
      get remainingMs() {
        return remaining();
      },
      reportProgress(p) {
        assertLive();
        const stored: StoredProgress = { ...p, at: iso() };
        allProgress.push(stored);
        params.onProgress?.(stored);
      },
      async requestDecision(req: ExecutorDecisionRequest) {
        assertLive();
        const key = req.idempotencyKey;
        if (typeof key !== 'string' || key.trim() === '') {
          // Idempotency is mandatory at decision points so resume/replay can
          // return the same record instead of creating duplicate decisions.
          throw ExecutorError.business('requestDecision requires a non-empty idempotencyKey', {
            detail: { intent: req.intent },
          });
        }
        const cached = resolvedDecisions.get(key);
        if (cached) return cached;
        const domain = req.domain ?? `org:${task.organizationId}`;
        const decision = await decisions.createDecision({ ...req, domain });
        assertLive();
        if (decision.status === 'decided') {
          resolvedDecisions.set(key, decision);
          return decision;
        }
        // blocked / awaiting_approval → suspend; the runner persists the pause.
        throw new CheckpointSuspension(decision);
      },
      async tool<T extends EffectResult = EffectResult>(
        name: string,
        args: Record<string, unknown>,
      ): Promise<T> {
        assertLive();
        assertToolGranted(name, grantedTools);
        if (!params.toolInvoker) throw new ToolDeniedError(name, grantedTools);
        const value = await params.toolInvoker.invoke(name, args, ctx);
        assertLive();
        return value as T;
      },
      async action<T extends EffectResult = EffectResult>(
        key: string,
        fn: () => Promise<T>,
      ): Promise<T> {
        assertLive();
        if (typeof key !== 'string' || key.trim() === '') {
          throw ExecutorError.business('ctx.action requires a non-empty idempotency key');
        }
        const existing = actionStore.get(key);
        if (existing.ok) return existing.value as T;
        const value = await fn();
        assertLive();
        actionStore.put(key, value);
        return value;
      },
    };

    // Race the whole run against the remaining budget. The wait handle is
    // cancelled once the run settles, so no timer lingers. An executor that
    // never cooperates with the signal still loses the race when it awaits.
    const deadlineWait = wait(remaining());
    let deadlineFired = false;
    const deadlinePromise = deadlineWait.promise.then(() => {
      deadlineFired = true;
      controller.abort();
      throw new ExecutorTimeoutError(deadlineMs, elapsed());
    });

    try {
      const completion = await Promise.race([executor.run(ctx), deadlinePromise]);
      assertLive();
      deadlineWait.cancel();
      return {
        outcome: 'complete',
        ...(completion.result !== undefined ? { result: completion.result } : {}),
        attempts,
      };
    } catch (thrown) {
      deadlineWait.cancel();
      void deadlineFired;

      if (thrown instanceof CheckpointSuspension) {
        return { outcome: 'awaiting_decision', decision: thrown.decision, attempts };
      }
      if (thrown instanceof ToolDeniedError) {
        return failed('tool_denied', thrown.message, attempts);
      }
      if (thrown instanceof ExecutorTimeoutError) {
        return failed('timeout', thrown.message, attempts);
      }
      if (thrown instanceof ExecutorError && thrown.kind === 'business') {
        return failed('business', thrown.message, attempts);
      }

      // Retryable: ExecutorError('retryable') or any unknown throw.
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      if (!canRetry(retryPolicy, attempt + 1)) {
        return failed('retryable_exhausted', message, attempts);
      }
      assertLive();
      const backoff = wait(backoffDelayMs(retryPolicy, attempt, rng));
      await backoff.promise;
      backoff.cancel();
      assertLive();
      continue;
    }
  }

  // Defensive: loop exhausted without returning (covered by the checks above).
  return failed('retryable_exhausted', 'retry budget exhausted', attempts);
}
