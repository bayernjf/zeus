import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { bootKernel } from '../src/state/boot.js';

async function freshRoot(): Promise<string> {
  const root = join(tmpdir(), `zeus-realm-${crypto.randomUUID()}`);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'note.md'), '# hello world\n', 'utf8');
  return root;
}

describe('G4 realm connection persistence', () => {
  it('connects a realm root on boot, persists it, and reconnects after restart', async () => {
    const stateFile = join(tmpdir(), `zeus-state-${crypto.randomUUID()}.json`);
    const root = await realpath(await freshRoot());

    const first = await bootKernel({ stateFile, realmRoots: [root] });
    const connection = first.realmStore!.connections()[0];
    expect(connection.root).toBe(root);
    expect((await first.realmStore!.search(connection.realmId, { text: 'hello' }))).toHaveLength(1);
    await first.saveState();

    const restarted = await bootKernel({ stateFile });
    const restored = restarted.realmStore!.connections()[0];
    expect(restored.root).toBe(root);
    expect(restored.realmId).toBe(connection.realmId);
    expect((await restarted.realmStore!.search(restored.realmId, { text: 'world' }))).toHaveLength(1);
  });

  it('fails boot when a supplied root cannot be connected', async () => {
    const stateFile = join(tmpdir(), `zeus-state-${crypto.randomUUID()}.json`);
    await expect(bootKernel({ stateFile, realmRoots: [join(tmpdir(), `no-such-${crypto.randomUUID()}`)] })).rejects.toThrow();
  });
});
