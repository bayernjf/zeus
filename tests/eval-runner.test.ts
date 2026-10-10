import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// design-evals V3 (tech map S7): the offline runner's baseline gate must fail
// the process (exit 1) when any family's blocked count grows versus the pinned
// baseline, stay green on warn-only regressions, and refuse to start (exit 2)
// when no baseline file exists. The positive block semantics (1 > 0) are
// covered by evals-score.test.ts; this file pins the script-level exit-code
// wiring. Requires the compiled artifact (`npm run build` first), same as
// smoke:core, because the runner exercises dist/*.
const SCRIPT = fileURLToPath(new URL('../scripts/eval-run.mjs', import.meta.url));
// A single, deterministic, loopback-only case keeps each spawn near-instant
// (~0.3s); its report carries two families (decision + escalation checks).
const CASE_ID = 'decision/unanimous-approve';

interface FamilyMetrics { total: number; passed: number; blocked: number }
interface EvalReport {
  caseCount: number;
  passed: number;
  failed: number;
  blocked: number;
  warned: number;
  byFamily: Record<string, FamilyMetrics>;
}

function runScript(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`eval-run.mjs timed out: ${args.join(' ')}`));
    }, 30_000);
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));
    child.on('close', status => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
    child.on('error', reject);
  });
}

describe('eval-run.mjs baseline gate (S7 V3)', () => {
  let dir = '';
  let greenReport: EvalReport;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'zeus-eval-gate-'));
    const firstOut = join(dir, 'first.json');
    const r = await runScript(['--filter', CASE_ID, '--out', firstOut]);
    // The fixed world must be green before any gate behaviour is meaningful.
    expect(r.status, r.stdout + r.stderr).toBe(0);
    greenReport = JSON.parse(readFileSync(firstOut, 'utf8')).report as EvalReport;
  });

  afterAll(() => {
    // tmpdir is OS-managed; nothing to clean, but keep the contract explicit.
  });

  /** Write a baseline built from the green report, with one tweak applied. */
  function writeBaseline(name: string, tweak: (report: EvalReport) => void): string {
    const report: EvalReport = JSON.parse(JSON.stringify(greenReport));
    tweak(report);
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify({ pinnedAt: 'test-fixture', report }, null, 2));
    return path;
  }

  async function runAgainst(baseline: string, outName: string) {
    return runScript(['--filter', CASE_ID, '--baseline-file', baseline, '--out', join(dir, outName)]);
  }

  it('exits 0 and reports no regression against an identical baseline', async () => {
    const baseline = writeBaseline('green.json', () => {});
    const r = await runAgainst(baseline, 'green-run.json');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('no regression vs baseline');
  });

  it('exits 1 on a block-severity regression (blocked count grew)', async () => {
    // The fixed world always reports 0 blocked, so a block regression cannot
    // occur naturally here. Pin the baseline one below zero so the current run
    // (0) regresses versus it; the pure-function direction (1 > 0) is covered
    // in evals-score.test.ts.
    const baseline = writeBaseline('block.json', report => {
      report.byFamily.decision!.blocked = -1;
    });
    const r = await runAgainst(baseline, 'block-run.json');
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toContain('[block]');
    expect(r.stdout).toContain('decision.blocked');
  });

  it('stays exit 0 on a warn-only regression (passed shrank, blocked flat)', async () => {
    const baseline = writeBaseline('warn.json', report => {
      report.byFamily.decision!.passed = 99;
    });
    const r = await runAgainst(baseline, 'warn-run.json');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('[warn]');
    expect(r.stdout).toContain('decision.passed');
  });

  it('exits 2 (cannot start) when the baseline file is missing', async () => {
    const r = await runScript([
      '--filter', CASE_ID,
      '--baseline-file', join(dir, 'does-not-exist.json'),
      '--out', join(dir, 'missing-run.json'),
    ]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('no baseline file');
  });
});
