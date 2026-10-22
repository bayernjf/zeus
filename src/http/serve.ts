#!/usr/bin/env node
/**
 * Development process assembly for the Zeus HTTP face (H1).
 *
 *   ZEUS_PORT=8787 ZEUS_HOST=127.0.0.1 \
 *   ZEUS_INTERNAL_TOKEN=... \
 *   ZEUS_STATE_FILE=./data/kernel-state.json \
 *   ZEUS_RSK_KEY_ID=zeus-rsk-2026-09 ZEUS_RSK_KEY_FILE=./secrets/rsk-private.pem \
 *   node dist/http/serve.js
 *
 * Persistence (E5.3): when ZEUS_STATE_FILE is set the registry, oversight queue
 * and orchestrator idempotency tables are restored on boot and atomically saved
 * on graceful shutdown (SIGINT/SIGTERM). Without it the kernel stays in-memory.
 *
 * Production RSK: NODE_ENV=production refuses to boot without ZEUS_RSK_KEY or
 * ZEUS_RSK_KEY_FILE (generate a pair with `node scripts/gen-rsk-key.mjs`). The
 * public half is published on the public face at GET /api/roster/keys; key
 * storage and rotation remain a deployment-slice concern tracked by deferred #7
 * (runbook: design-fealty-signing §5.4). Without
 * a key in other environments an ephemeral in-memory key is generated (dev only
 * — restarts invalidate every signature, and with it the published key).
 */
import { createRequire } from 'node:module';
import {
  bootKernel,
  concurrencyBootOptions,
  costBootOptions,
  KernelBootError,
  resolveAuditConfig,
  resolveConcurrencyConfig,
  resolveCostConfig,
  resolveDecisionConfig,
  resolveRealmConfig,
  resolveVassalSeedsConfig,
} from '../state/boot.js';
import { kernelStats } from '../state/stats.js';
import { parseRetentionMode } from '../state/archive.js';
import { loadRskSigner, RskConfigError } from './rsk.js';
import { RealmError } from '../realm/types.js';
import { startServer } from './server.js';
import { createLogger, redactText } from '../util/logger.js';
import { DecisionAuditChain, DecisionService, MemoryDecisionStore } from '../core/index.js';
import { MemoryPolicyStore } from '../core/grading/policy-loader.js';
import { DEFAULT_POLICY_V1 } from '../core/grading/default-policy.js';
import { JsonlDecisionAuditStore } from '../app/audit/jsonl-chain-store.js';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json') as { version: string };

// Structured operator log (feature-inventory 结构化日志). The audit trail keeps
// its own JSONL spine (dispatchAudit below); this logger is for boot lifecycle,
// refusal and transport failures. Level defaults to info until a level env is
// decided (deferred candidate, not in scope here).
const log = createLogger();

// The stderr audit mirror applies the same value-form redaction as the JSONL
// sink: entry.detail is free text that may carry error messages with embedded
// URL credentials or tokens. Structure is preserved; only detail is scrubbed.
function mirrorAuditEntry(entry: { detail?: string }): string {
  const safe = typeof entry.detail === 'string'
    ? { ...entry, detail: redactText(entry.detail) }
    : entry;
  return `[zeus-audit] ${JSON.stringify(safe)}\n`;
}

/** deferred #42: retention bounds are positive integers. A silent coercion to
 *  0 or NaN would disable the out-window condition entirely; abort boot like
 *  the concurrency caps do. */
