import { VassalRegistry } from '../registry/registry.js';
import type { FetchLike } from '../dispatch/client.js';
import { Dispatcher, type AuditSink } from '../dispatch/dispatcher.js';
import {
  DEFAULT_AUDIT_KEEP,
  DEFAULT_AUDIT_MAX_BYTES,
  jsonlAuditSink,
  reinstateAuditBridge,
  revokeAuditBridge,
} from '../dispatch/audit.js';
import { OversightDesk, conflictsToDesk } from '../oversight/oversight.js';
import type { OversightAuditEntry } from '../oversight/types.js';
import { Orchestrator } from '../orchestrator/orchestrator.js';
import { DagRunner } from '../orchestrator/dag-runner.js';
import { ConcurrencyMetrics } from '../orchestrator/metrics.js';
import { FsRealmStore } from '../realm/store.js';
import { DriverGrantLedger, type DriverGrantAuditEntry } from '../realm/grant.js';
import {
  ExecutionDelegationNonceLedger,
  type ExecutionDelegationAuditEntry,
} from '../delegation/execution-delegation.js';
import { WatchRegistry, realmReading, connectorReading, type WatchTickReport } from '../watch/watch.js';
import type { Ed25519MemorySigner } from '../registry/signing.js';
import { DomainGrantRegistry, type GrantAuditEntry } from '../realm/authorization.js';
import { normalizeTenant } from '../realm/tenant.js';
import type { RealmAuditEntry } from '../realm/source.js';
import type { RealmType, TenantScope } from '../realm/types.js';
import { ProgressHub, type ProgressEvent } from '../orchestrator/progress.js';
import { SkillRegistry } from '../skills/registry.js';
import { MentorshipLedger } from '../skills/mentor.js';
import { OrgRegistry } from '../org/registry.js';
import { MemoryStore, type MemoryAuditEntry } from '../memory/memory-store.js';
import { branchVerdictClaims } from '../memory/producer.js';
import { ConnectorRegistry, type ConnectorAuditEntry } from '../mcp/connectors.js';
import { CommissionLedger, type CommissionAuditEntry } from '../onboarding/commission.js';
import {
  FileKernelStateStore,
  applyKernelState,
  collectKernelState,
  type KernelComponents,
  type KernelSnapshot,
} from './kernel-state.js';
import type { DecisionBackend } from '../decision/types.js';
import { createJevBackendFromEnv } from '../decision/decision-model.js';
import { createLlmBackendFromEnv } from '../decision/llm.js';

/**
 * E5.3 process boot assembly (design-http-transport §2.2/§2.3: the long-running
 * service prerequisite). Wires the four live kernel components exactly once —
 * registry, oversight desk, dispatcher and orchestrator — with conflict
 * escalation already bridged into the desk (conflictsToDesk), and optionally
 * restores a JSON snapshot produced by FileKernelStateStore.
 *
 * Without `stateFile` the kernel stays purely in-memory (library/H1 behaviour).
 * With it, boot loads and applies the snapshot when one exists, and saveState()
 * atomically writes the live state for the next restart. The transport layer
 * (serve.js) calls saveState() during graceful shutdown.
 */

export type KernelBoot = KernelComponents & {
  /** E1.7 runtime concurrency metrics (not persisted); wired into the orchestrator. */
  metrics: ConcurrencyMetrics;
  /** H3: progress event hub feeding the SSE endpoint. */
  progressHub: ProgressHub;
  /**
   * Self-host loop §3.2: one evaluation pass over the watches. No timer lives in
   * the kernel, so the caller owns the cadence; each watch still honours its own
   * `intervalSeconds`.
   */
  runWatchTick: (at?: Date) => Promise<WatchTickReport>;
  /** Absolute or relative path of the state JSON, or null when in-memory only. */
  stateFile: string | null;
  /** E4.7: JSONL dispatch audit log path, or null when the process writes none. */
  auditFile: string | null;
  /** E6.4: feeds cross-domain read/refusal records into the audit spine. */
  realmAudit: (entry: RealmAuditEntry) => void;
  /**
   * E3.5 / deferred #14: how enterprise writes are authorized here. 'signed'
   * means a grant must carry an Ed25519 signature by an accepted driver key;
   * 'shape-only' means the kernel holds no driver key and can only check a
   * grant's shape, realm binding and expiry. Reported, never assumed.
   */
  driverGrantAuthority: 'signed' | 'shape-only';
  /** The driver key when one is configured; the HTTP face issues grants with it. */
  driverSigner: Ed25519MemorySigner | null;
  /** Feeds issued write grants into the audit spine. */
  driverGrantAudit: (entry: DriverGrantAuditEntry) => void;
  /** Feeds issued execution delegations into the audit spine. */
  executionDelegationAudit: (entry: ExecutionDelegationAuditEntry) => void;
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
  snapshot: KernelSnapshot | null;
  /** Atomically persist live kernel state; a no-op without stateFile. */
  saveState(): Promise<void>;
};

