import { createPrivateKey, createPublicKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Ed25519MemorySigner } from '../registry/signing.js';

/**
 * RSK (Roster Signing Key) loading for the HTTP process.
 *
 * Resolution order:
 *   1. ZEUS_RSK_KEY      — raw Ed25519 PEM passed via environment (12-factor);
 *   2. ZEUS_RSK_KEY_FILE — path to a PEM file (Docker/K8s secret mount);
 *   3. nothing           — production (NODE_ENV=production) refuses to boot,
 *                          other environments fall back to an ephemeral key with
 *                          a loud warning (restarts then invalidate every seal).
 *
 * Extracted from serve.ts so the production guard and file support are unit-testable.
 */

export type RskEnv = {
  ZEUS_RSK_KEY?: string;
  ZEUS_RSK_KEY_FILE?: string;
  ZEUS_RSK_KEY_ID?: string;
  NODE_ENV?: string;
};

export class RskConfigError extends Error {}

export type LoadRskOptions = {
  env?: RskEnv;
  /** Injected file reader (tests). */
  readFile?: (path: string) => Promise<string>;
  /** Warning sink for the dev-only ephemeral fallback. */
  warn?: (message: string) => void;
};

export async function loadRskSigner(options: LoadRskOptions = {}): Promise<Ed25519MemorySigner> {
  const env = options.env ?? process.env;
  const read = options.readFile ?? ((path: string) => readFile(path, 'utf8'));
  const warn = options.warn ?? ((message: string) => process.stderr.write(`${message}\n`));
  const keyId = env.ZEUS_RSK_KEY_ID ?? 'zeus-rsk-dev';
  const isProduction = env.NODE_ENV === 'production';

  let pem = env.ZEUS_RSK_KEY?.trim();
  if (!pem && env.ZEUS_RSK_KEY_FILE) {
    try {
      pem = (await read(env.ZEUS_RSK_KEY_FILE)).trim();
    } catch (error) {
      throw new RskConfigError(
        `cannot read RSK key file "${env.ZEUS_RSK_KEY_FILE}": ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  if (pem) {
    let privateKey;
    try {
      privateKey = createPrivateKey(pem);
    } catch (error) {
      throw new RskConfigError(
        `ZEUS_RSK_KEY is not a valid PEM private key: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (privateKey.asymmetricKeyType !== 'ed25519') {
      throw new RskConfigError(
        `ZEUS_RSK_KEY must be an Ed25519 key (got ${privateKey.asymmetricKeyType}); generate one with scripts/gen-rsk-key.sh`
      );
    }
    const publicKey = createPublicKey(privateKey);
    return new Ed25519MemorySigner(keyId, privateKey, publicKey);
  }

  if (isProduction) {
    throw new RskConfigError(
      'ZEUS_RSK_KEY or ZEUS_RSK_KEY_FILE is required when NODE_ENV=production: refusing to seal the public roster with an ephemeral key (restarts would invalidate every signature)'
    );
  }

  warn('[zeus-http] ZEUS_RSK_KEY not set: generated ephemeral in-memory RSK (dev only)');
  return new Ed25519MemorySigner(keyId);
}
