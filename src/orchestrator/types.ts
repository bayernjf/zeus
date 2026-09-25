import type { A2AEvent, RealmType, Task, TaskState } from '../a2a/types.js';
import type { DispatchRequest, DispatchResult } from '../dispatch/dispatcher.js';
import type { DecisionBackendError, DecisionBackendKind } from '../decision/types.js';

/** One vassal's participation in a fan-out intent. */
export type BranchOutcome = {
  vassal: string;
  runId: string;
  ok: boolean;
  state?: TaskState;
  taskId?: string;
  task?: Task;
  events: A2AEvent[];
  /** Refusal / failure / timeout reason. */
  reason?: string;
  timedOut?: boolean;
};

export type FanOutStatus = 'completed' | 'partial' | 'failed' | 'needs-driver';

/** An event tagged with the branch it came from, so a merged view stays traceable. */
export type SourcedEvent = {
  source: { vassal: string; taskId?: string; runId: string };
  event: A2AEvent;
};

/** A vassal's stance on the decision, extracted from its terminal task artifacts. */
export type Position = {
  vassal: string;
  stance: string;
  weight?: number;
  rationale?: string;
};

export type AggregationRule =
  | { kind: 'unanimous' }
  | { kind: 'majority' }
  | { kind: 'weighted'; threshold?: number };

export type AggregatedDecision = {
  rule: AggregationRule['kind'];
  /** null when the rule cannot produce a conclusion (split vote / no stances). */
  conclusion: string | null;
  positions: Position[]
  margin?: { winner: string; winnerCount: number; total: number };
  reason: string;
};

export type Conflict = {
  /** Default 'split': vassals disagree and the rule could not conclude.
   *  'judge-review': a gated high-confidence judge recommendation disagrees
   *  with a rule that had already concluded (E1.3 adversarial review). */
  kind?: 'split' | 'judge-review';
  stances: Array<{ stance: string; vassals: string[]; summary?: string }>;
  reason: string;
};

export type FanOutRequest = {
  /** Idempotency key; same key replays the stored result without re-dispatching. */
  intentId?: string;
  skill: string;
  /** Explicit targets; defaults to every active vassal providing the skill. */
  vassals?: string[];
  params: Record<string, unknown>;
  realm: RealmType;
  /** Connected realm this intent operates on, when one was named. Required
   *  for memory consolidation to land in the right memory domain. */
  realmId?: string;
  runId?: string;
  realmHits?: DispatchRequest['realmHits'];
  aggregation?: AggregationRule;
  /** Per-branch timeout; a branch still pending at the limit is recorded as timed out. */
  branchTimeoutMs?: number;
};

export type FanOutResult = {
  intentId: string;
  runId: string;
  skill: string;
  realm: RealmType;
  realmId?: string;
  branches: BranchOutcome[];
  stream: SourcedEvent[];
  positions: Position[];
  decision: AggregatedDecision;
  conflicts: Conflict[];
  status: FanOutStatus;
  replayed?: boolean;
  createdAt: string;
  /** Set once a driver settles an unresolved conflict (E6.2 write-back). */
  driverResolution?: DriverResolution;
  /** Set when a decision backend was consulted after the rule ended in needs-driver (S2). */
  backendArbitration?: BackendArbitration;
  /** Set when an LLM-as-judge adversarially reviewed a rule-concluded multi-stance decision (E1.3). */
  judgeReview?: JudgeReview;
  /** Set when the skill governor refused auto-selected targets before dispatch. */
  refused?: GovernanceRefusal;
};

/** Record of the S2 backend arbitration attempt on an unresolved split. */
export type BackendArbitration = {
  concluded: boolean;
  conclusion?: string;
  confidence?: number;
  calibrated?: boolean;
  backend?: DecisionBackendKind;
  model?: string;
  error?: DecisionBackendError;
  decidedAt: string;
};

/** Record of the E1.3 LLM-as-judge review after the rule already produced a conclusion. */
export type JudgeReview = {
  /** false when skipped / below the confidence gate / uncalibrated / backend failed. */
  judged: boolean;
  recommended?: string;
  probabilities?: Record<string, number>;
  confidence?: number;
  calibrated?: boolean;
  /** A gated recommendation equals the rule conclusion (judicial endorsement). */
  agreesWithRule?: boolean;
  /** A gated, high-confidence disagreement flipped the intent to needs-driver. */
  escalated?: boolean;
  backend?: DecisionBackendKind;
  model?: string;
  error?: DecisionBackendError;
  /** Why judging did not produce a gated recommendation. */
  reason?: 'rule-inconclusive' | 'single-stance' | 'below-threshold' | 'uncalibrated' | 'backend-failure';
  decidedAt: string;
};

/** A human driver's settlement of an intent-conflict, written back into the decision. */
export type DriverResolution = {
  escalationId: string;
  stance: string;
  note?: string;
  decidedAt: string;
};

/** Narrow port the orchestrator drives; Dispatcher satisfies it. */
export type DispatchPort = {
  dispatch(req: DispatchRequest): Promise<DispatchResult>;
  cancel(vassal: string, taskId: string): Promise<unknown>;
};

/** Target selection port; VassalRegistry.asVassalLookup() satisfies it. */
export type TargetLookup = {
  findBySkill(skillId: string): Array<{ name: string }>;
};

/**
 * E2.2/E2.3/E2.4 governance gate over auto-selected fan-out targets
 * (Active work 47 §E-3): the skill catalogue, not the card, decides who is an
 * active provider. `undefined` means the skill was never registered — the card
 * advertisement is the only record, so auto-selection passes through unchanged
 * (unregistered = ungoverned, the historical behaviour). `[]` means registered
 * but no active provider (uninstalled / deprecated everywhere): refusal.
 */
export type SkillGovernor = {
  activeProviders(skillId: string): string[] | undefined;
};

/** Why the skill governor refused an auto-selected fan-out before dispatch. */
export type GovernanceRefusal = {
  reason: 'skill-uninstalled' | 'no-active-provider';
  detail: string;
};

export type CancelBranchResult = {
  vassal: string;
  taskId: string;
  canceled: boolean;
  reason?: string;
};
