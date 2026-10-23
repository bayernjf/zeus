/**
 * T-M7-01/#12 SecretBackend tests: local env/file backends, ordered chain,
 * the local assembly factory, and the least-privilege resolution guard. Every
 * missing/unconfigured path must fail closed (throw CredentialError), never
 * yield an empty secret.
 */
import { describe, expect, it } from 'vitest';
import {
  ChainedSecretBackend,
  CredentialError,
  EnvSecretBackend,
  FileSecretBackend,
  UnconfiguredSecretBackend,
  createLocalSecretBackend,
  defaultEnvName,
  resolveGrantedCredential,
} from './credentials.js';

describe('defaultEnvName', () => {
  it('maps opaque refs to a namespaced env var', () => {
    expect(defaultEnvName('agent-world:service-token')).toBe('ZEUS_SECRET_AGENT_WORLD_SERVICE_TOKEN');
    expect(defaultEnvName('commerce:oauth')).toBe('ZEUS_SECRET_COMMERCE_OAUTH');
  });

  it('honours a custom prefix and trims separators', () => {
    expect(defaultEnvName(':weird:', 'T_')).toBe('T_WEIRD');
  });
});

describe('EnvSecretBackend', () => {
  it('resolves a secret via the default env name', async () => {
    const backend = new EnvSecretBackend({
      vars: { ZEUS_SECRET_COMMERCE_OAUTH: 'tok-123' },
    });
    expect(await backend.has('commerce:oauth')).toBe(true);
    expect(await backend.resolve('commerce:oauth')).toEqual({ secret: 'tok-123' });
  });

  it('honours an explicit ref → env map', async () => {
    const backend = new EnvSecretBackend({
      vars: { CUSTOM_TOKEN: 'mapped' },
      map: { 'agent-world:service-token': 'CUSTOM_TOKEN' },
    });
    expect(await backend.resolve('agent-world:service-token')).toEqual({ secret: 'mapped' });
  });

  it('treats an empty string as unset and fails closed', async () => {
    const backend = new EnvSecretBackend({ vars: { ZEUS_SECRET_COMMERCE_OAUTH: '' } });
    expect(await backend.has('commerce:oauth')).toBe(false);
    await expect(backend.resolve('commerce:oauth')).rejects.toBeInstanceOf(CredentialError);
  });

  it('fails closed for an unknown ref', async () => {
    const backend = new EnvSecretBackend({ vars: {} });
    await expect(backend.resolve('nope:missing')).rejects.toBeInstanceOf(CredentialError);
  });
});

describe('FileSecretBackend', () => {
  it('resolves string and structured entries', async () => {
    const backend = new FileSecretBackend({
      path: '/secrets.json',
      read: () =>
        JSON.stringify({
          'commerce:oauth': 'file-tok',
          'agent-world:service-token': { secret: 'svc', metadata: { scope: 'runs' } },
        }),
    });
    expect(await backend.resolve('commerce:oauth')).toEqual({ secret: 'file-tok' });
    expect(await backend.resolve('agent-world:service-token')).toEqual({
      secret: 'svc',
      metadata: { scope: 'runs' },
    });
  });

  it('fails closed when the file is missing or malformed', async () => {
    const backend = new FileSecretBackend({ path: '/nope.json', read: () => { throw new Error('ENOENT'); } });
    expect(await backend.has('commerce:oauth')).toBe(false);
    await expect(backend.resolve('commerce:oauth')).rejects.toBeInstanceOf(CredentialError);
  });

  it('fails closed for an empty secret value or unknown ref', async () => {
    const backend = new FileSecretBackend({
      path: '/secrets.json',
      read: () => JSON.stringify({ 'empty:ref': '' }),
    });
    await expect(backend.resolve('empty:ref')).rejects.toBeInstanceOf(CredentialError);
    await expect(backend.resolve('unknown:ref')).rejects.toBeInstanceOf(CredentialError);
  });
});

describe('ChainedSecretBackend', () => {
  it('falls through to the first backend that has the ref', async () => {
    const env = new EnvSecretBackend({ vars: { ZEUS_SECRET_A_B: 'from-env' } });
    const file = new FileSecretBackend({
      path: '/s.json',
      read: () => JSON.stringify({ 'c:d': 'from-file' }),
    });
    const chain = new ChainedSecretBackend([env, file]);
    expect(await chain.resolve('a:b')).toEqual({ secret: 'from-env' });
    expect(await chain.resolve('c:d')).toEqual({ secret: 'from-file' });
  });

  it('fails closed when no backend resolves', async () => {
    const chain = new ChainedSecretBackend([new UnconfiguredSecretBackend()]);
    await expect(chain.resolve('x:y')).rejects.toBeInstanceOf(CredentialError);
  });
});

describe('createLocalSecretBackend', () => {
  it('resolves from env with no file configured', async () => {
    const backend = createLocalSecretBackend({ vars: { ZEUS_SECRET_A_B: 'env-only' } });
    expect(await backend.resolve('a:b')).toEqual({ secret: 'env-only' });
  });

  it('uses env vars ahead of the file, then falls back to the file', async () => {
    const backend = createLocalSecretBackend({
      vars: {
        ZEUS_SECRET_FILE: '/secrets.json',
        ZEUS_SECRET_ENV_FIRST: 'env-wins',
      },
      readFile: () =>
        JSON.stringify({
          'env:first': 'file-would-lose',
          'file:only': 'file-secret',
        }),
    });
    expect(await backend.resolve('env:first')).toEqual({ secret: 'env-wins' });
    expect(await backend.resolve('file:only')).toEqual({ secret: 'file-secret' });
  });
});

describe('resolveGrantedCredential', () => {
  const backend = new EnvSecretBackend({ vars: { ZEUS_SECRET_GRANTED_REF: 'yes' } });

  it('resolves a granted reference', async () => {
    const resolved = await resolveGrantedCredential(backend, ['granted:ref'], 'granted:ref');
    expect(resolved.secret).toBe('yes');
  });

  it('denies a reference that was not granted to this run', async () => {
    await expect(
      resolveGrantedCredential(backend, ['granted:ref'], 'granted:ref'),
    ).resolves.toBeTruthy();
    await expect(
      resolveGrantedCredential(backend, ['granted:ref'], 'other:ref'),
    ).rejects.toBeInstanceOf(CredentialError);
  });

  it('fails closed when the backend cannot resolve a granted reference', async () => {
    await expect(
      resolveGrantedCredential(backend, ['missing:ref'], 'missing:ref'),
    ).rejects.toBeInstanceOf(CredentialError);
  });
});
