#!/usr/bin/env node
// @ts-check
// Zero-dependency secret scan (deferred #38). Looks for the shapes of common
// credentials in tracked files and fails with exit 1 on the first hit, so CI
// can gate the changeset without pulling in gitleaks and its binary supply
// chain. The pattern set is deliberately conservative (long, versioned token
// formats), so honest test fixtures and generated keys do not trip it.
//
// Usage:
//   node scripts/scan-secrets.mjs            # scan all tracked files
//   node scripts/scan-secrets.mjs --diff <base>  # scan files changed since <base>
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** @type {Array<[RegExp, string]>} */
const PATTERNS = [
  [/-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/, 'private key block'],
  [/ghp_[A-Za-z0-9]{36}/, 'GitHub personal access token'],
  [/github_pat_[A-Za-z0-9_]{22,}/, 'GitHub fine-grained token'],
  [/gho_[A-Za-z0-9]{36}/, 'GitHub OAuth token'],
  [/xox[baprs]-[0-9A-Za-z-]{10,}/, 'Slack token'],
  [/AKIA[0-9A-Z]{16}/, 'AWS access key id'],
  [/sk-ant-api03-[A-Za-z0-9_-]{20,}/, 'Anthropic API key'],
  [/npm_[A-Za-z0-9]{36}/, 'npm token'],
  [/AIza[0-9A-Za-z_-]{35}/, 'Google API key'],
  // Project keys carry hyphens after "sk-proj-", so the plain sk- shape below
  // cannot match them; the two shapes need separate patterns.
  [/sk-proj-[A-Za-z0-9_-]{20,}/, 'OpenAI project API key'],
  [/sk-[A-Za-z0-9]{48,}/, 'OpenAI API key'],
];

const IGNORE = /(^|\/)(\.git|node_modules|dist)\//;

const args = process.argv.slice(2);
const diffBase = args[0] === '--diff' ? args[1] : null;
if (diffBase === null && args.length > 0) {
  console.error('usage: scan-secrets.mjs [--diff <base-ref>]');
  process.exit(2);
}

// -z: NUL-delimited, and core.quotePath=false keeps non-ASCII paths literal.
// Without both, git emits paths like "秘.txt" as octal-escaped quoted
// strings; reading those escaped paths fails and the file is silently skipped.
/** @param {string[]} args */
const git = args => execFileSync('git', ['-c', 'core.quotePath=false', ...args], { encoding: 'utf-8' });

let files;
if (diffBase !== null) {
  files = git(['diff', '--name-only', '-z', `${diffBase}...HEAD`]).split('\0').filter(Boolean);
} else {
  files = git(['ls-files', '-z']).split('\0').filter(Boolean);
}

let hits = 0;
for (const file of files) {
  if (IGNORE.test(file)) continue;
  let content;
  try {
    content = readFileSync(file, 'utf-8');
  } catch {
    continue; // deleted or unreadable in this checkout
  }
  for (const [re, label] of PATTERNS) {
    const m = content.match(re);
    if (m) {
      const line = content.slice(0, m.index).split('\n').length;
      console.error(`${file}:${line}: possible ${label}`);
      hits += 1;
    }
  }
}
if (hits > 0) {
  console.error(`secret scan: ${hits} hit(s); fix or move to untracked files`);
  process.exit(1);
}
console.log(`secret scan: clean (${files.length} file(s) scanned)`);
