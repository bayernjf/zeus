/**
 * T-M7-01 tool authority guard unit tests. Any tool outside the position's
 * allow-list must fail closed.
 */
import { describe, expect, it } from 'vitest';
import {
  assertToolGranted,
  grantedSubset,
  isToolGranted,
} from './tool-guard.js';
import { ToolDeniedError } from './errors.js';

describe('tool authority guard', () => {
  const granted = ['listing.publish', 'refund.issue'];

  it('admits granted tools and rejects anything else', () => {
    expect(isToolGranted('listing.publish', granted)).toBe(true);
    expect(isToolGranted('payment.drain', granted)).toBe(false);
  });

  it('assertToolGranted throws ToolDeniedError naming the tool and the grant set', () => {
    expect(() => assertToolGranted('payment.drain', granted)).toThrow(ToolDeniedError);
    try {
      assertToolGranted('payment.drain', granted);
    } catch (e) {
      expect(e).toBeInstanceOf(ToolDeniedError);
      expect((e as ToolDeniedError).tool).toBe('payment.drain');
      expect((e as ToolDeniedError).grantedTools).toEqual(granted);
    }
  });

  it('denies every tool when the position grants none', () => {
    expect(() => assertToolGranted('listing.publish', [])).toThrow(ToolDeniedError);
  });

  it('filters a candidate set down to the granted subset', () => {
    expect(grantedSubset(['listing.publish', 'x', 'refund.issue'], granted)).toEqual([
      'listing.publish',
      'refund.issue',
    ]);
    expect(grantedSubset(['a', 'b'], granted)).toEqual([]);
  });
});
