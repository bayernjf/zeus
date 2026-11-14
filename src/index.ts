/**
 * Zeus public library surface.
 *
 * Runtime modules (pure TS, no transport):
 *  - a2a      standard A2A protocol types + x-zeus-* executor extensions
 *  - registry A1 executor registry (card registration / handshake / health / revoke)
 *  - roster   R0 roster projector (internal/public snapshots for bayjf)
 *  - dispatch A2 dispatcher (JSON-RPC + SSE, data diode, revocation gate, audit)
 *  - oversight A4 oversight desk (input-required escalation queue)
 *  - orchestrator E1 fan-out decision runtime (parallel dispatch, merge, aggregate, conflict)
 *  - memory   memory consolidation protocol (append-only event log, fact store via consolidator)
 *  - dataDomain    D1 DataDomain P0 (read-only personal data domain, scan search)
 *
 * Transport layers (MCP / HTTP) wrap this surface; they are not part of the
 * runtime and must not leak dataDomain paths or registry internals.
 */

// --- A2A protocol: standard layer + x-zeus-* supersession extensions ---
export { SUPPORTED_HANDSHAKE_VERSIONS } from './a2a/types.js';
export { isFilePart, artifactFileUris } from './a2a/parts.js';
export type {
  DataDomainType,
  Handshake,
  AgentCardSkill,
  AgentCard,
  TaskState,
  ZeusReport,
  Part,
  TextPart,
  DataPart,
  FilePart,
  Artifact,
  Task,
  A2AEvent,
} from './a2a/types.js';

// --- A1 executor registry ---
export { ExecutorRegistry, defaultTaskUrl, CardFetchError, ExecutorRevokedError, ExecutorConflictError } from './registry/registry.js';
export type {
  ExecutorEntry,
  PublicExecutorEntry,
  ExecutorLike,
  ExecutorLookup,
  ExecutorStatus,
  RegistryHooks,
} from './registry/registry.js';

// --- R0 roster projector (bayjf 公开签名名册) ---
export { projectInternalRoster, projectPublicRoster, ROSTER_SCHEMA_VERSION } from './registry/roster.js';
export type {
  RosterHealth,
  RosterCommitments,
  RosterEntry,
  PublicRosterEntry,
  RosterSnapshot,
} from './registry/roster.js';

// --- handshake signing chain v1 (R1 prerequisite; pure functions, Ed25519 + JCS subset) ---
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
} from './core/signing.js';
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
} from './core/signing.js';

// --- A2 dispatch: orchestration, data diode, revocation gate ---
export { Dispatcher, AmbiguousSkillError } from './dispatch/dispatcher.js';
export type {
  AuditDecision,
  AuditEntry,
  DispatchRequest,
  DispatchResult,
  AuditSink,
} from './dispatch/dispatcher.js';
export { sendTask, sendTaskSubscribe, cancelTask, A2AClientError } from './dispatch/client.js';
export type { SendTaskInput, SubscribeHandlers, FetchLike } from './dispatch/client.js';
export {
  jsonlAuditSink,
  memoryAuditSink,
  readAuditLog,
  AuditLogError,
  DEFAULT_AUDIT_MAX_BYTES,
  DEFAULT_AUDIT_KEEP,
  type AuditQuery,
  type JsonlAuditSinkOptions,
  revokeAuditBridge,
  reinstateAuditBridge,
} from './dispatch/audit.js';

// --- A4 oversight desk + E6.2 conflict settlement ---
export { OversightDesk, extractEscalation, conflictsToDesk } from './oversight/oversight.js';
export type { OversightOptions } from './oversight/oversight.js';
export type {
  Escalation,
  EscalationStatus,
  EscalationKind,
  OversightAuditEntry,
  CancelTaskFn,
} from './oversight/types.js';

