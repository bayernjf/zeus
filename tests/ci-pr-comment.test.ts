import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// design-evals V3 (tech map S7): the CI PR comment publisher must upsert one
// comment idempotently (POST when absent, PATCH when the marker already
// exists), no-op outside pull_request events or without a token, and never
// flip the gate verdict on API failure. A loopback HTTP server stands in for
// the GitHub REST API; the script is dependency-free and does not need dist/.
const SCRIPT = fileURLToPath(new URL('../scripts/ci-pr-comment.mjs', import.meta.url));
const MARKER = '<!-- zeus-eval-gate -->';

interface RecordedCall { method: string; url: string; body: unknown }

function runPublisher(opts: { apiBase: string; bodyFile: string; eventFile: string; eventName: string; token?: string; repo?: string }):
  Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, '--body-file', opts.bodyFile, '--marker', MARKER], {
      env: {
        ...process.env,
        GITHUB_API_URL: opts.apiBase,
        GITHUB_EVENT_PATH: opts.eventFile,
        GITHUB_EVENT_NAME: opts.eventName,
        GITHUB_REPOSITORY: opts.repo ?? 'bayjf/zeus',
        ...(opts.token === undefined ? {} : { GITHUB_TOKEN: opts.token }),
        NO_PROXY: '127.0.0.1,localhost',
        no_proxy: '127.0.0.1,localhost',
      },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('ci-pr-comment.mjs timed out'));
    }, 15_000);
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));
    child.on('close', status => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
    child.on('error', reject);
  });
}

describe('ci-pr-comment.mjs idempotent PR upsert (S7 V3)', () => {
  let server: Server;
  let calls: RecordedCall[];
  let listHandler: () => unknown;
  let listLink: string | undefined;
  let page2: unknown;
  let dir: string;
  let port: number;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'zeus-pr-comment-'));
    calls = [];
    listHandler = () => [];
    listLink = undefined;
    page2 = undefined;
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', chunk => (raw += chunk));
      req.on('end', () => {
        const url = req.url ?? '';
        let parsed: unknown = null;
        if (raw) {
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        }
        calls.push({ method: req.method ?? '?', url, body: parsed });
        if (req.method === 'GET' && url.includes('/comments')) {
          const isPage2 = url.includes('page=2');
          const headers: Record<string, string> = { 'content-type': 'application/json' };
          if (!isPage2 && listLink !== undefined) headers.link = listLink;
          res.writeHead(200, headers);
          res.end(JSON.stringify(isPage2 && page2 !== undefined ? page2 : listHandler()));
          return;
        }
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 1 }));
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    port = address && typeof address === 'object' ? address.port : 0;
    expect(port).toBeGreaterThan(0);
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  function apiBase(): string {
    return `http://127.0.0.1:${port}`;
  }

  function writeBodyFile(): string {
    const p = join(dir, 'comment.md');
    writeFileSync(p, `${MARKER}\n## Eval gate\nPASS\n`);
    return p;
  }

  function writeEventFile(pr: { number: number } | null): string {
    const p = join(dir, 'event.json');
    writeFileSync(p, JSON.stringify(pr === null
      ? { repository: { full_name: 'bayjf/zeus' } }
      : { pull_request: { number: pr.number }, repository: { full_name: 'bayjf/zeus' } }));
    return p;
  }

  it('POSTs a new comment when no marked comment exists', async () => {
    const base = await apiBase();
    const r = await runPublisher({
      apiBase: base,
      bodyFile: writeBodyFile(),
      eventFile: writeEventFile({ number: 42 }),
      eventName: 'pull_request',
      token: 'ghs_test',
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const post = calls.find(c => c.method === 'POST');
    expect(post?.url).toBe('/repos/bayjf/zeus/issues/42/comments');
    expect(String((post?.body as { body?: string })?.body ?? '')).toContain(MARKER);
    expect(calls.some(c => c.method === 'PATCH')).toBe(false);
    expect(r.stdout).toContain('posted PR comment');
  });

  it('PATCHes the existing marked comment instead of posting a second one', async () => {
    listHandler = () => [{ id: 77, body: `${MARKER}\nstale body` }, { id: 78, body: 'unrelated' }];
    const base = await apiBase();
    const r = await runPublisher({
      apiBase: base,
      bodyFile: writeBodyFile(),
      eventFile: writeEventFile({ number: 42 }),
      eventName: 'pull_request',
      token: 'ghs_test',
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const patch = calls.find(c => c.method === 'PATCH');
    expect(patch?.url).toBe('/repos/bayjf/zeus/issues/comments/77');
    expect(calls.some(c => c.method === 'POST')).toBe(false);
    expect(r.stdout).toContain('updated PR comment 77');
  });

  it('follows pagination to find a marked comment beyond the first page', async () => {
    // GitHub paginates issue comments at 100 per page; a long-lived PR can
    // push the marker past page 1. The upsert contract (design-evals V3)
    // still requires PATCHing that comment, not stacking a fresh one.
    listHandler = () => Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: `filler ${i + 1}` }));
    page2 = [{ id: 99, body: `${MARKER}\nstale body` }];
    listLink = `<${apiBase()}/repos/bayjf/zeus/issues/42/comments?per_page=100&page=2>; rel="next"`;
    const r = await runPublisher({
      apiBase: apiBase(),
      bodyFile: writeBodyFile(),
      eventFile: writeEventFile({ number: 42 }),
      eventName: 'pull_request',
      token: 'ghs_test',
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(calls.some(c => c.method === 'GET' && c.url.includes('page=2'))).toBe(true);
    const patch = calls.find(c => c.method === 'PATCH');
    expect(patch?.url).toBe('/repos/bayjf/zeus/issues/comments/99');
    expect(calls.some(c => c.method === 'POST')).toBe(false);
    expect(r.stdout).toContain('updated PR comment 99');
  });

  it('no-ops without touching the API on a push (non-pull_request) event', async () => {
    const base = await apiBase();
    const r = await runPublisher({
      apiBase: base,
      bodyFile: writeBodyFile(),
      eventFile: writeEventFile(null),
      eventName: 'push',
      token: 'ghs_test',
    });
    expect(r.status).toBe(0);
    expect(calls).toHaveLength(0);
    expect(r.stderr).toContain('not pull_request');
  });

  it('no-ops without a token (fork PRs carry a read-only token)', async () => {
    const base = await apiBase();
    const r = await runPublisher({
      apiBase: base,
      bodyFile: writeBodyFile(),
      eventFile: writeEventFile({ number: 42 }),
      eventName: 'pull_request',
      token: '',
    });
    expect(r.status).toBe(0);
    expect(calls).toHaveLength(0);
    expect(r.stderr).toContain('GITHUB_TOKEN');
  });
});
