import { describe, expect, it } from 'vitest';
import { assembleSkillInputs } from '../src/context/skill-inputs.js';

/**
 * S1 context engineering V2 (design-context-engineering §10.3): skill-declared
 * input assembly (source 2 of the assembly model). Contract — every declared
 * field is either satisfied from the caller's explicit payload or marked
 * `unavailable`; absence is never fabricated; undeclared payload keys are
 * untouched. The kernel's provider wiring and outbound serialization are
 * exercised in boot-context-assembly.test.ts and the fan-out tests; here the
 * assembler is tested over hand-built declarations.
 */

describe('assembleSkillInputs', () => {
  it('fills every declared field from the explicit payload', () => {
    const { inputs, unavailable, events } = assembleSkillInputs({
      declared: { code: {}, language: {}, task: {} },
      params: { code: 'src/orchestrator.ts', language: 'typescript', task: 'review' },
    });
    expect(inputs).toEqual([
      { name: 'code', source: 'explicit', value: 'src/orchestrator.ts' },
      { name: 'language', source: 'explicit', value: 'typescript' },
      { name: 'task', source: 'explicit', value: 'review' },
    ]);
    expect(unavailable).toBe(0);
    expect(events).toEqual([]);
  });

  it('marks a missing field unavailable, never fabricating a value', () => {
    const { inputs, unavailable, events } = assembleSkillInputs({
      declared: { code: {}, language: {}, task: {} },
      params: { code: 'src/orchestrator.ts' },
    });
    expect(inputs).toEqual([
      { name: 'code', source: 'explicit', value: 'src/orchestrator.ts' },
      { name: 'language', source: 'unavailable' },
      { name: 'task', source: 'unavailable' },
    ]);
    expect(unavailable).toBe(2);
    expect(events).toEqual([
      { kind: 'context-trimmed', trimmed: 1, reason: 'unavailable', source: 'skill-inputs' },
      { kind: 'context-trimmed', trimmed: 1, reason: 'unavailable', source: 'skill-inputs' },
    ]);
  });

  it('treats an undefined value as missing but a null value as explicit', () => {
    const { inputs, unavailable } = assembleSkillInputs({
      declared: { optional: {}, explicitNull: {} },
      params: { optional: undefined, explicitNull: null },
    });
    expect(inputs).toEqual([
      { name: 'optional', source: 'unavailable' },
      { name: 'explicitNull', source: 'explicit', value: null },
    ]);
    expect(unavailable).toBe(1);
  });

  it('assembles nothing for an empty declaration', () => {
    const { inputs, unavailable, events } = assembleSkillInputs({
      declared: {},
      params: { code: 'src/orchestrator.ts' },
    });
    expect(inputs).toEqual([]);
    expect(unavailable).toBe(0);
    expect(events).toEqual([]);
  });

  it('never touches undeclared payload keys', () => {
    const { inputs } = assembleSkillInputs({
      declared: { code: {} },
      params: { code: 'x', extra: 'untouched' },
    });
    // The assembler only constrains what the skill declared; the payload itself
    // is delivered as-is (the fan-out passthrough invariant, pinned elsewhere).
    expect(inputs).toEqual([{ name: 'code', source: 'explicit', value: 'x' }]);
  });
});