// --- E1 fan-out decision runtime (parallel dispatch / merge / aggregate / conflict) ---
export { Orchestrator, UnknownIntentError, IntentRequestConflictError } from './core/orchestrator/orchestrator.js';
export type { OrchestratorOptions } from './core/orchestrator/orchestrator.js';
export type { PushReceiveResult } from './core/orchestrator/orchestrator.js';
export { PlanFlow, PLANNER_TAG, extractPlanDraft } from './core/orchestrator/plan-flow.js';
export type { PlanFlowOptions, PlanFlowRequest, PlanFlowResult } from './core/orchestrator/plan-flow.js';
export { Semaphore, QueueFullError, type SlotRelease } from './core/orchestrator/semaphore.js';
export { mergeBranches } from './core/orchestrator/merge.js';
export { aggregate, extractPositions, extractStance } from './core/orchestrator/aggregate.js';
export { detectConflicts } from './core/orchestrator/conflict.js';
export { applyConflictResolution, recomputeResult, statusFromBranches } from './core/orchestrator/resolution.js';
export {
  replayDecision,
  replayDecisions,
  replaySnapshot,
  renderReplay,
  ReplayError,
} from './core/orchestrator/replay.js';
export type {
  DecisionReplay,
  ReplayStep,
  ReplayStepKind,
  ReplayParticipant,
} from './core/orchestrator/replay.js';
export { arbitrateConflict } from './core/orchestrator/arbitration.js';
export type { ArbitrateConflictInput } from './core/orchestrator/arbitration.js';
export { judgeDecision } from './core/orchestrator/judge.js';
export type { JudgeDecisionInput } from './core/orchestrator/judge.js';
export { ConcurrencyMetrics, percentile } from './core/orchestrator/metrics.js';
// --- S6 observability: trace projection + local exporters ---
export { buildTraceTree } from './observability/trace.js';
export type { TraceSpan, TraceSpanKind, TraceSpanEventKind, TraceTree, TraceExporter } from './observability/trace.js';
export { JsonlTraceExporter, OtlpTraceExporter } from './observability/exporter.js';
export type { ExportedTraceRecord, OtlpTraceExporterOptions, OtlpExportPayload, OtlpSpan } from './observability/exporter.js';
export { MetricsHistory } from './observability/metrics-history.js';
// --- deferred #40 read-only half: execution-after failure attribution ---
export { attributeFailures, participantsToEntries } from './reflection/failure-attribution.js';
export type {
  FailureAttribution,
  FailureCategory,
  FailurePattern,
  ExecutorAttribution,
  CategoryCounts,
} from './reflection/failure-attribution.js';
// --- Structured operator log (feature-inventory 结构化日志) ---
export { createLogger, redact, redactText, redactUrl } from './util/logger.js';
export type { Logger, LogLevel, LogFields, LogSink, LoggerOptions } from './util/logger.js';
export type {
  MetricsSnapshot,
  ExecutorMetric,
  LatencyStats,
  BranchMetricEvent,
  BranchOutcomeKind,
  MetricsOptions,
} from './core/orchestrator/metrics.js';
export {
  validateDag,
  topologicalOrder,
  topologicalLayers,
  criticalPath,
  dependenciesSatisfied,
  DagValidationError,
} from './core/orchestrator/dag.js';
export type { DagNode, DagSpec, DagNodeState, DagState } from './core/orchestrator/dag.js';
export { DagRunner, DagIdInUseError } from './core/orchestrator/dag-runner.js';
export type { DagResult, DagNodeResult, DagRunnerOptions, ChainRecoveryOptions, ChainRecoveryAudit } from './core/orchestrator/dag-runner.js';
export { selectCandidates, recoverChain, planRecovery, buildChainPlan } from './core/orchestrator/discovery.js';
export type { DispatchCandidate, DispatchMode, SelectionContext, ChainFailure, RecoveryAction, ChainStep, ChainPlan, RecoveryInstruction } from './core/orchestrator/discovery.js';
export {
  FileRuntimeStateStore,
  collectRuntimeState,
  applyRuntimeState,
  RuntimeStateError,
  RUNTIME_STATE_VERSION,
} from './state/runtime-state.js';
export type { RuntimeSnapshot, RuntimeComponents } from './state/runtime-state.js';
export { runtimeStats, type RuntimeStats } from './state/stats.js';
export { bootRuntime, resolveDecisionConfig, resolveConcurrencyConfig, resolveAuditConfig, RuntimeBootError } from './state/boot.js';
export type { RuntimeBootOptions, RuntimeBoot, ProcessDecisionConfig, ProcessConcurrencyConfig, ProcessAuditConfig } from './state/boot.js';
export type { OrchestratorSnapshot } from './core/orchestrator/orchestrator.js';
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
  OperatorResolution,
  BackendArbitration,
  JudgeReview,
} from './core/orchestrator/types.js';

