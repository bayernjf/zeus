import { describe, expect, it } from 'vitest';
import { SkillRegistry, DuplicateSkillError } from '../src/skills/registry.js';
import { SkillValidationError } from '../src/skills/validate-spec.js';
import type { SkillSpecInput } from '../src/skills/types.js';

const now = () => new Date('2026-09-22T00:00:00.000Z');

function spec(overrides: Partial<SkillSpecInput> = {}): SkillSpecInput {
  return {
    id: 'code-review',
    name: 'Code Review',
    version: '1.0.0',
    description: 'reviews code',
    tags: ['code'],
    permissions: ['realm', 'network', 'execute:deploy'],
    providedBy: ['vassal-1'],
    ...overrides,
  };
}

describe('E2.3 skill install / harden / uninstall', () => {
  it('install is effective: a registered active skill resolves its provider', () => {
    const registry = new SkillRegistry(now);
    registry.register(spec());
    const installed = registry.install('code-review');
    expect(installed.status).toBe('active');
    expect(installed.installedAt).toBeDefined();
    expect(registry.resolveTeam(['code-review']).complete).toBe(true);
  });

  it('uninstall immediately revokes: team resolution shows the skill missing', () => {
    const registry = new SkillRegistry(now);
    registry.register(spec());

    const uninstalled = registry.uninstall('code-review');
    expect(uninstalled.status).toBe('uninstalled');
    expect(uninstalled.uninstalledAt).toBeDefined();

    const team = registry.resolveTeam(['code-review']);
    expect(team.missingSkills).toEqual(['code-review']);
    expect(registry.get('code-review')).toBeUndefined();
  });

  it('reinstall after uninstall restores availability', () => {
    const registry = new SkillRegistry(now);
    registry.register(spec());
    registry.uninstall('code-review');
    registry.install('code-review');
    expect(registry.resolveTeam(['code-review']).complete).toBe(true);
  });

  it('hardening narrows permission claims to a subset and stacks constraints', () => {
    const registry = new SkillRegistry(now);
    registry.register(spec());

    const hardened = registry.harden('code-review', {
      permissions: ['realm:read', 'execute:deploy'],
      constraints: { readOnly: true },
    });
    expect(hardened.hardening!.permissions).toEqual(['realm:read', 'execute:deploy']);
    expect(hardened.hardening!.constraints).toEqual({ readOnly: true });

    // A second hardening can only shrink within the prior effective claims.
    registry.harden('code-review', { permissions: ['realm:read'], constraints: { maxRuntimeMs: 1000 } });
    const again = registry.get('code-review')!;
    expect(again.hardening!.permissions).toEqual(['realm:read']);
    expect(again.hardening!.constraints).toEqual({ readOnly: true, maxRuntimeMs: 1000 });
  });

  it('hardening cannot grant rights the skill did not hold', () => {
    const registry = new SkillRegistry(now);
    registry.register(spec());
    expect(() => registry.harden('code-review', { permissions: ['credential'] })).toThrowError(SkillValidationError);
    expect(() => registry.harden('code-review', { permissions: ['mcp:server'] })).toThrowError(/cannot grant/);
  });

  it('rejects invalid hardening claims and hardening an uninstalled skill', () => {
    const registry = new SkillRegistry(now);
    registry.register(spec());
    registry.uninstall('code-review');
    expect(() => registry.harden('code-review', { permissions: ['realm'] })).toThrowError(/uninstalled/);
  });

  it('cannot reinstall a deprecated version and surfaces unknown skills', () => {
    const registry = new SkillRegistry(now);
    registry.register(spec());
    registry.deprecate('code-review');
    expect(() => registry.install('code-review')).toThrowError(/deprecated/);
    expect(() => registry.uninstall('nope')).toThrowError(/not found/);
  });

  it('hardened bounds survive export/import', () => {
    const registry = new SkillRegistry(now);
    registry.register(spec());
    registry.harden('code-review', { permissions: ['realm:read'], constraints: { x: 1 } });
    const restored = new SkillRegistry(now);
    restored.importState(registry.exportState());
    expect(restored.get('code-review')!.hardening!.permissions).toEqual(['realm:read']);
    void DuplicateSkillError;
  });
});
