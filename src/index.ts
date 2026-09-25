/**
 * Zeus public library surface.
 *
 * Kernel modules (pure TS, no transport):
 *  - a2a      standard A2A protocol types + x-zeus-* vassal extensions
 *  - registry A1 vassal registry (card registration / fealty / health / revoke)
 *  - roster   R0 roster projector (internal/public snapshots for bayjf)
 *  - dispatch A2 dispatcher (JSON-RPC + SSE, data diode, revocation gate, audit)
 *  - oversight A4 oversight desk (input-required escalation queue)
 *  - orchestrator E1 fan-out decision kernel (parallel dispatch, merge, aggregate, conflict)
 *  - memory   memory consolidation protocol (append-only event log, fact store via consolidator)
 *  - realm    D1 Realm P0 (read-only personal data domain, scan search)
 *
 * Transport layers (MCP / HTTP) wrap this surface; they are not part of the
 * kernel and must not leak realm paths or registry internals.
 */

// --- A2A protocol: standard layer + x-zeus-* supersession extensions ---
export { SUPPORTED_FEALTY_VERSIONS } from './a2a/types.js';
export { isFilePart, artifactFileUris } from './a2a/parts.js';
export type {
  RealmType,
  Fealty,
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

// --- A1 vassal registry ---
export { VassalRegistry, defaultTaskUrl } from './registry/registry.js';
export type {
  VassalEntry,
  VassalLike,
  VassalLookup,
  VassalStatus,
  RegistryHooks,
} from './registry/registry.js';

// --- R0 roster projector (bayjf 封神榜) ---
export { projectInternalRoster, projectPublicRoster } from './registry/roster.js';
export type {
  RosterHealth,
  RosterCommitments,
  RosterEntry,
  PublicRosterEntry,
  RosterSnapshot,
} from './registry/roster.js';

// --- fealty signing chain v1 (R1 prerequisite; pure functions, Ed25519 + JCS subset) ---
export {
  canonicalJson,
  canonicalDigest,
  digestCard,
  createAttestation,
  sealSnapshot,
  verifySignedSnapshot,
  attestationMatchesCard,
  Ed25519MemorySigner,
  Ed25519Verifier,
} from './registry/signing.js';
export type {
  RosterSigner,
  RosterVerifier,
  Attestation,
  Seal,
  SignedRosterSnapshot,
  AttestationSource,
  SealOptions,
  VerifyResult,
} from './registry/signing.js';

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

// --- E1 fan-out decision kernel (parallel dispatch / merge / aggregate / conflict) ---
export { Orchestrator, UnknownIntentError } from './orchestrator/orchestrator.js';
export type { OrchestratorOptions } from './orchestrator/orchestrator.js';
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
export { DagRunner } from './orchestrator/dag-runner.js';
export type { DagResult, DagNodeResult, DagRunnerOptions } from './orchestrator/dag-runner.js';
export {
  FileKernelStateStore,
  collectKernelState,
  applyKernelState,
  KernelStateError,
  KERNEL_STATE_VERSION,
} from './state/kernel-state.js';
export type { KernelSnapshot, KernelComponents } from './state/kernel-state.js';
export { kernelStats, type KernelStats } from './state/stats.js';
export { bootKernel, resolveDecisionConfig, resolveConcurrencyConfig, resolveAuditConfig, KernelBootError } from './state/boot.js';
export type { KernelBootOptions, KernelBoot, ProcessDecisionConfig, ProcessConcurrencyConfig, ProcessAuditConfig } from './state/boot.js';
export type { OrchestratorSnapshot } from './orchestrator/orchestrator.js';
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

// --- E2 Skill registry (skills as first-class modules, independent of cards) ---
export { SkillRegistry, compareVersions, CARD_CATALOGUE_VERSION, DuplicateSkillError, SkillNotFoundError } from './skills/registry.js';
export { validateSkillSpecShape, validatePermissionClaims, SkillValidationError } from './skills/validate-spec.js';
export type { SkillSpec, SkillSpecInput, SkillStatus, TeamSlot, TeamResolution, SkillHardening } from './skills/types.js';

// --- E2.5 Mentor skill transfer ---
export { MentorshipLedger, MentorshipError } from './skills/mentor.js';
export type {
  MentorshipRecord,
  MentorshipStatus,
  CompetencyCheck,
  LessonEntry,
  CommissionMentorshipInput,
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
export { MemoryStore, MemoryBoundaryError } from './memory/memory-store.js';
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
export type {
  ConnectorDeclaration,
  ConnectorRecord,
  ConnectorStatus,
  ConnectorCapabilities,
  McpClientDeps,
} from './mcp/types.js';

// --- D1 Realm P0 ---
export { FsRealmStore } from './realm/store.js';
export { sha256Hex, digestManifest } from './realm/digest.js';
export type {
  RealmStore,
  RealmManifest,
  RealmBackupStrategy,
  RealmBackupState,
  RealmHit,
  SearchQuery,
  RealmItem,
  RealmWriteItem,
  RealmWriteResult,
  DriverWriteGrant,
  SignedDriverWriteGrant,
  GrantVerification,
} from './realm/types.js';
export {
  RealmError,
  RealmNotConnectedError,
  InvalidItemIdError,
  UnsupportedQueryError,
  UnauthorizedRealmWriteError,
  UnsupportedWriteError,
} from './realm/types.js';
export {
  verifyDriverWriteGrant,
  issueDriverWriteGrant,
  DriverGrantLedger,
  DriverGrantError,
  DRIVER_GRANT_DEFAULT_TTL_MS,
  DRIVER_GRANT_MAX_TTL_MS,
  MAX_SPENT_GRANT_NONCES,
} from './realm/grant.js';
export type {
  DriverGrantAuditEntry,
  DriverGrantLedgerOptions,
  GrantVerificationContext,
  IssueDriverGrantInput,
  IssueDriverGrantOptions,
} from './realm/grant.js';
export type { RealmWriteAuditEntry, FsRealmStoreOptions, DriverGrantAuthority } from './realm/store.js';

// --- E3.6 tenancy + E6.4 cross-domain authorization and retrieval ---
export { parseTenant, formatTenant, normalizeTenant, tenantReaches, TenantError } from './realm/tenant.js';
export {
  decideRealmAccess,
  verifyDomainGrant,
  DomainGrantRegistry,
  DomainGrantError,
} from './realm/authorization.js';
export type { ScopedRealm, GrantAuditEntry, DomainGrantState, GrantVerification as DomainGrantVerification } from './realm/authorization.js';
export { resolveRealmSource, RealmSourceError } from './realm/source.js';
export type { RealmSource, RealmAuditEntry, ResolvedRealmSource } from './realm/source.js';
export type {
  TenantScope,
  RealmActor,
  RealmAccess,
  DomainGrant,
  DomainDecision,
} from './realm/types.js';

// --- E9.1/E9.2 onboarding: the commission gate and the day-one briefing ---
export { CommissionLedger, verifyCommission } from './onboarding/commission.js';
export type { CommissionDeps, CommissionAuditEntry, OpenCommissionInput } from './onboarding/commission.js';
export { composeBriefing } from './onboarding/briefing.js';
export type { BriefingDeps, RoleBriefing } from './onboarding/briefing.js';
export {
  CommissionError,
  commissionId,
} from './onboarding/types.js';
export type {
  CommissionRecord,
  CommissionStage,
  CommissionCheck,
  CommissionVerdict,
  CommissionGate,
  EvidenceGate,
  MentorshipCheck,
} from './onboarding/types.js';

// --- Realm MCP stdio scaffold (read-only; process entry is realm/mcp-stdio.ts) ---
export {
  createRealmMcpHandler,
  publicManifest,
  manifestUri,
  searchUri,
  REALM_URI_SCHEME,
  JSONRPC_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  JSON_RPC_CODES,
} from './realm/mcp.js';
export type {
  JsonRpcId,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcError,
  McpHandlerDeps,
} from './realm/mcp.js';

// --- Vault treasure map & recovery protocol (E8.1/E8.2; references only, sealed at rest) ---
export { buildVault, parseMap, assertMap } from './vault/map.js';
export { seal, open, validateEnvelopeShape } from './vault/cipher.js';
export type { VaultKey } from './vault/cipher.js';
export { inventoryFromRealm } from './vault/inventory.js';
export { restoreDryRun, restorePlan } from './vault/restore.js';
export {
  packFull,
  openBundle,
  sealMap,
  openMap,
  restoreFromBundle,
  FsRestoreSink,
} from './vault/bundle.js';
export type { PackedFull } from './vault/bundle.js';
export {
  MAP_FORMAT,
  BUNDLE_FORMAT,
  VAULT_VERSION,
  VaultError,
  VaultDecryptError,
  VaultFormatError,
  VaultBundleMismatchError,
} from './vault/types.js';
export type {
  TreasureMap,
  MapMark,
  BundleRef,
  SealedEnvelope,
  FullBundle,
  BundleItem,
  RestoreReport,
  VaultInventory,
  RestoreSink,
} from './vault/types.js';

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
