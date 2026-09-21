#!/usr/bin/env node
/**
 * Development process assembly for the Zeus HTTP face (H1).
 *
 *   ZEUS_PORT=8787 ZEUS_HOST=127.0.0.1 \
 *   ZEUS_INTERNAL_TOKEN=... \
 *   ZEUS_RSK_KEY_ID=zeus-rsk-2026-09 ZEUS_RSK_KEY="$(cat rsk.pem)" \
 *   node dist/http/serve.js
 *
 * Production RSK storage (key chain / KMS) is a deployment-slice concern tracked
 * by deferred #7; without ZEUS_RSK_KEY an ephemeral in-memory key is generated
 * (dev only — restarts invalidate every signature).
 */
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { createRequire } from 'node:module';
import { VassalRegistry } from '../registry/registry.js';
import { Ed25519MemorySigner } from '../registry/signing.js';
import { createHttpServer } from './server.js';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json') as { version: string };

function loadSigner(): Ed25519MemorySigner {
  const keyId = process.env.ZEUS_RSK_KEY_ID ?? 'zeus-rsk-dev';
  const pem = process.env.ZEUS_RSK_KEY;
  if (pem) {
    const privateKey = createPrivateKey(pem);
    const publicKey = createPublicKey(privateKey);
    return new Ed25519MemorySigner(keyId, privateKey, publicKey);
  }
  process.stderr.write('[zeus-http] ZEUS_RSK_KEY not set: generated ephemeral in-memory RSK (dev only)\n');
  return new Ed25519MemorySigner(keyId);
}

async function main(): Promise<void> {
  // H1 starts with an empty registry; card registration belongs to the future
  // startup orchestration (Zeus pulls cards, nothing registers via HTTP writes).
  const registry = new VassalRegistry();
  const app = await createHttpServer({
    registry,
    signer: loadSigner(),
    internalToken: process.env.ZEUS_INTERNAL_TOKEN,
    version: pkg.version,
  });
  const port = Number(process.env.ZEUS_PORT ?? 8787);
  const host = process.env.ZEUS_HOST ?? '127.0.0.1';
  await app.listen({ host, port });
  process.stderr.write(`[zeus-http] listening on http://${host}:${port} (healthz, roster public${process.env.ZEUS_INTERNAL_TOKEN ? ', roster internal' : ''})\n`);

  const shutdown = async (signal: string): Promise<void> => {
    process.stderr.write(`[zeus-http] ${signal} received, draining...\n`);
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