function parseIntPositive(name: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new KernelBootError(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

async function main(): Promise<void> {
  // T-C: build the decision backend (Jev preferred, LLM fallback) and the
  // opt-in E1.3 judge from process env. No keys => null => rules-only kernel,
  // identical to the pre-backend behaviour (deployment keys are operator-owned).
  const decision = resolveDecisionConfig(process.env);
  // E1.5: an unusable cap value aborts the boot inside resolveConcurrencyConfig,
  // because a silently ignored cap would read as protection that is not there.
  const concurrency = resolveConcurrencyConfig(process.env);
  const cost = resolveCostConfig(process.env);
  const audit = resolveAuditConfig(process.env);
  // E3.6: enterprise mounts carry their tenant scope; a malformed one aborts the
  // boot here rather than mounting an org-visible realm.
  const realm = resolveRealmConfig(process.env);
  if (process.env.ZEUS_JUDGE_ENABLED && !decision.backend) {
    log.warn('judge-disabled', 'ZEUS_JUDGE_ENABLED is set but no decision backend is configured; judge stays off');
  }
  // E3.5 / deferred #14: the same Ed25519 key that seals the roster is this
  // process's driver key, so a write grant the kernel did not sign (or one a
  // vassal authored) cannot authorize an enterprise write. Loaded before the
  // kernel because the kernel needs it as the trust anchor.
  const { signer, ephemeral } = await loadRskSigner();
  const kernel = await bootKernel({
    driverSigner: signer,
    onAuditError: message => {
      log.error('audit-persist-failed', message);
    },
    onStateSaveError: message => {
      log.error('state-save-failed', message);
    },
    ...(process.env.ZEUS_STATE_FILE ? { stateFile: process.env.ZEUS_STATE_FILE } : {}),
    // deferred #42: decision-record retention. Defaults to retain (today's
    // behaviour); archive|evict move out-window intents out of the state file
    // (design-intent-retention §4/§5). The two bounds are positive integers;
    // a silently coerced 0 or NaN would read as protection that is not there,
    // so they abort boot exactly like the concurrency caps.
    ...(process.env.ZEUS_INTENT_RETENTION
      ? { intentRetention: parseRetentionMode(process.env.ZEUS_INTENT_RETENTION) }
      : {}),
    ...(process.env.ZEUS_INTENT_RETENTION_MAX_ENTRIES
      ? { intentRetentionMaxEntries: parseIntPositive('ZEUS_INTENT_RETENTION_MAX_ENTRIES', process.env.ZEUS_INTENT_RETENTION_MAX_ENTRIES) }
      : {}),
    ...(process.env.ZEUS_INTENT_RETENTION_WINDOW_MS
      ? { intentRetentionWindowMs: parseIntPositive('ZEUS_INTENT_RETENTION_WINDOW_MS', process.env.ZEUS_INTENT_RETENTION_WINDOW_MS) }
      : {}),
    // A-01: the resolved config goes across whole; copying it by hand is how the
    // per-vassal cap was validated at boot and then never reached the kernel.
    ...concurrencyBootOptions(concurrency),
    ...costBootOptions(cost),
    ...(process.env.ZEUS_VASSAL_SEEDS
      ? { vassalSeeds: resolveVassalSeedsConfig(process.env) }
      : {}),
    ...(realm.realmRoots.length ? { realmRoots: realm.realmRoots } : {}),
    ...(process.env.ZEUS_AUDIT_FILE ? { auditFile: process.env.ZEUS_AUDIT_FILE } : {}),
    // E4.11 (design-a2a-push): Zeus's own push receiver address. Armed intents
    // carry it as pushNotificationConfig; the callback endpoint is mounted with
    // the same gate as the driver token (unset → not mounted).
    ...(process.env.ZEUS_A2A_PUSH_URL
      ? {
          pushReceiver: {
            url: process.env.ZEUS_A2A_PUSH_URL,
            ...(process.env.ZEUS_INTERNAL_TOKEN
              ? { token: process.env.ZEUS_INTERNAL_TOKEN }
              : {}),
          },
        }
      : {}),
    // S6 V3: the two observability files are opt-in by path. Booted without them
    // the process is exactly V1/V2 - live metrics window only, no trace export -
    // and `GET /api/metrics/history` is not mounted at all. Before this they were
    // reachable only from bootKernel callers: the shipped entry never passed the
    // options, so the endpoint existed in the library and was dead in deployment.
    ...(process.env.ZEUS_TRACE_EXPORT_FILE ? { traceExportFile: process.env.ZEUS_TRACE_EXPORT_FILE } : {}),
    ...(process.env.ZEUS_METRICS_HISTORY_FILE ? { metricsHistoryFile: process.env.ZEUS_METRICS_HISTORY_FILE } : {}),
    ...(audit.auditMaxBytes !== undefined ? { auditMaxBytes: audit.auditMaxBytes } : {}),
    ...(audit.auditKeep !== undefined ? { auditKeep: audit.auditKeep } : {}),
    dispatchAudit: entry => {
      process.stderr.write(mirrorAuditEntry(entry));
    },
    ...(decision.backend ? { decisionBackend: decision.backend } : {}),
    judgeEnabled: decision.judgeEnabled,
    ...(decision.judgeThreshold !== undefined ? { judgeThreshold: decision.judgeThreshold } : {}),
    ...(decision.allowUncalibratedJudge !== undefined
      ? { allowUncalibratedJudge: decision.allowUncalibratedJudge }
      : {}),
  });
  if (decision.backend) {
    log.info('decision-backend', 'configured', {
      kind: decision.backendKind,
      model: decision.backend.model,
      arbitration: true,
      judge: decision.judgeEnabled,
    });
  } else {
    log.info('decision-backend', 'not configured (arbitration/judge off, rules-only)');
  }
  log.info('branch-concurrency', undefined, {
    maxConcurrentBranches: concurrency.maxConcurrentBranches ?? 'unbounded',
    branchQueueLimit: concurrency.branchQueueLimit ?? 'unbounded',
    maxConcurrentPerVassal: concurrency.maxConcurrentPerVassal ?? 'unbounded',
  });
  if (kernel.auditFile) {
    const ceiling = kernel.auditMaxBytes === Number.POSITIVE_INFINITY
      ? 'no ceiling'
      : `${Math.round((kernel.auditMaxBytes ?? 0) / 1048576)}MiB x ${kernel.auditKeep ?? 0} kept`;
    log.info('audit-log', undefined, { file: kernel.auditFile, ceiling });
  }
  // Both switches print their resolved value, "off" included: an operator who
  // cannot tell whether the history file was configured reads an unmounted
  // endpoint as a broken one rather than an unset option.
  log.info('observability-export', undefined, {
    traceExport: process.env.ZEUS_TRACE_EXPORT_FILE ?? 'off',
    metricsHistory: process.env.ZEUS_METRICS_HISTORY_FILE ?? 'off',
  });
  // The exported tree is rebuilt from the audit spine, so a trace file without
  // an audit file stays empty forever (src/state/boot.ts guards on both). Say it
  // at boot rather than letting the operator discover it through an empty file.
  if (process.env.ZEUS_TRACE_EXPORT_FILE && !process.env.ZEUS_AUDIT_FILE) {
    log.warn('trace-export-needs-audit-file', 'ZEUS_TRACE_EXPORT_FILE is set but ZEUS_AUDIT_FILE is not; no trace will be exported');
  }

  // The operator's first question after "is it up" is "which realms did it
  // mount, and under which ids" - the ids otherwise only appear on the
  // bearer face, which presupposes knowing the bearer face exists.
  for (const connection of kernel.realmStore?.connections() ?? []) {
    const scope = connection.tenant
      ? [connection.tenant.org, connection.tenant.department, connection.tenant.member].filter(Boolean).join('/')
      : undefined;
    log.info('realm-mounted', undefined, {
      realmId: connection.realmId,
      type: connection.type,
      ...(scope !== undefined ? { tenant: scope } : {}),
      writable: !connection.readOnly,
      root: connection.root,
    });
  }
  log.info(
    'enterprise-writes',
    kernel.driverGrantAuthority === 'signed'
      ? `accepting only driver grants signed by "${kernel.driverSigner?.keyId}"`
      : 'NO driver key configured - grants are checked for shape/realm/expiry only, so anything that can call write() can author its own authorization'
  );
  if (kernel.stateFile) {
    if (kernel.restoredFromSnapshot) {
      const intents = kernel.snapshot?.orchestrator.intents.length ?? 0;
      log.info('kernel-state-restored', undefined, {
        file: kernel.stateFile,
        vassals: kernel.registry.listAll().length,
        escalations: kernel.oversight.list().length,
        intents,
      });
    } else {
      log.info('kernel-state-file-missing', undefined, { file: kernel.stateFile });
    }
  }

  // Live SSE caps (M-04): a per-process limit on concurrently attached live
  // streams and the attach grace for "connect SSE, then POST fan-out". Both are
  // positive integers like the concurrency caps; a malformed value aborts boot
  // rather than silently disabling the bound.
  const sseMaxStreams =
    process.env.ZEUS_SSE_MAX_STREAMS !== undefined
      ? parseIntPositive('ZEUS_SSE_MAX_STREAMS', process.env.ZEUS_SSE_MAX_STREAMS)
      : undefined;
  const sseAttachGraceMs =
    process.env.ZEUS_SSE_ATTACH_GRACE_MS !== undefined
      ? parseIntPositive('ZEUS_SSE_ATTACH_GRACE_MS', process.env.ZEUS_SSE_ATTACH_GRACE_MS)
      : undefined;

  // Decision API v1 (T-M1-06): assemble the graded decision service. The
  // sealing key is the same Ed25519 RSK key (key rotation stays a deployment
  // concern). The JSONL trail is opt-in via ZEUS_DECISION_AUDIT_FILE; without
  // it the chain is in-memory and the process restart loses the trail.
  // Records are in-memory for M1 (SQLite/PG tables land with the deployment
  // slice). A trail that fails verification refuses to open (fail-closed).
  let decisionService: DecisionService | undefined;
  if (process.env.ZEUS_INTERNAL_TOKEN) {
    const policyStore = new MemoryPolicyStore();
    policyStore.put(DEFAULT_POLICY_V1);
    const audit = process.env.ZEUS_DECISION_AUDIT_FILE
      ? await JsonlDecisionAuditStore.open(process.env.ZEUS_DECISION_AUDIT_FILE, signer, signer.verifier())
      : new DecisionAuditChain(signer);
    decisionService = new DecisionService({
      policyStore,
      recordStore: new MemoryDecisionStore(),
      audit,
    });
    log.info('decision-service', 'assembled', {
      defaultPolicy: `v${DEFAULT_POLICY_V1.version}`,
      auditTrail: process.env.ZEUS_DECISION_AUDIT_FILE ?? 'in-memory',
    });
  }

  // The start primitive owns the bind defaults (loopback:8787, design-http-transport
  // §2.1); ZEUS_HOST / ZEUS_PORT only override them, so the process entry and the
  // published `zeus/http` API cannot drift into two different answers.
  const app = await startServer({
    registry: kernel.registry,
    signer,
    // One line on stderr at boot is not a record an operator can consult later, so
    // the fact the loader knows - whether this key survives a restart - is passed
    // down and reported by the two faces that answer "which key is this?".
    rosterKey: { keyId: signer.keyId, source: ephemeral ? 'ephemeral' : 'configured' },
    ...(process.env.ZEUS_INTERNAL_TOKEN !== undefined ? { internalToken: process.env.ZEUS_INTERNAL_TOKEN } : {}),
    ...(process.env.ZEUS_CORS_ORIGINS
      ? { corsOrigins: process.env.ZEUS_CORS_ORIGINS.split(',').map(s => s.trim()).filter(s => s.length > 0) }
      : {}),
    version: pkg.version,
    orchestrator: kernel.orchestrator,
    dagRunner: kernel.dagRunner,
    oversight: kernel.oversight,
    metrics: kernel.metrics,
    progressHub: kernel.progressHub,
    ...(sseMaxStreams !== undefined ? { sseMaxStreams } : {}),
    ...(sseAttachGraceMs !== undefined ? { sseAttachGraceMs } : {}),
    // Transport faults whose HTTP/JSON-RPC body stays generic keep their raw
    // detail here; the logger's redaction sink is the only place it lands.
    log: (event, msg, fields) => {
      log.error(event, msg, fields);
    },
    // deferred #42: replay/approve-resume read the out-window archive when the
    // state table misses; the retention mode is surfaced on replay misses so an
    // eviction-mode 404 is not mistaken for "never existed".
    ...(kernel.intentArchive ? { intentArchive: kernel.intentArchive } : {}),
    retention: kernel.retention,
    ...(kernel.skillRegistry ? { skillRegistry: kernel.skillRegistry } : {}),
    ...(kernel.mentorshipLedger ? { mentorshipLedger: kernel.mentorshipLedger } : {}),
    ...(kernel.orgRegistry ? { orgRegistry: kernel.orgRegistry } : {}),
    ...(kernel.memoryStore ? { memoryStore: kernel.memoryStore } : {}),
    // M-12: retract / forget-subject answer only once the erasure is durable.
    persistState: () => kernel.saveState(),
    ...(kernel.realmStore ? { realmStore: kernel.realmStore } : {}),
    ...(kernel.realmStore
      ? {
          realmMcp: {
            realmIds: (kernel.realmStore.connections() ?? []).map(connection => connection.realmId),
          },
        }
      : {}),
    // Inbound A2A (design-inbound-a2a, deferred #19): publish Zeus' own agent
    // card when the kernel has a skill catalogue to advertise. The card URL is
    // the public-facing base (ZEUS_PUBLIC_URL when a reverse proxy fronts the
    // process, otherwise the bind defaults the start primitive owns).
    ...(kernel.skillRegistry
      ? {
          agentCard: {
            name: 'zeus',
            description: 'Zeus multi-agent runtime: aggregate intent fan-out and decision surface over pre-connected vassals.',
            url: process.env.ZEUS_PUBLIC_URL ?? `http://${process.env.ZEUS_HOST ?? '127.0.0.1'}:${process.env.ZEUS_PORT ?? '8787'}`,
            version: pkg.version,
            capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
            defaultInputModes: ['application/json'],
            defaultOutputModes: ['application/json'],
            skills: kernel.skillRegistry.list().map(spec => ({
              id: spec.id,
              name: spec.name,
              description: spec.description ?? '',
              tags: spec.tags ?? [],
            })),
          },
          inboundAudit: entry => {
            process.stderr.write(mirrorAuditEntry(entry));
          },
        }
      : {}),
    // E6.4: the two data domains, their tenant scopes and the grants between them.
    ...(kernel.domainGrants ? { domainGrants: kernel.domainGrants } : {}),
    realmAudit: kernel.realmAudit,
    // E3.5 / deferred #14: enterprise write credentials (issue + replay ledger).
    ...(kernel.driverGrantLedger ? { driverGrantLedger: kernel.driverGrantLedger } : {}),
    driverGrantAuthority: kernel.driverGrantAuthority,
    driverGrantAudit: kernel.driverGrantAudit,
    // deferred #33: issuing an execution delegation is audited separately from
    // the dispatch it authorizes - without this bridge the issuance endpoint
    // hands out tickets while the trail stays silent (inject tests cannot see
    // the process entry, deferred #25 discipline).
    executionDelegationAudit: kernel.executionDelegationAudit,
    // Self-host loop step 5: the operator-facing delegation-contract face.
    ...(kernel.delegationContracts ? { delegationContracts: kernel.delegationContracts } : {}),
    ...(kernel.watches ? { watches: kernel.watches } : {}),
    runWatchTick: kernel.runWatchTick,
    delegationContractAudit: kernel.delegationContractAudit,
    // E9.1/E9.2: the day-one briefing and the commission gate.
    ...(kernel.commissionLedger ? { commissions: kernel.commissionLedger } : {}),
    ...(kernel.connectorRegistry ? { connectorRegistry: kernel.connectorRegistry } : {}),
    ...(kernel.auditFile ? { auditFile: kernel.auditFile } : {}),
    // The route is conditional on the port being present, so this is the line
    // that decides whether an operator can read the trend at all.
    ...(kernel.metricsHistory ? { metricsHistory: kernel.metricsHistory } : {}),
    kernelStats: () => kernelStats(kernel),
    // Same facts the boot log line prints, now readable over the bearer face.
    decisionStatus: {
      configured: decision.backend !== null,
      ...(decision.backendKind ? { kind: decision.backendKind } : {}),
      ...(decision.backend ? { model: decision.backend.model } : {}),
      arbitration: { enabled: decision.backend !== null },
      judge: {
        enabled: decision.judgeEnabled,
        ...(decision.judgeThreshold !== undefined ? { threshold: decision.judgeThreshold } : {}),
        ...(decision.allowUncalibratedJudge !== undefined
          ? { allowUncalibrated: decision.allowUncalibratedJudge }
          : {}),
      },
    },
    // E2.6: the same pluggable backend that drives arbitration also powers
    // operator intent recognition. Recognition is plan-only and the model is
    // only consulted when the caller explicitly opts in (useModel: true).
    ...(decision.backend ? { decisionBackend: decision.backend } : {}),
    // Decision API v1 (T-M1-06): present only when the service assembled above.
    ...(decisionService ? { decisionService } : {}),
  }, {
    ...(process.env.ZEUS_HOST ? { host: process.env.ZEUS_HOST } : {}),
    ...(process.env.ZEUS_PORT ? { port: Number(process.env.ZEUS_PORT) } : {}),
  });
  // Report the address the socket actually bound rather than the one requested:
  // with ZEUS_PORT=0 the two differ, and this line is where an operator learns
  // which port to point a client at.
  const bound = app.server.address();
  const boundLabel = typeof bound === 'object' && bound !== null ? `${bound.address}:${bound.port}` : String(bound);
  log.info('listening', undefined, {
    address: `http://${boundLabel}`,
    faces: `healthz, roster public${process.env.ZEUS_INTERNAL_TOKEN ? ', roster internal + H2 driver API' : ''}`,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string, exitCode = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutdown-signal', undefined, { signal });
    try {
      await kernel.saveState();
      if (kernel.stateFile) log.info('kernel-state-saved', undefined, { file: kernel.stateFile });
    } catch (error) {
      log.error('kernel-state-save-failed', error instanceof Error ? error.message : String(error));
    }
    // M-10: release only after the final snapshot landed (or failed). A failed
    // atomic save leaves the prior file intact, so the lock may still be handed
    // to the next boot.
    try {
      await kernel.releaseLock();
    } catch (error) {
      log.error('kernel-state-unlock-failed', error instanceof Error ? error.message : String(error));
    }
    await app.close();
    process.exit(exitCode);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  // A throw from outside a request handler (a hijacked SSE socket, a timer) has
  // nowhere to go: without this listener Node prints the stack and exits at
  // once, losing everything since the last save. Route it through the same
  // drain-and-save path, and keep the non-zero exit so the failure is visible.
  process.on('uncaughtException', error => {
    log.error('uncaught-exception', undefined, { stack: error.stack ?? String(error) });
    void shutdown('uncaughtException', 1);
  });
}

main().catch(error => {
  // A mistyped ZEUS_REALM_ROOTS, an unusable tenant string or an unwritable
  // audit path are configuration facts, not bugs: emit the one line that names
  // what to change and leave the stack to everything else. The structured log
  // keeps the same semantics: named event, error class, message, exit 1.
  if (error instanceof KernelBootError || error instanceof RealmError || error instanceof RskConfigError) {
    log.error('boot-refused', (error as Error).message, { errorClass: error.constructor.name });
    process.exit(1);
  }
  log.error('boot-failed', error instanceof Error ? error.message : String(error), {
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
});
