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
import { bootKernel } from '../state/boot.js';
import { loadRskSigner } from './rsk.js';
import { createHttpServer } from './server.js';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json') as { version: string };

async function main(): Promise<void> {
  const kernel = await bootKernel({
    ...(process.env.ZEUS_STATE_FILE ? { stateFile: process.env.ZEUS_STATE_FILE } : {}),
    ...(process.env.ZEUS_VASSAL_SEEDS
      ? { vassalSeeds: process.env.ZEUS_VASSAL_SEEDS.split(',').map(url => url.trim()).filter(Boolean) }
      : {}),
    ...(process.env.ZEUS_REALM_ROOTS
      ? { realmRoots: process.env.ZEUS_REALM_ROOTS.split(',').map(root => root.trim()).filter(Boolean) }
      : {}),
    dispatchAudit: entry => {
      process.stderr.write(`[zeus-audit] ${JSON.stringify(entry)}\n`);
    },
  });

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
