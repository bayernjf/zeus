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
export { jsonlAuditSink, memoryAuditSink, revokeAuditBridge } from './dispatch/audit.js';

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
export { mergeBranches } from './orchestrator/merge.js';
export { aggregate, extractPositions, extractStance } from './orchestrator/aggregate.js';
export { detectConflicts } from './orchestrator/conflict.js';
export { applyConflictResolution, recomputeResult, statusFromBranches } from './orchestrator/resolution.js';
export { arbitrateConflict } from './orchestrator/arbitration.js';
export type { ArbitrateConflictInput } from './orchestrator/arbitration.js';
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
export { bootKernel } from './state/boot.js';
export type { KernelBoot, KernelBootOptions } from './state/boot.js';
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
} from './realm/types.js';
export {
  RealmError,
  RealmNotConnectedError,
  UnsupportedRealmTypeError,
  InvalidItemIdError,
  UnsupportedQueryError,
} from './realm/types.js';

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
