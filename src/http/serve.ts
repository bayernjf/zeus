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
import { bootKernel, resolveAuditConfig, resolveConcurrencyConfig, resolveDecisionConfig } from '../state/boot.js';
import { kernelStats } from '../state/stats.js';
import { loadRskSigner } from './rsk.js';
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
  if (process.env.ZEUS_JUDGE_ENABLED && !decision.backend) {
    process.stderr.write(
      '[zeus-http] ZEUS_JUDGE_ENABLED is set but no decision backend is configured; judge stays off\n'
    );
  }
  const kernel = await bootKernel({
    ...(process.env.ZEUS_STATE_FILE ? { stateFile: process.env.ZEUS_STATE_FILE } : {}),
    ...(concurrency.maxConcurrentBranches !== undefined
      ? { maxConcurrentBranches: concurrency.maxConcurrentBranches }
      : {}),
    ...(concurrency.branchQueueLimit !== undefined
      ? { branchQueueLimit: concurrency.branchQueueLimit }
      : {}),
    ...(process.env.ZEUS_VASSAL_SEEDS
      ? { vassalSeeds: process.env.ZEUS_VASSAL_SEEDS.split(',').map(url => url.trim()).filter(Boolean) }
      : {}),
    ...(process.env.ZEUS_REALM_ROOTS
      ? { realmRoots: process.env.ZEUS_REALM_ROOTS.split(',').map(root => root.trim()).filter(Boolean) }
      : {}),
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
    signer: await loadRskSigner(),
    internalToken: process.env.ZEUS_INTERNAL_TOKEN,
    version: pkg.version,
    orchestrator: kernel.orchestrator,
    oversight: kernel.oversight,
    metrics: kernel.metrics,
    progressHub: kernel.progressHub,
    skillRegistry: kernel.skillRegistry,
    mentorshipLedger: kernel.mentorshipLedger,
    orgRegistry: kernel.orgRegistry,
    memoryStore: kernel.memoryStore,
    realmStore: kernel.realmStore,
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
  console.error(error);
  process.exit(1);
});
