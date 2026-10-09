import type { ContextAssemblyEvent } from './assemble.js';

/**
 * S1 context engineering V2 (design-context-engineering §10.3): skill-declared
 * input assembly (source 2 of the assembly model).
 *
 * `SkillSpec.inputs` is a free-form schema descriptor (v0.1 shape) — its keys
 * are the input field names a skill may consume. The field was a dead
 * declaration before V2: nothing checked it against the payload a branch was
 * dispatched with. This module turns it into an assembly constraint:
 *
 * - every declared field is either satisfied from the caller's explicit
 *   payload (highest-priority source, never trimmed) or marked `unavailable`;
 * - an unavailable field is never filled with a fabricated value — the branch
 *   sees an explicit absence, and the drop is audited on the same
 *   `context-trimmed` spine as memory trimming;
 * - undeclared payload keys are untouched (explicit content is preserved as
 *   delivered; the assembler only constrains what the skill declared).
 *
 * The module is a pure function over injected inputs: no kernel state, no
 * retrieval, no write-back. Type-level validation of descriptor values is out
 * of scope for V2 — the free-form descriptor has no unified type syntax, so
 * fabricating one would invent a mechanism; presence is the only contract.
 */

/** One assembled skill input field. */
export type SkillInputEntry =
  | {
      /** Field name as declared in `SkillSpec.inputs`. */
      name: string;
      /** Filled from the caller's explicit payload. */
      source: 'explicit';
      value: unknown;
    }
  | {
      /** Field name as declared in `SkillSpec.inputs`. */
      name: string;
      /** No source could supply the field; the branch must handle the absence. */
      source: 'unavailable';
    };

export type SkillInputAssembly = {
  /** Per-declared-field assembly, in declaration order. */
  inputs: SkillInputEntry[];
  /** Number of fields left unavailable (mirrors the audit events). */
  unavailable: number;
  /** Trim events: one `context-trimmed (unavailable, skill-inputs)` per field. */
  events: ContextAssemblyEvent[];
};

/**
 * Assemble the declared skill inputs against the caller's explicit payload.
 *
 * Presence rule: a field is `explicit` when `params` owns the key with a value
 * other than `undefined`. `null` is treated as an explicit value — the caller
 * deliberately delivered it, and explicit content is never re-judged. A missing
 * or `undefined` field is `unavailable`, never fabricated.
 */
export function assembleSkillInputs(args: {
  declared: Record<string, unknown>;
  params: Record<string, unknown>;
}): SkillInputAssembly {
  const { declared, params } = args;
  const inputs: SkillInputEntry[] = [];
  const events: ContextAssemblyEvent[] = [];
  let unavailable = 0;

  for (const name of Object.keys(declared)) {
    const value = params[name];
    if (value !== undefined) {
      inputs.push({ name, source: 'explicit', value });
    } else {
      inputs.push({ name, source: 'unavailable' });
      unavailable += 1;
      events.push({
        kind: 'context-trimmed',
        trimmed: 1,
        reason: 'unavailable',
        source: 'skill-inputs',
      });
    }
  }

  return { inputs, unavailable, events };
}
