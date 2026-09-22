import type { A2AEvent, RealmType, Task, TaskState } from '../a2a/types.js';
import type { DispatchRequest, DispatchResult } from '../dispatch/dispatcher.js';

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
  stances: Array<{ stance: string; vassals: string[] }>;
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

export type CancelBranchResult = {
  vassal: string;
  taskId: string;
  canceled: boolean;
  reason?: string;
};
