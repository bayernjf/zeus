import { describe, expect, it } from 'vitest';
import type { AgentCard } from '../src/a2a/types.js';
import {
  CARD_CATALOGUE_VERSION,
  compareVersions,
  DuplicateSkillError,
  SkillRegistry,
  SkillNotFoundError,
} from '../src/skills/registry.js';

const fixedNow = () => new Date('2026-09-22T00:00:00.000Z');

function card(name: string, skills: AgentCard['skills']): AgentCard {
  return { name, url: `http://127.0.0.1/${name}`, skills };
}

describe('compareVersions', () => {
  it('orders semver-ish versions with missing segments as 0', () => {
    expect(compareVersions('1.2.0', '1.2.1')).toBe(-1);
    expect(compareVersions('2.0', '1.9.9')).toBe(1);
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
  });
});

describe('SkillRegistry registration and lookup', () => {
  it('registers a spec with defaults and returns a clone', () => {
    const registry = new SkillRegistry(fixedNow);
    const spec = registry.register({
      id: 'code-review', name: 'Review code', description: 'd', version: '1.0.0',
      domain: 'code', tags: ['review'], permissions: ['realm:read'],
    });
    expect(spec.status).toBe('active');
    expect(spec.providedBy).toEqual([]);
    expect(spec.registeredAt).toBe('2026-09-22T00:00:00.000Z');
    spec.tags.push('mutated');
    expect(registry.get('code-review')?.tags).toEqual(['review']);
  });

  it('rejects registration without id/version and rejects duplicate id@version', () => {
    const registry = new SkillRegistry(fixedNow);
    expect(() => registry.register({ id: '', name: 'x', description: '', version: '1.0.0', tags: [] })).toThrow();
    registry.register({ id: 's', name: 's', description: '', version: '1.0.0', tags: [] });
    expect(() => registry.register({ id: 's', name: 's', description: '', version: '1.0.0', tags: [] })).toThrowError(DuplicateSkillError);
  });

  it('coexists multiple versions and get defaults to the latest active', () => {
    const registry = new SkillRegistry(fixedNow);
    registry.register({ id: 's', name: 's', description: '', version: '1.0.0', tags: [] });
    registry.register({ id: 's', name: 's', description: '', version: '1.2.0', tags: [] });
    registry.register({ id: 's', name: 's', description: '', version: '1.1.0', tags: [] });
    expect(registry.get('s')?.version).toBe('1.2.0');
    expect(registry.get('s', '1.0.0')?.version).toBe('1.0.0');
    expect(registry.versions('s').map(v => v.version)).toEqual(['1.2.0', '1.1.0', '1.0.0']);
    expect(registry.get('missing')).toBeUndefined();
  });

  it('deprecate marks a version (kept for traceability) and drops it from default lookup', () => {
    const registry = new SkillRegistry(fixedNow);
    registry.register({ id: 's', name: 's', description: '', version: '1.0.0', tags: [] });
    registry.register({ id: 's', name: 's', description: '', version: '2.0.0', tags: [] });
    registry.deprecate('s', '2.0.0');
    expect(registry.get('s')?.version).toBe('1.0.0');
    expect(registry.get('s', '2.0.0')?.status).toBe('deprecated');
    expect(registry.list({ status: 'deprecated' })).toHaveLength(1);
    expect(() => registry.deprecate('nope')).toThrowError(SkillNotFoundError);
  });

  it('filters by domain and tag', () => {
    const registry = new SkillRegistry(fixedNow);
    registry.register({ id: 'a', name: 'a', description: '', version: '1.0.0', domain: 'code', tags: ['review'], providedBy: [] });
    registry.register({ id: 'b', name: 'b', description: '', version: '1.0.0', domain: 'research', tags: ['search'], providedBy: [] });
    expect(registry.findByDomain('code').map(s => s.id)).toEqual(['a']);
    expect(registry.findByTag('search').map(s => s.id)).toEqual(['b']);
  });
});

describe('SkillRegistry.registerFromCard', () => {
  it('imports card skills into a catalogue entry and merges duplicate providers', () => {
    const registry = new SkillRegistry(fixedNow);
    registry.registerFromCard(card('pr-helper', [
      { id: 'deployment-health', name: 'health', description: '', tags: ['health'] },
    ]));
    registry.registerFromCard(card('loom', [
      { id: 'deployment-health', name: 'health', description: '', tags: ['health'] },
      { id: 'plan', name: 'plan', description: '', tags: [] },
    ]));
    const spec = registry.get('deployment-health');
    expect(spec?.version).toBe(CARD_CATALOGUE_VERSION);
    expect(spec?.providedBy).toEqual(['pr-helper', 'loom']);
    expect(registry.get('plan')?.providedBy).toEqual(['loom']);
  });

  it('lets an explicit spec take provider precedence over the catalogue entry', () => {
    const registry = new SkillRegistry(fixedNow);
    registry.registerFromCard(card('pr-helper', [{ id: 's', name: 's', description: '', tags: [] }]));
    registry.register({ id: 's', name: 's', description: '', version: '1.0.0', providedBy: ['loom'], tags: [] });
    expect(registry.resolveTeam(['s']).slots[0].providers).toEqual(['loom']);
  });
});

describe('SkillRegistry.resolveTeam (E2.4, no silent random pick)', () => {
  it('resolves a complete team when each skill has exactly one provider', () => {
    const registry = new SkillRegistry(fixedNow);
    registry.register({ id: 'a', name: 'a', description: '', version: '1.0.0', providedBy: ['va'], tags: [] });
    registry.register({ id: 'b', name: 'b', description: '', version: '1.0.0', providedBy: ['vb'], tags: [] });
    const resolution = registry.resolveTeam(['a', 'b']);
    expect(resolution.complete).toBe(true);
    expect(resolution.missingSkills).toEqual([]);
    expect(resolution.ambiguousSkills).toEqual([]);
  });

  it('flags ambiguous multi-provider slots instead of choosing, and missing slots', () => {
    const registry = new SkillRegistry(fixedNow);
    registry.register({ id: 'dup', name: 'dup', description: '', version: '1.0.0', providedBy: ['v1', 'v2'], tags: [] });
    const resolution = registry.resolveTeam(['dup', 'none']);
    expect(resolution.complete).toBe(false);
    expect(resolution.ambiguousSkills).toEqual(['dup']);
    expect(resolution.missingSkills).toEqual(['none']);
    const dupSlot = resolution.slots.find(s => s.skillId === 'dup')!;
    expect(dupSlot.ambiguous).toBe(true);
    expect(dupSlot.providers).toEqual(['v1', 'v2']);
  });
});
