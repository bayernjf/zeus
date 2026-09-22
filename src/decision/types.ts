import type { RealmType } from '../a2a/types.js';

/** Decision backend family (audit + selection policy use it; the port semantics are identical). */
export type DecisionBackendKind = 'decision-model' | 'llm';

/** Narrow, model-agnostic decision port. Kernel and wiring depend only on this. */
export type DecisionBackend = {
  readonly kind: DecisionBackendKind;
  /** Audit identifier, e.g. 'jev-latest' / 'gpt-5.6-luna' / 'local:apus'. */
  readonly model: string;
  /** Boolean judgement: probability (0–1) that a proposition is true. */
  noul(request: NoulRequest): Promise<NoulResult>;
  /** Pick one of predefined options; returns per-option probabilities + confidence. */
  choice(request: ChoiceRequest): Promise<ChoiceResult>;
  /** Score against level bands; returns a continuous score, distribution, confidence. */
  score(request: ScoreRequest): Promise<ScoreResult>;
};

export type QuestionBase = {
  /** Minimal state needed for the judgement only (see design §8). */
  state: Record<string, unknown> | string;
  /** Human-readable decision criteria. */
  instructions: string;
  runId: string;
  realm: RealmType;
  /** Per-call timeout; defaults: decision model 1500ms / LLM 15000ms. */
  maxWaitMs?: number;
};

export type NoulRequest = QuestionBase & { question: string };
export type NoulResult = {
  probability: number;
  confidence: number;
  /** Whether confidence is model-calibrated. Decision models: true. LLM self-report: false. */
  calibrated: boolean;
  decisionAt: string;
};

export type ChoiceRequest = QuestionBase & { question: string; options: string[] };
export type ChoiceResult = {
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
  calibrated: boolean;
  decisionAt: string;
};

export type ScoreRequest = QuestionBase & { question: string; levels: string[] };
export type ScoreResult = {
  /** Continuous score on 0–100. */
  score: number;
  level?: string;
  distribution: Record<string, number>;
  confidence: number;
  calibrated: boolean;
  decisionAt: string;
};

/** Unified failure semantics; adapters fold network/auth/timeout into this. */
export type DecisionBackendErrorCode = 'unavailable' | 'timeout' | 'auth' | 'invalid';
export type DecisionBackendError = { code: DecisionBackendErrorCode; message: string };

export class DecisionBackendFailure extends Error {
  readonly code: DecisionBackendErrorCode;
  constructor(code: DecisionBackendErrorCode, message: string) {
    super(message);
    this.name = 'DecisionBackendFailure';
    this.code = code;
  }
  toJSON(): DecisionBackendError {
    return { code: this.code, message: this.message };
  }
}

export type DecisionTrace = {
  runId: string;
  backend: DecisionBackendKind;
  model: string;
  request: { kind: 'noul' | 'choice' | 'score'; question: string; stateKeys: string[] };
  result?: unknown;
  error?: DecisionBackendError;
  latencyMs: number;
  /** Audit-only cost estimate (not billing); absent when unit price is unknown. */
  cost?: { inputTokens: number; outputTokens: number; cents: number };
  decidedAt: string;
};

/** Data-sovereignty + transport options shared by adapters (design §8). */
export type BackendOptions = {
  /** Whitelist of state keys allowed to leave the device. Default empty = send {}. */
  stateKeys?: string[];
  /** enterprise realm state is never sent externally unless explicitly opted in (default false). */
  allowEnterpriseExfiltration?: boolean;
  /** Sanitization hook applied after whitelist filtering (name/id/token replacement). */
  redact?: (state: Record<string, unknown>) => Record<string, unknown>;
  /** Receives one DecisionTrace per call (E1.6 replayability). */
  onTrace?: (trace: DecisionTrace) => void;
  /** Injected fetch (tests / transport replacement). */
  fetchImpl?: typeof fetch;
  now?: () => Date;
};
