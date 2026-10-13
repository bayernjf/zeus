import { describe, expect, it } from 'vitest';
import { SkillRegistry } from '../src/skills/registry.js';
import { skillSpecInputFrom } from '../src/skills/spec-input.js';
import { registerSkillSpecs, UsageError } from '../src/daily/cli.js';

/**
 * E2.7's registration side. Both faces that take an explicit spec — the operator
 * HTTP endpoint and the product entry's `--spec` — copy the payload through one
 * shared whitelist, because two copies drift and the weaker one becomes the live
 * contract. These cases pin the whitelist itself, then the entry's file handling.
 */

describe('skillSpecInputFrom (shared whitelist)', () => {
  it('keeps the declared fields, including aliases', () => {
    const input = skillSpecInputFrom({
      id: 'research',
      name: 'Deep Research',
      description: 'restates notes',
      version: '1.0.0',
      tags: ['docs'],
      aliases: ['归纳要点'],
      providedBy: ['alpha'],
    });
    expect(input).toMatchObject({ id: 'research', version: '1.0.0', aliases: ['归纳要点'], providedBy: ['alpha'] });
  });

  it('drops keys the registry owns, so a payload cannot forge them', () => {
    const input = skillSpecInputFrom({
      id: 'research',
      name: 'Deep Research',
      description: 'd',
      version: '1.0.0',
      registeredAt: '2020-01-01T00:00:00.000Z',
      status: 'deprecated',
      kernelStateStore: '/etc/passwd',
      constructor: { prototype: { smuggled: true } },
    }) as unknown as Record<string, unknown>;
    expect(input.registeredAt).toBeUndefined();
    expect(input.kernelStateStore).toBeUndefined();
    // `status` is deliberately allowed (an operator may register a non-active
    // version); what must never survive is an unknown key reaching storage.
    const registry = new SkillRegistry();
    const stored = registry.register(skillSpecInputFrom({
      id: 'research',
      name: 'Deep Research',
      description: 'd',
      version: '1.0.0',
      kernelStateStore: '/etc/passwd',
    }));
    expect(Object.keys(stored)).not.toContain('kernelStateStore');
  });

  it('leaves the validator to refuse a bad shape rather than guessing here', () => {
    const registry = new SkillRegistry();
    expect(() => registry.register(skillSpecInputFrom({ id: 'x', name: 'X', description: '', version: '1', aliases: ['  '] })))
      .toThrow(/version must be major\.minor\.patch/);
  });
});

describe('registerSkillSpecs (--spec file handling)', () => {
  const spec = { id: 'research', name: 'Deep Research', description: 'restates notes', version: '1.0.0', aliases: ['归纳要点'], providedBy: ['alpha'] };
  const files = (map: Record<string, string>) => (path: string) => {
    if (!(path in map)) throw new Error(`ENOENT: no such file, open '${path}'`);
    return map[path]!;
  };

  it('registers nothing when no file was passed', () => {
    expect(registerSkillSpecs(new SkillRegistry(), [])).toEqual([]);
  });

  it('accepts one object or an array of them', () => {
    const registry = new SkillRegistry();
    const one = registerSkillSpecs(registry, ['a.json'], files({ 'a.json': JSON.stringify(spec) }));
    expect(one).toEqual(['research@1.0.0']);
    const many = registerSkillSpecs(new SkillRegistry(), ['b.json'], files({
      'b.json': JSON.stringify([spec, { ...spec, id: 'release', name: 'Release Notes', version: '2.0.0' }]),
    }));
    expect(many).toEqual(['research@1.0.0', 'release@2.0.0']);
  });

  it('reports an unreadable file as a usage error, not a crash', () => {
    expect(() => registerSkillSpecs(new SkillRegistry(), ['gone.json'], files({}))).toThrow(/not readable/);
  });

  it('names the file when the JSON is malformed', () => {
    try {
      registerSkillSpecs(new SkillRegistry(), ['bad.json'], files({ 'bad.json': '{oops' }));
      throw new Error('expected a throw');
    } catch (error) {
      expect((error as Error).message).toContain('--spec bad.json is not valid JSON');
    }
  });

  it('refuses a document that is not a spec object', () => {
    expect(() => registerSkillSpecs(new SkillRegistry(), ['t.json'], files({ 't.json': '["research"]' })))
      .toThrow(/must hold a skill spec object/);
  });

  it('carries the validator message out as a usage error that names the field', () => {
    try {
      registerSkillSpecs(new SkillRegistry(), ['t.json'], files({ 't.json': JSON.stringify({ ...spec, version: 'nope' }) }));
      throw new Error('expected a throw');
    } catch (error) {
      expect(error).toBeInstanceOf(UsageError);
      expect((error as Error).message).toMatch(/version must be major\.minor\.patch/);
    }
  });

  it('skips a spec the catalogue already holds, so re-running stays usable', () => {
    const registry = new SkillRegistry();
    const read = files({ 'a.json': JSON.stringify(spec) });
    expect(registerSkillSpecs(registry, ['a.json'], read)).toEqual(['research@1.0.0']);
    expect(registerSkillSpecs(registry, ['a.json'], read)).toEqual([]);
    expect(registry.get('research', '1.0.0')?.version).toBe('1.0.0');
  });
});