export type KernelBootOptions = {
  /** When set, state is restored from this file on boot and saved on shutdown. */
  stateFile?: string;
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
   *  E4.8: an entry may be `{ cardUrl, token? }` to seed the vassal's outbound
   *  bearer; a plain string registers with no token. */
  vassalSeeds?: Array<string | { cardUrl: string; token?: string }>;
  /** G4: realm roots connected on boot. Strings are personal read-write roots;
   *  objects may set type/readOnly/tenant (E3.6, enterprise scopes). Persisted
   *  roots are reconnected as well. */
  realmRoots?: Array<string | { root: string; type?: RealmType; readOnly?: boolean; tenant?: string | TenantScope }>;
  /** Audit sink for memory boundary violations (cross-realm read/append). */
  memoryAudit?: (entry: MemoryAuditEntry) => void;
  /** Audit sink for MCP connector lifecycle events. */
  connectorAudit?: (entry: ConnectorAuditEntry) => void;
  /**
   * E1.2/E1.3 decision backend wired into the orchestrator. When present the S2
   * critic arbitration path is live (rule-inconclusive fan-outs consult it);
   * when omitted the kernel runs rules-only exactly as before. serve.ts builds
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
  /** #9 per-vassal saturation cap; must sit below maxConcurrentBranches for
   *  diversion to fire. Unset = no per-vassal saturation check. */
  maxConcurrentPerVassal?: number;
  /**
   * E3.5 / deferred #14: the driver key. When present, an enterprise write is
   * only honored on a grant this key signed (or one whose signer the kernel
   * accepts), and each grant nonce is consumed once. When absent, grants are
   * checked for shape/realm/expiry only — a vassal that can reach `write()`
   * could then author its own "authorization", which is why `KernelBoot` reports
   * the effective authority instead of hiding it.
   */
  driverSigner?: Ed25519MemorySigner;
  /** Called when a state write triggered by an event outside shutdown (a
   *  consumed driver-grant nonce) fails. Defaults to silence; serve.ts logs it,
   *  because a nonce that never reaches disk can be replayed after a restart. */
  onStateSaveError?: (message: string) => void;
  /** Called when a persisted audit line cannot be written. Defaults to silence; a
   *  deployment should log it, because a missing trail is a governance fact. */
  onAuditError?: (message: string) => void;
}

const noop = (): void => {};

