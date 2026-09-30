import { describe, expect, it } from 'vitest';
import { AUDIT_DECISIONS } from '../src/dispatch/dispatcher.js';
import { auditToken, makePalette, paintStatus, statusToken } from '../src/tui/tokens.js';

describe('TUI semantic tokens (design-ui-foundations §3.2)', () => {
  it('maps each kernel/API status to exactly one known semantic token', () => {
    for (const status of [
      'running',
      'working',
      'completed',
      'partial',
      'failed',
      'needs-driver',
      'input-required',
      'active',
      'revoked',
    ]) {
      const resolved = statusToken(status);
      expect(resolved.known, status).toBe(true);
      expect(resolved.token).not.toBe('unknown');
    }
  });

  it('falls back to the unknown token for an unmapped status instead of inventing one', () => {
    expect(statusToken('some-future-state')).toEqual({ token: 'unknown', known: false });
  });

  it('emits no ANSI escapes when color is disabled or NO_COLOR applies', () => {
    const off = makePalette(false);
    expect(off.paint('danger', 'x')).toBe('x');
    expect(off.bold('x')).toBe('x');
    expect(paintStatus(off, 'failed', '失败')).toBe('失败');
  });

  it('wraps colored output in a single SGR open/reset pair', () => {
    const on = makePalette(true);
    const painted = on.paint('success', 'ok');
    expect(painted.startsWith('\x1b[32m')).toBe(true);
    expect(painted.endsWith('\x1b[0m')).toBe(true);
    expect(painted).not.toContain('#');
  });

  it('maps every audit decision the kernel can emit to a known semantic token', () => {
    expect(AUDIT_DECISIONS.length).toBeGreaterThan(20);
    for (const decision of AUDIT_DECISIONS) {
      const resolved = auditToken(decision);
      expect(resolved.known, decision).toBe(true);
      expect(resolved.token).not.toBe('unknown');
    }
  });

  it('falls back to the unknown token for an unmapped audit decision', () => {
    expect(auditToken('some-future-decision')).toEqual({ token: 'unknown', known: false });
  });
});
