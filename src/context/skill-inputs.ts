import type { ContextAssemblyEvent } from './assemble.js';
import {
  classifyContentRisk,
  scanContentSignals,
  type ContentProvenance,
} from '../guardrails/content-risk.js';

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
      /**
       * S8 V2 (design-guardrails §3.1/§4): the operator's explicit payload is
       * driver-supplied content — trusted with the operator, never trimmed,
       * but still data with a visible boundary. The label rides the entry so
       * the branch consumer reads the boundary, not the prose.
       */
      provenance: ContentProvenance;
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
  /** Assembly events: `context-trimmed (unavailable, skill-inputs)` per
   *  unavailable field plus, for explicit fields, `guardrail-annotated`
   *  when the content-risk chain finds a deterministic signal. */
  events: ContextAssemblyEvent[];
};

/**
 * Assemble the declared skill inputs against the caller's explicit payload.
 *
 * Presence rule: a field is `explicit` when `params` owns the key with a value
 * other than `undefined`. `null` is treated as an explicit value — the caller
 * deliberately delivered it, and explicit content is never re-judged. A missing
 * or `undefined` field is `unavailable`, never fabricated.
 *
 * S8 V2 (design-guardrails §4): each explicit field is additionally run
 * through the content-risk decision chain as driver-supplied content bound
 * for an outbound plan. The disposition is annotation-only at this assembly
 * point (driver-supplied payload is never trimmed or refused here — an
 * escalate verdict from an external-url / credential hit degrades to an
 * audited boundary annotation, matching the memory-assembly point), and only
 * fields carrying a deterministic signal emit a `guardrail-annotated` event.
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
      inputs.push({ name, source: 'explicit', value, provenance: 'driver-supplied' });
      const signals = scanContentSignals(renderInputText(value));
      const handling = classifyContentRisk({
        provenance: 'driver-supplied',
        destination: { kind: 'outbound', mode: 'plan' },
        signals,
      });
      // Driver-supplied payload is never trimmed or refused here; only a
      // deterministic signal produces an audited boundary annotation
      // (design-guardrails §3.2 "命中信号时标注 + 审计" — plain explicit
      // fields are the operator's own content and emit nothing).
      if (signals.length > 0 && (handling.action === 'annotate' || handling.action === 'escalate')) {
        events.push({
          kind: 'guardrail-annotated',
          entry: name,
          boundary: 'data-boundary:driver-supplied',
          signals,
        });
      }
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

/** Render an explicit payload value to the text the signal scanner reads. */
function renderInputText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? null);
}