// --- Decision backend (model-agnostic port; Jev decision-model + LLM adapters) ---
export { createJevBackend, createJevBackendFromEnv } from './decision/decision-model.js';
export { createLlmBackend, createLlmBackendFromEnv } from './decision/llm.js';
export { arbitrateSplit } from './decision/arbitrate.js';
export { DecisionBackendFailure } from './decision/types.js';
export type {
  DecisionBackend,
  DecisionBackendKind,
  DecisionBackendError,
  DecisionBackendErrorCode,
  DecisionTrace,
  NoulRequest,
  NoulResult,
  ChoiceRequest,
  ChoiceResult,
  ScoreRequest,
  ScoreResult,
  QuestionBase,
  BackendOptions,
} from './decision/types.js';
export type { JevConfig } from './decision/decision-model.js';
export type { LlmConfig } from './decision/llm.js';
export type { ArbitrateInput, ArbitrateOutcome, SplitStance } from './decision/arbitrate.js';

// --- E2.6 Operator intent recognition (plan-only; pluggable backend) ---
export { recognizeIntent, rankCandidates } from './intent/recognize.js';
export type {
  SkillCatalogEntry,
  IntentCandidate,
  IntentRecognitionOptions,
  IntentRecognitionResult,
  RecognizedIntent,
} from './intent/recognize.js';

// --- E2 Skill registry (skills as first-class modules, independent of cards) ---
export { SkillRegistry, compareVersions, CARD_CATALOGUE_VERSION, DuplicateSkillError, SkillNotFoundError } from './skills/registry.js';
export { validateSkillSpecShape, validatePermissionClaims, permissionClaimIssue, SkillValidationError } from './skills/validate-spec.js';
export type { SkillSpec, SkillSpecInput, SkillStatus, TeamSlot, TeamResolution, SkillHardening } from './skills/types.js';

// --- E2.5 Mentor skill transfer ---
export { MentorshipLedger, MentorshipError } from './skills/mentor.js';
export type {
  MentorshipRecord,
  MentorshipStatus,
  CompetencyCheck,
  LessonEntry,
  SeatGrantMentorshipInput,
  AssessOptions,
} from './skills/mentor.js';

// --- Memory consolidation protocol (P0: append log + pure consolidator) ---
export {
  consolidate,
  aggregateConfidence,
  isClaimContent,
  stableStringify,
  MemoryConsolidationError,
} from './memory/consolidate.js';
export {
  branchVerdictClaims,
  claimSubject,
  claimPredicate,
  MAX_STANCE_CHARS,
  type BranchClaimOptions,
} from './memory/producer.js';
export { MemoryStore, MemoryBoundaryError, MemoryEventConflictError } from './memory/memory-store.js';
export { RecallIndex, LocalHashingEmbedder, tokenize, factText } from './memory/recall.js';
export {
  reconcileMemoryStates,
  verifyMemoryState,
} from './memory/reconcile.js';
export type {
  MemoryDriftReport,
  FactDrift,
  FactFieldChange,
  MemoryConsistencyViolation,
} from './memory/reconcile.js';
export { factId } from './memory/consolidate.js';
export type {
  MemoryKind,
  MemoryEvent,
  FactStatus,
  FactRecord,
  DisputeRecord,
  ConsolidationResult,
  ClaimContent,
  ConsolidateOptions,
  MemoryState,
  Embedder,
  RecallHit,
  RecallSearchOptions,
  RetractionRecord,
} from './memory/types.js';
export type { MemoryAuditEntry, MemoryReplay } from './memory/memory-store.js';

// --- E7 MCP connectors (minimum-privilege external system connections) ---
export { ConnectorRegistry, ConnectorError } from './mcp/connectors.js';
export type { ConnectorAuditEntry } from './mcp/connectors.js';
export { McpClient, McpClientError } from './mcp/client.js';
export { McpStdioClient, McpStdioError } from './mcp/stdio-client.js';
export type { StdioSpawnOptions } from './mcp/stdio-client.js';
export type {
  ConnectorDeclaration,
  ConnectorRecord,
  ConnectorStatus,
  ConnectorCapabilities,
  ConnectorTransport,
  McpClientDeps,
} from './mcp/types.js';

