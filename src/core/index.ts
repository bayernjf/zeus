/**
 * 决策内核 zeus-core 公共出口。
 *
 * 纯决策内核（不依赖 Fastify / TUI / 文件系统运行态 / 网络外壳），可独立导出、
 * 被其他仓嵌入；HTTP/TUI 等外壳装配留在 src/app。
 *
 * T-M1-01：分级基础类型（Grade/Impact/Reversibility）。
 * T-M1-02：fan-out 编排（aggregate/arbitrate/replay/dag 等）与 fealty 签名链
 *          从 src/orchestrator、src/registry/signing 迁入；旧路径保留兼容重导出。
 */

// --- 决策分级基础类型（T-M1-01） ---
export type { Grade, Impact, Reversibility } from './types.js';

// --- 决策分级策略（T-M1-03/04） ---
export { gradeDecision, modeForGrade, GRADE_MODES } from './grading/grade.js';
export type { GradeMode } from './grading/grade.js';
export { parsePolicy, validatePolicy, loadPolicyFromJson, MemoryPolicyStore } from './grading/policy-loader.js';
export type { PolicyStore } from './grading/policy-loader.js';
export { DEFAULT_POLICY_V1 } from './grading/default-policy.js';
export { DECISION_ERROR_CODES, DecisionError, ValidationError, PolicyNotFoundError } from './grading/errors.js';
export type { DecisionErrorCode } from './grading/errors.js';
export type {
  PolicyRule,
  RuleMatch,
  AmountRange,
  DecisionPolicy,
  DecisionRequest,
  Amount,
  GradeDecision,
} from './grading/policy.js';

// --- 决策审计链式签名（T-M1-05，ADR-04） ---
export {
  AUDIT_GENESIS,
  AUDIT_ENTRY_KEYS,
  AUDIT_PAYLOAD_KEYS,
  DECISION_AUDIT_KINDS,
} from './audit/types.js';
export type {
  DecisionAuditKind,
  DecisionAuditPayload,
  DecisionAuditInput,
  DecisionAuditEntry,
} from './audit/types.js';
export {
  DecisionAuditChain,
  DecisionAuditValidationError,
  auditEntryHash,
  auditSigningText,
  validateAuditEntry,
  validateAuditPayload,
  verifyDecisionAuditChain,
} from './audit/audit-chain.js';
export type {
  AuditSealingDoc,
  AuditVerification,
  DecisionAuditChainSigner,
  DecisionAuditChainVerifier,
  DecisionAuditAppender,
} from './audit/audit-chain.js';
export {
  DecisionAuditCodecError,
  encodeAuditLine,
  encodeAuditJsonl,
  decodeAuditLine,
  decodeAuditJsonl,
} from './audit/jsonl.js';

// --- 决策服务（T-M1-06：分级生命周期 / SLA / 幂等） ---
export {
  DecisionService,
  DecisionRecordNotFoundError,
  validateDecisionRequest,
  filterAuditByDecision,
  MemoryDecisionStore,
} from './decision-service/index.js';
export type {
  DecisionServiceDeps,
  DecisionRecordStore,
  DecisionStatus,
  DecisionMode,
  ApprovalVerdict,
  DecisionOutcome,
  DecisionApprovalRecord,
  DecisionResult,
  DecisionRecord,
  ApprovalRequest,
  DecisionListFilter,
} from './decision-service/index.js';

// --- fealty 签名链 v1（纯函数，Ed25519 + JCS 子集，仅依赖 node:crypto） ---
export {
  canonicalJson,
  canonicalDigest,
  digestCard,
  createAttestation,
  sealSnapshot,
  verifySignedSnapshot,
  attestationMatchesCard,
  publishRootKey,
  Ed25519MemorySigner,
  Ed25519Verifier,
} from './signing.js';
export type {
  RosterSigner,
  RosterVerifier,
  PublishedRootKey,
  Attestation,
  Seal,
  SignedRosterSnapshot,
  AttestationSource,
  SealOptions,
  VerifyResult,
} from './signing.js';

