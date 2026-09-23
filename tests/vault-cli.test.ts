import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { runVaultCli, VAULT_EXIT } from '../src/vault/cli.js';

const PASSPHRASE = 'correct-horse-battery-staple';
const SECRET_A = '# Alpha\nunique-secret-token-AAA\n';
const SECRET_B = 'Bravo content BBB\n';
const FIXED_NOW = '2026-09-23T01:02:03.000Z';

let work: string;
let root: string;
let outDir: string;
let mapPath: string;

async function run(argv: string[], env: Record<string, string | undefined> = { ZEUS_VAULT_PASSPHRASE: PASSPHRASE }) {
  return runVaultCli(argv, { env, now: () => new Date(FIXED_NOW) });
}

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'zeus-vault-cli-'));
  root = join(work, 'realm');
  outDir = join(work, 'backups');
  mapPath = join(outDir, 'manifest.map.json');
  await mkdir(join(root, 'sub'), { recursive: true });
  await writeFile(join(root, 'a.md'), SECRET_A);
  await writeFile(join(root, 'sub', 'b.txt'), SECRET_B);
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

describe('vault CLI: build + check (manifest-only, L0)', () => {
  it('builds a sealed map and checks a healthy realm as recoverable (exit 0)', async () => {
    const built = await run(['build', '--root', root, '--out', mapPath]);
    expect(built.code).toBe(VAULT_EXIT.ok);
    const envelope = JSON.parse(await readFile(mapPath, 'utf8'));
    expect(envelope.format).toBe('zeus-treasure-map');
    expect(envelope.ciphertext).toBeTruthy();

    const checked = await run(['check', '--map', mapPath]);
    expect(checked.code).toBe(VAULT_EXIT.ok);
    expect(checked.stdout).toContain('recoverable:      true');
    expect(checked.stdout).toContain('ok:               2');
  });

  it('emits machine-readable JSON with --json', async () => {
    await run(['build', '--root', root, '--out', mapPath]);
    const checked = await run(['check', '--map', mapPath, '--json']);
    expect(checked.code).toBe(VAULT_EXIT.ok);
    const parsed = JSON.parse(checked.stdout);
    expect(parsed.command).toBe('check');
    expect(parsed.report.recoverable).toBe(true);
    expect(parsed.report.total).toBe(2);
  });

  it('reports changed items and exits 2 after a file is modified', async () => {
    await run(['build', '--root', root, '--out', mapPath]);
    await writeFile(join(root, 'a.md'), '# Alpha\nTAMPERED CONTENT\n');
    const checked = await run(['check', '--map', mapPath]);
    expect(checked.code).toBe(VAULT_EXIT.drift);
    expect(checked.stdout).toContain('changed:          1');
    expect(checked.stdout).toContain('- a.md');
    expect(checked.stdout).toContain('recoverable:      false');
  });

  it('reports an unexpected extra file as drift (digest mismatch, exit 2)', async () => {
    await run(['build', '--root', root, '--out', mapPath]);
    await writeFile(join(root, 'new.md'), 'newcomer\n');
    const checked = await run(['check', '--map', mapPath]);
    expect(checked.code).toBe(VAULT_EXIT.drift);
    expect(checked.stdout).toContain('unexpected:       1');
    expect(checked.stdout).toContain('- new.md');
  });

  it('exits 3 when the root is unreachable', async () => {
    await run(['build', '--root', root, '--out', mapPath]);
    await rm(root, { recursive: true, force: true });
    const checked = await run(['check', '--map', mapPath]);
    expect(checked.code).toBe(VAULT_EXIT.unreachable);
    expect(checked.stdout).toContain('root reachable:   false');
    expect(checked.stdout).toContain('missing:          2');
  });
});

