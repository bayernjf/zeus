import type { BackendOptions, DecisionBackendError, DecisionBackendKind, DecisionTrace, QuestionBase } from './types.js';
import { DecisionBackendFailure } from './types.js';

/**
 * Apply the data-sovereignty hard lines (design §8) before any state leaves the
 * device: enterprise realm is refused by default; object state is reduced to the
 * explicit stateKeys whitelist (default empty); an optional redact hook runs last.
 * String state is treated as already-minimized instruction text (no fields to filter).
 */
export function prepareState(
  request: QuestionBase,
  options: BackendOptions
): { state: Record<string, unknown> | string; stateKeys: string[] } {
  if (request.realm === 'enterprise' && !options.allowEnterpriseExfiltration) {
    throw new DecisionBackendFailure(
      'invalid',
      'enterprise realm state is not sent to external decision backends by default (set allowEnterpriseExfiltration per skill)'
    );
  }
  if (typeof request.state === 'string') {
    return { state: request.state, stateKeys: [] };
  }
  const whitelist = options.stateKeys ?? [];
  const filtered: Record<string, unknown> = {};
  for (const key of whitelist) {
    if (key in request.state) filtered[key] = request.state[key];
  }
  const redacted = options.redact ? options.redact(filtered) : filtered;
  return { state: redacted, stateKeys: whitelist };
}

/** fetch with a hard timeout folded into the unified failure type. */
export async function timedFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchImpl: typeof fetch
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new DecisionBackendFailure('timeout', `decision backend timed out after ${timeoutMs}ms`);
    }
    if (error instanceof DecisionBackendFailure) throw error;
    throw new DecisionBackendFailure('unavailable', error instanceof Error ? error.message : 'network error');
  } finally {
    clearTimeout(timer);
  }
}

/** Fold HTTP status into the unified error taxonomy. Raw upstream detail is not propagated. */
export function failureFromStatus(status: number): DecisionBackendError {
  if (status === 401 || status === 403) return { code: 'auth', message: `decision backend auth failed (HTTP ${status})` };
  if (status === 408 || status === 504) return { code: 'timeout', message: `decision backend gateway timeout (HTTP ${status})` };
  return { code: 'unavailable', message: `decision backend returned HTTP ${status}` };
}

export function assertRanged(value: unknown, field: string): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new DecisionBackendFailure('invalid', `decision field ${field} must be a number in [0,1]`);
  }
  return n;
}

/** Rough token estimate (~4 chars/token) for audit-only cost accounting. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export type TraceSink = {
  emit(partial: Omit<DecisionTrace, 'decidedAt' | 'latencyMs'> & { latencyMs: number }): void;
};

export function createTraceSink(options: BackendOptions, now: () => Date, backend: DecisionBackendKind, model: string): TraceSink {
  return {
    emit(partial) {
      options.onTrace?.({ ...partial, decidedAt: now().toISOString() });
    },
  };
}