// --- D1 DataDomain P0 ---
export { FsDataDomainStore } from './dataDomain/store.js';
export { sha256Hex, digestManifest } from './dataDomain/digest.js';
export type {
  DataDomainStore,
  DataDomainManifest,
  DataDomainBackupStrategy,
  DataDomainBackupState,
  DataDomainHit,
  SearchQuery,
  DataDomainItem,
  DataDomainWriteItem,
  DataDomainWriteResult,
  OperatorWriteGrant,
  SignedOperatorWriteGrant,
  GrantVerification,
} from './dataDomain/types.js';
export {
  DataDomainError,
  DataDomainNotConnectedError,
  InvalidItemIdError,
  UnsupportedQueryError,
  UnauthorizedDataDomainWriteError,
  UnsupportedWriteError,
} from './dataDomain/types.js';
export {
  verifyOperatorWriteGrant,
  issueOperatorWriteGrant,
  OperatorGrantLedger,
  OperatorGrantError,
  OPERATOR_GRANT_DEFAULT_TTL_MS,
  OPERATOR_GRANT_MAX_TTL_MS,
  MAX_SPENT_GRANT_NONCES,
} from './dataDomain/grant.js';
export type {
  OperatorGrantAuditEntry,
  OperatorGrantLedgerOptions,
  GrantVerificationContext,
  IssueOperatorGrantInput,
  IssueOperatorGrantOptions,
} from './dataDomain/grant.js';
export type { DataDomainWriteAuditEntry, FsDataDomainStoreOptions, OperatorGrantAuthority } from './dataDomain/store.js';

// --- E3.6 tenancy + E6.4 cross-domain authorization and retrieval ---
export { parseTenant, formatTenant, normalizeTenant, tenantKey, tenantReaches, TenantError } from './dataDomain/tenant.js';
export {
  decideDataDomainAccess,
  verifyDomainGrant,
  DomainGrantRegistry,
  DomainGrantError,
} from './dataDomain/authorization.js';
export type { ScopedDataDomain, GrantAuditEntry, DomainGrantState, GrantVerification as DomainGrantVerification } from './dataDomain/authorization.js';
export { resolveDataDomainSource, DataDomainSourceError } from './dataDomain/source.js';
export type { DataDomainSource, DataDomainAuditEntry, ResolvedDataDomainSource } from './dataDomain/source.js';
export type {
  TenantScope,
  DataDomainActor,
  DataDomainAccess,
  DomainGrant,
  DomainDecision,
} from './dataDomain/types.js';

// --- E9.1/E9.2 onboarding: the seatGrant gate and the day-one briefing ---
export { SeatGrantLedger, verifySeatGrant } from './onboarding/seatGrant.js';
export type { SeatGrantDeps, SeatGrantAuditEntry, OpenSeatGrantInput } from './onboarding/seatGrant.js';
export { composeBriefing } from './onboarding/briefing.js';
export type { BriefingDeps, RoleBriefing } from './onboarding/briefing.js';
export {
  SeatGrantError,
  seatGrantId,
} from './onboarding/types.js';
export type {
  SeatGrantRecord,
  SeatGrantStage,
  SeatGrantCheck,
  SeatGrantVerdict,
  SeatGrantGate,
  EvidenceGate,
  MentorshipCheck,
} from './onboarding/types.js';

// --- DataDomain MCP stdio scaffold (read-only; process entry is dataDomain/mcp-stdio.ts) ---
export {
  createDataDomainMcpHandler,
  publicManifest,
  manifestUri,
  searchUri,
  DATA_DOMAIN_URI_SCHEME,
  JSONRPC_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  JSON_RPC_CODES,
} from './dataDomain/mcp.js';
export type {
  JsonRpcId,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcError,
  McpHandlerDeps,
} from './dataDomain/mcp.js';

// --- G6: read-only runtime tool face over MCP (memory.recall / traces.query) ---
export {
  createRuntimeToolsMcpHandler,
  RUNTIME_MCP_PROTOCOL_VERSION,
  RUNTIME_MCP_ERROR_CODES,
} from './mcp/runtime-tools.js';
export type { RuntimeMcpActor, RuntimeToolsMcpDeps } from './mcp/runtime-tools.js';