describe('vault CLI: backup + restore (full bundle, L1)', () => {
  it('packs map+bundle and restores a destroyed realm into a new target (exit 0)', async () => {
    const backup = await run(['backup', '--root', root, '--out-dir', outDir]);
    expect(backup.code).toBe(VAULT_EXIT.ok);
    const files = backup.stdout;
    expect(files).toMatch(/\.map\.json/);
    expect(files).toMatch(/\.bundle\.json/);

    // Disaster: one file changed, one deleted.
    await writeFile(join(root, 'a.md'), 'destroyed\n');
    await rm(join(root, 'sub', 'b.txt'), { force: true });
    const mapFile = backupPath(backup, '.map.json');
    const drifted = await run(['check', '--map', mapFile]);
    expect(drifted.code).toBe(VAULT_EXIT.drift);

    // Recover to a fresh location using map + bundle.
    const target = join(work, 'restored');
    const restore = await run([
      'restore',
      '--map', mapFile,
      '--bundle', backupPath(backup, '.bundle.json'),
      '--target', target,
    ]);
    expect(restore.code).toBe(VAULT_EXIT.ok);
    expect(restore.stdout).toContain('recoverable:      true');
    expect(await readFile(join(target, 'a.md'), 'utf8')).toBe(SECRET_A);
    expect(await readFile(join(target, 'sub', 'b.txt'), 'utf8')).toBe(SECRET_B);
  });

  it('refuses a bundle that does not match the map reference (exit 1)', async () => {
    await run(['backup', '--root', root, '--out-dir', outDir, '--name', 'good']);
    const other = join(work, 'other');
    await mkdir(other, { recursive: true });
    await writeFile(join(other, 'x.md'), 'totally different realm content\n');
    await run(['backup', '--root', other, '--out-dir', outDir, '--name', 'evil']);
    const restore = await run([
      'restore',
      '--map', join(outDir, 'good.map.json'),
      '--bundle', join(outDir, 'evil.bundle.json'),
      '--target', join(work, 'restored'),
    ]);
    expect(restore.code).toBe(VAULT_EXIT.error);
    expect(restore.stderr).toContain('does not match');
  });
});

describe('vault CLI: key handling and usage errors', () => {
  it('fails with exit 1 on a wrong passphrase', async () => {
    await run(['build', '--root', root, '--out', mapPath]);
    const checked = await runVaultCli(['check', '--map', mapPath], {
      env: { ZEUS_VAULT_PASSPHRASE: 'wrong-passphrase' },
    });
    expect(checked.code).toBe(VAULT_EXIT.error);
    expect(checked.stderr).toContain('key error');
  });

  it('fails with exit 1 when no key is provided', async () => {
    const built = await runVaultCli(['build', '--root', root, '--out', mapPath], { env: {} });
    expect(built.code).toBe(VAULT_EXIT.error);
    expect(built.stderr).toContain('no vault key');
  });

  it('accepts a raw 32-byte hex key file', async () => {
    const keyPath = join(work, 'vault.key');
    await writeFile(keyPath, randomBytes(32).toString('hex'));
    const built = await run(['build', '--root', root, '--out', mapPath, '--key-file', keyPath]);
    expect(built.code).toBe(VAULT_EXIT.ok);
    const checked = await run(['check', '--map', mapPath, '--key-file', keyPath]);
    expect(checked.code).toBe(VAULT_EXIT.ok);
  });

  it('rejects a malformed key file', async () => {
    const keyPath = join(work, 'bad.key');
    await writeFile(keyPath, 'not-a-key');
    const built = await run(['build', '--root', root, '--out', mapPath, '--key-file', keyPath]);
    expect(built.code).toBe(VAULT_EXIT.error);
    expect(built.stderr).toContain('32 raw bytes or 64 hex');
  });

  it('rejects unknown commands and missing required flags (exit 1)', async () => {
    expect((await run(['frobnicate'])).code).toBe(VAULT_EXIT.error);
    expect((await run(['build', '--root', root])).code).toBe(VAULT_EXIT.error);
    expect((await run(['restore', '--map', 'a', '--bundle', 'b'])).code).toBe(VAULT_EXIT.error);
  });
});

/** Extract a deterministic backup file path from CLI stdout (fixed now). */
function backupPath(result: { stdout: string }, suffix: '.map.json' | '.bundle.json'): string {
  const line = result.stdout.split('\n').find(l => l.includes(suffix));
  if (!line) throw new Error(`no ${suffix} path in stdout: ${result.stdout}`);
  const match = line.match(/\S+\.json/);
  if (!match) throw new Error(`cannot parse path from: ${line}`);
  return match[0];
}
