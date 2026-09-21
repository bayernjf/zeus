/**
 * Zeus public library surface.
 *
 * Kernel modules (pure TS, no transport):
 *  - a2a      standard A2A protocol types + x-zeus-* vassal extensions
 *  - registry A1 vassal registry (card registration / fealty / health / revoke)
 *  - roster   R0 roster projector (internal/public snapshots for bayjf)
 *  - dispatch A2 dispatcher (JSON-RPC + SSE, data diode, revocation gate, audit)
 *  - oversight A4 oversight desk (input-required escalation queue)
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

// --- A4 oversight desk ---
export { OversightDesk, extractEscalation } from './oversight/oversight.js';
export type { OversightOptions } from './oversight/oversight.js';
export type {
  Escalation,
  EscalationStatus,
  OversightAuditEntry,
  CancelTaskFn,
} from './oversight/types.js';

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
