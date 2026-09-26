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
 * ZEUS_RSK_KEY_FILE (generate with scripts/gen-rsk-key.sh). Key storage/rotation
 * is a deployment-slice concern tracked by deferred #7; without a key in other
 * environments an ephemeral in-memory key is generated (dev only — restarts
 * invalidate every signature).
 */
import { createRequire } from 'node:module';
import {
  bootKernel,
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
import { createHttpServer } from './server.js';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json') as { version: string };

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
    process.stderr.write(
      '[zeus-http] ZEUS_JUDGE_ENABLED is set but no decision backend is configured; judge stays off\n'
    );
  }
  // E3.5 / deferred #14: the same Ed25519 key that seals the roster is this
  // process's driver key, so a write grant the kernel did not sign (or one a
  // vassal authored) cannot authorize an enterprise write. Loaded before the
  // kernel because the kernel needs it as the trust anchor.
  const signer = await loadRskSigner();
  const kernel = await bootKernel({
    driverSigner: signer,
    onAuditError: message => {
      process.stderr.write(`[zeus-http] FAILED to persist an audit entry: ${message}\n`);
    },
    onStateSaveError: message => {
      process.stderr.write(`[zeus-http] FAILED to persist kernel state after a consumed driver grant: ${message}\n`);
    },
    ...(process.env.ZEUS_STATE_FILE ? { stateFile: process.env.ZEUS_STATE_FILE } : {}),
    ...(concurrency.maxConcurrentBranches !== undefined
      ? { maxConcurrentBranches: concurrency.maxConcurrentBranches }
      : {}),
    ...(concurrency.branchQueueLimit !== undefined
      ? { branchQueueLimit: concurrency.branchQueueLimit }
      : {}),
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
    process.stderr.write(
      `[zeus-http] decision backend: ${decision.backendKind}/${decision.backend.model} ` +
        `(arbitration=on, judge=${decision.judgeEnabled ? 'on' : 'off'})\n`
    );
  } else {
    process.stderr.write('[zeus-http] decision backend: not configured (arbitration/judge off, rules-only)\n');
  }
  process.stderr.write(
    `[zeus-http] branch concurrency: ${concurrency.maxConcurrentBranches ?? 'unbounded'}` +
      `${concurrency.branchQueueLimit !== undefined ? `, queue ${concurrency.branchQueueLimit}` : ', queue unbounded'}\n`
  );
  if (kernel.auditFile) {
    const ceiling = kernel.auditMaxBytes === Number.POSITIVE_INFINITY
      ? 'no ceiling'
      : `${Math.round((kernel.auditMaxBytes ?? 0) / 1048576)}MiB x ${kernel.auditKeep ?? 0} kept`;
    process.stderr.write(`[zeus-http] audit log: ${kernel.auditFile} (${ceiling})\n`);
  }

  // The operator's first question after "is it up" is "which realms did it
  // mount, and under which ids" - the ids otherwise only appear on the
  // bearer face, which presupposes knowing the bearer face exists.
  for (const connection of kernel.realmStore?.connections() ?? []) {
    const scope = connection.tenant
      ? ` tenant=${[connection.tenant.org, connection.tenant.department, connection.tenant.member].filter(Boolean).join('/')}`
      : '';
    process.stderr.write(
      `[zeus-http] realm ${connection.realmId} type=${connection.type}${scope}` +
        `${connection.readOnly ? ' read-only' : ' writable'} at ${connection.root}\n`
    );
  }
  process.stderr.write(
    kernel.driverGrantAuthority === 'signed'
      ? `[zeus-http] enterprise writes: accepting only driver grants signed by "${kernel.driverSigner?.keyId}"\n`
      : '[zeus-http] enterprise writes: NO driver key configured - grants are checked for shape/realm/expiry only, so anything that can call write() can author its own authorization\n'
  );
  if (kernel.stateFile) {
    if (kernel.restoredFromSnapshot) {
      const intents = kernel.snapshot?.orchestrator.intents.length ?? 0;
      process.stderr.write(
        `[zeus-http] restored kernel state from ${kernel.stateFile} ` +
          `(vassals=${kernel.registry.listAll().length}, escalations=${kernel.oversight.list().length}, intents=${intents})\n`
      );
    } else {
      process.stderr.write(`[zeus-http] kernel state file ${kernel.stateFile} not found yet; will persist on shutdown\n`);
    }
  }

  const app = await createHttpServer({
    registry: kernel.registry,
    signer,
    internalToken: process.env.ZEUS_INTERNAL_TOKEN,
    version: pkg.version,
    orchestrator: kernel.orchestrator,
    dagRunner: kernel.dagRunner,
    oversight: kernel.oversight,
    metrics: kernel.metrics,
    progressHub: kernel.progressHub,
    skillRegistry: kernel.skillRegistry,
    mentorshipLedger: kernel.mentorshipLedger,
    orgRegistry: kernel.orgRegistry,
    memoryStore: kernel.memoryStore,
    realmStore: kernel.realmStore,
    // E6.4: the two data domains, their tenant scopes and the grants between them.
    domainGrants: kernel.domainGrants,
    realmAudit: kernel.realmAudit,
    // E3.5 / deferred #14: enterprise write credentials (issue + replay ledger).
    driverGrantLedger: kernel.driverGrantLedger,
    driverGrantAuthority: kernel.driverGrantAuthority,
    driverGrantAudit: kernel.driverGrantAudit,
    // E9.1/E9.2: the day-one briefing and the commission gate.
    commissions: kernel.commissionLedger,
    connectorRegistry: kernel.connectorRegistry,
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
  });
  const port = Number(process.env.ZEUS_PORT ?? 8787);
  const host = process.env.ZEUS_HOST ?? '127.0.0.1';
  await app.listen({ host, port });
  process.stderr.write(
    `[zeus-http] listening on http://${host}:${port} (healthz, roster public` +
      `${process.env.ZEUS_INTERNAL_TOKEN ? ', roster internal + H2 driver API' : ''})\n`
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`[zeus-http] ${signal} received, draining...\n`);
    try {
      await kernel.saveState();
      if (kernel.stateFile) process.stderr.write(`[zeus-http] kernel state saved to ${kernel.stateFile}\n`);
    } catch (error) {
      process.stderr.write(`[zeus-http] failed to save kernel state: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch(error => {
  // A mistyped ZEUS_REALM_ROOTS, an unusable tenant string or an unwritable
  // audit path are configuration facts, not bugs: print the one line that names
  // what to change and leave the stack to everything else.
  if (error instanceof KernelBootError || error instanceof RealmError || error instanceof RskConfigError) {
    process.stderr.write(`[zeus-http] refused to start: ${(error as Error).message}\n`);
    process.exit(1);
  }
  console.error(error);
  process.exit(1);
});
