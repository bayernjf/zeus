import { describe, expect, it } from 'vitest';
import { SkillRegistry } from '../src/skills/registry.js';
import { SkillValidationError } from '../src/skills/validate-spec.js';
import type { SkillSpecInput } from '../src/skills/types.js';

function spec(overrides: Partial<SkillSpecInput> = {}): SkillSpecInput {
  return {
    id: 'code-review',
    name: 'Code Review',
    description: 'reviews code',
    version: '1.0.0',
    tags: ['code'],
    ...overrides,
  };
}

describe('E2.1 skill spec validation', () => {
  it('registers a well-formed spec with normalized empty collections', () => {
    const registry = new SkillRegistry();
    const registered = registry.register(spec());
    expect(registered.permissions).toEqual([]);
    expect(registered.dependencies).toEqual([]);
    expect(registered.status).toBe('active');
  });

  it('collects multiple shape issues in one error', () => {
    const registry = new SkillRegistry();
    expect(() => registry.register({ id: '', name: '', description: '', version: 'nope' } as unknown as SkillSpecInput))
      .toThrow(SkillValidationError);
  });

  it('rejects an unparseable version', () => {
    const registry = new SkillRegistry();
    expect(() => registry.register(spec({ version: 'v1' }))).toThrow(/major.minor.patch/);
  });

  it('rejects malformed and unknown-scope permissions', () => {
    const registry = new SkillRegistry();
    expect(() => registry.register(spec({ permissions: ['BAD'] }))).toThrow(/permission/);
    expect(() => registry.register(spec({ permissions: ['filesystem:read'] }))).toThrow(/unknown permission scope/);
  });

  it('accepts valid scope and scope:action claims', () => {
    const registry = new SkillRegistry();
    const registered = registry.register(spec({ permissions: ['realm:read', 'execute', 'mcp:connect'] }));
    expect(registered.permissions).toHaveLength(3);
  });

  it('rejects inputs/outputs that are not object descriptors', () => {
    const registry = new SkillRegistry();
    expect(() => registry.register(spec({ inputs: ['x'] as unknown as Record<string, unknown> }))).toThrow(/inputs/);
  });

  it('rejects self-dependency', () => {
    const registry = new SkillRegistry();
    expect(() => registry.register(spec({ dependencies: ['code-review'] }))).toThrow(/itself/);
  });

  it('rejects an unknown dependency (no forward references)', () => {
    const registry = new SkillRegistry();
    expect(() => registry.register(spec({ dependencies: ['missing-skill'] }))).toThrow(/unknown dependency/);
  });

  it('accepts a dependency once it is registered', () => {
    const registry = new SkillRegistry();
    registry.register(spec({ id: 'git-read', version: '1.0.0' }));
    const dependent = registry.register(spec({ id: 'code-review', dependencies: ['git-read'] }));
    expect(dependent.dependencies).toEqual(['git-read']);
  });

  it('rejects a dependency cycle', () => {
    const registry = new SkillRegistry();
    registry.register(spec({ id: 'a', version: '1.0.0' }));
    registry.register(spec({ id: 'b', version: '1.0.0', dependencies: ['a'] }));
    expect(() => registry.register(spec({ id: 'a', version: '2.0.0', dependencies: ['b'] }))).toThrow(/cycle/);
  });
});
