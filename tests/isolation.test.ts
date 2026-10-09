// design-sandbox (tech map S16) V1: classifyIsolation + validateIsolation pure
// functions. Test coverage per design-sandbox §5 acceptance: four-level
// decision positives/negatives, fs over-authorization refused, direct network
// only under L-container, L-container without a runtime refused (never a silent
// downgrade), and L-remote unconstrained by host measures.

import { describe, expect, it } from 'vitest';
import {
  classifyIsolation,
  type IsolationManifest,
  validateIsolation,
} from '../src/mcp/isolation.js';

function manifest(overrides: Partial<IsolationManifest> = {}): IsolationManifest {
  return {
    fs: { read: ['realm-docs'], write: [] },
    network: 'off',
    resources: { cpuShares: 2, memoryMb: 512 },
    exec: { command: '/usr/local/bin/server', args: ['--stdio'], envAllowList: ['PATH'] },
    ...overrides,
  };
}

describe('classifyIsolation (S16 V1)', () => {
  it('maps http transports to L-remote regardless of tier or declaration', () => {
    for (const tier of ['tier-0', 'tier-1', 'tier-2', 'tier-3'] as const) {
      expect(classifyIsolation({ transport: 'http', tier, manifest: manifest({ network: 'direct' }) })).toBe('L-remote');
    }
  });

  it('requires container isolation for direct network on stdio bodies', () => {
    const level = classifyIsolation({ transport: 'stdio', tier: 'tier-3', manifest: manifest({ network: 'direct' }) });
    expect(level).toBe('L-container');
  });

  it('maps signature-verified local bodies to L-process', () => {
    expect(classifyIsolation({ transport: 'stdio', tier: 'tier-3', manifest: manifest() })).toBe('L-process');
  });

  it('maps shape/roster-trust local bodies to L-process-restricted', () => {
    expect(classifyIsolation({ transport: 'stdio', tier: 'tier-1', manifest: manifest() })).toBe('L-process-restricted');
    expect(classifyIsolation({ transport: 'stdio', tier: 'tier-2', manifest: manifest() })).toBe('L-process-restricted');
  });

  it('maps the never-reached tier-0 defensively to L-container', () => {
    expect(classifyIsolation({ transport: 'stdio', tier: 'tier-0', manifest: manifest() })).toBe('L-container');
  });
});

describe('validateIsolation (S16 V1)', () => {
  it('passes a declaration fully inside the authorized face', () => {
    const r = validateIsolation({
      level: 'L-process-restricted',
      manifest: manifest({ fs: { read: ['realm-docs'], write: ['realm-drafts'] } }),
      authorizedRealms: ['realm-docs', 'realm-drafts'],
      containerRuntimeAvailable: false,
    });
    expect(r).toEqual({ ok: true });
  });

  it('refuses when the fs face extends beyond the authorized Realms', () => {
    const r = validateIsolation({
      level: 'L-process',
      manifest: manifest({ fs: { read: ['realm-docs', 'home-anywhere'], write: [] } }),
      authorizedRealms: ['realm-docs'],
      containerRuntimeAvailable: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join(' ')).toContain('home-anywhere');
  });

  it('refuses direct network outside container isolation', () => {
    const r = validateIsolation({
      level: 'L-process-restricted',
      manifest: manifest({ network: 'direct' }),
      authorizedRealms: ['realm-docs'],
      containerRuntimeAvailable: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join(' ')).toContain('direct network requires container isolation');
  });

  it('never downgrades: L-container without a runtime is refused, not run at L-process', () => {
    const r = validateIsolation({
      level: 'L-container',
      manifest: manifest({ network: 'direct' }),
      authorizedRealms: ['realm-docs'],
      containerRuntimeAvailable: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join(' ')).toContain('container runtime unavailable');
  });

  it('passes L-container when the runtime is available and the face is inside the Realms', () => {
    const r = validateIsolation({
      level: 'L-container',
      manifest: manifest({ network: 'direct', fs: { read: ['realm-docs'], write: [] } }),
      authorizedRealms: ['realm-docs'],
      containerRuntimeAvailable: true,
    });
    expect(r).toEqual({ ok: true });
  });

  it('leaves L-remote unconstrained by host measures', () => {
    const r = validateIsolation({
      level: 'L-remote',
      manifest: manifest({ fs: { read: ['anywhere'], write: [] }, network: 'direct' }),
      authorizedRealms: [],
      containerRuntimeAvailable: false,
    });
    expect(r).toEqual({ ok: true });
  });

  it('leaves L-none unconstrained by host measures', () => {
    const r = validateIsolation({
      level: 'L-none',
      manifest: manifest({ fs: { read: ['anywhere'], write: [] } }),
      authorizedRealms: [],
      containerRuntimeAvailable: false,
    });
    expect(r).toEqual({ ok: true });
  });

  it('refuses a process-level body with no resource declaration (no fabricated defaults)', () => {
    const r = validateIsolation({
      level: 'L-process',
      manifest: manifest({ resources: {} }),
      authorizedRealms: ['realm-docs'],
      containerRuntimeAvailable: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join(' ')).toContain('resources are not declared');
  });

  it('refuses a missing exec command', () => {
    const r = validateIsolation({
      level: 'L-process-restricted',
      manifest: manifest({ exec: { command: '', args: [], envAllowList: [] } }),
      authorizedRealms: ['realm-docs'],
      containerRuntimeAvailable: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join(' ')).toContain('exec command is not declared');
  });

  it('collects every refusal reason in one pass', () => {
    const r = validateIsolation({
      level: 'L-container',
      manifest: manifest({ fs: { read: ['realm-docs', 'outside'], write: [] }, exec: { command: '', args: [], envAllowList: [] } }),
      authorizedRealms: ['realm-docs'],
      containerRuntimeAvailable: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reasons.join(' ')).toContain('outside');
      expect(r.reasons.join(' ')).toContain('container runtime unavailable');
      expect(r.reasons.join(' ')).toContain('exec command is not declared');
    }
  });
});
