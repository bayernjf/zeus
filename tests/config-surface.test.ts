import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The environment surface is a contract with the operator, and both directions of
 * it drift: a variable can be read by the process and appear in no document (the
 * operator cannot reach a feature that exists - ZEUS_MAX_CONCURRENT_PER_VASSAL
 * shipped that way in the #9 batch), or it can be documented while nothing reads
 * it (worse, because it teaches someone to set a knob with no effect).
 *
 * This suite is the executable version of the sweep first run by hand during
 * review v0.17 (deferred #26).
 */

const ENV_NAME = /ZEUS_[A-Z0-9_]+/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|mjs)$/.test(entry) ? [path] : [];
  });
}

/** Names the process reads statically: `env.ZEUS_X` / `process.env.ZEUS_X`. */
function readInCode(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of [...sourceFiles('src'), ...sourceFiles('scripts')]) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/\b(?:process\.)?env\.(ZEUS_[A-Z0-9_]+)/g)) {
      if (!found.has(match[1])) found.set(match[1], file);
    }
  }
  return found;
}

/**
 * Read through a computed name rather than a literal, so the regex above cannot
 * see it. Each entry needs a reason: an unexplained addition here means the guard
 * is being widened instead of answered.
 */
const DYNAMIC_READS: Record<string, string> = {
  // src/vault/cli.ts:118 `env[envName]` - the name itself is operator-chosen via
  // --passphrase-env, defaulting to this one (src/vault/cli.ts:56).
  ZEUS_VAULT_PASSPHRASE: 'src/vault/cli.ts',
};

function documented(name: string): string[] {
  const hits: string[] = [];
  const envExample = readFileSync('.env.example', 'utf8');
  if (new RegExp(`\\b${name}\\b`).test(envExample)) hits.push('.env.example');
  const deployment = readFileSync('docs/deployment.md', 'utf8');
  if (new RegExp(`\`?${name}\`?`).test(deployment)) hits.push('docs/deployment.md');
  return hits;
}

/** The §2 table's variable cells: rows that start with a backticked ZEUS name. */
function deploymentTableVars(): Set<string> {
  const rows = readFileSync('docs/deployment.md', 'utf8').split('\n');
  const vars = new Set<string>();
  for (const row of rows) {
    if (!/^\|\s*`ZEUS_[A-Z0-9_]+`/.test(row)) continue;
    const firstCell = row.split(/(?<!\\)\|/)[1] ?? '';
    for (const match of firstCell.matchAll(/`(ZEUS_[A-Z0-9_]+)`/g)) vars.add(match[1]);
  }
  return vars;
}

function envExampleVars(): Set<string> {
  const names = readFileSync('.env.example', 'utf8').match(ENV_NAME) ?? [];
  return new Set(names);
}

describe('environment configuration surface', () => {
  const read = readInCode();
  const all = new Set([...read.keys(), ...Object.keys(DYNAMIC_READS)]);

  it('finds the reads at all, so an empty set cannot pass by accident', () => {
    // Positive control: a test whose two sets are both empty passes silently and
    // then guards nothing.
    expect(read.size).toBeGreaterThanOrEqual(20);
    expect(envExampleVars().size).toBeGreaterThanOrEqual(10);
  });

  it('documents every variable the process reads', () => {
    const undocumented = [...all]
      .sort()
      .filter(name => documented(name).length === 0)
      .map(name => `${name} (read in ${read.get(name) ?? DYNAMIC_READS[name]})`);
    expect(undocumented, `variables read but in neither .env.example nor deployment.md:\n${undocumented.join('\n')}`).toEqual([]);
  });

  it('has no documented knob that nothing reads', () => {
    const stale = [...envExampleVars()]
      .filter(name => !all.has(name))
      .map(name => `${name} (.env.example)`);
    const table = [...deploymentTableVars()]
      .filter(name => !all.has(name))
      .map(name => `${name} (deployment.md §2 table row)`);
    expect([...stale, ...table], `documented but never read - each one teaches an operator to set something with no effect:\n${[...stale, ...table].join('\n')}`).toEqual([]);
  });
});
