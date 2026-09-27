import { execFileSync } from 'node:child_process';
import { createPublicKey, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { publishRootKey } from '../src/registry/signing.js';

const SCRIPT = fileURLToPath(new URL('../scripts/gen-rsk-key.mjs', import.meta.url));
const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function workDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zeus-keygen-'));
  dirs.push(dir);
  return dir;
}

function generate(target: string, env: Record<string, string> = {}): string {
  return execFileSync(process.execPath, [SCRIPT, target], { encoding: 'utf8', env: { ...process.env, ...env } });
}

// Each case spawns a cold Node process; the ceiling is a hang detector under the
// CPU contention this repo's suites share (see tests/verify-roster.test.ts).
describe('scripts/gen-rsk-key.mjs', { timeout: 90_000 }, () => {
  it('prints the value verifiers are told to pin, matching the shipped computation', () => {
    const dir = workDir();
    const out = generate(join(dir, 'rsk.pem'));

    const printed = out.match(/jwkThumbprint\s+(\S+)/)?.[1];
    const printedSpki = out.match(/spkiSha256\s+(\S+)/)?.[1];
    expect(printed, `no jwkThumbprint in keygen output:\n${out}`).toBeTruthy();
    expect(printedSpki, `no spkiSha256 in keygen output:\n${out}`).toBeTruthy();

    // Recomputed here from the file that was just written: the announcement is
    // worthless unless it is the same string the publication endpoint serves, and
    // that endpoint derives it through this function.
    const key = createPublicKey(readFileSync(join(dir, 'rsk.public.pem'), 'utf8'));
    const expected = publishRootKey('whatever-the-label-is', key);
    expect(printed).toBe(expected.jwkThumbprint);
    expect(printedSpki).toBe(expected.spkiSha256);
  });

  it('names the keyId it will be served under, and says so when it is unset', () => {
    const dir = workDir();
    expect(generate(join(dir, 'a.pem'))).toMatch(/ZEUS_RSK_KEY_ID \(currently: \(unset -> zeus-rsk-dev\)\)/);
    expect(generate(join(dir, 'b.pem'), { ZEUS_RSK_KEY_ID: 'zeus-rsk-2026-11' })).toMatch(/currently: zeus-rsk-2026-11/);
  });

  it('keeps the private key unreadable to the group and refuses to touch an existing pair', () => {
    const dir = workDir();
    const target = join(dir, 'mode.pem');
    generate(target);
    expect((statSync(target).mode & 0o777).toString(8)).toBe('600');
    expect((statSync(join(dir, 'mode.public.pem')).mode & 0o777).toString(8)).toBe('644');

    // Overwrite would silently invalidate every seal and every pin made from the
    // old key, so the refusal has to be loud and non-zero.
    let failure: { stderr?: string; status?: number } | undefined;
    try {
      generate(target);
    } catch (error) {
      failure = error as { stderr?: string; status?: number };
    }
    expect(failure?.status).toBe(1);
    expect(String(failure?.stderr)).toMatch(/refusing to overwrite existing key/);
    // The guard fires before anything is written, so the original stays intact.
    expect(existsSync(target)).toBe(true);
  });

  it('does not print a fingerprint for a key it refused to create', () => {
    const dir = workDir();
    const target = join(dir, 'pair.pem');
    writeFileSync(join(dir, 'pair.public.pem'), 'not a key, but the file exists\n');
    expect(() => generate(target)).toThrow();
    expect(existsSync(target)).toBe(false);
  });
});
