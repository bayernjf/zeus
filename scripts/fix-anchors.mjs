#!/usr/bin/env node
/**
 * Fix drifted anchor citations after code insertions (doc-consistency gate).
 * For each failing citation (doc, file, from, token) find the token's current
 * line closest to the old position and rewrite the citation line number.
 * Matches any `file:LINE(-LINE)? #token` form in the doc. Doc paths may be
 * rooted (`docs/x.md`) or at the repo root (`handoff.md`).
 * Usage: node scripts/fix-anchors.mjs  (after `vitest run tests/doc-consistency.test.ts`)
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = '/Users/jiangfeng/000mycodes/zeus';
const out = execSync(`cd ${root} && npx vitest run tests/doc-consistency.test.ts 2>&1 || true`, { maxBuffer: 1 << 24 }).toString();

const re = /((?:docs\/)?[\w./-]+\.(?:md|ts)): (src|tests)\/([\w./-]+\.(?:ts|js)):(\d+)(?:-(\d+))? 的区间里没有校验词 #([\w.]+)/g;
const list = [];
for (const m of out.matchAll(re)) {
  list.push({ doc: m[1], file: `${m[2]}/${m[3]}`, from: Number(m[4]), token: m[6] });
}
console.log('failing citations:', list.length);
if (list.length === 0) { console.log('nothing to fix'); process.exit(0); }

const byDoc = new Map();
for (const c of list) {
  if (!byDoc.has(c.doc)) byDoc.set(c.doc, []);
  byDoc.get(c.doc).push(c);
}

let changed = 0;
for (const [doc, cites] of byDoc) {
  const docPath = path.join(root, doc);
  let text = fs.readFileSync(docPath, 'utf8');
  for (const c of cites) {
    const srcPath = path.join(root, c.file);
    const lines = fs.readFileSync(srcPath, 'utf8').split('\n');
    const hits = [];
    lines.forEach((line, i) => { if (line.includes(c.token)) hits.push(i + 1); });
    if (hits.length === 0) { console.log(`!! token ${c.token} not found in ${c.file}`); continue; }
    const best = hits.reduce((a, b) => (Math.abs(a - c.from) <= Math.abs(b - c.from) ? a : b));
    const fileEsc = c.file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const tokenEsc = c.token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // `#approve` must not absorb `#approve-resume`/`#approve-contract`.
    const pat = new RegExp(`(${fileEsc}):\\d+(?:-\\d+)?(?= #${tokenEsc}(?![\\w-]))`, 'g');
    const before = text.match(pat)?.length ?? 0;
    text = text.replace(pat, `$1:${best}`);
    changed += before;
    console.log(`${doc}: ${c.file}:${c.from} -> :${best} #${c.token} (${before} occurrence(s))`);
  }
  fs.writeFileSync(docPath, text);
}
console.log('total citations rewritten:', changed);
