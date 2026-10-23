/**
 * T-M7-01 bounded retry / deadline policy unit tests. Deterministic: rng is
 * injected, so backoff numbers are exact.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RETRY_POLICY,
  backoffDelayMs,
  canRetry,
  deadlineExceeded,
  remainingBudgetMs,
  validateRetryPolicy,
} from './backoff.js';

describe('backoffDelayMs', () => {
  const p = { maxAttempts: 4, baseBackoffMs: 100, maxBackoffMs: 1000, factor: 2, jitter: 0.2 };

  it('grows exponentially with no jitter when rng=0', () => {
    expect(backoffDelayMs(p, 0, () => 0)).toBe(100);
    expect(backoffDelayMs(p, 1, () => 0)).toBe(200);
    expect(backoffDelayMs(p, 2, () => 0)).toBe(400);
    expect(backoffDelayMs(p, 3, () => 0)).toBe(800);
  });

  it('caps at maxBackoffMs', () => {
    const capped = { ...p, maxBackoffMs: 300 };
    expect(backoffDelayMs(capped, 3, () => 0)).toBe(300);
  });

  it('adds jitter bounded by the jitter fraction', () => {
    const noJitter = backoffDelayMs(p, 1, () => 0);
    const maxJitter = backoffDelayMs(p, 1, () => 1);
    expect(noJitter).toBe(200);
    expect(maxJitter).toBe(240); // 200 + 20% of 200
  });

  it('returns 0 when no retry is configured', () => {
    expect(backoffDelayMs({ ...p, maxAttempts: 1 }, 0)).toBe(0);
  });
});

describe('canRetry', () => {
  it('allows attempts while failures stay below maxAttempts', () => {
    expect(canRetry(DEFAULT_RETRY_POLICY, 1)).toBe(true); // 1 failed, 2 left
    expect(canRetry(DEFAULT_RETRY_POLICY, 2)).toBe(true); // 2 failed, 1 left
    expect(canRetry(DEFAULT_RETRY_POLICY, 3)).toBe(false); // budget spent
  });
});

describe('deadline math', () => {
  it('flags an elapsed deadline and never returns a negative remaining budget', () => {
    expect(deadlineExceeded(0, 100, 500)).toBe(false);
    expect(deadlineExceeded(0, 500, 500)).toBe(true);
    expect(deadlineExceeded(0, 900, 500)).toBe(true);
    expect(remainingBudgetMs(100, 300, 500)).toBe(300);
    expect(remainingBudgetMs(100, 900, 500)).toBe(0);
  });

  it('a negative deadline means no deadline', () => {
    expect(deadlineExceeded(0, 999_999, -1)).toBe(false);
  });
});

describe('validateRetryPolicy', () => {
  it('accepts the default policy', () => {
    expect(validateRetryPolicy(DEFAULT_RETRY_POLICY)).toBeUndefined();
  });

  it('rejects non-positive or non-integer attempts', () => {
    expect(validateRetryPolicy({ ...DEFAULT_RETRY_POLICY, maxAttempts: 0 })).toBeTruthy();
    expect(validateRetryPolicy({ ...DEFAULT_RETRY_POLICY, maxAttempts: 1.5 })).toBeTruthy();
  });

  it('rejects inverted or negative backoff', () => {
    expect(validateRetryPolicy({ ...DEFAULT_RETRY_POLICY, baseBackoffMs: -1 })).toBeTruthy();
    expect(
      validateRetryPolicy({ ...DEFAULT_RETRY_POLICY, baseBackoffMs: 100, maxBackoffMs: 50 }),
    ).toBeTruthy();
  });

  it('rejects factor below 1 and out-of-range jitter', () => {
    expect(validateRetryPolicy({ ...DEFAULT_RETRY_POLICY, factor: 0.5 })).toBeTruthy();
    expect(validateRetryPolicy({ ...DEFAULT_RETRY_POLICY, jitter: 2 })).toBeTruthy();
  });
});
