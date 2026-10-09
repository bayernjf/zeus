import { describe, expect, it } from 'vitest';
import { narrowSpawn } from '../src/mcp/isolation.js';
import { McpStdioClient } from '../src/mcp/stdio-client.js';

/**
 * S16 V2 (design-sandbox §5): stdio spawn narrowing. The manifest pins
 * command + fixed args + an env allow-list, so a spawned body inherits
 * nothing beyond the listed variables and a declared wall-clock bound is
 * enforced — the fail-closed principle of V1 carried onto the actual spawn.
 */

const MANIFEST = {
  fs: { read: ['/r'], write: [] },
  network: 'off' as const,
  resources: { maxWallSeconds: 5 },
  exec: { command: 'work-learn', args: ['--serve'], envAllowList: ['ZEUS_REALM_ROOT', 'HOME'] },
};

describe('S16 V2 narrowSpawn', () => {
  it('copies only the allow-listed env vars that exist, never the full environment', () => {
    const narrowed = narrowSpawn({
      manifest: MANIFEST,
      env: { ZEUS_REALM_ROOT: '/data/realm', HOME: '/Users/test', PATH: '/usr/bin', SECRET_TOKEN: 's3cret' },
    });
    expect(narrowed.command).toBe('work-learn');
    expect(narrowed.args).toEqual(['--serve']);
    expect(narrowed.env).toEqual({ ZEUS_REALM_ROOT: '/data/realm', HOME: '/Users/test' });
    expect(narrowed.envAllowList).toEqual(['ZEUS_REALM_ROOT', 'HOME']);
    // The caller's full environment never leaks into the narrowed spawn.
    expect(narrowed.env.SECRET_TOKEN).toBeUndefined();
    expect(narrowed.maxWallSeconds).toBe(5);
  });

  it('drops allow-listed vars that are absent instead of fabricating them', () => {
    const narrowed = narrowSpawn({ manifest: MANIFEST, env: { HOME: '/Users/test' } });
    expect(narrowed.env).toEqual({ HOME: '/Users/test' });
  });

  it('omits the wall-clock bound when the manifest declares none', () => {
    const narrowed = narrowSpawn({
      manifest: { ...MANIFEST, resources: {} },
      env: { HOME: '/Users/test' },
    });
    expect(narrowed.maxWallSeconds).toBeUndefined();
  });
});

describe('S16 V2 stdio client spawn narrowing', () => {
  it('passes only the allow-listed env to the child process', async () => {
    let captured: { command: string; args: string[]; options: { env: NodeJS.ProcessEnv } } | undefined;
    const spawnImpl = ((command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      captured = { command, args, options };
      // A fake child: nothing is ever read, close() must not throw.
      return {
        stdout: { on: () => undefined },
        stderr: { on: () => undefined },
        stdin: { end: () => undefined, write: () => undefined },
        kill: () => undefined,
        on: () => undefined,
      } as never;
    }) as unknown as typeof import('node:child_process').spawn;

    const client = new McpStdioClient({
      command: 'work-learn',
      args: ['--serve'],
      envAllowList: ['ZEUS_REALM_ROOT'],
      env: { ZEUS_REALM_ROOT: '/data/realm' },
      spawnImpl,
    });
    await client.initialize().catch(() => undefined);
    client.close();

    expect(captured?.command).toBe('work-learn');
    expect(captured?.args).toEqual(['--serve']);
    const env = captured?.options.env ?? {};
    expect(env.ZEUS_REALM_ROOT).toBe('/data/realm');
    // PATH and every other inherited variable are not passed through.
    expect(env.PATH).toBeUndefined();
  });
});
