import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { runChatCli } from '../src/chat/cli.js';

/**
 * The chat shell keeps one booted kernel across many turns. Its defects are in
 * the wiring (boot once, REPL loop, plan-only fan-out, no write-back), so the
 * cases below drive the real thing: a kernel booted by the CLI itself, a real
 * realm directory the shell must never write into, and a skill catalogue seeded
 * by explicit --spec files (no vassal card fetch, so the tests are independent
 * of the local outbound-network environment).
 *
 * The shell's core promise is plan-only: every recognized sentence goes out
 * with mode 'plan', no execution delegation is ever minted, and the realm is
 * never written. The tests assert both directly.
 */

const tempDirs: string[] = [];
function tempRoot(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `zeus-chat-${label}-`));
  tempDirs.push(dir);
  return dir;
}

/** Writes a skill spec file (object or array); returns its path. */
function writeSpec(dir: string, spec: Record<string, unknown> | Record<string, unknown>[]): string {
  const id = Array.isArray(spec) ? 'bundle' : String(spec.id);
  const path = join(dir, `skill-${id}.json`);
  writeFileSync(path, JSON.stringify(spec));
  return path;
}

function specPathForSkills(dir: string): string {
  return writeSpec(dir, [
    {
      id: 'deployment-health',
      name: 'Deployment Health',
      description: 'check a deployment for health',
      version: '1.0.0',
      tags: [],
    },
    {
      id: 'research',
      name: 'Deep Research',
      description: 'multi-source research',
      version: '1.0.0',
      tags: [],
    },
  ]);
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...extra } as NodeJS.ProcessEnv;
}

type Script = {
  argv: string[];
  /** Lines fed to the REPL after boot. The last one should end the loop. */
  lines: string[];
  env?: NodeJS.ProcessEnv;
};

async function driveChat(script: Script): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  let err = '';
  stdout.on('data', chunk => (out += chunk.toString()));
  stderr.on('data', chunk => (err += chunk.toString()));
  const done = runChatCli(script.argv, {
    stdin,
    stdout,
    stderr,
    env: script.env ?? cleanEnv(),
  });
  for (const line of script.lines) stdin.write(`${line}\n`);
  const result = await done;
  return { code: result.code, stdout: result.stdout || out, stderr: result.stderr || err };
}

describe('npm run chat', () => {
  it('prints usage and exits 0 on --help', async () => {
    const result = await driveChat({ argv: ['--help'], lines: [] });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('usage: npm run chat');
    expect(result.stdout).toContain('/exit | /quit');
  });

  it('rejects unknown options before booting the kernel', async () => {
    const result = await driveChat({ argv: ['--bogus', 'x'], lines: [] });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('unknown option: --bogus');
  });

  it('runs multiple turns, each plan-only, and never writes to the realm', async () => {
    const root = tempRoot('multi-turn');
    const specDir = tempRoot('multi-turn-spec');
    const spec = specPathForSkills(specDir);
    const before = readdirSync(root);
    const result = await driveChat({
      argv: ['--root', root, '--spec', spec, '--state', 'none'],
      lines: ['check the deployment health', 'research the quarterly numbers', '', '/exit'],
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('bye.');
    // Both sentences were recognized and planned.
    expect(result.stdout).toContain('skill: deployment-health');
    expect(result.stdout).toContain('skill: research');
    // Every turn explicitly says plan-only; no turn ever reports execute mode.
    const modeLines = result.stdout.split('\n').filter(line => line.includes('mode:'));
    expect(modeLines.length).toBeGreaterThanOrEqual(2);
    for (const line of modeLines) expect(line).toContain('plan');
    expect(result.stdout).not.toMatch(/mode:\s+execute/i);
    // The realm directory was not written into (chat never calls store.write).
    expect(readdirSync(root)).toEqual(before);
  });

  it('survives an unrecognized sentence and keeps the loop alive', async () => {
    const root = tempRoot('unrecognized');
    const specDir = tempRoot('unrecognized-spec');
    const spec = specPathForSkills(specDir);
    const result = await driveChat({
      argv: ['--root', root, '--spec', spec, '--state', 'none'],
      lines: ['zzzqqq the purple elephant dances at midnight', '/exit'],
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('no intent');
    expect(result.stdout).toContain('ranked candidates');
    expect(result.stdout).toContain('bye.');
  });

  it('/help works inside the loop', async () => {
    const root = tempRoot('help');
    const specDir = tempRoot('help-spec');
    const spec = specPathForSkills(specDir);
    const result = await driveChat({
      argv: ['--root', root, '--spec', spec, '--state', 'none'],
      lines: ['/help', '/exit'],
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('usage: npm run chat');
    expect(result.stdout).toContain('/exit | /quit');
  });

  it('exits 2 with guidance when no writable realm is mounted', async () => {
    const result = await driveChat({ argv: ['--state', 'none'], lines: [] });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('no writable personal realm');
  });
});
