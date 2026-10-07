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
  KernelBootError,
  resolveAuditConfig,
  resolveConcurrencyConfig,
  resolveDecisionConfig,
  resolveRealmConfig,
  resolveVassalSeedsConfig,
} from '../state/boot.js';
import { kernelStats } from '../state/stats.js';
import { loadRskSigner, RskConfigError } from './rsk.js';
import { RealmError } from '../realm/types.js';
import { startServer } from './server.js';
import { createLogger } from '../util/logger.js';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json') as { version: string };

// Structured operator log (feature-inventory 结构化日志). The audit trail keeps
// its own JSONL spine (dispatchAudit below); this logger is for boot lifecycle,
// refusal and transport failures. Level defaults to info until a level env is
// decided (deferred candidate, not in scope here).
const log = createLogger();

async function main(): Promise<void> {
  // T-C: build the decision backend (Jev preferred, LLM fallback) and the
  // opt-in E1.3 judge from process env. No keys => null => rules-only kernel,
  // identical to the pre-backend behaviour (deployment keys are operator-owned).
  const decision = resolveDecisionConfig(process.env);
  // E1.5: an unusable cap value aborts the boot inside resolveConcurrencyConfig,
  // because a silently ignored cap would read as protection that is not there.
  const concurrency = resolveConcurrencyConfig(process.env);
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
    // A-01: the resolved config goes across whole; copying it by hand is how the
    // per-vassal cap was validated at boot and then never reached the kernel.
    ...concurrencyBootOptions(concurrency),
    ...(process.env.ZEUS_VASSAL_SEEDS
      ? { vassalSeeds: resolveVassalSeedsConfig(process.env) }
      : {}),
    ...(realm.realmRoots.length ? { realmRoots: realm.realmRoots } : {}),
    ...(process.env.ZEUS_AUDIT_FILE ? { auditFile: process.env.ZEUS_AUDIT_FILE } : {}),
    ...(audit.auditMaxBytes !== undefined ? { auditMaxBytes: audit.auditMaxBytes } : {}),
    ...(audit.auditKeep !== undefined ? { auditKeep: audit.auditKeep } : {}),
    dispatchAudit: entry => {
      process.stderr.write(`[zeus-audit] ${JSON.stringify(entry)}\n`);
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
    ...(kernel.skillRegistry ? { skillRegistry: kernel.skillRegistry } : {}),
    ...(kernel.mentorshipLedger ? { mentorshipLedger: kernel.mentorshipLedger } : {}),
    ...(kernel.orgRegistry ? { orgRegistry: kernel.orgRegistry } : {}),
    ...(kernel.memoryStore ? { memoryStore: kernel.memoryStore } : {}),
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
            process.stderr.write(`[zeus-audit] ${JSON.stringify(entry)}\n`);
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
