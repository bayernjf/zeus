import { VassalRegistry } from '../registry/registry.js';
import type { FetchLike } from '../dispatch/client.js';
import { Dispatcher, type AuditSink } from '../dispatch/dispatcher.js';
import {
  DEFAULT_AUDIT_KEEP,
  DEFAULT_AUDIT_MAX_BYTES,
  jsonlAuditSink,
  revokeAuditBridge,
} from '../dispatch/audit.js';
import { OversightDesk, conflictsToDesk } from '../oversight/oversight.js';
import type { OversightAuditEntry } from '../oversight/types.js';
import { Orchestrator } from '../orchestrator/orchestrator.js';
import { ConcurrencyMetrics } from '../orchestrator/metrics.js';
import { FsRealmStore } from '../realm/store.js';
import { DomainGrantRegistry, type GrantAuditEntry } from '../realm/authorization.js';
import { normalizeTenant } from '../realm/tenant.js';
import type { RealmAuditEntry } from '../realm/source.js';
import type { RealmType, TenantScope } from '../realm/types.js';
import { ProgressHub, type ProgressEvent } from '../orchestrator/progress.js';
import { SkillRegistry } from '../skills/registry.js';
import { MentorshipLedger } from '../skills/mentor.js';
import { OrgRegistry } from '../org/registry.js';
import { MemoryStore, type MemoryAuditEntry } from '../memory/memory-store.js';
import { ConnectorRegistry, type ConnectorAuditEntry } from '../mcp/connectors.js';
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
  /** Absolute or relative path of the state JSON, or null when in-memory only. */
  stateFile: string | null;
  /** E4.7: JSONL dispatch audit log path, or null when the process writes none. */
  auditFile: string | null;
  /** E6.4: feeds cross-domain read/refusal records into the audit spine. */
  realmAudit: (entry: RealmAuditEntry) => void;
  /** Effective audit rotation ceiling for the active file (Infinity = unbounded). */
  auditMaxBytes: number;
  /** Effective rotated audit generations kept beside the active file. */
  auditKeep: number;
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
   *  snapshot or an earlier seed) is skipped, so seeds never trigger a refetch. */
  vassalSeeds?: string[];
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
  const fileSink = options.auditFile
    ? jsonlAuditSink(options.auditFile, {
        ...(options.auditMaxBytes !== undefined ? { maxBytes: options.auditMaxBytes } : {}),
        ...(options.auditKeep !== undefined ? { keep: options.auditKeep } : {}),
      })
    : null;
  const auditSink: AuditSink = fileSink
    ? entry => {
        fileSink(entry);
        options.dispatchAudit?.(entry);
      }
    : (options.dispatchAudit ?? noop);
  const registry = new VassalRegistry(fetchImpl, now, {
    onRegister: entry => skillRegistry.registerFromCard(entry.card),
    onRevoke: revokeAuditBridge(auditSink),
  });
  const oversight = new OversightDesk({
    now,
    ...(options.oversightAudit ? { audit: options.oversightAudit } : {}),
    onDecided: decided => {
      if (decided.kind !== 'memory-dispute' || !decided.factId) return;
      // Approve confirms the new fact: the conflicting facts were wrong. Reject
      // means the new fact itself was wrong. Either way the losing authors are
      // corrected, lowering their reliability in future consolidation.
      const losingFacts = decided.status === 'rejected'
        ? [decided.factId]
        : decided.conflictingFacts ?? [];
      const authors = memoryStore.authorsOfFacts(losingFacts);
      memoryStore.recordCorrections(authors, decided.runId);
    },
  });
  const metrics = new ConcurrencyMetrics({ now });
  const progressHub = new ProgressHub();
  const realmStore = new FsRealmStore();
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
  };
  const realmAudit = (entry: RealmAuditEntry): void => {
    auditSink(entry);
  };
  const domainGrants = new DomainGrantRegistry(now, grantAudit);
  const memoryAudit: (entry: MemoryAuditEntry) => void = options.memoryAudit ?? noop;
  const memoryStore = new MemoryStore(memoryAudit, now);
  const connectorRegistry = new ConnectorRegistry(
    now,
    options.connectorAudit ?? noop,
  );
  const dispatcher = new Dispatcher(registry.asVassalLookup(), {
    audit: auditSink,
    now,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  const orchestrator = new Orchestrator(registry.asVassalLookup(), dispatcher, {
    now,
    metrics,
    onConflict: conflictsToDesk(oversight),
    onProgress: event => {
      progressHub.publish(event);
      if (event.type === 'intent-finished' && event.realmId) {
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
  });
  const components: KernelComponents = {
    registry, oversight, orchestrator, realmStore, skillRegistry, memoryStore, connectorRegistry, mentorshipLedger, orgRegistry, domainGrants,
  };

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
        id: result.escalations[i],
        runId: event.runId,
        realm,
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
    snapshot = await store.load();
    if (snapshot) applyKernelState(components, snapshot);
  }

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
    for (const cardUrl of options.vassalSeeds) {
      if (known.has(cardUrl)) continue;
      await registry.register(cardUrl);
      known.add(cardUrl);
    }
  }

  return {
    ...components,
    metrics,
    progressHub,
    stateFile: options.stateFile ?? null,
    auditFile: options.auditFile ?? null,
    realmAudit,
    auditMaxBytes: options.auditMaxBytes ?? DEFAULT_AUDIT_MAX_BYTES,
    auditKeep: options.auditKeep ?? DEFAULT_AUDIT_KEEP,
    restoredFromSnapshot: snapshot !== null,
    snapshot,
    async saveState(): Promise<void> {
      if (!store) return;
      await store.save(collectKernelState(components));
    },
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
  if (env.ZEUS_JUDGE_THRESHOLD) {
    const threshold = Number(env.ZEUS_JUDGE_THRESHOLD);
    if (Number.isFinite(threshold)) config.judgeThreshold = threshold;
  }
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
};

export function resolveConcurrencyConfig(env: NodeJS.ProcessEnv = process.env): ProcessConcurrencyConfig {
  const config: ProcessConcurrencyConfig = {};
  const cap = envInteger(env.ZEUS_MAX_CONCURRENT_BRANCHES, 'ZEUS_MAX_CONCURRENT_BRANCHES', 1);
  if (cap !== undefined) config.maxConcurrentBranches = cap;
  // 0 is a meaningful queue limit: refuse immediately rather than wait for a slot.
  const limit = envInteger(env.ZEUS_BRANCH_QUEUE_LIMIT, 'ZEUS_BRANCH_QUEUE_LIMIT', 0);
  if (limit !== undefined) config.branchQueueLimit = limit;
  return config;
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
    config.auditMaxBytes = UNLIMITED.has(rawMax) ? Number.POSITIVE_INFINITY : envInteger(rawMax, 'ZEUS_AUDIT_MAX_BYTES', 1);
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