// --- E1 fan-out 决策内核（并行派发 / 合并 / 聚合 / 冲突 / 仲裁 / 回放） ---
export { Orchestrator, UnknownIntentError, IntentRequestConflictError } from './orchestrator/orchestrator.js';
export type { OrchestratorOptions, PushReceiveResult, OrchestratorSnapshot } from './orchestrator/orchestrator.js';
export { PlanFlow, PLANNER_TAG, extractPlanDraft } from './orchestrator/plan-flow.js';
export type { PlanFlowOptions, PlanFlowRequest, PlanFlowResult } from './orchestrator/plan-flow.js';
export { Semaphore, QueueFullError, type SlotRelease } from './orchestrator/semaphore.js';
export { mergeBranches } from './orchestrator/merge.js';
export { aggregate, extractPositions, extractStance } from './orchestrator/aggregate.js';
export { detectConflicts } from './orchestrator/conflict.js';
export { applyConflictResolution, recomputeResult, statusFromBranches } from './orchestrator/resolution.js';
export {
  replayDecision,
  replayDecisions,
  replaySnapshot,
  renderReplay,
  ReplayError,
} from './orchestrator/replay.js';
export type {
  DecisionReplay,
  ReplayStep,
  ReplayStepKind,
  ReplayParticipant,
} from './orchestrator/replay.js';
export { arbitrateConflict } from './orchestrator/arbitration.js';
export type { ArbitrateConflictInput } from './orchestrator/arbitration.js';
export { judgeDecision } from './orchestrator/judge.js';
export type { JudgeDecisionInput } from './orchestrator/judge.js';
export { ConcurrencyMetrics, percentile } from './orchestrator/metrics.js';
export type {
  MetricsSnapshot,
  VassalMetric,
  LatencyStats,
  BranchMetricEvent,
  BranchOutcomeKind,
  MetricsOptions,
} from './orchestrator/metrics.js';
export {
  validateDag,
  topologicalOrder,
  topologicalLayers,
  criticalPath,
  dependenciesSatisfied,
  DagValidationError,
} from './orchestrator/dag.js';
export type { DagNode, DagSpec, DagNodeState, DagState } from './orchestrator/dag.js';
export { DagRunner, DagIdInUseError } from './orchestrator/dag-runner.js';
export type { DagResult, DagNodeResult, DagRunnerOptions, ChainRecoveryOptions, ChainRecoveryAudit } from './orchestrator/dag-runner.js';
export { selectCandidates, recoverChain, planRecovery, buildChainPlan } from './orchestrator/discovery.js';
export type { DispatchCandidate, DispatchMode, SelectionContext, ChainFailure, RecoveryAction, ChainStep, ChainPlan, RecoveryInstruction } from './orchestrator/discovery.js';
export type {
  FanOutRequest,
  FanOutResult,
  FanOutStatus,
  BranchOutcome,
  SourcedEvent,
  Position,
  AggregationRule,
  AggregatedDecision,
  Conflict,
  DispatchPort,
  TargetLookup,
  CancelBranchResult,
  DriverResolution,
  BackendArbitration,
  JudgeReview,
} from './orchestrator/types.js';

// ── Org (Tier0 M2; M7 hardened executor) ─────────────────────────────────
export { OrgService, MemoryOrgStore, ORG_ERROR_CODES, OrgServiceError, TaskWorker } from './org/index.js';
export type {
  OrgServiceDeps,
  OrgTaskExecutor,
  OrgTaskExecutorV2,
  ExecutorContext,
  TaskSettlement,
  DispatchResult,
  OrgSnapshot,
  Json,
  ScaleTier,
  Organization,
  Department,
  Position as OrgPosition,
  OrgTask,
  OrgTaskStatus,
  OrgTaskFailureKind,
  OrgTaskProgress,
  OrgTaskTransition,
  CreateOrganizationInput,
  CreateDepartmentInput,
  CreatePositionInput,
  AssignAgentInput,
  CreateOrgTaskInput,
  TaskWorkerDeps,
} from './org/index.js';