export async function bootKernel(options: KernelBootOptions = {}): Promise<KernelBoot> {
  const now = options.now ?? (() => new Date());
  const fetchImpl = options.fetchImpl;

  const skillRegistry = new SkillRegistry(now);
  const mentorshipLedger = new MentorshipLedger(skillRegistry, now);
  const orgRegistry = new OrgRegistry(now);
  // One audit spine: the dispatcher's decisions, the registry's revocations and
  // whatever transport the caller wants (stderr, JSONL file) all funnel here.
  const fileSink: AuditSink | null = options.auditFile
    ? (() => {
        try {
          return jsonlAuditSink(options.auditFile!, {
            ...(options.auditMaxBytes !== undefined ? { maxBytes: options.auditMaxBytes } : {}),
            ...(options.auditKeep !== undefined ? { keep: options.auditKeep } : {}),
          });
        } catch (error) {
          // Constructing the sink creates the file, so an unusable path is a
          // boot-time configuration fact and must read like one.
          throw new KernelBootError(
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
    // problem was indistinguishable from a vassal problem - and the operator
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
  const registry = new VassalRegistry(fetchImpl, now, {
    onRegister: entry => skillRegistry.registerFromCard(entry.card),
    onRevoke: revokeAuditBridge(auditSink),
    // A-02: the counterpart event — a revocation is only undone by an explicit
    // reinstate, so both directions land on the same audit trail.
    onReinstate: reinstateAuditBridge(auditSink),
  });
  const oversight = new OversightDesk({
    now,
    ...(options.oversightAudit ? { audit: options.oversightAudit } : {}),
    onDecided: decided => {
      if (decided.kind !== 'memory-dispute' || !decided.factId) return;
      // A dispute recorded before realmId was carried cannot resolve authors
      // without a cross-realm scan, so its correction is skipped rather than
      // guessed. New disputes always carry it (see consolidateFinishedMemory).
      if (!decided.realmId) return;
      // Approve confirms the new fact: the conflicting facts were wrong. Reject
      // means the new fact itself was wrong. Either way the losing authors are
      // corrected, lowering their reliability in future consolidation.
      const losingFacts = decided.status === 'rejected'
        ? [decided.factId]
        : decided.conflictingFacts ?? [];
      const authors = memoryStore.authorsOfFacts(decided.realmId, losingFacts);
      memoryStore.recordCorrections(authors, decided.runId);
    },
  });
  const metrics = new ConcurrencyMetrics({ now });
  const progressHub = new ProgressHub();
  // Replaced once the state file exists below. Until then it is a no-op: a
  // kernel without a state file has nothing to persist a consumed nonce into.
  let persistLiveState: () => Promise<void> = async () => {};
  // Tail of the save chain. Every save writes the same `.tmp` path, so two
  // overlapping saves can interleave content or lose a rename (the loser's tmp
  // is already gone) - chaining them keeps the file equal to the newest state.
  let persistTail: Promise<void> = Promise.resolve();
  // E3.5 / deferred #14: the driver trust anchor. With a signer the kernel only
  // honors grants IT signed (or grants signed by a key it accepts) and consumes
  // each nonce once; without one, a grant is checked for shape, realm binding and
  // expiry only - which is why the authority is reported through stats instead of
  // being assumed.
  const driverGrantLedger = new DriverGrantLedger({
    // A nonce that only lives in memory is a grant that replays after a crash,
    // so consumption pushes the state file immediately rather than waiting for
    // shutdown.
    onChange: () => {
      void persistLiveState().catch(error => {
        (options.onStateSaveError ?? noop)(error instanceof Error ? error.message : String(error));
      });
    },
  });
  const driverGrantAuthority: 'signed' | 'shape-only' = options.driverSigner ? 'signed' : 'shape-only';
  const realmStore = new FsRealmStore({
    now,
    // The nonce ledger is wired in BOTH modes: single-use is a property of the
    // credential, not of how it was authenticated. Stopping at "we can't check
    // the signature, so we won't check anything else either" would make the
    // weaker mode strictly weaker still.
    driverGrants: {
      ledger: driverGrantLedger,
      ...(options.driverSigner
        ? { verifier: options.driverSigner.verifier(), acceptedKeyIds: [options.driverSigner.keyId] }
        : {}),
    },
    // Only grant-authorized (enterprise) writes reach the spine: a personal write
    // is the user writing in their own directory, and logging each one would bury
    // the events that are actually about authorization.
    audit: entry => {
      if (!entry.grantedBy) return;
      auditSink({
        ts: entry.at,
        vassal: entry.grantedBy,
        decision: 'realm-write',
        realm: entry.realmType,
        detail: `driver-authorized write ${entry.itemId} (${entry.bytes}B) into ${entry.realmId}`,
      });
    },
  });
  // E6.4: authorizations ride the same audit spine as dispatch decisions, so
  // issuing one, revoking one and testing a boundary land in one trail.
  const grantAudit = (entry: GrantAuditEntry): void => {
    auditSink({
      ts: entry.at,
      vassal: entry.subject,
      decision: entry.decision === 'grant-issued' ? 'domain-grant-issued' : 'domain-grant-revoked',
      realm: 'enterprise',
      detail: `${entry.decision} ${entry.grantId}: ${entry.access} ${entry.subject} -> ${entry.realmId} by ${entry.grantedBy}`,
    });
    // Issuing or revoking a grant changes who may cross a domain boundary, so it
    // reaches disk now rather than at the next graceful shutdown: a crash would
    // otherwise resurrect a revoked grant (or drop a live one) on the next boot,
    // both of which silently widen access.
    void persistLiveState().catch(error => {
      (options.onStateSaveError ?? noop)(error instanceof Error ? error.message : String(error));
    });
  };
  const realmAudit = (entry: RealmAuditEntry): void => {
    auditSink(entry);
  };
  // Issuance is audited separately from the write it authorizes: the moment a
  // human said "write this" matters even when the write never happens.
  const driverGrantAudit = (entry: DriverGrantAuditEntry): void => {
    auditSink({
      ts: entry.at,
      vassal: entry.grantedBy,
      decision: 'driver-grant-issued',
      realm: 'enterprise',
      detail: `driver grant for ${entry.realmId} by ${entry.grantedBy} (key ${entry.keyId}, expires ${entry.expiresAt})${entry.reason ? `: ${entry.reason}` : ''}`,
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
      vassal: entry.grantedBy,
      decision: 'execution-delegation-issued',
      detail: `execution delegation for ${entry.skill}${entry.vassal ? ` (${entry.vassal})` : ''} by ${entry.grantedBy}, capabilities ${entry.capabilities.join(',')} (key ${entry.keyId}, nonce ${entry.nonce}, expires ${entry.expiresAt})${entry.reason ? `: ${entry.reason}` : ''}`,
    });
  };
  const domainGrants = new DomainGrantRegistry(now, grantAudit);
  // E9.1/E9.2: the commission gate reads its evidence from the layers that own
  // it (org roster, live vassal directory, realm boundary decisions, mentorship
  // certifications), so nothing here can go stale in the way a cached "is this
  // agent cleared?" flag would.
  const commissionAudit = (entry: CommissionAuditEntry): void => {
    auditSink({
      ts: entry.at,
      vassal: entry.agentId,
      decision: entry.decision,
      detail: `${entry.decision} ${entry.commissionId} by ${entry.by}: ${entry.detail}`,
    });
  };
  const commissionLedger = new CommissionLedger(
    {
      org: orgRegistry,
      vassals: registry.asVassalLookup(),
      realms: realmStore,
      grants: domainGrants,
      mentorships: mentorshipLedger,
      now,
    },
    now,
    commissionAudit,
  );
  const memoryAudit: (entry: MemoryAuditEntry) => void = options.memoryAudit ?? noop;
  const memoryStore = new MemoryStore(memoryAudit, now);
  const connectorRegistry = new ConnectorRegistry(
    now,
    options.connectorAudit ?? noop,
  );
  const dispatcher = new Dispatcher(registry.asVassalLookup(), {
    audit: auditSink,
    now,
    // E4.8: the dispatcher attaches each vassal's seeded bearer. Revocations are
    // already gated before token issuance inside dispatch, and tokenFor itself
    // yields nothing for revoked vassals, so no path can attach a retired token.
    tokenFor: name => registry.tokenFor(name),
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  const orchestrator = new Orchestrator(registry.asVassalLookup(), dispatcher, {
    now,
    metrics,
    onConflict: conflictsToDesk(oversight),
    // E6.1 (C-28): a branch that stops at input-required is a vassal asking the
    // driver for parameters. The desk's `ingest` had no caller anywhere in src,
    // so in a booted process this question was never raised — only intent
    // conflicts and memory disputes reached the desk.
    onTaskInput: (result, request) => {
      oversight.ingest(result, request);
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
        vassal: '(auto)',
        skill: entry.skill,
        realm: entry.realm,
        decision: entry.reason === 'skill-uninstalled' ? 'refused-skill-uninstalled' : 'refused-no-active-provider',
        detail: entry.detail,
      });
    },
    // #9: a saturated target re-pointed to an alternate same-skill provider lands
    // on the same audit spine as refusals (design §4.5).
    onDiverted: entry => {
      auditSink({
        ts: entry.at,
        vassal: entry.to,
        skill: entry.skill,
        realm: entry.realm,
        decision: 'branch-diverted',
        detail: `target '${entry.from}' saturated/unavailable; diverted to '${entry.to}' for skill '${entry.skill}'`,
      });
    },
    // deferred #33: the execute gate refused a branch. An execute without a
    // verified, unconsumed delegation is a governance fact — refused before any
    // outbound request exists, so this audit line is the refusal itself.
    onExecutionDelegationRefused: entry => {
      auditSink({
        ts: entry.at,
        vassal: entry.vassal,
        skill: entry.skill,
        realm: entry.realm,
        decision: 'execution-delegation-denied',
        detail: `execute refused for skill '${entry.skill}' vassal '${entry.vassal}': ${entry.reason}`,
      });
    },
    // deferred #33: execute-mode gate. Signed, single-use approval for
    // irreversible external writes; with no driver signer there is no trust
    // anchor and execute fails closed.
    ...(options.driverSigner
      ? {
          executionDelegation: {
            verifier: options.driverSigner.verifier(),
            ledger: executionDelegationLedger,
            acceptedKeyIds: [options.driverSigner.keyId],
            now,
          },
        }
      : {}),
    onProgress: event => {
      progressHub.publish(event);
      if (event.type === 'intent-finished' && event.realmId) {
        recordBranchVerdicts(event);
        consolidateFinishedMemory(event);
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
    ...(options.maxConcurrentPerVassal !== undefined ? { maxConcurrentPerVassal: options.maxConcurrentPerVassal } : {}),
  });
  // S3 DAG orchestration: runs each DAG node as a fan-out through the SAME
  // orchestrator, so node intents share the kernel's idempotency table and
  // persist with it. The runner only adds wave scheduling + spec/result recall.
  const dagRunner = new DagRunner(registry.asVassalLookup(), dispatcher, { now }, orchestrator);

  // Self-host loop step 2: the trigger primitive. It is assembled here rather
  // than left as a library type so "an intent can be raised with nobody present"
  // is a fact about the running kernel, not about a design document.
  const watches = new WatchRegistry();

  const components: KernelComponents = {
    registry, oversight, orchestrator, dagRunner, realmStore, skillRegistry, memoryStore, connectorRegistry, mentorshipLedger, orgRegistry, domainGrants, commissionLedger, driverGrantLedger, executionDelegationLedger, watches,
  };

  // deferred #27: a finished fan-out's verdicts are the kernel's only memory
  // producer. Written one step before consolidation so an intent folds into
  // facts on the same tick it produced them. Claims go through
  // appendFromRealm, never append, so the realm-boundary invariant cannot be
  // bypassed by this new path.
  function recordBranchVerdicts(event: Extract<ProgressEvent, { type: 'intent-finished' }>): void {
    const realmId = event.realmId;
    if (!realmId) return;
    const result = orchestrator.getIntent(event.intentId);
    const request = orchestrator.getRequest(event.intentId);
    if (!result || !request) return;
    // A realm disconnected mid-flight (deferred #17) must not start receiving
    // claims afterwards: the mount table is the authority on what still exists.
    const mounted = (realmStore?.connections() ?? []).some(connection => connection.realmId === realmId);
    if (!mounted) {
      auditSink({
        ts: now().toISOString(),
        vassal: '(kernel)',
        skill: result.skill,
        realm: result.realm,
        decision: 'memory-claim-skipped',
        detail: `intent ${result.intentId} finished on unmounted realm ${realmId}; ${result.positions.length} verdict(s) not recorded as claims`,
      });
      return;
    }
    for (const claim of branchVerdictClaims(result, request, { realmId, occurredAt: now().toISOString() })) {
      try {
        memoryStore.appendFromRealm(realmId, claim);
      } catch (error) {
        auditSink({
          ts: now().toISOString(),
          vassal: claim.source.agentId,
          skill: result.skill,
          realm: result.realm,
          decision: 'memory-claim-skipped',
          detail: `claim ${claim.eventId} refused for realm ${realmId}: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  }

  // Memory P1: when an intent operating on a connected realm reaches a terminal
  // state, consolidate that realm's events; disputes become pending
  // memory-dispute escalations rather than silent splits.
  function consolidateFinishedMemory(
    event: Extract<ProgressEvent, { type: 'intent-finished' }>,
  ): void {
    const reliability = (agentId: string): number => {
      const stat = metrics.snapshot().perVassal[agentId];
      const base = !stat || stat.calls === 0 ? 0.5 : 1 - stat.failureRate;
      return memoryStore.reliabilityScore(agentId, base);
    };
    const result = memoryStore.consolidateRealm(event.realmId!, { now, reliability });
    const realm = orchestrator.getIntent(event.intentId)?.realm ?? 'personal';
    result.disputes.forEach((dispute, i) => {
      oversight.ingestMemoryDispute({
        id: result.escalations[i]!,
        runId: event.runId,
        realm,
        ...(event.realmId ? { realmId: event.realmId } : {}),
        factId: dispute.factId,
        conflictingFacts: dispute.conflicting,
        reason: dispute.reason,
      });
    });
  }

  let store: FileKernelStateStore | null = null;
  let snapshot: KernelSnapshot | null = null;
  if (options.stateFile) {
    store = new FileKernelStateStore(options.stateFile, now);
    try {
      snapshot = await store.load();
    } catch (error) {
      // A corrupt or wrong-version snapshot is a configuration fact the operator
      // must act on (restore a backup, or delete the file), not a bug. Wrapping it
      // keeps it on `serve.ts`'s refused-to-start path - one line naming what to
      // fix - instead of falling through to a raw stack trace.
      throw new KernelBootError(
        `kernel state file is unusable: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (snapshot) applyKernelState(components, snapshot);
  }
  // Now that the state file exists, a freshly consumed nonce can reach disk.
  persistLiveState = async (): Promise<void> => {
    const target = store;
    if (!target) return;
    // Serialize: the next snapshot is collected only after the previous save has
    // landed, so a burst of governance changes cannot race on one `.tmp` file.
    const run = persistTail.then(() => target.save(collectKernelState(components)));
    persistTail = run.catch(() => {});
    await run;
  };

  // G4: reconnect realms restored from the snapshot, then connect the roots
  // supplied on this boot. Connect dedupes by realpath, so overlap is harmless.
  // A restored root that can no longer be reached fails boot loudly rather than
  // silently dropping a data domain (the recovery promise). The tenant scope is
  // restored too — dropping it would silently widen an enterprise realm from
  // "this department" to "reachable by any subject with no declared tenant".
  if (snapshot?.realms) {
    for (const connection of snapshot.realms) {
      await realmStore.connect(connection.root, connection.type, {
        readOnly: connection.readOnly,
        ...(connection.tenant ? { tenant: connection.tenant } : {}),
      });
    }
  }
  for (const entry of options.realmRoots ?? []) {
    const connection = typeof entry === 'string' ? { root: entry } : entry;
    await realmStore.connect(connection.root, connection.type ?? 'personal', {
      ...(connection.readOnly !== undefined ? { readOnly: connection.readOnly } : {}),
      ...(connection.tenant !== undefined ? { tenant: connection.tenant } : {}),
    });
  }

  if (options.vassalSeeds && options.vassalSeeds.length > 0) {
    const known = new Set(registry.listAll().map(entry => entry.cardUrl));
    for (const seed of options.vassalSeeds) {
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
        throw new KernelBootError(
          `vassal seed failed for ${cardUrl}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      known.add(cardUrl);
    }
  }

  /**
   * Self-host loop §3.2: one evaluation pass over the enabled watches. The
   * kernel holds no timer on purpose (the vault scheduler is external for the
   * same reason), so whatever drives this - cron, or the operator - decides the
   * cadence, and `intervalSeconds` still gates each individual watch.
   */
  async function runWatchTick(at?: Date): Promise<WatchTickReport> {
    return watches.runTick({
      now: () => at ?? now(),
      sources: {
        metrics: () => metrics.snapshot(),
        ...(realmStore
          ? { realm: async (realmId: string) => realmReading(realmStore, realmId) }
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
        const result = await orchestrator.fanOut({
          intentId: request.intentId,
          skill: request.skill,
          params: { subject: request.subject },
          realm: request.realm,
        });
        // A refusal is not a fire: the tick reports it so the operator can see
        // that the condition held and nothing was dispatched.
        if (result.refused) return { ok: false, reason: result.refused.reason };
        return { ok: true, ...(result.replayed ? { replayed: true } : {}) };
      },
      audit: entry => {
        auditSink({
          ts: entry.at,
          vassal: '(kernel)',
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
    realmAudit,
    driverGrantAuthority,
    driverGrantAudit,
    executionDelegationAudit,
    driverSigner: options.driverSigner ?? null,
    auditMaxBytes: options.auditMaxBytes ?? DEFAULT_AUDIT_MAX_BYTES,
    auditKeep: options.auditKeep ?? DEFAULT_AUDIT_KEEP,
    get auditFailures(): number {
      return auditFailures;
    },
    restoredFromSnapshot: snapshot !== null,
    snapshot,
    saveState: persistLiveState,
  };
}


/**
 * Process-env decision wiring for the long-running service (T-C / Active work 15
 * T4 boundary: "process assembly not done; needs deployment env/keys").
 *
 * Backend precedence: the dedicated decision model (Jev, ZEUS_DECISION_*) wins,
 * then a generic OpenAI-compatible LLM (ZEUS_LLM_*). With neither fully set the
 * result is `backend: null` and the kernel degrades to rules-only — booting with
 * no keys must reproduce the pre-backend behaviour rather than crash.
 *
 * The E1.3 judge is opt-in (ZEUS_JUDGE_ENABLED) and silently stays disabled when
 * there is no backend to consult; arbitration itself activates as soon as a
 * backend is present (it has no separate enable switch in the orchestrator).
 */
export type ProcessDecisionConfig = {
  backend: DecisionBackend | null;
  /** Which factory produced the backend, for an unambiguous boot log line. */
  backendKind: 'decision-model' | 'llm' | null;
  judgeEnabled: boolean;
  judgeThreshold?: number;
  allowUncalibratedJudge?: boolean;
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

/** A boot-time env value was present but unusable. */
export class KernelBootError extends Error {}

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
  maxConcurrentPerVassal?: number;
};

export function resolveConcurrencyConfig(env: NodeJS.ProcessEnv = process.env): ProcessConcurrencyConfig {
  const config: ProcessConcurrencyConfig = {};
  const cap = envInteger(env.ZEUS_MAX_CONCURRENT_BRANCHES, 'ZEUS_MAX_CONCURRENT_BRANCHES', 1);
  if (cap !== undefined) config.maxConcurrentBranches = cap;
  // 0 is a meaningful queue limit: refuse immediately rather than wait for a slot.
  const limit = envInteger(env.ZEUS_BRANCH_QUEUE_LIMIT, 'ZEUS_BRANCH_QUEUE_LIMIT', 0);
  if (limit !== undefined) config.branchQueueLimit = limit;
  // #9: per-vassal saturation cap (>= 1). Enables diversion only when it sits
  // below maxConcurrentBranches; a malformed value fails boot loudly.
  const perVassal = envInteger(env.ZEUS_MAX_CONCURRENT_PER_VASSAL, 'ZEUS_MAX_CONCURRENT_PER_VASSAL', 1);
  if (perVassal !== undefined) config.maxConcurrentPerVassal = perVassal;
  return config;
}

/**
 * A-01: the resolved concurrency config is handed to bootKernel as a whole.
 *
 * The process used to copy it field by field, which is how
 * ZEUS_MAX_CONCURRENT_PER_VASSAL came to be parsed and validated at boot
 * (resolveConcurrencyConfig) and then dropped before reaching the orchestrator:
 * the operator set a cap, the boot accepted it, and the runtime never enforced
 * it. A whole-object spread puts every present field on the kernel options and
 * keeps every future field doing the same.
 */
export function concurrencyBootOptions(
  concurrency: ProcessConcurrencyConfig,
): Pick<KernelBootOptions, 'maxConcurrentBranches' | 'branchQueueLimit' | 'maxConcurrentPerVassal'> {
  return { ...concurrency };
}

function envInteger(
  value: string | undefined,
  name: string,
  min: number,
): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new KernelBootError(`${name} must be a whole number >= ${min}, got '${value}'`);
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
    throw new KernelBootError(`${name} must be a number >= ${min}, got '${value}'`);
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
 * Realm mounts from env (G4 + E3.6).
 *
 * `ZEUS_REALM_ROOTS` stays what it always was: a comma list of personal roots.
 * Enterprise mounts need a tenant scope, so they get their own variable rather
 * than an overloaded separator inside the personal one:
 * `ZEUS_REALM_ENTERPRISE="/srv/acme::acme,/srv/acme-eng::acme/eng"`. `::`
 * separates path from tenant because a Windows drive letter already owns the
 * single colon. An unusable tenant fails the boot: an enterprise realm mounted
 * WITHOUT its scope is a silently widened data domain, the opposite of what the
 * scope is for.
 */
export type ProcessRealmConfig = {
  realmRoots: NonNullable<KernelBootOptions['realmRoots']>;
};

export function resolveRealmConfig(env: NodeJS.ProcessEnv = process.env): ProcessRealmConfig {
  const roots: ProcessRealmConfig['realmRoots'] = [];
  for (const entry of splitEnvList(env.ZEUS_REALM_ROOTS)) roots.push(entry);
  for (const entry of splitEnvList(env.ZEUS_REALM_ENTERPRISE)) {
    const separator = entry.indexOf('::');
    if (separator < 0) {
      throw new KernelBootError(
        `ZEUS_REALM_ENTERPRISE entries are "<root>::<tenant>", got '${entry}' (the tenant is what keeps an enterprise realm from being org-visible)`,
      );
    }
    const root = entry.slice(0, separator).trim();
    const tenant = entry.slice(separator + 2).trim();
    if (!root) throw new KernelBootError(`ZEUS_REALM_ENTERPRISE entry has an empty root: '${entry}'`);
    try {
      normalizeTenant(tenant);
    } catch (error) {
      throw new KernelBootError(`ZEUS_REALM_ENTERPRISE entry '${entry}' has an unusable tenant: ${(error as Error).message}`);
    }
    roots.push({ root, type: 'enterprise', tenant });
  }
  return { realmRoots: roots };
}

function splitEnvList(value: string | undefined): string[] {
  return (value ?? '').split(',').map(entry => entry.trim()).filter(Boolean);
}

/**
 * E4.8: parse `ZEUS_VASSAL_SEEDS` — a comma list of card URLs, optionally each
 * carrying its vassal bearer after `|` (e.g. `"https://…/agent-card|token-1"`).
 * `|` is unambiguous: it is not a legal raw character in an RFC 3986 URL, so a
 * card URL can never contain it unencoded. A plain URL registers with no token.
 */
export type ProcessVassalSeedsConfig = NonNullable<KernelBootOptions['vassalSeeds']>;

export function resolveVassalSeedsConfig(env: NodeJS.ProcessEnv = process.env): ProcessVassalSeedsConfig {
  const seeds: ProcessVassalSeedsConfig = [];
  for (const entry of splitEnvList(env.ZEUS_VASSAL_SEEDS)) {
    const separator = entry.indexOf('|');
    if (separator < 0) {
      seeds.push(entry);
      continue;
    }
    const cardUrl = entry.slice(0, separator).trim();
    const token = entry.slice(separator + 1).trim();
    if (!cardUrl) throw new KernelBootError(`vassal seed entry has an empty card URL: '${entry}'`);
    if (!token) throw new KernelBootError(`vassal seed entry '${entry}' has an empty token after '|'`);
    seeds.push({ cardUrl, token });
  }
  return seeds;
}
