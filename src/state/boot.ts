import { ExecutorRegistry } from '../registry/registry.js';
import { sha256Hex } from '../util/crypto.js';
import type { FetchLike } from '../dispatch/client.js';
import { Dispatcher, type AuditSink } from '../dispatch/dispatcher.js';
import {
  DEFAULT_AUDIT_KEEP,
  DEFAULT_AUDIT_MAX_BYTES,
  jsonlAuditSink,
  readAuditLog,
  reinstateAuditBridge,
  revokeAuditBridge,
} from '../dispatch/audit.js';
import { OversightDesk, conflictsToDesk } from '../oversight/oversight.js';
import type { OversightAuditEntry } from '../oversight/types.js';
import { Orchestrator } from '../orchestrator/orchestrator.js';
import type { BackendArbitration, JudgeReview } from '../core/orchestrator/types.js';
import { DagRunner } from '../orchestrator/dag-runner.js';
import { PlanFlow } from '../orchestrator/plan-flow.js';
import { ConcurrencyMetrics } from '../orchestrator/metrics.js';
import { FsDataDomainStore } from '../dataDomain/store.js';
import { OperatorGrantLedger, type OperatorGrantAuditEntry } from '../dataDomain/grant.js';
import {
  ExecutionDelegationNonceLedger,
  type ExecutionDelegationAuditEntry,
  type ExecutionDelegation,
} from '../delegation/execution-delegation.js';
import {
  DelegationContractRegistry,
  deriveExecutionDelegation,
  type DelegationContractAuditEntry,
} from '../delegation/delegation-contract.js';
import { WatchRegistry, dataDomainReading, connectorReading, type WatchTickReport } from '../watch/watch.js';
import type { Ed25519MemorySigner } from '../registry/signing.js';
import { DomainGrantRegistry, type GrantAuditEntry } from '../dataDomain/authorization.js';
import { normalizeTenant } from '../dataDomain/tenant.js';
import type { DataDomainAuditEntry } from '../dataDomain/source.js';
import type { DataDomainType, TenantScope } from '../dataDomain/types.js';
import { ProgressHub, type ProgressEvent } from '../orchestrator/progress.js';
import { buildTraceTree, type DecisionTraceBuffer, type TraceExporter } from '../observability/trace.js';
import { JsonlTraceExporter } from '../observability/exporter.js';
import { MetricsHistory } from '../observability/metrics-history.js';
import {
  IntentArchive,
  archiveFilePath,
  selectArchivable,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_WINDOW_MS,
  type ArchivedIntentRecord,
  type IntentArchiveLookup,
  type RetentionMode,
} from './archive.js';
import { SkillRegistry } from '../skills/registry.js';
import { MentorshipLedger } from '../skills/mentor.js';
import { OrgRegistry } from '../org/registry.js';
import { MemoryStore, type MemoryAuditEntry } from '../memory/memory-store.js';
import { createMemoryEmbedder } from '../memory/hub-embedder.js';
import { branchVerdictClaims } from '../memory/producer.js';
import { ConnectorRegistry, type ConnectorAuditEntry } from '../mcp/connectors.js';
import { SeatGrantLedger, type SeatGrantAuditEntry } from '../onboarding/seatGrant.js';
import {
  FileRuntimeStateStore,
  applyRuntimeState,
  collectRuntimeState,
  type RuntimeComponents,
  type RuntimeSnapshot,
} from './runtime-state.js';
import { ProcessLock } from './process-lock.js';
import { computeCheckpoint, executeRecovery } from '../orchestrator/recovery.js';
import type { CostLimit } from '../orchestrator/cost-ledger.js';
import type { BackendOptions, DecisionBackend } from '../decision/types.js';
import { createJevBackendFromEnv } from '../decision/decision-model.js';
import { createLlmBackendFromEnv } from '../decision/llm.js';
import { activeHubModelResolve, createHubDecisionBackend, type HubTestPort } from '../decision/hub-backend.js';
import { redactUrl } from '../util/logger.js';

/**
 * E5.3 process boot assembly (design-http-transport §2.2/§2.3: the long-running
 * service prerequisite). Wires the four live runtime components exactly once —
 * registry, oversight desk, dispatcher and orchestrator — with conflict
 * escalation already bridged into the desk (conflictsToDesk), and optionally
 * restores a JSON snapshot produced by FileRuntimeStateStore.
 *
 * Without `stateFile` the runtime stays purely in-memory (library/H1 behaviour).
 * With it, boot loads and applies the snapshot when one exists, and saveState()
 * atomically writes the live state for the next restart. The transport layer
 * (serve.js) calls saveState() during graceful shutdown.
 */

export type RuntimeBoot = RuntimeComponents & {
  /** E1.7 runtime concurrency metrics (not persisted); wired into the orchestrator. */
  metrics: ConcurrencyMetrics;
  /** H3: progress event hub feeding the SSE endpoint. */
  progressHub: ProgressHub;
  /**
   * Self-host loop §3.2: one evaluation pass over the watches. No timer lives in
   * the runtime, so the caller owns the cadence; each watch still honours its own
   * `intervalSeconds`.
   */
  runWatchTick: (at?: Date) => Promise<WatchTickReport>;
  /** Absolute or relative path of the state JSON, or null when in-memory only. */
  stateFile: string | null;
  /** E4.7: JSONL dispatch audit log path, or null when the process writes none. */
  auditFile: string | null;
  /** E6.4: feeds cross-domain read/refusal records into the audit spine. */
  dataDomainAudit: (entry: DataDomainAuditEntry) => void;
  /**
   * E3.5 / deferred #14: how enterprise writes are authorized here. 'signed'
   * means a grant must carry an Ed25519 signature by an accepted operator key;
   * 'shape-only' means the runtime holds no operator key and can only check a
   * grant's shape, dataDomain binding and expiry. Reported, never assumed.
   */
  operatorGrantAuthority: 'signed' | 'shape-only';
  /** The operator key when one is configured; the HTTP face issues grants with it. */
  operatorSigner: Ed25519MemorySigner | null;
  /** Feeds issued write grants into the audit spine. */
  operatorGrantAudit: (entry: OperatorGrantAuditEntry) => void;
  /** Feeds issued execution delegations into the audit spine. */
  executionDelegationAudit: (entry: ExecutionDelegationAuditEntry) => void;
  /** Feeds delegation-contract issuance/revocation into the audit spine. */
  delegationContractAudit: (entry: DelegationContractAuditEntry) => void;
  /** Effective audit rotation ceiling for the active file (Infinity = unbounded). */
  auditMaxBytes: number;
  /** Effective rotated audit generations kept beside the active file. */
  auditKeep: number;
  /**
   * Audit writes that failed after boot. Non-zero means the trail is degraded:
   * decisions were made and answered, but not persisted. Surfaced here so a
   * disk problem cannot hide behind a healthy-looking HTTP status.
   */
  readonly auditFailures: number;
  /** True when a snapshot was found and applied during boot. */
  restoredFromSnapshot: boolean;
  /** The applied snapshot, or null on first boot / in-memory mode. */
  snapshot: RuntimeSnapshot | null;
  /** deferred #42: out-window intent archive when retention is archive|evict. */
  intentArchive?: IntentArchiveLookup;
  /** deferred #42: effective retention mode (retain | archive | evict). */
  retention: RetentionMode;
  /**
   * S6 V3: trace exporter attached when `traceExportFile` was set, otherwise
   * undefined (the default build stays exporter-less). Typed concretely so the
   * HTTP layer can serve the D-5 query face off the same instance's read side
   * (readBack); the write side still satisfies the narrow TraceExporter port.
   */
  traceExporter?: JsonlTraceExporter;
  /**
   * G2 (design-observability §5): the opt-in OTLP exporter when a caller handed
   * one in; undefined = no network export. The settle path fire-and-forgets the
   * same tree to both this and `traceExporter` when both are attached.
   */
  otlpTraceExporter?: TraceExporter;
  /**
   * TracePort v1 §2: the DecisionTrace registry the trace tree assembles model
   * spans from. Wired by the process entry (the same onTrace hook feeds the
   * decision ledger); absent, tree assembly is unchanged (no model spans).
   */
  decisionTraceBuffer?: DecisionTraceBuffer;
  /**
   * S6 V3: metrics history writer attached when `metricsHistoryFile` was set,
   * otherwise undefined (default is off; the live window alone keeps working).
   */
  metricsHistory?: MetricsHistory;
  /** Atomically persist live runtime state; a no-op without stateFile. */
  saveState(): Promise<void>;
  /**
   * Release the cross-process lock held on the state file for this boot's
   * lifetime; a no-op without stateFile. Must run after the final saveState.
   */
  releaseLock(): Promise<void>;
};

