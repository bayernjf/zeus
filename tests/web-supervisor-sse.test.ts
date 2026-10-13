import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

/**
 * Contract guard for the supervisor SSE client's resilience policy:
 * exponential reconnect backoff, non-retryable auth failures (401/403),
 * bearer handling without a configured token, and pausing background
 * polling while the tab is hidden.
 *
 * The console ships as one inline-script HTML file, so the executable policy
 * lives in a marker-delimited block evaluated here (the same extraction
 * pattern the I18N tables use); the wiring around it is pinned with
 * normalized substring guards like the rest of the web supervisor tests.
 */
const HTML = readFileSync('web/supervisor/index.html', 'utf8');
const squash = (s: string): string => s.replace(/\s+/g, ' ');

function loadPolicy(): {
  sseBackoffMs: (retries: number) => number;
  sseNonRetryableStatus: (status: number) => boolean;
} {
  const begin = HTML.indexOf('// SSE-POLICY-BEGIN');
  const end = HTML.indexOf('// SSE-POLICY-END');
  expect(begin).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(begin);
  const sandbox: Record<string, unknown> = {};
  vm.createContext(sandbox);
  vm.runInContext(
    `${HTML.slice(begin, end)}
this.sseBackoffMs = sseBackoffMs;
this.sseNonRetryableStatus = sseNonRetryableStatus;`,
    sandbox,
  );
  return sandbox as unknown as ReturnType<typeof loadPolicy>;
}

const section = (start: string, stop: string): string =>
  squash(HTML.slice(HTML.indexOf(start), HTML.indexOf(stop)));

describe('supervisor SSE reconnect policy', () => {
  it('backs reconnect attempts off exponentially with a 30s ceiling', () => {
    const { sseBackoffMs } = loadPolicy();
    expect([0, 1, 2, 3, 4, 5].map(sseBackoffMs)).toEqual([2000, 4000, 8000, 16000, 30000, 30000]);
  });

  it('treats 401/403 as non-retryable and every other status as retryable', () => {
    const { sseNonRetryableStatus } = loadPolicy();
    for (const status of [401, 403]) expect(sseNonRetryableStatus(status)).toBe(true);
    for (const status of [200, 404, 500, 502, 503]) expect(sseNonRetryableStatus(status)).toBe(false);
  });
});

describe('supervisor SSE client wiring', () => {
  const stopSse = section('function stopSse()', 'function appendSseEvent');
  const startSse = section('async function startSse', 'async function cancelIntent');

  it('tracks the reconnect timer and clears it from stopSse', () => {
    expect(HTML).toContain('sseReconnect: null');
    expect(stopSse).toContain('if (state.sseReconnect) { clearTimeout(state.sseReconnect); state.sseReconnect = null; }');
  });

  it('accumulates backoff across retries instead of resetting before reconnect', () => {
    // The old timer callback ran `state.sseRetries = 0; startSse(id);`, so
    // every retry computed 2^0 = 2s and the 30s ceiling was unreachable.
    expect(startSse).not.toContain('state.sseRetries = 0; startSse(id);');
    // The counter resets only after response headers prove the connection is healthy.
    expect(startSse).toContain('state.sseRetries = 0;');
  });

  it('revalidates the current view before a deferred reconnect', () => {
    expect(startSse).toContain('if (state.view === \'intent\' && state.intentId === id) startSse(id);');
  });

  it('omits the authorization header when no token is configured', () => {
    expect(startSse).not.toContain("authorization: 'Bearer ' + token");
    expect(startSse).toContain("const sseHeaders = { accept: 'text/event-stream' };");
    expect(startSse).toContain("if (token) sseHeaders.authorization = 'Bearer ' + token;");
  });

  it('stops without reconnecting on a non-retryable auth failure', () => {
    expect(startSse).toContain('if (sseNonRetryableStatus(res.status))');
    expect(startSse).toContain("t('sse.authDenied', { status: res.status })");
    const branch = startSse.slice(startSse.indexOf('if (sseNonRetryableStatus(res.status))'));
    expect(branch).toContain('stopSse();');
    expect(branch).toContain('return;');
  });
});

describe('supervisor background polling', () => {
  it('pauses the 10s view refresh while the tab is hidden', () => {
    expect(HTML).toContain('state.conn.base && !document.hidden) refreshView();');
  });

  it('refreshes immediately when the tab becomes visible again', () => {
    expect(HTML).toContain("document.addEventListener('visibilitychange'");
  });
});
