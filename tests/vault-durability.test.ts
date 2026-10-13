/**
 * Mechanism-level probes for durability/TOCTOU hardening. A power loss or a
 * concurrent path swap cannot be staged deterministically on a real filesystem,
 * so these tests intercept node:fs/promises and assert the exact syscall
 * ordering and the fd-based read the hardening relies on.
 */
import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const probes = vi.hoisted(() => ({
  order: [] as string[],
  opens: [] as Array<{ path: unknown; flags: unknown }>,
  reads: [] as Array<'fd' | 'path'>,
}));

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (path: FileHandle | string, flags?: string | number, mode?: number) => {
      probes.opens.push({ path, flags });
      const handle = await actual.open(path as string, flags as string, mode);
      if (typeof handle.sync === 'function') {
        const sync = handle.sync.bind(handle);
        Object.assign(handle, {
          sync: async () => {
            if (flags === 'wx') probes.order.push('file-sync');
            else if (flags === 'r' && typeof path === 'string') probes.order.push('dir-sync');
            return sync();
          },
        });
      }
      return handle;
    },
    rename: async (a: string, b: string) => {
      probes.order.push('rename');
      return actual.rename(a, b);
    },
    readFile: async (target: FileHandle | string | Buffer, ...rest: unknown[]) => {
      probes.reads.push(typeof target === 'string' || Buffer.isBuffer(target) ? 'path' : 'fd');
      return (actual.readFile as (...args: unknown[]) => Promise<Buffer>)(target, ...rest);
    },
  };
});

let sandbox: string;

afterEach(async () => {
  if (sandbox) await rm(sandbox, { recursive: true, force: true });
  probes.order.length = 0;
  probes.opens.length = 0;
  probes.reads.length = 0;
});

describe('writeFileAtomic durability ordering', () => {
  it('fsyncs the temp file, renames, then fsyncs the parent directory', async () => {
    sandbox = await realpath(await mkdtemp(join(tmpdir(), 'zeus-vdur-')));
    const { writeFileAtomic } = await import('../src/vault/fs.js');
    const file = join(sandbox, 'sealed.json');
    await writeFileAtomic(file, '{}');
    expect(probes.order).toEqual(['file-sync', 'rename', 'dir-sync']);
    const dirOpen = probes.opens.find(entry => entry.flags === 'r');
    expect(dirOpen?.path).toBe(join(sandbox));
  });
});

describe('whitelisted file reads', () => {
  it('opens the resolved file refusing a trailing symlink and reads via the fd', async () => {
    sandbox = await realpath(await mkdtemp(join(tmpdir(), 'zeus-vread-')));
    await writeFile(join(sandbox, 'kernel.json'), '{"version":1}\n');
    const { inventoryFromFiles } = await import('../src/vault/inventory.js');
    const entries = await inventoryFromFiles({ root: sandbox, files: ['kernel.json'] }).entries();
    expect(entries).toHaveLength(1);
    const opened = probes.opens.find(entry => typeof entry.path === 'string' && String(entry.path).endsWith('kernel.json'));
    expect(opened, 'the whitelisted file is opened explicitly').toBeDefined();
    expect(typeof opened!.flags).toBe('number');
    expect((opened!.flags as number) & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
    expect(probes.reads).toContain('fd');
    expect(probes.reads).not.toContain('path');
  });
});
