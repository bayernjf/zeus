import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { loadRskSigner, RskConfigError, type RskEnv } from '../src/http/rsk.js';

function ed25519Pem(): string {
  const { privateKey } = generateKeyPairSync('ed25519');
  return privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
}
function rsaPem(): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
}

const silentWarn = (): void => {};

describe('T3 RSK signer loading', () => {
  it('falls back to an ephemeral key outside production and warns', async () => {
    const warnings: string[] = [];
    const signer = await loadRskSigner({ env: { NODE_ENV: 'development' }, warn: m => warnings.push(m) });
    expect(signer.keyId).toBe('zeus-rsk-dev');
    expect(warnings.join(' ')).toMatch(/ephemeral in-memory RSK/);
    // the ephemeral key actually signs and verifies
    const sig = await signer.sign('canonical-text');
    expect(await signer.verifier().verify(signer.keyId, 'canonical-text', sig)).toBe(true);
  });

  it('refuses to boot in production without a key', async () => {
    await expect(
      loadRskSigner({ env: { NODE_ENV: 'production' }, warn: silentWarn })
    ).rejects.toBeInstanceOf(RskConfigError);
    await expect(
      loadRskSigner({ env: { NODE_ENV: 'production' }, warn: silentWarn })
    ).rejects.toThrow(/ZEUS_RSK_KEY/);
  });

  it('loads an inline Ed25519 PEM from ZEUS_RSK_KEY and honours keyId', async () => {
    const pem = ed25519Pem();
    const env: RskEnv = { ZEUS_RSK_KEY: pem, ZEUS_RSK_KEY_ID: 'zeus-rsk-2026-09' };
    const signer = await loadRskSigner({ env, warn: silentWarn });
    expect(signer.keyId).toBe('zeus-rsk-2026-09');
    const sig = await signer.sign('abc');
    expect(await signer.verifier().verify('zeus-rsk-2026-09', 'abc', sig)).toBe(true);
  });

  it('loads a PEM from ZEUS_RSK_KEY_FILE', async () => {
    const pem = ed25519Pem();
    const signer = await loadRskSigner({
      env: { ZEUS_RSK_KEY_FILE: '/secrets/rsk.pem' },
      readFile: async () => pem,
      warn: silentWarn,
    });
    const sig = await signer.sign('from-file');
    expect(await signer.verifier().verify(signer.keyId, 'from-file', sig)).toBe(true);
  });

  it('prefers ZEUS_RSK_KEY over ZEUS_RSK_KEY_FILE', async () => {
    const inline = ed25519Pem();
    let fileRead = false;
    const signer = await loadRskSigner({
      env: { ZEUS_RSK_KEY: inline, ZEUS_RSK_KEY_FILE: '/should/not/be/read' },
      readFile: async () => {
        fileRead = true;
        return ed25519Pem();
      },
      warn: silentWarn,
    });
    expect(fileRead).toBe(false);
    expect(signer.keyId).toBe('zeus-rsk-dev');
  });

  it('rejects malformed PEM', async () => {
    await expect(
      loadRskSigner({ env: { ZEUS_RSK_KEY: 'not a pem' }, warn: silentWarn })
    ).rejects.toBeInstanceOf(RskConfigError);
  });

  // Synchronous RSA-2048 keygen only to prove "not Ed25519"; it starves under
  // parallel load (global floor in vitest.config.ts).
  it('rejects a non-Ed25519 key', async () => {
    await expect(
      loadRskSigner({ env: { ZEUS_RSK_KEY: rsaPem() }, warn: silentWarn })
    ).rejects.toThrow(/Ed25519/);
  });

  it('reports a missing key file as a config error', async () => {
    await expect(
      loadRskSigner({
        env: { ZEUS_RSK_KEY_FILE: '/no/such/rsk.pem' },
        readFile: async () => {
          throw new Error('ENOENT');
        },
        warn: silentWarn,
      })
    ).rejects.toThrow(/cannot read RSK key file/);
  });

  it('accepts a real key in production when provided', async () => {
    const signer = await loadRskSigner({
      env: { NODE_ENV: 'production', ZEUS_RSK_KEY: ed25519Pem(), ZEUS_RSK_KEY_ID: 'prod' },
      warn: silentWarn,
    });
    expect(signer.keyId).toBe('prod');
  });
});
