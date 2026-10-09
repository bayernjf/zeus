// design-evals (tech map S7): the offline, deterministic eval set — fixed
// worlds + scripted agent behaviour + property assertions on observable
// artefacts (final decision, escalation, selection, evidence chain,
// guardrails, budget). V1 ships the pure scorer only (design-evals §5): no
// world runner, no CI gate — every input is caller-supplied, so scoring is
// fully unit-testable and reproducible.

import type { FanOutRequest, FanOutResult } from '../orchestrator/types.js';
import type { ContentHandling } from '../guardrails/content-risk.js';

/** One property assertion on an eval run. Every field is optional so a case
 *  asserts only what it cares about; `severity` is always required and decides
 *  the gate weight (block / warn / observe). */
export type EvalExpectation = {
  /** Final decision predicate over the settled fan-out result. */
  decision?: (outcome: FanOutResult) => boolean;
  /** Escalation: whether an operator interruption was expected, and at which
   *  level. Reads the interrupt-level-* audit rows. */
  escalation?: { expected: boolean; level?: 0 | 1 | 2 };
  /** Target selection: providers that must/must not appear in the branch set,
   *  and whether a re-pointing is allowed. */
  selection?: { mustInclude?: string[]; mustExclude?: string[]; diversionAllowed?: boolean };
  /** Evidence chain: conclusions must cite these sources; when
   *  `forbidBareAssertions` is set, every position must carry a rationale
   *  (verify-before-asserting machine check). */
  evidence?: { mustCite?: string[]; forbidBareAssertions?: boolean };
  /** Guardrail handling expected for the case (S8): the audit row action must
   *  match. */
  guardrails?: { expectedHandling?: ContentHandling['action'] };
  /** Budget: branch count cap (S4/S9). `maxCostTokens` is declared for the
   *  cost family but has no V1 data source, so the scorer marks it
   *  not-assessable instead of guessing. */
  budget?: { maxBranches?: number; maxCostTokens?: number };
  severity: 'block' | 'warn' | 'observe';
};

/** An eval case: a fixed world + scripted agents + one request + the property
 *  assertions. `world`/`agents` are opaque in V1 — the runner owns them; the
 *  scorer never looks inside. */
export type EvalCase = {
  id: string;
  world: unknown;
  agents: unknown;
  input: FanOutRequest;
  expect: EvalExpectation[];
};
