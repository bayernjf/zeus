/**
 * E2.6 operator intent recognition (PRD E2.6): turn a natural-language
 * instruction into a structured, plan-only fan-out intent.
 *
 * Design constraints honored:
 *  - data sovereignty (design philosophy 1): the instruction is handled
 *    locally by deterministic rules by default - zero bytes leave the
 *    machine. The external decision backend is only consulted when the
 *    caller explicitly asks (`useModel: true`), and every such call goes
 *    through the existing narrow, pluggable DecisionBackend port (Jev /
 *    OpenAI-compatible LLM / rules-only are interchangeable).
 *  - every concept is executable (design constraint 2): recognition is a
 *    pure function with a strict output contract; anything that cannot be
 *    resolved fails closed with a named reason, never a guessed intent.
 *  - plan-only (deferred #33 discipline): a recognized intent always carries
 *    mode 'plan'. An execute never originates from recognition alone - the
 *    execution-delegation gate (Active work 107) is the only path to execute.
 *
 * The port has no free-text primitive, so recognition reuses `choice`: the
 * candidate skill ids are the options and the instruction is the state. The
 * deterministic ranker narrows the catalogue first, so the model only ever
 * picks among a small, relevant set and the call is cheap.
 */

import type { ChoiceRequest, DecisionBackend } from '../decision/types.js';

/** One catalogue row fed to the ranker. */
export type SkillCatalogEntry = {
  id: string;
  name: string;
  description: string;
};

/** Ranked candidate for model judgement. */
export type IntentCandidate = {
  skill: string;
  /** Deterministic relevance score from the local ranker. */
  score: number;
};

export type IntentRecognitionOptions = {
  /** The instruction in natural language (operator wording). */
  text: string;
  /**
   * Pluggable decision backend. When absent, or when `useModel` is false,
   * recognition is fully local (rules only) and the text never leaves the
   * machine.
   */
  backend?: DecisionBackend;
  /** Catalogue rows to rank against (typically SkillRegistry.list()). */
  catalog: SkillCatalogEntry[];
  /** 'personal' is the sovereign default; only that or 'enterprise'. */
  realm?: 'personal' | 'enterprise';
  /** Explicit opt-in for consulting the external backend. Default false. */
  useModel?: boolean;
  /** Confidence below this never yields an intent (fail closed). Default 0.6. */
  confidenceThreshold?: number;
  /** Per-call timeout for the backend; backend default applies when omitted. */
  maxWaitMs?: number;
  /** Fixed clock for tests. */
  now?: () => Date;
};

export type RecognizedIntent = {
  skill: string;
  /** Recognition suggests shape only; parameters stay empty for the driver. */
  params: Record<string, unknown>;
  /** Recognition alone never authorizes execution (deferred #33). */
  mode: 'plan';
};

export type IntentRecognitionResult =
  | {
      ok: true;
      intent: RecognizedIntent;
      confidence: number;
      /** null when the local rule path resolved it (zero model involvement). */
      backend: { kind: DecisionBackend['kind']; model: string } | null;
      decisionAt: string;
    }
  | {
      ok: false;
      reason:
        | 'no-candidates'
        | 'ambiguous'
        | 'no-backend'
        | 'backend-unavailable'
        | 'invalid-choice'
        | 'low-confidence';
      detail?: string;
    };

const LOCAL_CONFIDENCE = 0.5;

/** Split an instruction into tokens; keeps ASCII words and CJK runs intact. */
export function tokenize(text: string): string[] {
  const matches = text.match(/[a-zA-Z0-9_-]+|[\u4e00-\u9fa5]+/g);
  return (matches ?? []).map(t => t.toLowerCase());
}

/**
 * Deterministic local ranker: token overlap against id/name/description,
 * with id/name weighted higher than the description. Pure, testable, and the
 * only path when no model is involved.
 */
export function rankCandidates(catalog: SkillCatalogEntry[], text: string, limit = 5): IntentCandidate[] {
  const tokens = tokenize(text);
  const scored = catalog
    .map(entry => {
      const id = entry.id.toLowerCase();
      const name = entry.name.toLowerCase();
      const description = entry.description.toLowerCase();
      let score = 0;
      for (const token of tokens) {
        if (id.includes(token) || token.includes(id)) score += 3;
        if (name.includes(token)) score += 2;
        if (description.includes(token)) score += 1;
      }
      return { skill: entry.id, score };
    })
    .filter(c => c.score > 0)
    .sort((a, b) => b.score - a.score || a.skill.localeCompare(b.skill));
  return scored.slice(0, limit);
}

function isRealm(realm: unknown): realm is 'personal' | 'enterprise' {
  return realm === 'personal' || realm === 'enterprise';
}

/**
 * Recognize an operator instruction as a plan-only intent. Fails closed with
 * a named reason on every unresolvable case; never guesses.
 */
export async function recognizeIntent(options: IntentRecognitionOptions): Promise<IntentRecognitionResult> {
  const now = options.now ?? (() => new Date());
  const realm = options.realm ?? 'personal';
  const threshold = options.confidenceThreshold ?? 0.6;
  const candidates = rankCandidates(options.catalog, options.text);

  if (candidates.length === 0) {
    return { ok: false, reason: 'no-candidates', detail: `no catalogue skill matched "${options.text.slice(0, 80)}"` };
  }

  // Model path only when the caller explicitly opted in and a backend exists.
  if (options.useModel === true && options.backend) {
    const ids = candidates.map(c => c.skill);
    const request: ChoiceRequest = {
      state: { instruction: options.text, realm },
      stateKeys: ['instruction', 'realm'],
      instructions: 'Pick the single best-matching skill id for the operator instruction. Answer with exactly one of the given options.',
      question: `Which skill in ${JSON.stringify(ids)} fits this instruction best?`,
      options: ids,
      runId: `recognize-${now().getTime()}`,
      realm,
      ...(options.maxWaitMs !== undefined ? { maxWaitMs: options.maxWaitMs } : {}),
    };
    let result;
    try {
      result = await options.backend.choice(request);
    } catch (error) {
      return {
        ok: false,
        reason: 'backend-unavailable',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    if (!ids.includes(result.choice)) {
      return { ok: false, reason: 'invalid-choice', detail: `model answered "${result.choice}", not among candidates` };
    }
    if (result.confidence < threshold) {
      return { ok: false, reason: 'low-confidence', detail: `confidence ${result.confidence.toFixed(3)} below threshold ${threshold}` };
    }
    return {
      ok: true,
      intent: { skill: result.choice, params: {}, mode: 'plan' },
      confidence: result.confidence,
      backend: { kind: options.backend.kind, model: options.backend.model },
      decisionAt: result.decisionAt,
    };
  }

  // Local rule path: only a clear, unique best match may yield an intent.
  if (options.useModel === true && !options.backend) {
    return { ok: false, reason: 'no-backend', detail: 'useModel was requested but no decision backend is configured' };
  }
  if (candidates.length > 1 && candidates[0]?.score === candidates[1]?.score) {
    return { ok: false, reason: 'ambiguous', detail: `tied candidates: ${candidates.slice(0, 3).map(c => c.skill).join(', ')}` };
  }
  const best = candidates[0];
  if (!best) return { ok: false, reason: 'no-candidates' };
  return {
    ok: true,
    intent: { skill: best.skill, params: {}, mode: 'plan' },
    confidence: LOCAL_CONFIDENCE,
    backend: null,
    decisionAt: now().toISOString(),
  };
}

export { isRealm };
