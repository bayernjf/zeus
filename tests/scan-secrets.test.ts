import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = new URL('../scripts/scan-secrets.mjs', import.meta.url).pathname;

function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zeus-secret-scan-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

function runScanner(dir: string): { status: number; stderr: string } {
  try {
    return { status: 0, stderr: execFileSync('node', [SCRIPT], { cwd: dir, encoding: 'utf-8' }) };
  } catch (error) {
    const e = error as { status?: number; stderr?: string };
    return { status: e.status ?? -1, stderr: e.stderr ?? '' };
  }
}

describe('scan-secrets (tracked-file CLI)', () => {
  it('M-08: flags an OpenAI project key (sk-proj-)', () => {
    const dir = gitRepo();
    const file = join(dir, 'notes.txt');
    writeFileSync(file, `key = sk-proj-${'A'.repeat(48)}\n`);
    execFileSync('git', ['add', 'notes.txt'], { cwd: dir });
    const { status, stderr } = runScanner(dir);
    expect(status).toBe(1);
    expect(stderr).toMatch(/OpenAI/);
  });

  it('M-08: scans tracked files whose names contain non-ASCII characters instead of silently skipping them', () => {
    const dir = gitRepo();
    // git ls-files quotes this path as "\345\257\206..." under the default
    // core.quotePath; a scanner that trusts the quoted path never opens it.
    const name = '密钥配置.txt';
    writeFileSync(join(dir, name), `token=ghp_${'a'.repeat(36)}\n`);
    execFileSync('git', ['add', name], { cwd: dir });
    const { status, stderr } = runScanner(dir);
    expect(status).toBe(1);
    expect(stderr).toMatch(/GitHub personal access token/);
  });

  it('exits clean on a repository without credential shapes', () => {
    const dir = gitRepo();
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'main.ts'), "export const x = 'hello';\n");
    execFileSync('git', ['add', 'src/main.ts'], { cwd: dir });
    const { status, stderr } = runScanner(dir);
    expect(status).toBe(0);
    expect(stderr).toMatch(/clean/);
  });
});
