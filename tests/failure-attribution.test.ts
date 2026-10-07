import { describe, expect, it } from 'vitest';
import { attributeFailures, participantsToEntries } from '../src/reflection/failure-attribution.js';
import type { AuditEntry } from '../src/dispatch/dispatcher.js';

function entry(partial: Partial<AuditEntry> & { decision: AuditEntry['decision']; vassal: string }): AuditEntry {
  return { ts: '2026-10-07T00:00:00.000Z', ...partial };
}

describe('failure attribution (deferred #40 read-only half)', () => {
  it('is empty and null-windowed on no input', () => {
    const out = attributeFailures([]);
    expect(out.window).toBeNull();
    expect(out.totals).toEqual({ entries: 0, failures: 0, failureRate: 0 });
    expect(out.byVassal).toEqual([]);
    expect(out.patterns).toEqual([]);
  });

  it('aggregates totals and categories across decisions', () => {
    const entries: AuditEntry[] = [
      entry({ vassal: 'a1', decision: 'dispatched' }),
      entry({ vassal: 'a1', decision: 'dispatch-failed', detail: 'ECONNREFUSED' }),
      entry({ vassal: 'a1', decision: 'dispatch-failed', detail: 'ECONNREFUSED' }),
      entry({ vassal: 'b1', decision: 'refused-data-policy', detail: 'origin unverifiable' }),
      entry({ vassal: 'b1', decision: 'domain-refused', detail: 'tenant mismatch' }),
      entry({ vassal: 'a1', decision: 'vassal-revoked' }), // governance: excluded
    ];
    const out = attributeFailures(entries);
    expect(out.totals.entries).toBe(6);
    expect(out.totals.failures).toBe(4);
    expect(out.totals.failureRate).toBeCloseTo(4 / 6);
    expect(out.byCategory).toEqual({ dispatch: 2, 'refused-policy': 2 });
    // a1: dispatched + 2 failures (revoked excluded) = 3 total
    const a1 = out.byVassal.find((v) => v.vassal === 'a1')!;
    expect(a1.total).toBe(3);
    expect(a1.failures).toBe(2);
    expect(a1.rate).toBeCloseTo(2 / 3);
    expect(a1.sampleReasons).toEqual(['ECONNREFUSED']);
  });

  it('derives window from entry timestamps', () => {
    const entries: AuditEntry[] = [
      entry({ ts: '2026-10-01T00:00:00.000Z', vassal: 'a', decision: 'dispatch-failed' }),
      entry({ ts: '2026-10-03T12:00:00.000Z', vassal: 'a', decision: 'dispatched' }),
    ];
    expect(attributeFailures(entries).window).toEqual({
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-03T12:00:00.000Z',
    });
  });

  it('marks a stable vassal-concentrated pattern and a writeback candidate', () => {
    const entries: AuditEntry[] = [
      entry({ vassal: 'flaky', decision: 'dispatched' }),
      entry({ vassal: 'flaky', decision: 'dispatch-failed', detail: 'ECONNREFUSED' }),
      entry({ vassal: 'flaky', decision: 'dispatch-failed', detail: 'ECONNREFUSED' }),
      entry({ vassal: 'flaky', decision: 'dispatch-failed', detail: 'ECONNREFUSED' }),
    ];
    const out = attributeFailures(entries);
    const pattern = out.patterns.find((p) => p.kind === 'vassal-concentrated')!;
    expect(pattern.target).toBe('flaky');
    expect(pattern.confidence).toBe('stable');
    expect(pattern.writebackCandidate).toBe(true);
    expect(out.patterns.some((p) => p.kind === 'reason-repeated')).toBe(true);
  });

  it('labels a weaker concentration as suggestive, not writeback-candidate', () => {
    const entries: AuditEntry[] = [
      entry({ vassal: 'mid', decision: 'dispatched' }),
      entry({ vassal: 'mid', decision: 'dispatched' }),
      entry({ vassal: 'mid', decision: 'dispatched' }),
      entry({ vassal: 'mid', decision: 'dispatch-failed' }),
      entry({ vassal: 'mid', decision: 'dispatch-failed' }),
    ];
    const out = attributeFailures(entries);
    const pattern = out.patterns.find((p) => p.kind === 'vassal-concentrated')!;
    expect(pattern.confidence).toBe('suggestive');
    expect(pattern.writebackCandidate).toBe(false);
  });

  it('flags a category-concentrated pattern at >= 50% of failures', () => {
    const entries: AuditEntry[] = [
      entry({ vassal: 'a', decision: 'refused-data-policy' }),
      entry({ vassal: 'b', decision: 'refused-data-policy' }),
      entry({ vassal: 'c', decision: 'refused-data-policy' }),
      entry({ vassal: 'd', decision: 'dispatch-failed' }),
      entry({ vassal: 'e', decision: 'dispatch-failed' }),
    ];
    const out = attributeFailures(entries);
    const pattern = out.patterns.find((p) => p.kind === 'category-concentrated')!;
    expect(pattern.target).toBe('refused-policy');
    expect(pattern.confidence).toBe('suggestive');
    expect(pattern.evidence[0]).toBe('3/5 failures are refused-policy');
  });

  it('does not emit patterns for pure governance traffic', () => {
    const entries: AuditEntry[] = [
      entry({ vassal: 'a', decision: 'vassal-revoked' }),
      entry({ vassal: 'b', decision: 'domain-grant-issued' }),
      entry({ vassal: 'c', decision: 'watch-registered' }),
    ];
    const out = attributeFailures(entries);
    expect(out.totals.failures).toBe(0);
    expect(out.patterns).toEqual([]);
    expect(out.byVassal).toEqual([]);
  });

  it('treats success decisions as ok and content-injected as tracking', () => {
    const entries: AuditEntry[] = [
      entry({ vassal: 'a', decision: 'dispatched' }),
      entry({ vassal: 'a', decision: 'domain-read' }),
      entry({ vassal: 'a', decision: 'realm-write' }),
      entry({ vassal: 'a', decision: 'content-injected', detail: 'policy recorded' }),
    ];
    const out = attributeFailures(entries);
    expect(out.totals.failures).toBe(0);
    expect(out.byVassal[0]!.total).toBe(3); // content-injected excluded
  });

  it('participantsToEntries maps replayed branch outcomes into audit entries', () => {
    const entries = participantsToEntries(
      [
        { vassal: 'a', ok: true },
        { vassal: 'b', ok: false, timedOut: true, reason: 'no ack within window' },
        { vassal: 'c', ok: false, reason: 'ECONNREFUSED' },
      ],
      { ts: '2026-10-07T01:00:00.000Z', runId: 'r1', skill: 'research' },
    );
    expect(entries.map((e) => e.decision)).toEqual(['dispatched', 'sla-ack-breached', 'dispatch-failed']);
    const out = attributeFailures(entries);
    expect(out.totals.failures).toBe(2);
    expect(out.byCategory).toEqual({ ack: 1, dispatch: 1 });
    expect(entries[2]!.detail).toBe('ECONNREFUSED');
  });

  it('sorts vassals deterministically by failures desc then name', () => {
    const entries: AuditEntry[] = [
      entry({ vassal: 'z', decision: 'dispatch-failed' }),
      entry({ vassal: 'a', decision: 'dispatch-failed' }),
      entry({ vassal: 'a', decision: 'dispatch-failed' }),
    ];
    expect(attributeFailures(entries).byVassal.map((v) => v.vassal)).toEqual(['a', 'z']);
  });
});
