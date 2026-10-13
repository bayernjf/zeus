#!/usr/bin/env node
// @ts-check
/**
 * design-evals (tech map S7) V3 — idempotent PR comment publisher.
 *
 * Posts (or updates in place) one Markdown body on the current pull request.
 * A fixed marker in the body identifies the comment across repeated CI runs,
 * so a burst of pushes updates one comment instead of stacking a new one per
 * run. The gate's pass/fail lives in the eval step's exit code; this step is
 * informational and never flips the job:
 *  - not a pull_request event (push builds) -> no-op, exit 0
 *  - GITHUB_TOKEN absent (e.g. fork PRs, whose token is read-only) -> no-op 0
 *  - API non-2xx -> warn on stderr, exit 0 (the eval verdict already ran)
 *
 * Usage (inside a GitHub Actions step, after the eval run wrote the body):
 *   node scripts/ci-pr-comment.mjs --body-file /tmp/comment.md \
 *     --marker '<!-- zeus-eval-gate -->'
 * Env: GITHUB_EVENT_PATH, GITHUB_TOKEN, GITHUB_API_URL (defaults to
 * https://api.github.com), GITHUB_REPOSITORY (owner/repo).
 */

import { readFileSync, existsSync } from 'node:fs';

/** @typedef {{ id: number; body?: string | null }} IssueComment */

function argValue(/** @type {string} */ name) {
  const at = process.argv.indexOf(name);
  return at >= 0 ? (process.argv[at + 1] ?? '') : '';
}

function warn(/** @type {string} */ message) {
  console.warn(`ci-pr-comment: ${message}`);
}

/** Parse the RFC 5988 Link header for rel="next" (GitHub paginates issue
 *  comments at 100 per page; the marker may sit beyond the first page).
 *  Returns '' when there is no next page. */
function nextPageUrl(/** @type {string | null} */ linkHeader) {
  if (!linkHeader) return '';
  for (const part of linkHeader.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (match) return match[1] ?? '';
  }
  return '';
}

async function main() {
  const bodyFile = argValue('--body-file');
  const marker = argValue('--marker');
  if (!bodyFile || !marker) {
    warn('usage: ci-pr-comment.mjs --body-file <path> --marker <string>');
    process.exit(2);
  }

  const eventPath = process.env.GITHUB_EVENT_PATH ?? '';
  if (!eventPath || !existsSync(eventPath)) {
    warn('not running in GitHub Actions (no GITHUB_EVENT_PATH); skipping');
    process.exit(0);
  }
  /** @type {{ pull_request?: { number?: number }; repository?: { full_name?: string } }} */
  const event = JSON.parse(readFileSync(eventPath, 'utf8'));
  const prNumber = event.pull_request?.number;
  if (process.env.GITHUB_EVENT_NAME !== 'pull_request' || prNumber === undefined) {
    warn(`event is ${process.env.GITHUB_EVENT_NAME ?? 'unknown'}, not pull_request; skipping`);
    process.exit(0);
  }

  const token = process.env.GITHUB_TOKEN ?? '';
  if (!token) {
    warn('no GITHUB_TOKEN (fork pull requests carry a read-only token); skipping');
    process.exit(0);
  }

  const repo = process.env.GITHUB_REPOSITORY ?? event.repository?.full_name ?? '';
  if (!repo) {
    warn('cannot resolve repository (no GITHUB_REPOSITORY); skipping');
    process.exit(0);
  }

  if (!existsSync(bodyFile)) {
    warn(`body file not found: ${bodyFile}; skipping`);
    process.exit(0);
  }
  const body = readFileSync(bodyFile, 'utf8');

  const api = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'content-type': 'application/json',
    'user-agent': 'zeus-ci-pr-comment',
  };
  // Page through the comment list: without this the marker search sees only
  // the first 100 comments and a long-lived PR gets a second stacked comment,
  // breaking the idempotent-upsert contract. 20 pages (2000 comments) is a
  // runaway guard, not an expected scale.
  /** @type {IssueComment | undefined} */
  let existing;
  let commentsUrl = `${api}/repos/${repo}/issues/${prNumber}/comments?per_page=100`;
  for (let page = 0; page < 20 && commentsUrl !== ''; page++) {
    const listRes = await fetch(commentsUrl, { headers });
    if (!listRes.ok) {
      warn(`GET comments failed: ${listRes.status} ${listRes.statusText}; skipping (the gate verdict is unaffected)`);
      process.exit(0);
    }
    const payload = await listRes.json();
    if (!Array.isArray(payload)) {
      warn('GET comments returned a non-array payload; skipping (the gate verdict is unaffected)');
      process.exit(0);
    }
    existing = payload.find(c => typeof c.body === 'string' && c.body.includes(marker));
    if (existing) break;
    commentsUrl = nextPageUrl(listRes.headers.get('link'));
  }

  if (existing) {
    const patchRes = await fetch(`${api}/repos/${repo}/issues/comments/${existing.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ body }),
    });
    if (!patchRes.ok) {
      warn(`PATCH comment ${existing.id} failed: ${patchRes.status} ${patchRes.statusText}; skipping`);
      process.exit(0);
    }
    console.log(`updated PR comment ${existing.id} on ${repo}#${prNumber}`);
  } else {
    const postRes = await fetch(`${api}/repos/${repo}/issues/${prNumber}/comments`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ body }),
    });
    if (!postRes.ok) {
      warn(`POST comment failed: ${postRes.status} ${postRes.statusText}; skipping`);
      process.exit(0);
    }
    console.log(`posted PR comment on ${repo}#${prNumber}`);
  }
  process.exit(0);
}

main().catch(error => {
  warn(error instanceof Error ? error.message : String(error));
  // Publishing is informational; never let it flip the eval gate's verdict.
  process.exit(0);
});