export type RuntimeBootOptions = {
  /** When set, state is restored from this file on boot and saved on shutdown. */
  stateFile?: string;
  /**
   * S13 V2 (design-long-running §5): an auto-resume whose crash window exceeds
   * this is reclassified to awaiting the operator. Unset = no time bound.
   */
  recoveryMaxAutoResumeMs?: number;
  /**
   * S9 V2 (design-cost-governance §5): when set, every fan-out is admitted
   * against this intent-level cost limit before dispatch; refusals land on
   * the audit spine (cost-budget-exceeded / cost-rate-circuit-open).
   */
  costLimit?: CostLimit;
  now?: () => Date;
  /** Injected fetch for card registration / outbound A2A calls (tests / proxies). */
  fetchImpl?: FetchLike;
  /** Audit sink for outbound dispatch decisions; defaults to no-op. */
  dispatchAudit?: AuditSink;
  /**
   * E4.7: path of a JSONL dispatch audit log. When set, every audit entry is
   * appended there *and* still forwarded to `dispatchAudit`, so a deployment can
   * persist the trail without losing the live log. Nothing writes it by default.
   */
  auditFile?: string;
  /** A: audit rotation ceiling for the active JSONL file (default 64 MiB). */
  auditMaxBytes?: number;
  /** A: rotated audit generations kept beside the active file (default 5). */
  auditKeep?: number;
  /** Audit sink for oversight actions; defaults to no-op. */
  oversightAudit?: (entry: OversightAuditEntry) => void;
  /** G1: card URLs auto-registered on boot. A URL already present (restored from
   *  snapshot or an earlier seed) is skipped, so seeds never trigger a refetch.
   *  E4.8: an entry may be `{ cardUrl, token? }` to seed the executor's outbound
   *  bearer; a plain string registers with no token. */
  executorSeeds?: Array<string | { cardUrl: string; token?: string }>;
  /** G4: dataDomain roots connected on boot. Strings are personal read-write roots;
   *  objects may set type/readOnly/tenant (E3.6, enterprise scopes). Persisted
   *  roots are reconnected as well. */
  dataDomainRoots?: Array<string | { root: string; type?: DataDomainType; readOnly?: boolean; tenant?: string | TenantScope }>;
  /** Audit sink for memory boundary violations (cross-dataDomain read/append). */
  memoryAudit?: (entry: MemoryAuditEntry) => void;
  /** Audit sink for MCP connector lifecycle events. */
  connectorAudit?: (entry: ConnectorAuditEntry) => void;
  /**
   * deferred #42: decision-record retention. 'retain' (default) keeps every
   * settled intent in the state file; 'archive' moves out-window records to
   * `<stateDir>/intent-archive.jsonl` (append-only, idempotent reads keep
   * working); 'evict' deletes them outright and documents idempotency as
   * window-scoped. The mechanism lands in the runtime regardless; the default
   * keeps today's behaviour until a real instance meets the design §5 trigger.
   */
  intentRetention?: RetentionMode;
  /** deferred #42: settled-intent cap for the out-window condition. */
  intentRetentionMaxEntries?: number;
  /** deferred #42: time window for the out-window condition (ms). */
  intentRetentionWindowMs?: number;
  /**
   * S6 V3 (design-observability §5): when set, each settled intent's trace tree
   * is appended to this JSONL file via JsonlTraceExporter (local file, keyed by
   * traceId). Unset = no exporter, exactly the V1/V2 behaviour.
   */
  traceExportFile?: string;
  /**
   * G2 (design-observability §5): a second, opt-in network exporter (the
   * OTLP/HTTP JSON adapter). Accepted as an instance — endpoint/headers/transport
   * stay the caller's configuration concern (serve.ts builds it from
   * ZEUS_OTLP_ENDPOINT); boot only wires the settle-path fire-and-forget export.
   * Unset = nothing dials out, exactly the V1/V2 behaviour.
   */
  otlpTraceExporter?: TraceExporter;
  /**
   * TracePort v1 §2: the DecisionTrace registry the trace tree assembles model
   * spans from (see the runtime component of the same name). Absent = no model
   * spans, tree assembly unchanged.
   */
  decisionTraceBuffer?: DecisionTraceBuffer;
  /**
   * S6 V3: when set, a MetricsSnapshot is appended to this JSONL file on every
   * state save (keyed by capturedAt), answering trend questions across
   * restarts. Unset = no history, exactly the V1/V2 behaviour.
   */
  metricsHistoryFile?: string;
  /**
   * E1.2/E1.3 decision backend wired into the orchestrator. When present the S2
   * critic arbitration path is live (rule-inconclusive fan-outs consult it);
   * when omitted the runtime runs rules-only exactly as before. serve.ts builds
   * this from process env via resolveDecisionConfig(). Tests inject a mock.
   */
  decisionBackend?: DecisionBackend | null;
  /** E1.3 adversarial judge. Defaults to false; only meaningful with a backend. */
  judgeEnabled?: boolean;
  judgeThreshold?: number;
  allowUncalibratedJudge?: boolean;
  judgeEscalateOnDisagreement?: boolean;
  judgeMaxWaitMs?: number;
  /**
   * E1.5: cap on branches in flight across every intent (one orchestrator per
   * process, so this is the process-wide bound). Unset = unbounded dispatch, the
   * historical behaviour.
   */
  maxConcurrentBranches?: number;
  /** Branches allowed to wait for a slot before one is refused. 0 = never queue. */
  branchQueueLimit?: number;
  /** #9 per-executor saturation cap; must sit below maxConcurrentBranches for
   *  diversion to fire. Unset = no per-executor saturation check. */
  maxConcurrentPerExecutor?: number;
  /**
   * E3.5 / deferred #14: the operator key. When present, an enterprise write is
   * only honored on a grant this key signed (or one whose signer the runtime
   * accepts), and each grant nonce is consumed once. When absent, grants are
   * checked for shape/dataDomain/expiry only — a executor that can reach `write()`
   * could then author its own "authorization", which is why `RuntimeBoot` reports
   * the effective authority instead of hiding it.
   */
  operatorSigner?: Ed25519MemorySigner;
  /** Called when a state write triggered by an event outside shutdown (a
   *  consumed operator-grant nonce) fails. Defaults to silence; serve.ts logs it,
   *  because a nonce that never reaches disk can be replayed after a restart. */
  onStateSaveError?: (message: string) => void;
  /** Called when a persisted audit line cannot be written. Defaults to silence; a
   *  deployment should log it, because a missing trail is a governance fact. */
  onAuditError?: (message: string) => void;
  /**
   * S1 context engineering tuning (design-context-engineering §4/§5/§10):
   * overrides for the per-branch context assembler — memory appendix cap
   * (`maxEntries`, default 20), relevance gate (`minScore`, default off), and
   * the V3 per-branch total entry budget (`maxContextEntriesPerBranch`,
   * default 64). Every value is a structural guard, not a performance
   * calibration; tuning is deferred to #9 once real-load distributions exist.
   */
  contextOptions?: { maxEntries?: number; minScore?: number; maxContextEntriesPerBranch?: number };
  /**
   * E4.11 (design-a2a-push): Zeus's own A2A push receiver address. When set,
   * intents armed with `pushNotification: true` dispatch via plain `tasks/send`
   * carrying this config and settle through the callback endpoint
   * (`POST /api/a2a/push-notifications`, serve.ts mounts it only when the
   * internal token is configured). Arming without this is refused.
   */
  pushReceiver?: { url: string; token?: string };
}

const noop = (): void => {};

