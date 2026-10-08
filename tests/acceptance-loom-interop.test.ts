import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../scripts/acceptance-loom-interop.mjs', import.meta.url));

function run(env: Record<string, string>, args: string[] = []) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 30_000,
  });
  return { status: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

// The end-to-end path is proven by scripts/acceptance-loom-interop.mjs against
// a running loom + a running Zeus (checklist row A2); what must not rot in CI
// is the contract around it: which problems are configuration (exit 2, and
// named) versus a failed acceptance (exit 1), and that no credential leaks.
// Each case spawns a cold Node process, so the suite timeout follows the
// acceptance-real-fanout precedent.
describe('scripts/acceptance-loom-interop.mjs', { timeout: 90_000 }, () => {
  it('treats missing configuration as a usage error and names the variable', () => {
    const noKernel = run({ KERNEL_URL: '', ZEUS_INTERNAL_TOKEN: 'x', CARD_URL: 'https://a/b', AGENT_TOKEN: 'y' });
    expect(noKernel.status).toBe(2);
    expect(noKernel.out).toMatch(/KERNEL_URL is required/);

    const noToken = run({ KERNEL_URL: 'http://127.0.0.1:8799', ZEUS_INTERNAL_TOKEN: '', CARD_URL: 'https://a/b', AGENT_TOKEN: 'y' });
    expect(noToken.status).toBe(2);
    expect(noToken.out).toMatch(/ZEUS_INTERNAL_TOKEN is required/);

    const noCard = run({ KERNEL_URL: 'http://127.0.0.1:8799', ZEUS_INTERNAL_TOKEN: 'x', CARD_URL: '', AGENT_TOKEN: 'y' });
    expect(noCard.status).toBe(2);
    expect(noCard.out).toMatch(/CARD_URL \(or LOOM_URL\) is required/);

    const noAgent = run({ KERNEL_URL: 'http://127.0.0.1:8799', ZEUS_INTERNAL_TOKEN: 'x', CARD_URL: 'https://a/b', AGENT_TOKEN: '' });
    expect(noAgent.status).toBe(2);
    expect(noAgent.out).toMatch(/AGENT_TOKEN is required/);
  });

  it('never echoes the loom credential on a configuration failure', () => {
    const secret = 'loom-secret-probe-value';
    const out = run({ KERNEL_URL: '', ZEUS_INTERNAL_TOKEN: 'x', CARD_URL: 'https://a/b', AGENT_TOKEN: secret });
    expect(out.status).toBe(2);
    expect(out.out).not.toContain(secret);
  });

  it('accepts LOOM_URL and derives the card from it', () => {
    // With LOOM_URL set and CARD_URL omitted the script proceeds past config
    // (it then fails at the network step with exit 1, not 2) — the derivation
    // is what we pin here.
    const out = run({ KERNEL_URL: 'http://127.0.0.1:8799', ZEUS_INTERNAL_TOKEN: 'x', LOOM_URL: 'http://127.0.0.1:8000', AGENT_TOKEN: 'y' });
    expect(out.status).toBe(1);
    expect(out.out).toMatch(/card: +http:\/\/127\.0\.0\.1:8000\/\.well-known\/agent-card\.json/);
  });
});
