import { describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { bootRuntime } from '../src/state/boot.js';

async function freshRoot(): Promise<string> {
  const root = join(tmpdir(), `zeus-dataDomain-${crypto.randomUUID()}`);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'note.md'), '# hello world\n', 'utf8');
  return root;
}

describe('G4 dataDomain connection persistence', () => {
  it('connects a dataDomain root on boot, persists it, and reconnects after restart', async () => {
    const stateFile = join(tmpdir(), `zeus-state-${crypto.randomUUID()}.json`);
    const root = await realpath(await freshRoot());

    const first = await bootRuntime({ stateFile, dataDomainRoots: [root] });
    const connection = first.dataDomainStore!.connections()[0]!;
    expect(connection.root).toBe(root);
    expect((await first.dataDomainStore!.search(connection.dataDomainId, { text: 'hello' }))).toHaveLength(1);
    await first.saveState();

    const restarted = await bootRuntime({ stateFile });
    const restored = restarted.dataDomainStore!.connections()[0]!;
    expect(restored.root).toBe(root);
    expect(restored.dataDomainId).toBe(connection.dataDomainId);
    expect((await restarted.dataDomainStore!.search(restored.dataDomainId, { text: 'world' }))).toHaveLength(1);
  });

  it('persists issue/revoke of a domain grant without waiting for shutdown', async () => {
    const stateFile = join(tmpdir(), `zeus-state-${crypto.randomUUID()}.json`);

    const first = await bootRuntime({ stateFile });
    const issued = first.domainGrants!.issue({
      subject: 'jev',
      dataDomainId: 'dataDomain-dept',
      access: 'read',
      grantedBy: 'operator',
      nonce: 'n1',
    });
    expect(first.domainGrants!.list()).toHaveLength(1);

    // No saveState() before the revoke: the registry pushes governance changes to
    // disk itself, so an abrupt exit between here and a graceful shutdown cannot
    // resurrect the revoked grant.
    first.domainGrants!.revoke(issued.grantId);
    await vi.waitFor(async () => {
      const raw = JSON.parse(await readFile(stateFile, 'utf8')) as {
        domainGrants?: { grants: unknown[]; spentNonces: string[] };
      };
      expect(raw.domainGrants?.grants).toEqual([]);
      expect(raw.domainGrants?.spentNonces).toContain('n1');
    });

    const restarted = await bootRuntime({ stateFile });
    expect(restarted.domainGrants!.list()).toHaveLength(0);
    // The nonce stays spent after restart, so revoking cannot be used to mint a
    // fresh credential reusing the revoked one's nonce.
    expect(() => restarted.domainGrants!.issue({
      subject: 'jev',
      dataDomainId: 'dataDomain-dept',
      access: 'read',
      grantedBy: 'operator',
      nonce: 'n1',
    })).toThrow(/already used/);
  });

  it('fails boot when a supplied root cannot be connected', async () => {
    const stateFile = join(tmpdir(), `zeus-state-${crypto.randomUUID()}.json`);
    await expect(bootRuntime({ stateFile, dataDomainRoots: [join(tmpdir(), `no-such-${crypto.randomUUID()}`)] })).rejects.toThrow();
  });
});
