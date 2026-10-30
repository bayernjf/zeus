import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { redactText } from '../util/logger.js';
import type { DecisionTrace } from '../decision/types.js';

/**
 * Per-call decision ledger (TracePort v1 §6, W2-1).
 *
 * DecisionTrace already computes tokens/latency/cost per model call, but in
 * production it had no subscriber — the values evaporated. This sink lands
 * them as append-only JSONL (0600). Payload rules follow D-4: redactText on
 * every free-text field, a 2048-byte truncation bound, and no full prompt
 * bodies — full context stays reconstructible through the intent replay API
 * by runId.
 */

const MAX_FIELD_BYTES = 2048;

function clip(value: string): string {
  const redacted = redactText(value);
  if (redacted.length <= MAX_FIELD_BYTES) return redacted;
  return `${redacted.slice(0, MAX_FIELD_BYTES)}…(truncated, ${redacted.length} bytes; full context via replay by runId)`;
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

export interface DecisionTraceRecord {
  runId: string;
  backend: string;
  model: string;
  kind: string;
  question: string;
  result?: string;
  error?: string;
  tokens_in: number;
  tokens_out: number;
  reasoning_tokens?: number;
  cache_read_tokens?: number;
  /** True when token counts came from the ~4 chars/token estimate. */
  tokens_estimated?: boolean;
  /** Family-wide cost unit (TracePort v1 §2); DecisionTrace computes cents. */
  cost_micros: number | null;
  latency_ms: number;
  decided_at: string;
}

export function createDecisionTraceSink(filePath: string): {
  onTrace: (trace: DecisionTrace) => void;
} {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const onTrace = (trace: DecisionTrace): void => {
    const record: DecisionTraceRecord = {
      runId: trace.runId,
      backend: trace.backend,
      model: trace.model,
      kind: trace.request.kind,
      question: clip(trace.request.question),
      ...(trace.result !== undefined ? { result: clip(stringifyValue(trace.result)) } : {}),
      ...(trace.error !== undefined ? { error: clip(stringifyValue(trace.error)) } : {}),
      // TracePort v1 §2: token counts come from the provider usage block when
      // present, falling back to the cost block's audit estimate.
      tokens_in: trace.usage?.inputTokens ?? trace.cost?.inputTokens ?? 0,
      tokens_out: trace.usage?.outputTokens ?? trace.cost?.outputTokens ?? 0,
      ...(trace.usage?.reasoningTokens !== undefined ? { reasoning_tokens: trace.usage.reasoningTokens } : {}),
      ...(trace.usage?.cacheReadTokens !== undefined ? { cache_read_tokens: trace.usage.cacheReadTokens } : {}),
      ...(trace.usage?.tokensEstimated ? { tokens_estimated: true } : {}),
      cost_micros: trace.cost ? Math.round(trace.cost.cents * 10_000) : null,
      latency_ms: trace.latencyMs,
      decided_at: trace.decidedAt,
    };
    // Mode applies on create; the parent directory is 0700 above.
    appendFileSync(filePath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  };
  return { onTrace };
}
