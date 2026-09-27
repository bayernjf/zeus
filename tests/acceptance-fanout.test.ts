import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../scripts/acceptance-real-fanout.mjs', import.meta.url));

function run(env: Record<string, string>, args: string[] = []) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 30_000,
  });
  return { status: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

// The end-to-end path is proven by scripts/acceptance-real-fanout.mjs against a
// local kernel and a stub agent (see handoff Active work 64); what must not rot
// in CI is the contract around it: which problems are configuration (exit 2, and
// named) versus a failed acceptance (exit 1), and that no credential leaks.
// Each case spawns a cold Node process (measured here: 4-10s per case, and this
// repo has recorded ~10x slowdowns when other suites share the CPU), so the
// global 20s ceiling is a hang detector that would misfire under contention.
// Raised for this file only, same treatment as tests/verify-roster.test.ts.
describe('scripts/acceptance-real-fanout.mjs', { timeout: 90_000 }, () => {
  it('treats missing configuration as a usage error and names the variable', () => {
    const missing = run({ KERNEL_URL: '', ZEUS_INTERNAL_TOKEN: 'x', CARD_URL: 'https://a/b' });
    expect(missing.status).toBe(2);
    expect(missing.out).toMatch(/KERNEL_URL is required/);

    const badUrl = run({ KERNEL_URL: 'not-a-url', ZEUS_INTERNAL_TOKEN: 'x', CARD_URL: 'https://a/b' });
    expect(badUrl.status).toBe(2);
    expect(badUrl.out).toMatch(/not a valid URL/);

    const noCard = run({ KERNEL_URL: 'http://127.0.0.1:9', ZEUS_INTERNAL_TOKEN: 'x', CARD_URL: '' });
    expect(noCard.status).toBe(2);
    expect(noCard.out).toMatch(/CARD_URL is required/);
  });

  it('prints usage on request without touching the network', () => {
    const help = run({ KERNEL_URL: 'http://127.0.0.1:1', ZEUS_INTERNAL_TOKEN: 'secret-value', CARD_URL: 'https://a/b' }, ['--help']);
    expect(help.status).toBe(0);
    expect(help.out).toMatch(/usage:/i);
    expect(help.out).not.toContain('secret-value');
  });

  it('reports an unreachable target as a failed step, not a crash', () => {
    const result = run({
      KERNEL_URL: 'http://127.0.0.1:9',
      ZEUS_INTERNAL_TOKEN: 'never-sent-value',
      CARD_URL: 'http://127.0.0.1:9/api/a2a/agent-card',
    });
    expect(result.status).toBe(1);
    expect(result.out).toMatch(/cannot reach http:\/\/127\.0\.0\.1:9/);
    expect(result.out).toMatch(/0\/1 steps passed|steps passed/);
    expect(result.out).not.toContain('never-sent-value');
  });
});
