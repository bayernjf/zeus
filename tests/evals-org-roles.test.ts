import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// D9-1: the organization-role scenario suite is a third independent eval gate.
// It narrates the content (D0) / listing (D3) / after-sales (D2) roles and pins
// its own baseline, so the primary `evals/baseline.json` gate stays unchanged.
// Requires the compiled artifact (`npm run build` first), same as
// eval-runner.test.ts, because the runner scores through dist/*.
const SCRIPT = fileURLToPath(new URL('../scripts/eval-run.mjs', import.meta.url));
const SUITE = 'evals/cases/org-roles.mjs';
const BASELINE = fileURLToPath(new URL('../evals/baseline-org-roles.json', import.meta.url));

interface EvalReport {
  caseCount: number;
  passed: number;
  failed: number;
  blocked: number;
  warned: number;
  byFamily: Record<string, { total: number; passed: number; blocked: number }>;
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

describe('org-roles scenario suite (D9-1)', () => {
  it('is green against its pinned baseline and reports all six role scenarios', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zeus-org-roles-'));
    const out = join(dir, 'org.json');
    const r = await runScript(['--suite-file', SUITE, '--baseline-file', BASELINE, '--baseline', '--out', out]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('no regression vs baseline');

    const report = JSON.parse(readFileSync(out, 'utf8')).report as EvalReport;
    expect(report.caseCount).toBe(6);
    expect(report.failed).toBe(0);
    expect(report.blocked).toBe(0);
    // The suite must actually exercise all four governance families it claims.
    for (const family of ['decision', 'escalation', 'selection', 'evidence', 'artifacts']) {
      expect(report.byFamily[family], family).toBeDefined();
    }
  });

  it('exits 1 on a block regression in the org-roles gate', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zeus-org-roles-block-'));
    const baseline = join(dir, 'block.json');
    const body = JSON.parse(readFileSync(BASELINE, 'utf8')) as { pinnedAt: string; report: EvalReport };
    const regressed: EvalReport = JSON.parse(JSON.stringify(body.report));
    // The green world reports 0 blocked, so pin one below zero to force a
    // block-severity regression in this suite and prove the gate wiring.
    regressed.byFamily.decision!.blocked = -1;
    writeFileSync(baseline, JSON.stringify({ pinnedAt: 'test-fixture', report: regressed }, null, 2));

    const r = await runScript(['--suite-file', SUITE, '--baseline-file', baseline, '--baseline', '--out', join(dir, 'block-run.json')]);
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toContain('[block]');
    expect(r.stdout).toContain('decision.blocked');
  });
});