// --- Backup treasure map & recovery protocol (E8.1/E8.2; references only, sealed at rest) ---
export { buildBackup, parseMap, assertMap } from './backup/map.js';
export { seal, open, validateEnvelopeShape } from './backup/cipher.js';
export type { BackupKey } from './backup/cipher.js';
export { inventoryFromDataDomain } from './backup/inventory.js';
export { restoreDryRun, restorePlan } from './backup/restore.js';
export {
  packFull,
  openBundle,
  sealMap,
  openMap,
  restoreFromBundle,
  FsRestoreSink,
} from './backup/bundle.js';
export type { PackedFull } from './backup/bundle.js';
export {
  MAP_FORMAT,
  BUNDLE_FORMAT,
  BACKUP_VERSION,
  BackupError,
  BackupDecryptError,
  BackupFormatError,
  BackupBundleMismatchError,
} from './backup/types.js';
export type {
  TreasureMap,
  MapMark,
  BundleRef,
  SealedEnvelope,
  FullBundle,
  BundleItem,
  RestoreReport,
  BackupInventory,
  RestoreSink,
} from './backup/types.js';

// --- Diary (E8.3 narrative memory) ---
export { buildDiary } from './diary/build.js';
export { renderDiaryMarkdown } from './diary/markdown.js';
export { persistDiary, exportDiary } from './diary/persist.js';
export { buildDiariesFromState } from './diary/from-memory.js';
export type { BuildDiariesOptions } from './diary/from-memory.js';
export {
  renderEventContent,
  dayBucket,
  formatTime,
  renderObject,
  NO_CONTENT,
} from './diary/render.js';
export { DiaryError, DiaryBoundaryError, DiaryUnsupportedError } from './diary/types.js';
export type {
  DiaryEntry,
  DiaryLine,
  DiaryFact,
  DiaryId,
  BuildDiaryOptions,
  PersistDiaryOptions,
} from './diary/types.js';

// --- Org virtual departments (E9.3 establishment & accountability) ---
export { createDepartment, assignMember, removeMember, setLead, slug, departmentIdFor } from './org/department.js';
export { buildOrgChart, renderOrgMarkdown } from './org/chart.js';
export type { OrgChartView } from './org/chart.js';
export { traceAccountability } from './org/accountability.js';
export { OrgRegistry } from './org/registry.js';
export { OrgError } from './org/types.js';
export type {
  Department,
  OrgMember,
  OrgRole,
  CreateDepartmentInput,
  AssignMemberInput,
  AccountabilityChain,
  AccountabilityNode,
} from './org/types.js';

// --- Execution delegation (deferred #33): one-time, short-lived operator authorization ---
export {
  issueExecutionDelegation,
  verifyAndConsumeExecutionDelegation,
  ExecutionDelegationNonceLedger,
  ExecutionDelegationError,
  EXECUTION_DELEGATION_DEFAULT_TTL_MS,
  EXECUTION_DELEGATION_MAX_TTL_MS,
} from './delegation/execution-delegation.js';
export type {
  ExecutionDelegation,
  IssueExecutionDelegationInput,
  ExecutionDelegationVerification,
  VerifyExecutionDelegationContext,
} from './delegation/execution-delegation.js';

// --- Delegation contract (design-self-host-loop §4): bounded authority to mint tickets unattended ---
export {
  issueDelegationContract,
  verifyDelegationContract,
  deriveExecutionDelegation,
  DelegationContractRegistry,
  DelegationContractError,
  DELEGATION_CONTRACT_REQUIRED_CAPABILITY,
} from './delegation/delegation-contract.js';
export type {
  DelegationContract,
  IssueDelegationContractInput,
  DelegationContractCheck,
  DelegationContractRefusal,
  DeriveExecutionDelegationInput,
  DeriveResult,
} from './delegation/delegation-contract.js';

// --- Watch (design-self-host-loop §3): the trigger primitive, metrics + dataDomain sources ---
export {
  WatchRegistry,
  WatchError,
  evaluatePredicate,
  dataDomainReading,
  connectorReading,
  readPath,
  WATCH_SOURCES,
  WATCH_OPS,
  WATCH_FIELDS,
  WATCH_PATH_GRAMMAR,
} from './watch/watch.js';
export type {
  Watch,
  WatchSource,
  WatchOp,
  WatchPredicate,
  WatchReading,
  WatchSources,
  WatchAuditEntry,
  WatchSubmitRequest,
  WatchSubmitResult,
  WatchTickOptions,
  WatchTickReport,
} from './watch/watch.js';