export async function bootRuntime(options: RuntimeBootOptions = {}): Promise<RuntimeBoot> {
  // M-10: one cross-process lock covers the whole load-mutate-save window for
  // the boot's lifetime. Acquire is fail-fast (a live holder refuses this boot
  // via RuntimeBootError). A boot that unwinds after taking the lock releases it,
  // so a bad configuration leaves no directory behind; a hard crash cannot run
  // this catch, and the next boot reclaims the stale pid.
  let processLock: ProcessLock | null = null;
  if (options.stateFile) {
    try {
      processLock = await ProcessLock.acquire(`${options.stateFile}.lock`);
    } catch (error) {
      throw new RuntimeBootError(
        `runtime state file is locked by another Zeus process: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  try {
    return await assembleRuntime(options, processLock);
  } catch (error) {
    // Never mask the original boot failure with a release failure.
    if (processLock) await processLock.release().catch(() => {});
    throw error;
  }
}

async function assembleRuntime(
  options: RuntimeBootOptions,
  processLock: ProcessLock | null,
): Promise<RuntimeBoot> {
  const now = options.now ?? (() => new Date());
  const fetchImpl = options.fetchImpl;

  const retention: RetentionMode = options.intentRetention ?? 'retain';
  // S6 V3 (design-observability §5): exporter + metrics history attach only when
  // a caller names a local file — the default build stays exactly V1/V2 (no
  // exporter, live window only). Both are local-file JSONL; nothing leaves the
  // machine through them.
  const traceExporter: JsonlTraceExporter | undefined = options.traceExportFile
    ? new JsonlTraceExporter(options.traceExportFile)
    : undefined;
  // G2: the OTLP exporter is handed in fully configured; boot never reads env
  // and never constructs a network client on its own.
  const otlpTraceExporter: TraceExporter | undefined = options.otlpTraceExporter;
  const metricsHistory: MetricsHistory | undefined = options.metricsHistoryFile
    ? new MetricsHistory(options.metricsHistoryFile)
    : undefined;
  // deferred #42: the archive lives beside the state file. Constructed before
  // the orchestrator so its read port can be injected; absent a state file or
  // in retain mode there is nothing to archive.
  let intentArchive: IntentArchive | null = null;
  if (options.stateFile && retention !== 'retain') {
    intentArchive = new IntentArchive(archiveFilePath(options.stateFile));
    await intentArchive.loadIndex();
  }

  const skillRegistry = new SkillRegistry(now);
  const mentorshipLedger = new MentorshipLedger(skillRegistry, now);
  const orgRegistry = new OrgRegistry(now);
  // One audit spine: the dispatcher's decisions, the registry's revocations and
  // whatever transport the caller wants (stderr, JSONL file) all funnel here.
  const fileSink: AuditSink | null = options.auditFile
    ? (() => {
        try {
          return jsonlAuditSink(options.auditFile, {
            ...(options.auditMaxBytes !== undefined ? { maxBytes: options.auditMaxBytes } : {}),
            ...(options.auditKeep !== undefined ? { keep: options.auditKeep } : {}),
          });
        } catch (error) {
          // Constructing the sink creates the file, so an unusable path is a
          // boot-time configuration fact and must read like one.
          throw new RuntimeBootError(
            `audit log is unusable: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      })()
    : null;
  let auditFailures = 0;
  let auditFailureReported = false;
  const warnAuditFailure = (detail: string): void => {
    // One loud line naming the consequence, then just the count-worth of detail:
    // a full disk fails every single entry, and per-entry noise would bury the
    // first, informative one.
    (options.onAuditError ?? noop)(
      auditFailureReported
        ? detail
        : `${detail}; the audit trail is degraded from here on`,
    );
    auditFailureReported = true;
  };
  const auditSink: AuditSink = entry => {
    // A failing audit write must never become the reason a dispatch reports
    // failure. It used to: an ENOENT on the audit path surfaced as
    // `branch.reason: "ENOENT ... audit.jsonl"` for every branch, so a disk
    // problem was indistinguishable from a executor problem - and the operator
    // went looking for a broken agent. Observability that changes results is a
    // defect, so the file write is contained here and reported as what it is.
    if (fileSink) {
      try {
        fileSink(entry);
      } catch (error) {
        auditFailures += 1;
        warnAuditFailure(`audit write failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    options.dispatchAudit?.(entry);
  };
  const registry = new ExecutorRegistry(fetchImpl, now, {
    onRegister: entry => skillRegistry.registerFromCard(entry.card),
    onRevoke: revokeAuditBridge(auditSink),
    // A-02: the counterpart event — a revocation is only undone by an explicit
    // reinstate, so both directions land on the same audit trail.
    onReinstate: reinstateAuditBridge(auditSink),
  });
  const oversight = new OversightDesk({
    now,
    // E6.1 / P0-5 pilot gap: the desk's audit hook was optional and serve.ts
    // never passed it, so approvals and rejections - the operator's own
    // decisions - left no trace on the spine in a real process. The bridge is
    // now the default; an injected oversightAudit replaces it (tests only).
    audit: options.oversightAudit
      ? options.oversightAudit
      : entry => {
          auditSink({
            ts: entry.ts,
            executor: entry.executor,
            runId: entry.runId,
            decision:
              entry.action === 'approved'
                ? 'escalation-approved'
                : entry.action === 'rejected'
                  ? 'escalation-rejected'
                  : 'escalation-escalated',
            detail: [
              entry.escalationId,
              ...(entry.decidedStance ? [`stance: ${entry.decidedStance}`] : []),
              ...(entry.note ? [`note: ${entry.note}`] : []),
              ...(entry.detail ? [entry.detail] : []),
            ].join(' · '),
          });
        },
    onDecided: decided => {
      if (decided.kind !== 'memory-dispute' || !decided.factId) return;
      // A dispute recorded before dataDomainId was carried cannot resolve authors
      // without a cross-dataDomain scan, so its correction is skipped rather than
      // guessed. New disputes always carry it (see consolidateFinishedMemory).
      if (!decided.dataDomainId) return;
      // Approve confirms the new fact: the conflicting facts were wrong. Reject
      // means the new fact itself was wrong. Either way the losing authors are
      // corrected, lowering their reliability in future consolidation.
      const losingFacts = decided.status === 'rejected'
        ? [decided.factId]
        : decided.conflictingFacts ?? [];
      const authors = memoryStore.authorsOfFacts(decided.dataDomainId, losingFacts);
      memoryStore.recordCorrections(authors, decided.runId);
    },
  });
  const metrics = new ConcurrencyMetrics({ now });
  const progressHub = new ProgressHub();
  // Replaced once the state file exists below. Until then it is a no-op: a
  // runtime without a state file has nothing to persist a consumed nonce into.
  let persistLiveState: () => Promise<void> = async () => {};
  // Tail of the save chain. Every save writes the same `.tmp` path, so two
  // overlapping saves can interleave content or lose a rename (the loser's tmp
  // is already gone) - chaining them keeps the file equal to the newest state.
  let persistTail: Promise<void> = Promise.resolve();
  // E3.5 / deferred #14: the operator trust anchor. With a signer the runtime only
  // honors grants IT signed (or grants signed by a key it accepts) and consumes
  // each nonce once; without one, a grant is checked for shape, dataDomain binding and
  // expiry only - which is why the authority is reported through stats instead of
  // being assumed.
  const operatorGrantLedger = new OperatorGrantLedger({
    // A nonce that only lives in memory is a grant that replays after a crash,
    // so consumption pushes the state file immediately rather than waiting for
    // shutdown.
    onChange: () => {
      void persistLiveState().catch(error => {
        (options.onStateSaveError ?? noop)(error instanceof Error ? error.message : String(error));
      });
    },
  });
  const operatorGrantAuthority: 'signed' | 'shape-only' = options.operatorSigner ? 'signed' : 'shape-only';
  const dataDomainStore = new FsDataDomainStore({
    now,
    // The nonce ledger is wired in BOTH modes: single-use is a property of the
    // credential, not of how it was authenticated. Stopping at "we can't check
    // the signature, so we won't check anything else either" would make the
    // weaker mode strictly weaker still.
    operatorGrants: {
      ledger: operatorGrantLedger,
      ...(options.operatorSigner
        ? { verifier: options.operatorSigner.verifier(), acceptedKeyIds: [options.operatorSigner.keyId] }
        : {}),
    },
    // Only grant-authorized (enterprise) writes reach the spine: a personal write
    // is the user writing in their own directory, and logging each one would bury
    // the events that are actually about authorization.
    audit: entry => {
      if (!entry.grantedBy) return;
      auditSink({
        ts: entry.at,
        executor: entry.grantedBy,
        decision: 'dataDomain-write',
        dataDomain: entry.dataDomainType,
        detail: `operator-authorized write ${entry.itemId} (${entry.bytes}B) into ${entry.dataDomainId}`,
      });
    },
  });
  // E6.4: authorizations ride the same audit spine as dispatch decisions, so
  // issuing one, revoking one and testing a boundary land in one trail.
  const grantAudit = (entry: GrantAuditEntry): void => {
    auditSink({
      ts: entry.at,
      executor: entry.subject,
      decision: entry.decision === 'grant-issued' ? 'domain-grant-issued' : 'domain-grant-revoked',
      dataDomain: 'enterprise',
      detail: `${entry.decision} ${entry.grantId}: ${entry.access} ${entry.subject} -> ${entry.dataDomainId} by ${entry.grantedBy}`,
    });
    // Issuing or revoking a grant changes who may cross a domain boundary, so it
    // reaches disk now rather than at the next graceful shutdown: a crash would
    // otherwise resurrect a revoked grant (or drop a live one) on the next boot,
    // both of which silently widen access.
    void persistLiveState().catch(error => {
      (options.onStateSaveError ?? noop)(error instanceof Error ? error.message : String(error));
    });
  };
  const dataDomainAudit = (entry: DataDomainAuditEntry): void => {
    auditSink(entry);
  };
  // Issuance is audited separately from the write it authorizes: the moment a
  // human said "write this" matters even when the write never happens.
  const operatorGrantAudit = (entry: OperatorGrantAuditEntry): void => {
    auditSink({
      ts: entry.at,
      executor: entry.grantedBy,
      decision: 'operator-grant-issued',
      dataDomain: 'enterprise',
      detail: `operator grant for ${entry.dataDomainId} by ${entry.grantedBy} (key ${entry.keyId}, expires ${entry.expiresAt})${entry.reason ? `: ${entry.reason}` : ''}`,
    });
  };
  // deferred #33: spent execution-delegation nonces. The ledger is wired to
  // persistence now, so once the dispatch gate verifies a delegation a consumed
  // nonce already survives a crash; wiring persistence does not depend on the
  // peer credential-proxy interface.
  const executionDelegationLedger = new ExecutionDelegationNonceLedger(10_000, () => {
    void persistLiveState().catch(error => {
      (options.onStateSaveError ?? noop)(error instanceof Error ? error.message : String(error));
    });
  });
  const executionDelegationAudit = (entry: ExecutionDelegationAuditEntry): void => {
    auditSink({
      ts: entry.at,
      executor: entry.grantedBy,
      decision: 'execution-delegation-issued',
      detail: `execution delegation for ${entry.skill}${entry.executor ? ` (${entry.executor})` : ''} by ${entry.grantedBy}, capabilities ${entry.capabilities.join(',')} (key ${entry.keyId}, nonce ${entry.nonce}, expires ${entry.expiresAt})${entry.reason ? `: ${entry.reason}` : ''}`,
    });
  };
  const domainGrants = new DomainGrantRegistry(now, grantAudit);
  // E9.1/E9.2: the seatGrant gate reads its evidence from the layers that own
  // it (org roster, live executor directory, dataDomain boundary decisions, mentorship
  // certifications), so nothing here can go stale in the way a cached "is this
  // agent cleared?" flag would.
  const seatGrantAudit = (entry: SeatGrantAuditEntry): void => {
    auditSink({
      ts: entry.at,
      executor: entry.agentId,
      decision: entry.decision,
      detail: `${entry.decision} ${entry.seatGrantId} by ${entry.by}: ${entry.detail}`,
    });
  };
  const seatGrantLedger = new SeatGrantLedger(
    {
      org: orgRegistry,
      executors: registry.asExecutorLookup(),
      dataDomains: dataDomainStore,
      grants: domainGrants,
      mentorships: mentorshipLedger,
      now,
    },
    now,
    seatGrantAudit,
  );
  const memoryAudit: (entry: MemoryAuditEntry) => void = options.memoryAudit ?? noop;
  // MemoryPort v1 §4 (ruling D-1): hub-backed embedding with local fallback;
  // the kill switch pins the local hashing embedder. The hub resolver lands
  // later (decision wiring) and is read lazily on every embed call.
  const memoryEmbedder = createMemoryEmbedder({
    enabled: (process.env.ZEUS_MEMORY_EMBEDDING ?? '').trim().toLowerCase() !== 'off',
    resolveEndpoint: () => {
      const resolved = activeHubModelResolve('embed');
      return resolved
        ? {
            baseUrl: resolved.baseUrl,
            apiKey: resolved.apiKey,
            model: resolved.model,
            ...(resolved.endpoints?.embeddings
              ? { embeddingsPath: resolved.endpoints.embeddings }
              : {}),
          }
        : null;
    },
    onExternalCall: entry =>
      auditSink({
        ts: now().toISOString(),
        executor: 'memory',
        decision: 'memory-embed-external',
        // P2-5: the dataDomain scope identifies whose memory the call served.
        detail: `hash=${entry.hash} ok=${entry.ok} latencyMs=${entry.latencyMs}${entry.dataDomainId ? ` dataDomainId=${entry.dataDomainId}` : ''}${entry.reason ? ` reason=${entry.reason}` : ''}`,
      }),
  });
  const memoryStore = new MemoryStore(memoryAudit, now, { embedder: memoryEmbedder });
  const connectorRegistry = new ConnectorRegistry(
    now,
    options.connectorAudit ?? noop,
  );
  const dispatcher = new Dispatcher(registry.asExecutorLookup(), {
    audit: auditSink,
    now,
    // E4.8: the dispatcher attaches each executor's seeded bearer. Revocations are
    // already gated before token issuance inside dispatch, and tokenFor itself
    // yields nothing for revoked executors, so no path can attach a retired token.
    tokenFor: name => registry.tokenFor(name),
    // S8 V3 (design-guardrails §5): wire the DomainGrant registry into the
    // dispatcher as the content-grant port. A executor holds a content grant for
    // a dataDomain when it has a live (unrevoked, unexpired) grant entry whose
    // dataDomainId matches the hit's dataDomain; an unexpired grant for dataDomain A does not
    // cover enterprise content from dataDomain B. The gate is off until this port
    // exists; an unconfigured runtime keeps the V2 dispatch behaviour.
    ...(domainGrants
      ? {
          contentGrant: (executor: string, dataDomainId: string) =>
            domainGrants.list().some(
              grant =>
                grant.subject === executor &&
                grant.dataDomainId === dataDomainId &&
                (grant.expiresAt === undefined ||
                  Date.parse(grant.expiresAt) > now().getTime()),
            ),
        }
      : {}),
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  const orchestrator = new Orchestrator(registry.asExecutorLookup(), dispatcher, {
    now,
    metrics,
    ...(intentArchive ? { archive: intentArchive } : {}),
    // S1 context engineering V1 (design-context-engineering §10): memory recall
    // feeds the branch dispatch context. Assembled once per intent at the
    // dispatch boundary, audited on the same spine as dispatches. boot always
    // has a memory store; an unconfigured runtime degrades to zero assembly.
    memoryStore,
    contextOptions: { maxEntries: 20, ...options.contextOptions },
    // S1 V2 (design-context-engineering §10.3): the skill catalogue resolves
    // the declared input shape; a registered skill with no inputs yields {} and
    // assembles nothing, an unregistered skill yields undefined and degrades to
    // zero skill-input assembly.
    skillInputsProvider: skillId => skillRegistry.get(skillId)?.inputs,
    // deferred #44 (design-memory-self-evolution §2.2): the runtime write-back
    // face — active selection-weight cards feed the auto-selection pool. A
    // store with no cards yields {} and dispatch stays at the baseline.
    selectionWeightsProvider: dataDomainId => memoryStore.selectionWeights(dataDomainId),
    // E4.11 (design-a2a-push): the push receiver config rides outbound
    // tasks/send for armed intents; push callbacks audit to the same spine as
    // dispatches.
    ...(options.pushReceiver ? { pushReceiver: options.pushReceiver } : {}),
    audit: auditSink,
    onContextAssembled: (events, entry) => {
      for (const event of events) {
        auditSink({
          ts: entry.at,
          executor: '(intent)',
          runId: entry.runId,
          skill: entry.skill,
          dataDomain: entry.dataDomain,
          decision: event.kind,
          detail:
            event.kind === 'context-assembled'
              ? `intent ${entry.intentId}: ${event.appendixEntries} memory entries assembled${entry.dataDomainId ? ` (dataDomain ${entry.dataDomainId})` : ''}`
              : event.kind === 'guardrail-annotated'
                ? `intent ${entry.intentId}: appendix entry ${event.entry} annotated (${event.boundary}${event.signals.length > 0 ? `, signals ${event.signals.join(',')}` : ''})`
                : event.kind === 'guardrail-escalated'
                ? `intent ${entry.intentId}: appendix entry ${event.entry} escalated (${event.boundary}${event.signals.length > 0 ? `, signals ${event.signals.join(',')}` : ''})`
                : event.kind === 'context-trimmed'
                ? event.source === 'skill-inputs'
                  ? `intent ${entry.intentId}: ${event.trimmed} skill input field unavailable (${event.reason})`
                  : `intent ${entry.intentId}: ${event.trimmed} memory entry trimmed (${event.reason})`
                : event.source
                  ? `intent ${entry.intentId}: branch context budget ${event.limit} exhausted, ${event.source} truncated (${event.kept} kept)`
                  : `intent ${entry.intentId}: memory appendix capped at ${event.limit} (${event.kept} kept)`,
        });
      }
    },
    onConflict: conflictsToDesk(oversight),
    // E6.1 (C-28): a branch that stops at input-required is a executor asking the
    // operator for parameters. The desk's `ingest` had no caller anywhere in src,
    // so in a booted process this question was never raised — only intent
    // conflicts and memory disputes reached the desk.
    onTaskInput: (result, request) => {
      oversight.ingest(result, request);
    },
    // S8 V3 (design-guardrails §5): an execute-mode intent whose assembled
    // content hit a deterministic signal lands in the oversight queue as an L1
    // guardrail-content escalation. Nothing was dispatched; the operator
    // decides whether the crossing may proceed.
    onGuardrailEscalated: input => {
      oversight.ingestGuardrail(input);
    },
    // E2.2/E2.3/E2.4 (Active work 47 §E-3): auto-selected fan-out targets are
    // filtered through the skill catalogue, so uninstall/deprecate/harden take
    // effect on dispatch. Refusals land on the same audit spine as dispatches.
    skillGovernor: {
      activeProviders: skillId => skillRegistry.activeProviders(skillId),
    },
    onRefusal: entry => {
      auditSink({
        ts: entry.at,
        executor: '(auto)',
        skill: entry.skill,
        dataDomain: entry.dataDomain,
        decision: entry.reason === 'skill-uninstalled' ? 'refused-skill-uninstalled' : 'refused-no-active-provider',
        detail: entry.detail,
      });
    },
    // S4 (design-supervision §7.1): the intent-level termination guard refused a
    // spawn — budget exhausted or circuit open. A guard holding is a governance
    // fact the operator must see, same spine as refusals.
    onTerminationRefused: entry => {
      auditSink({
        ts: entry.at,
        executor: '(intent)',
        skill: entry.skill,
        dataDomain: entry.dataDomain,
        decision: entry.reason === 'budget-exceeded' ? 'intent-branch-budget-exceeded' : 'intent-circuit-opened',
        detail: entry.detail,
      });
    },
    // S9 V2 (design-cost-governance §5): the cost gate refused an admission —
    // a window-cap crossing or an open rate circuit lands on the same spine as
    // the other governance refusals. The limit itself is handed through only
    // when configured (an unset runtime keeps its historical uncharged path).
    ...(options.costLimit !== undefined ? { costLimit: options.costLimit, onCostRefused: entry => {
      if (entry.reason === 'cost-budget-exceeded' || entry.reason === 'cost-rate-circuit-open') {
        auditSink({
          ts: entry.at,
          executor: '(intent)',
          skill: entry.skill,
          dataDomain: entry.dataDomain,
          decision: entry.reason,
          detail: entry.detail,
        });
      }
    } } : {}),
    // #9: a saturated target re-pointed to an alternate same-skill provider lands
    // on the same audit spine as refusals (design §4.5).
    onDiverted: entry => {
      auditSink({
        ts: entry.at,
        executor: entry.to,
        skill: entry.skill,
        dataDomain: entry.dataDomain,
        decision: 'branch-diverted',
        detail: `target '${entry.from}' saturated/unavailable; diverted to '${entry.to}' for skill '${entry.skill}'`,
      });
    },
    // S11 V2: one line per fan-out describing the candidate face the live
    // saturation data produced, so "why this provider set" is on the audit
    // spine alongside the branches it dispatched.
    onCandidatesSelected: entry => {
      auditSink({
        ts: entry.at,
        executor: '(runtime)',
        skill: entry.skill,
        dataDomain: entry.dataDomain,
        decision: 'tool-selected',
        detail: entry.pinned
          ? `candidate face for skill '${entry.skill}': ${entry.namedCount} operator-pinned name(s); pool not consulted`
          : `candidate face for skill '${entry.skill}': pool ${entry.poolSize}, live-saturated dropped ${entry.saturatedDropped}, diverted ${entry.diverted}`,
      });
    },
    // S11 V3 (design-tool-discovery §5): a failed branch and the recovery
    // chain's verdict for it. tool-failed is the failure itself (really emitted
    // on the runtime now); the chain-* line follows the fixed-order verdict.
    // Escalate keeps the existing needs-operator semantics and adds no chain line.
    onChainRecovered: entry => {
      auditSink({
        ts: entry.at,
        executor: entry.executor,
        skill: entry.skill,
        dataDomain: entry.dataDomain,
        decision: 'tool-failed',
        detail: `branch for skill '${entry.skill}' on executor '${entry.executor}' failed: ${entry.reason}`,
      });
      if (entry.action === 'retry') {
        auditSink({
          ts: entry.at,
          executor: entry.executor,
          skill: entry.skill,
          dataDomain: entry.dataDomain,
          decision: 'chain-retried',
          detail: `recovery chain decided retry for skill '${entry.skill}' on executor '${entry.executor}'`,
        });
      } else if (entry.action === 'switch') {
        auditSink({
          ts: entry.at,
          executor: entry.alternateProvider ?? entry.executor,
          skill: entry.skill,
          dataDomain: entry.dataDomain,
          decision: 'chain-switched',
          detail: `recovery chain decided switch from '${entry.executor}' to '${entry.alternateProvider}' for skill '${entry.skill}'`,
        });
      } else if (entry.action === 'degrade') {
        auditSink({
          ts: entry.at,
          executor: entry.executor,
          skill: entry.skill,
          dataDomain: entry.dataDomain,
          decision: 'chain-degraded',
          detail: `recovery chain decided degrade (skip step) for skill '${entry.skill}' on executor '${entry.executor}'`,
        });
      }
    },
    // deferred #33: the execute gate refused a branch. An execute without a
    // verified, unconsumed delegation is a governance fact — refused before any
    // outbound request exists, so this audit line is the refusal itself.
    onExecutionDelegationRefused: entry => {
      auditSink({
        ts: entry.at,
        executor: entry.executor,
        skill: entry.skill,
        dataDomain: entry.dataDomain,
        decision: 'execution-delegation-denied',
        detail: `execute refused for skill '${entry.skill}' executor '${entry.executor}': ${entry.reason}`,
      });
    },
    // deferred #33: execute-mode gate. Signed, single-use approval for
    // irreversible external writes; with no operator signer there is no trust
    // anchor and execute fails closed.
    ...(options.operatorSigner
      ? {
          executionDelegation: {
            verifier: options.operatorSigner.verifier(),
            ledger: executionDelegationLedger,
            acceptedKeyIds: [options.operatorSigner.keyId],
            now,
          },
        }
      : {}),
    onProgress: event => {
      progressHub.publish(event);
      if (event.type === 'intent-finished') {
        if (event.dataDomainId) {
          recordBranchVerdicts(event);
          consolidateFinishedMemory(event);
        }
        // S6 V3: a settled intent is the natural export point for its trace
        // tree — every span fact now exists on the audit spine / progress hub,
        // and the tree is a read-only projection (design-observability §2).
        // Fire-and-forget: an export write failure degrades observability, it
        // never blocks dispatch or the fan-out return path.
        if (traceExporter !== undefined && options.auditFile !== undefined) {
          void exportSettledTrace(event.intentId, options.auditFile, progressHub, traceExporter)
            .catch(error => (options.onAuditError ?? noop)(`trace export failed for ${event.intentId}: ${error instanceof Error ? error.message : String(error)}`));
        }
        // G2: the OTLP face shares the settle-path projection and the
        // fire-and-forget contract; its own transport failures are fail-soft
        // inside the exporter (log sink), this catch is the belt over braces.
        if (otlpTraceExporter !== undefined && options.auditFile !== undefined) {
          void exportSettledTrace(event.intentId, options.auditFile, progressHub, otlpTraceExporter)
            .catch(error => (options.onAuditError ?? noop)(`otlp trace export failed for ${event.intentId}: ${error instanceof Error ? error.message : String(error)}`));
        }
      }
    },
    ...(options.decisionBackend ? { decisionBackend: options.decisionBackend } : {}),
    ...(options.judgeEnabled ? { judgeEnabled: true } : {}),
    ...(options.judgeThreshold !== undefined ? { judgeThreshold: options.judgeThreshold } : {}),
    ...(options.allowUncalibratedJudge !== undefined
      ? { allowUncalibratedJudge: options.allowUncalibratedJudge }
      : {}),
    ...(options.judgeEscalateOnDisagreement !== undefined
      ? { judgeEscalateOnDisagreement: options.judgeEscalateOnDisagreement }
      : {}),
    ...(options.judgeMaxWaitMs !== undefined ? { judgeMaxWaitMs: options.judgeMaxWaitMs } : {}),
    ...(options.maxConcurrentBranches !== undefined
      ? { maxConcurrentBranches: options.maxConcurrentBranches }
      : {}),
    ...(options.branchQueueLimit !== undefined ? { branchQueueLimit: options.branchQueueLimit } : {}),
    ...(options.maxConcurrentPerExecutor !== undefined ? { maxConcurrentPerExecutor: options.maxConcurrentPerExecutor } : {}),
  });
  // S3 DAG orchestration: runs each DAG node as a fan-out through the SAME
  // orchestrator, so node intents share the runtime's idempotency table and
  // persist with it. The runner only adds wave scheduling + spec/result recall.
  const dagRunner = new DagRunner(registry.asExecutorLookup(), dispatcher, { now }, orchestrator);

  // S12 V2 (design-planning §5): planning wired as a fan-out. Planner skills
  // are found by their `planning` tag, drafts are validated/scored/selected by
  // the V1 pure functions, and the selected plan runs through the same DAG
  // runner. plan-conflict / unplannable goals land on the oversight desk.
  const planFlow = new PlanFlow({
    orchestrator,
    skillRegistry,
    dagRunner,
    oversight,
    audit: entry => auditSink(entry),
    now,
  });

  // Self-host loop step 2: the trigger primitive. It is assembled here rather
  // than left as a library type so "an intent can be raised with nobody present"
  // is a fact about the running runtime, not about a design document.
  // The operator's own watch lifecycle acts (register/disable/revoke) are
  // governance facts and ride the same spine as the tick-time decisions.
  const watches = new WatchRegistry({
    now,
    audit: entry => {
      auditSink({
        ts: entry.at,
        executor: entry.owner,
        decision: entry.decision,
        detail: `${entry.watchId}: ${entry.detail}`,
      });
    },
  });
  // Self-host loop step 4: bounded, signed contracts let the watch derive a
  // one-time execute ticket per fire with nobody present. Persisted like the
  // other ledgers, so a spent ceiling survives a restart.
  const delegationContracts = new DelegationContractRegistry(() => {
    void persistLiveState().catch(error => {
      (options.onStateSaveError ?? noop)(error instanceof Error ? error.message : String(error));
    });
  });
  // Step 5: contract issuance/revocation are governance facts on the same
  // spine as ticket issuance — the moment a human widened unattended authority
  // matters even when no fire ever spends it.
  const delegationContractAudit = (entry: DelegationContractAuditEntry): void => {
    auditSink({
      ts: entry.at,
      executor: entry.grantedBy,
      skill: entry.skill,
      decision: entry.decision,
      detail:
        `delegation contract ${entry.contractId} ${entry.decision === 'delegation-contract-issued' ? 'issued' : 'revoked'}` +
        ` by ${entry.grantedBy} for ${entry.skill}${entry.executor ? ` (${entry.executor})` : ''}` +
        `, capabilities ${entry.capabilities.join(',')}, tickets ${entry.maxChildTickets}` +
        ` / concurrent ${entry.maxConcurrent}, window ends ${entry.windowEndsAt} (key ${entry.keyId})` +
        `${entry.reason ? `: ${entry.reason}` : ''}`,
    });
  };

  const components: RuntimeComponents = {
    registry, oversight, orchestrator, dagRunner, planFlow, dataDomainStore, skillRegistry, memoryStore, connectorRegistry, mentorshipLedger, orgRegistry, domainGrants, seatGrantLedger, operatorGrantLedger, executionDelegationLedger, delegationContracts, watches,
    // MemoryPort v1 §7: the HTTP consumer face writes its service-call lines
    // on the same audit spine; not part of any snapshot.
    auditSink,
  };

  // S6 V3: assemble the settled intent's trace tree from what already exists
  // (the audit spine scoped to this intent's runIds + the retained progress
  // events) and hand it to the exporter. Same projection the /trace endpoint
  // serves; here it runs at settle time for the local file, not on read.
  async function exportSettledTrace(
    intentId: string,
    auditFile: string,
    hub: ProgressHub,
    exporter: TraceExporter,
  ): Promise<void> {
    const progress = hub.eventsOf(intentId);
    const runIds = new Set<string>();
    for (const e of progress) {
      if ('runId' in e && e.runId !== undefined) runIds.add(e.runId);
    }
    const audit = readAuditLog(auditFile).filter(a => a.runId !== undefined && runIds.has(a.runId));
    await exporter.export(buildTraceTree({
      audit,
      progress,
      ...(options.decisionTraceBuffer ? { traces: options.decisionTraceBuffer.forRuns(runIds) } : {}),
      ...decisionStepsOf(intentId),
    }));
  }

  /**
   * TracePort v1 §2: the decision-layer facts of a settled intent — measured
   * arbitration/judge steps and the aggregation conclusion — for the
   * decision-step spans. Unknown intent = no facts (nothing is guessed).
   */
  function decisionStepsOf(intentId: string): {
    steps?: { arbitration?: BackendArbitration; judge?: JudgeReview; conclusion?: string };
  } {
    const result = orchestrator.getIntent(intentId);
    if (!result) return {};
    const conclusion = result.decision.conclusion;
    return {
      steps: {
        ...(result.backendArbitration ? { arbitration: result.backendArbitration } : {}),
        ...(result.judgeReview ? { judge: result.judgeReview } : {}),
        ...(conclusion !== null ? { conclusion } : {}),
      },
    };
  }

  // deferred #27: a finished fan-out's verdicts are the runtime's only memory
  // producer. Written one step before consolidation so an intent folds into
  // facts on the same tick it produced them. Claims go through
  // appendFromDataDomain, never append, so the dataDomain-boundary invariant cannot be
  // bypassed by this new path.
  function recordBranchVerdicts(event: Extract<ProgressEvent, { type: 'intent-finished' }>): void {
    const dataDomainId = event.dataDomainId;
    if (!dataDomainId) return;
    const result = orchestrator.getIntent(event.intentId);
    const request = orchestrator.getRequest(event.intentId);
    if (!result || !request) return;
    // A dataDomain disconnected mid-flight (deferred #17) must not start receiving
    // claims afterwards: the mount table is the authority on what still exists.
    const mounted = (dataDomainStore?.connections() ?? []).some(connection => connection.dataDomainId === dataDomainId);
    if (!mounted) {
      auditSink({
        ts: now().toISOString(),
        executor: '(runtime)',
        skill: result.skill,
        dataDomain: result.dataDomain,
        decision: 'memory-claim-skipped',
        detail: `intent ${result.intentId} finished on unmounted dataDomain ${dataDomainId}; ${result.positions.length} verdict(s) not recorded as claims`,
      });
      return;
    }
    for (const claim of branchVerdictClaims(result, request, { dataDomainId, occurredAt: now().toISOString() })) {
      try {
        memoryStore.appendFromDataDomain(dataDomainId, claim);
      } catch (error) {
        auditSink({
          ts: now().toISOString(),
          executor: claim.source.agentId,
          skill: result.skill,
          dataDomain: result.dataDomain,
          decision: 'memory-claim-skipped',
          detail: `claim ${claim.eventId} refused for dataDomain ${dataDomainId}: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  }

  // Memory P1: when an intent operating on a connected dataDomain reaches a terminal
  // state, consolidate that dataDomain's events; disputes become pending
  // memory-dispute escalations rather than silent splits.
  function consolidateFinishedMemory(
    event: Extract<ProgressEvent, { type: 'intent-finished' }>,
  ): void {
    const reliability = (agentId: string): number => {
      const stat = metrics.snapshot().perExecutor[agentId];
      const base = !stat || stat.calls === 0 ? 0.5 : 1 - stat.failureRate;
      return memoryStore.reliabilityScore(agentId, base);
    };
    // Consolidation embeds facts through the (possibly hub-backed) embedder,
    // so it is asynchronous; the progress boundary stays synchronous and
    // fail-soft — a consolidation failure must not break the event stream.
    void (async () => {
      // MemoryPort v1 §6: the settled conclusion is written back as a
      // decision memory (category=decision) before consolidation, so the
      // next same-kind intent recalls it at the dispatch boundary. The
      // event id is deterministic per (intentId, runId): a replayed settle
      // is append-deduped, never double-counted. The writeback obeys the
      // same mount-table authority as the verdict claims above: a dataDomain
      // disconnected mid-flight receives nothing, and the append goes
      // through appendFromDataDomain so the dataDomain-boundary invariant cannot be
      // bypassed by this path either.
      const intent = orchestrator.getIntent(event.intentId);
      const conclusion = intent?.decision?.conclusion;
      const dataDomainId = event.dataDomainId;
      const mounted = dataDomainId !== undefined &&
        (dataDomainStore?.connections() ?? []).some(connection => connection.dataDomainId === dataDomainId);
      if (intent && dataDomainId !== undefined && !mounted) {
        auditSink({
          ts: now().toISOString(),
          executor: '(runtime)',
          skill: intent.skill,
          dataDomain: intent.dataDomain,
          decision: 'memory-writeback-skipped',
          detail: `intent ${intent.intentId} finished on unmounted dataDomain ${dataDomainId}; settled conclusion not written back as a decision memory`,
        });
      }
      if (intent && dataDomainId !== undefined && mounted && typeof conclusion === 'string' && conclusion.length > 0) {
        try {
          memoryStore.appendFromDataDomain(dataDomainId, {
            eventId: `mem-decision-${sha256Hex(`${event.intentId}|${event.runId}`).slice(0, 16)}`,
            dataDomainId,
            runId: event.runId,
            source: { agentId: 'zeus-runtime' },
            kind: 'claim',
            content: {
              subject: intent.skill,
              predicate: 'settled-decision',
              object: {
                conclusion,
                conflicts: intent.conflicts.length,
                intentId: event.intentId,
              },
              category: 'decision',
            },
            refs: [event.runId],
            confidence: 1,
            occurredAt: now().toISOString(),
          });
        } catch {
          // Fail-soft: a writeback failure must not block consolidation.
        }
      }
      const result = await memoryStore.consolidateDataDomain(event.dataDomainId!, { now, reliability });
      const dataDomain = orchestrator.getIntent(event.intentId)?.dataDomain ?? 'personal';
      result.disputes.forEach((dispute, i) => {
        oversight.ingestMemoryDispute({
          id: result.escalations[i]!,
          runId: event.runId,
          dataDomain,
          ...(event.dataDomainId ? { dataDomainId: event.dataDomainId } : {}),
          factId: dispute.factId,
          conflictingFacts: dispute.conflicting,
          reason: dispute.reason,
        });
      });
    })().catch((err: unknown) => {
      // Fail-soft at the progress boundary, but never silent: the audit spine
      // must show why memory stopped updating.
      auditSink({
        ts: now().toISOString(),
        executor: 'memory',
        decision: 'memory-consolidation-failed',
        detail: err instanceof Error ? err.message : String(err),
      });
    });
  }

  let store: FileRuntimeStateStore | null = null;
  let snapshot: RuntimeSnapshot | null = null;
  if (options.stateFile) {
    // M-10: processLock was acquired by bootRuntime() before this body ran and is
    // released through the returned handle (or on a failed boot by the wrapper).
    store = new FileRuntimeStateStore(options.stateFile, now);
    try {
      snapshot = await store.load();
    } catch (error) {
      // A corrupt or wrong-version snapshot is a configuration fact the operator
      // must act on (restore a backup, or delete the file), not a bug. Wrapping it
      // keeps it on `serve.ts`'s refused-to-start path - one line naming what to
      // fix - instead of falling through to a raw stack trace.
      throw new RuntimeBootError(
        `runtime state file is unusable: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (snapshot) {
      applyRuntimeState(components, snapshot);
      // S13 V2 (design-long-running §5): crash recovery runs between state
      // restoration and the first new intent — every unsettled intent in the
      // snapshot is classified (auto-resume / await-operator / settle-failed /
      // settle-canceled) and executed, each on the audit spine. auto-resume
      // re-enters the fan-out gate: the same intentId key means the F2 cache
      // and single-flight prevent a double dispatch.
      const checkpoint = computeCheckpoint(snapshot.orchestrator);
      const requestsByIntent = new Map(snapshot.orchestrator.requests.map(({ intentId, request }) => [intentId, request]));
      await executeRecovery(
        checkpoint,
        {
          settleIntent: (intentId, status) => {
            orchestrator.settleRecovered(intentId, status);
          },
          awaitOperator: () => {
            // A restored needs-operator intent already has its escalation row:
            // the desk is snapshotted with the runtime, so the audit is the
            // recovery marker and the operator picks it up from the existing
            // queue face.
          },
          autoResume: async intentId => {
            const request = requestsByIntent.get(intentId);
            if (!request) throw new Error(`cannot auto-resume ${intentId}: no original request in the snapshot`);
            await orchestrator.fanOut(request);
          },
        },
        {
          now,
          ...(options.recoveryMaxAutoResumeMs === undefined ? {} : { maxAutoResumeMs: options.recoveryMaxAutoResumeMs }),
          audit: auditSink,
        },
      );
    }
  }
  // Now that the state file exists, a freshly consumed nonce can reach disk.
  // deferred #42: before each save, out-window settled intents leave the state
  // table — appended to the archive in 'archive' mode, dropped outright in
  // 'evict'. The archive append lands before the state snapshot, so a crash
  // between the two cannot orphan a record (the next flush re-appends, and
  // appends are idempotent by intentId).
  const runRetention = async (): Promise<void> => {
    if (!intentArchive || retention === 'retain') return;
    const settled = orchestrator.exportState().intents;
    if (settled.length === 0) return;
    const toArchive = selectArchivable(settled, oversight.list(), {
      maxEntries: options.intentRetentionMaxEntries ?? DEFAULT_MAX_ENTRIES,
      windowMs: options.intentRetentionWindowMs ?? DEFAULT_WINDOW_MS,
      now,
    });
    if (toArchive.length === 0) return;
    if (retention === 'archive') {
      const records: ArchivedIntentRecord[] = toArchive.map(intentId => {
        const result = orchestrator.getIntent(intentId);
        // selectArchivable only ever names settled intents still in the table.
        if (!result) throw new Error(`retention selected unknown intent ${intentId}`);
        const request = orchestrator.getRequest(intentId);
        return {
          intentId,
          ts: now().toISOString(),
          createdAt: result.createdAt,
          status: result.status,
          ...(request ? { request } : {}),
          result,
        };
      });
      await intentArchive.append(records);
    }
    orchestrator.removeIntents(toArchive);
  };
  persistLiveState = async (): Promise<void> => {
    const target = store;
    if (!target) return;
    // Serialize: the next snapshot is collected only after the previous save has
    // landed, so a burst of governance changes cannot race on one `.tmp` file.
    const run = persistTail.then(async () => {
      await runRetention();
      await target.save(collectRuntimeState(components));
      // S6 V3: one metrics snapshot per save, keyed by capturedAt. Landed inside
      // the save chain so a burst of saves serializes the history file exactly
      // like the state file — no interleaved partial lines.
      if (metricsHistory !== undefined) {
        await metricsHistory.capture(metrics.snapshot());
      }
    });
    persistTail = run.catch(() => {});
    await run;
  };

  // G4: reconnect dataDomains restored from the snapshot, then connect the roots
  // supplied on this boot. Connect dedupes by realpath, so overlap is harmless.
  // A restored root that can no longer be reached fails boot loudly rather than
  // silently dropping a data domain (the recovery promise). The tenant scope is
  // restored too — dropping it would silently widen an enterprise dataDomain from
  // "this department" to "reachable by any subject with no declared tenant".
  if (snapshot?.dataDomains) {
    for (const connection of snapshot.dataDomains) {
      await dataDomainStore.connect(connection.root, connection.type, {
        readOnly: connection.readOnly,
        ...(connection.tenant ? { tenant: connection.tenant } : {}),
      });
    }
  }
  for (const entry of options.dataDomainRoots ?? []) {
    const connection = typeof entry === 'string' ? { root: entry } : entry;
    await dataDomainStore.connect(connection.root, connection.type ?? 'personal', {
      ...(connection.readOnly !== undefined ? { readOnly: connection.readOnly } : {}),
      ...(connection.tenant !== undefined ? { tenant: connection.tenant } : {}),
    });
  }

  if (options.executorSeeds && options.executorSeeds.length > 0) {
    const known = new Set(registry.listAll().map(entry => entry.cardUrl));
    for (const seed of options.executorSeeds) {
      const cardUrl = typeof seed === 'string' ? seed : seed.cardUrl;
      if (known.has(cardUrl)) continue;
      try {
        await registry.register(cardUrl, {
          ...(typeof seed !== 'string' && seed.token !== undefined ? { token: seed.token } : {}),
        });
      } catch (error) {
        // A seed that cannot be registered is a boot-time configuration fact:
        // the operator typed a URL, and either it is unreachable or the card does
        // not swear the oath. Say which, in one line, instead of a stack trace.
        throw new RuntimeBootError(
          `executor seed failed for ${cardUrl}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      known.add(cardUrl);
    }
  }

  /**
   * Self-host loop §3.2: one evaluation pass over the enabled watches. The
   * runtime holds no timer on purpose (the backup scheduler is external for the
   * same reason), so whatever drives this - cron, or the operator - decides the
   * cadence, and `intervalSeconds` still gates each individual watch.
   */
  async function runWatchTick(at?: Date): Promise<WatchTickReport> {
    return watches.runTick({
      now: () => at ?? now(),
      sources: {
        metrics: () => metrics.snapshot(),
        ...(dataDomainStore
          ? { dataDomain: async (dataDomainId: string) => dataDomainReading(dataDomainStore, dataDomainId) }
          : {}),
        // Step 3: the connector source reads through the declaration's own
        // boundary, so an undeclared tool is unreadable rather than empty.
        ...(connectorRegistry
          ? {
              connector: async (ref: { id: string; tool: string; args?: Record<string, unknown> }) =>
                // FetchLike accepts a narrower input union than the DOM fetch
                // signature the connector port declares; the value is the same.
                connectorReading(connectorRegistry, ref, fetchImpl as typeof fetch | undefined),
            }
          : {}),
      },
      submit: async request => {
        const childTicket = request.executionDelegation as ExecutionDelegation | undefined;
        try {
          const result = await orchestrator.fanOut({
            intentId: request.intentId,
            skill: request.skill,
            params: { subject: request.subject },
            dataDomain: request.dataDomain,
            mode: request.mode,
            ...(request.executionDelegation !== undefined
              ? { executionDelegation: request.executionDelegation as ExecutionDelegation }
              : {}),
          });
          // M-01: a refusal has been recorded at this boundary under the
          // deterministic intent id, so replaying that id can only ever return
          // the same recorded failure. The refused marker tells the tick to
          // advance the fire sequence instead of pinning it forever; a throw
          // carries no marker and stays a same-sequence replay (delivery
          // unknown).
          if (result.refused) return { ok: false, reason: result.refused.reason, refused: true };
          return { ok: true, ...(result.replayed ? { replayed: true } : {}) };
        } finally {
          // The child ticket's one dispatch has settled (fired, refused, or
          // replayed), so its contract concurrency slot is free regardless of
          // the outcome - a refusal must not permanently spend maxConcurrent.
          if (childTicket) delegationContracts.release(childTicket.nonce);
        }
      },
      // Step 4: derive the one-time child ticket from the watch's named
      // contract. With no operator signer there is no trust anchor, so the hook
      // is absent and execute fires fail closed into a desk escalation.
      ...(options.operatorSigner
        ? {
            deriveExecution: async (input: { watchId: string; delegationId: string; skill: string }) => {
              const derived = await deriveExecutionDelegation(
                input.delegationId,
                {
                  capabilities: ['execute'],
                  reason: `watch ${input.watchId} fire`,
                },
                {
                  registry: delegationContracts,
                  signer: options.operatorSigner!,
                  verifier: options.operatorSigner!.verifier(),
                  now,
                },
              );
              if (!derived.ok) return { ok: false as const, reason: derived.reason };
              return { ok: true as const, delegation: derived.delegation };
            },
          }
        : {}),
      escalateLimit: input => {
        oversight.ingestDelegationLimit({
          watchId: input.watchId,
          ...(input.delegationId ? { delegationId: input.delegationId } : {}),
          skill: input.skill,
          dataDomain: input.dataDomain,
          ...(input.dataDomainId ? { dataDomainId: input.dataDomainId } : {}),
          limitReason: input.reason,
          tickSeq: input.tickSeq,
          // S10 V2: the watch tick already ran the classifier; the desk stores
          // that verdict instead of re-deriving it.
          interruptLevel: input.interruptLevel,
        });
      },
      audit: entry => {
        auditSink({
          ts: entry.at,
          executor: '(runtime)',
          decision: entry.decision,
          detail: `${entry.watchId} (owner ${entry.owner}): ${entry.detail}`,
        });
      },
    });
  }

  return {
    ...components,
    metrics,
    progressHub,
    runWatchTick,
    stateFile: options.stateFile ?? null,
    auditFile: options.auditFile ?? null,
    dataDomainAudit,
    operatorGrantAuthority,
    operatorGrantAudit,
    executionDelegationAudit,
    delegationContractAudit,
    operatorSigner: options.operatorSigner ?? null,
    auditMaxBytes: options.auditMaxBytes ?? DEFAULT_AUDIT_MAX_BYTES,
    auditKeep: options.auditKeep ?? DEFAULT_AUDIT_KEEP,
    get auditFailures(): number {
      return auditFailures;
    },
    restoredFromSnapshot: snapshot !== null,
    snapshot,
    ...(intentArchive ? { intentArchive } : {}),
    retention,
    ...(traceExporter ? { traceExporter } : {}),
    ...(otlpTraceExporter ? { otlpTraceExporter } : {}),
    ...(options.decisionTraceBuffer ? { decisionTraceBuffer: options.decisionTraceBuffer } : {}),
    ...(metricsHistory ? { metricsHistory } : {}),
    saveState: persistLiveState,
    releaseLock: async () => {
      const lock = processLock;
      processLock = null;
      if (lock) await lock.release();
    },
  };
}


/**
 * Process-env decision wiring for the long-running service (T-C / Active work 15
 * T4 boundary: "process assembly not done; needs deployment env/keys").
 *
 * Backend precedence: the dedicated decision model (Jev, ZEUS_DECISION_*) wins,
 * then a generic OpenAI-compatible LLM (ZEUS_LLM_*). With neither fully set the
 * result is `backend: null` and the runtime degrades to rules-only — booting with
 * no keys must reproduce the pre-backend behaviour rather than crash.
 *
 * The E1.3 judge is opt-in (ZEUS_JUDGE_ENABLED) and silently stays disabled when
 * there is no backend to consult; arbitration itself activates as soon as a
 * backend is present (it has no separate enable switch in the orchestrator).
 */
export type ProcessDecisionConfig = {
  backend: DecisionBackend | null;
  /** Which factory produced the backend, for an unambiguous boot log line. */
  backendKind: 'hub' | 'decision-model' | 'llm' | null;
  judgeEnabled: boolean;
  judgeThreshold?: number;
  allowUncalibratedJudge?: boolean;
  /** L3/L4 hub test surface, present only when the hub backend is active. */
  hubTest?: HubTestPort;
};

const ENV_TRUE = new Set(['1', 'true', 'yes', 'on']);
function envFlag(value: string | undefined): boolean {
  return value !== undefined && ENV_TRUE.has(value.trim().toLowerCase());
}

export function resolveDecisionConfig(env: NodeJS.ProcessEnv = process.env): ProcessDecisionConfig {
  const jev = createJevBackendFromEnv(env);
  const llm = jev ? null : createLlmBackendFromEnv(env);
  const backend = jev ?? llm;
  const backendKind: ProcessDecisionConfig['backendKind'] = jev ? 'decision-model' : llm ? 'llm' : null;

  // A judge request without a backend cannot run; keep it off rather than let
  // the orchestrator treat every review as a backend failure.
  const judgeEnabled = envFlag(env.ZEUS_JUDGE_ENABLED) && backend !== null;

  const config: ProcessDecisionConfig = { backend, backendKind, judgeEnabled };
  // A threshold the operator set and the process quietly ignored is the same class
  // of failure as a silently-ignored concurrency cap (E1.5): it reads as a setting
  // that is not there. Malformed values fail boot loudly, like the other params.
  const threshold = envNumber(env.ZEUS_JUDGE_THRESHOLD, 'ZEUS_JUDGE_THRESHOLD', 0);
  if (threshold !== undefined) config.judgeThreshold = threshold;
  if (envFlag(env.ZEUS_JUDGE_ALLOW_UNCALIBRATED)) config.allowUncalibratedJudge = true;
  return config;
}

type HubWiring = {
  hubUrl: string;
  token: string;
  cachePath: string;
};

function readHubWiring(env: NodeJS.ProcessEnv): HubWiring | null {
  const hubUrl = env.MODEL_HUB_URL?.trim();
  const token = env.MODEL_HUB_TOKEN?.trim();
  if (!hubUrl || !token) return null;
  const cachePath =
    env.MODEL_HUB_CACHE_PATH?.trim() ?? './data/model-cache.json';
  return { hubUrl, token, cachePath };
}

function applyJudgeSettings(
  env: NodeJS.ProcessEnv,
  config: ProcessDecisionConfig,
): ProcessDecisionConfig {
  const threshold = envNumber(env.ZEUS_JUDGE_THRESHOLD, 'ZEUS_JUDGE_THRESHOLD', 0);
  if (threshold !== undefined) config.judgeThreshold = threshold;
  if (envFlag(env.ZEUS_JUDGE_ALLOW_UNCALIBRATED)) {
    config.allowUncalibratedJudge = true;
  }
  return config;
}

/**
 * Async decision wiring: model-hub first. When the hub is unreachable or has
 * no assigned models, the process-env wiring (resolveDecisionConfig) is used
 * as a safety net. W7-3 removed the MODEL_HUB_DISABLED kill switch: the hub
 * is now the only configured model source, and there is no way to silently
 * skip it by env.
 */
export async function resolveDecisionConfigWithHub(
  env: NodeJS.ProcessEnv = process.env,
  options: BackendOptions & { onUsageReportFailed?: (reason: string) => void } = {},
): Promise<ProcessDecisionConfig> {
  const hub = readHubWiring(env);

  if (hub) {
    try {
      const wiring = await createHubDecisionBackend({
        ...options,
        hubUrl: hub.hubUrl,
        token: hub.token,
        cachePath: hub.cachePath,
      });
      return applyJudgeSettings(env, {
        backend: wiring.backend,
        backendKind: 'hub',
        judgeEnabled: envFlag(env.ZEUS_JUDGE_ENABLED),
        hubTest: wiring.testPort,
      });
    } catch {
      // Hub unavailable / no models: fall through to env.
    }
  }

  return resolveDecisionConfig(env);
}

/** A boot-time env value was present but unusable. */
export class RuntimeBootError extends Error {}

/**
 * E1.5 process-env concurrency wiring.
 *
 * A cap the operator set and the process quietly ignored is worse than no cap at
 * all — it reads as protection that is not there — so a malformed value fails
 * the boot loudly instead of falling back to unbounded dispatch.
 */
export type ProcessConcurrencyConfig = {
  maxConcurrentBranches?: number;
  branchQueueLimit?: number;
  maxConcurrentPerExecutor?: number;
};

export function resolveConcurrencyConfig(env: NodeJS.ProcessEnv = process.env): ProcessConcurrencyConfig {
  const config: ProcessConcurrencyConfig = {};
  const cap = envInteger(env.ZEUS_MAX_CONCURRENT_BRANCHES, 'ZEUS_MAX_CONCURRENT_BRANCHES', 1);
  if (cap !== undefined) config.maxConcurrentBranches = cap;
  // 0 is a meaningful queue limit: refuse immediately rather than wait for a slot.
  const limit = envInteger(env.ZEUS_BRANCH_QUEUE_LIMIT, 'ZEUS_BRANCH_QUEUE_LIMIT', 0);
  if (limit !== undefined) config.branchQueueLimit = limit;
  // #9: per-executor saturation cap (>= 1). Enables diversion only when it sits
  // below maxConcurrentBranches; a malformed value fails boot loudly.
  const perExecutor = envInteger(env.ZEUS_MAX_CONCURRENT_PER_EXECUTOR, 'ZEUS_MAX_CONCURRENT_PER_EXECUTOR', 1);
  if (perExecutor !== undefined) config.maxConcurrentPerExecutor = perExecutor;
  return config;
}

/**
 * A-01: the resolved concurrency config is handed to bootRuntime as a whole.
 *
 * The process used to copy it field by field, which is how
 * ZEUS_MAX_CONCURRENT_PER_EXECUTOR came to be parsed and validated at boot
 * (resolveConcurrencyConfig) and then dropped before reaching the orchestrator:
 * the operator set a cap, the boot accepted it, and the runtime never enforced
 * it. A whole-object spread puts every present field on the runtime options and
 * keeps every future field doing the same.
 */
export function concurrencyBootOptions(
  concurrency: ProcessConcurrencyConfig,
): Pick<RuntimeBootOptions, 'maxConcurrentBranches' | 'branchQueueLimit' | 'maxConcurrentPerExecutor'> {
  return { ...concurrency };
}

/**
 * S9 V2 (design-cost-governance §5): resolve the intent-level cost gate from
 * process env. Same discipline as resolveConcurrencyConfig — a malformed value
 * fails boot loudly (an ignored cap would read as protection that is not
 * there), and an unset variable leaves the corresponding dimension unlimited.
 */
export function resolveCostConfig(env: NodeJS.ProcessEnv = process.env): CostLimit {
  const config: CostLimit = {};
  const windowMs = envInteger(env.ZEUS_COST_WINDOW_MS, 'ZEUS_COST_WINDOW_MS', 1);
  if (windowMs !== undefined) config.circuitWindowMs = windowMs;
  const cap = envInteger(env.ZEUS_COST_MAX_WINDOW_COST, 'ZEUS_COST_MAX_WINDOW_COST', 1);
  if (cap !== undefined) config.maxWindowCost = cap;
  const rate = envInteger(env.ZEUS_COST_MAX_RATE_PER_WINDOW, 'ZEUS_COST_MAX_RATE_PER_WINDOW', 1);
  if (rate !== undefined) config.maxRatePerWindow = rate;
  return config;
}

export function costBootOptions(
  cost: CostLimit,
): Pick<RuntimeBootOptions, 'costLimit'> {
  return { costLimit: cost };
}

function envInteger(
  value: string | undefined,
  name: string,
  min: number,
): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new RuntimeBootError(`${name} must be a whole number >= ${min}, got '${value}'`);
  }
  return parsed;
}

/** Like envInteger but admits fractional values (e.g. a 0..1 judge threshold). */
function envNumber(
  value: string | undefined,
  name: string,
  min: number,
): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new RuntimeBootError(`${name} must be a number >= ${min}, got '${value}'`);
  }
  return parsed;
}

/**
 * Audit rotation config. `0` / `off` / `unlimited` opt out of the size ceiling -
 * a deliberate choice an operator should be able to make, not a default.
 */
export type ProcessAuditConfig = {
  auditMaxBytes?: number;
  auditKeep?: number;
};

const UNLIMITED = new Set(['0', 'off', 'unlimited', 'none']);

export function resolveAuditConfig(env: NodeJS.ProcessEnv = process.env): ProcessAuditConfig {
  const config: ProcessAuditConfig = {};
  const rawMax = env.ZEUS_AUDIT_MAX_BYTES?.trim().toLowerCase();
  if (rawMax !== undefined && rawMax !== '') {
    if (UNLIMITED.has(rawMax)) {
      config.auditMaxBytes = Number.POSITIVE_INFINITY;
    } else {
      const parsed = envInteger(rawMax, 'ZEUS_AUDIT_MAX_BYTES', 1);
      if (parsed !== undefined) config.auditMaxBytes = parsed;
    }
  }
  const keep = envInteger(env.ZEUS_AUDIT_KEEP, 'ZEUS_AUDIT_KEEP', 1);
  if (keep !== undefined) config.auditKeep = keep;
  return config;
}

/**
 * DataDomain mounts from env (G4 + E3.6).
 *
 * `ZEUS_DATA_DOMAIN_ROOTS` stays what it always was: a comma list of personal roots.
 * Enterprise mounts need a tenant scope, so they get their own variable rather
 * than an overloaded separator inside the personal one:
 * `ZEUS_DATA_DOMAIN_ENTERPRISE="/srv/acme::acme,/srv/acme-eng::acme/eng"`. `::`
 * separates path from tenant because a Windows drive letter already owns the
 * single colon. An unusable tenant fails the boot: an enterprise dataDomain mounted
 * WITHOUT its scope is a silently widened data domain, the opposite of what the
 * scope is for.
 */
export type ProcessDataDomainConfig = {
  dataDomainRoots: NonNullable<RuntimeBootOptions['dataDomainRoots']>;
};

export function resolveDataDomainConfig(env: NodeJS.ProcessEnv = process.env): ProcessDataDomainConfig {
  const roots: ProcessDataDomainConfig['dataDomainRoots'] = [];
  for (const entry of splitEnvList(env.ZEUS_DATA_DOMAIN_ROOTS)) roots.push(entry);
  for (const entry of splitEnvList(env.ZEUS_DATA_DOMAIN_ENTERPRISE)) {
    const separator = entry.indexOf('::');
    if (separator < 0) {
      throw new RuntimeBootError(
        `ZEUS_DATA_DOMAIN_ENTERPRISE entries are "<root>::<tenant>", got '${entry}' (the tenant is what keeps an enterprise dataDomain from being org-visible)`,
      );
    }
    const root = entry.slice(0, separator).trim();
    const tenant = entry.slice(separator + 2).trim();
    if (!root) throw new RuntimeBootError(`ZEUS_DATA_DOMAIN_ENTERPRISE entry has an empty root: '${entry}'`);
    try {
      normalizeTenant(tenant);
    } catch (error) {
      throw new RuntimeBootError(`ZEUS_DATA_DOMAIN_ENTERPRISE entry '${entry}' has an unusable tenant: ${(error as Error).message}`);
    }
    roots.push({ root, type: 'enterprise', tenant });
  }
  return { dataDomainRoots: roots };
}

function splitEnvList(value: string | undefined): string[] {
  return (value ?? '').split(',').map(entry => entry.trim()).filter(Boolean);
}

/**
 * E4.8: parse `ZEUS_EXECUTOR_SEEDS` — a comma list of card URLs, optionally each
 * carrying its executor bearer after `|` (e.g. `"https://…/agent-card|token-1"`).
 * `|` is unambiguous: it is not a legal raw character in an RFC 3986 URL, so a
 * card URL can never contain it unencoded. A plain URL registers with no token.
 */
export type ProcessExecutorSeedsConfig = NonNullable<RuntimeBootOptions['executorSeeds']>;

export function resolveExecutorSeedsConfig(env: NodeJS.ProcessEnv = process.env): ProcessExecutorSeedsConfig {
  const seeds: ProcessExecutorSeedsConfig = [];
  for (const entry of splitEnvList(env.ZEUS_EXECUTOR_SEEDS)) {
    const separator = entry.indexOf('|');
    if (separator < 0) {
      seeds.push(entry);
      continue;
    }
    const cardUrl = entry.slice(0, separator).trim();
    const token = entry.slice(separator + 1).trim();
    // Parse errors must not echo the entry: the token segment after '|' (and any
    // URL userinfo) is a credential, and boot errors travel into logs/audit.
    if (!cardUrl) throw new RuntimeBootError('executor seed entry has an empty card URL before \'|\'');
    if (!token) {
      throw new RuntimeBootError(
        `executor seed entry '${redactUrl(cardUrl)}' has an empty token after '|'`,
      );
    }
    seeds.push({ cardUrl, token });
  }
  return seeds;
}
