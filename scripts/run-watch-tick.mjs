#!/usr/bin/env node
// @ts-check
/**
 * Caller-owned watch scheduler for the self-host loop.
 *
 * design-self-host-loop §3.2 / verify-self-host-pilot: the kernel deliberately
 * holds no timer (the same boundary the vault CLI keeps with cron). Watches
 * honour their own `intervalSeconds`, but something outside the process has to
 * say "evaluate now". This is that thing: it drives POST /api/watch-tick, the
 * same endpoint the Web supervisor's "run one evaluation" button and the TUI
 * `wt` command call. It is intentionally a thin scheduler over the HTTP face,
 * not a second trigger path.
 *
 * Two shapes, both unattended-friendly:
 *   1. one shot (default)  - fire one tick, print the report, exit.
 *   2. loop (--watch)      - fire a tick every INTERVAL seconds until SIGTERM,
 *                            retrying with bounded backoff while the process
 *                            is unreachable (a restarting Zeus must not kill
 *                            the scheduler).
 *
 * Cron/systemd shape for production rhythm (loopback only):
 *   KERNEL_URL=http://127.0.0.1:8787 \
 *   ZEUS_INTERNAL_TOKEN="$(cat data/internal-token)" \
 *     node scripts/run-watch-tick.mjs                      # one tick (cron)
 *   node scripts/run-watch-tick.mjs --watch --interval 60  # long-running
 *
 * Exit codes (same contract as the other shipped runners):
 *   0 the tick(s) ran (a tick that fired nothing is still success),
 *   1 a tick was rejected by the kernel (non-2xx) or reported a watch whose
 *     source it could not evaluate,
 *   2 cannot start (missing config / bad flags / kernel unreachable in a
 *     one-shot run).
 */

const env = process.env;

/** @typedef {{ evaluated: number, fired: string[], unavailable: string[], autoDisabled: string[] }} TickReport */

const VALUE_FLAGS = new Set(['--interval', '--timeout']);
const flags = new Set();
const positional = [];
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === undefined) continue;
  if (VALUE_FLAGS.has(arg)) {
    flags.add(arg);
    i += 1; // the next argv element is the value, never a positional
  } else if (arg.startsWith('--')) {
    flags.add(arg);
  } else {
    positional.push(arg);
  }
}
const WATCH = flags.has('--watch');

/** @param {string} message */
function usageExit(message) {
  if (message) console.error(`error: ${message}`);
  console.error(
    'usage: KERNEL_URL=… ZEUS_INTERNAL_TOKEN=… node scripts/run-watch-tick.mjs [--watch] [--interval SECONDS] [--timeout MS]',
  );
  process.exit(2);
}

/** @param {string} name */
function numberFlag(name) {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : Number(process.argv[at + 1]);
}
if (positional.length > 0) usageExit(`unexpected argument: ${positional[0]}`);

const KERNEL_URL = (env.KERNEL_URL ?? '').replace(/\/+$/, '');
const INTERNAL_TOKEN = env.ZEUS_INTERNAL_TOKEN ?? '';
const INTERVAL_SECONDS = numberFlag('--interval') ?? Number(env.WATCH_INTERVAL_SECONDS ?? 60);
const TIMEOUT_MS = numberFlag('--timeout') ?? Number(env.WATCH_HTTP_TIMEOUT_MS ?? 10_000);
const MAX_BACKOFF_MS = Number(env.WATCH_MAX_BACKOFF_MS ?? 30_000);
const loopback = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(KERNEL_URL);

if (!KERNEL_URL) usageExit('KERNEL_URL is required (e.g. http://127.0.0.1:8787)');
if (!INTERNAL_TOKEN) usageExit('ZEUS_INTERNAL_TOKEN is required: /api/watch-tick is on the internal/driver face');
if (!Number.isInteger(INTERVAL_SECONDS) || INTERVAL_SECONDS < 1) {
  usageExit('--interval (or WATCH_INTERVAL_SECONDS) must be a positive integer of seconds');
}
if (!Number.isInteger(TIMEOUT_MS) || TIMEOUT_MS < 1) {
  usageExit('--timeout (or WATCH_HTTP_TIMEOUT_MS) must be a positive integer of ms');
}
if (!loopback) {
  console.error(`refusing to run: KERNEL_URL ${KERNEL_URL} is not loopback - the internal token must not leave the host`);
  process.exit(2);
}

/** @param {number} ms */
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const timestamp = () => new Date().toISOString();
/** @param {string} value */
const clip = value => value.replace(/\s+/g, ' ').slice(0, 200);

/**
 * One evaluation pass. Returns "unreachable" when the kernel could not be
 * reached (the loop backs off and retries; one-shot treats it as exit 2).
 * Never throws.
 * @returns {Promise<{ ok: true, status: number, report: TickReport } | { ok: false, status: number, detail: string } | { unreachable: true, detail: string }>}
 */
async function tick() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${KERNEL_URL}/api/watch-tick`, {
      method: 'POST',
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}`, 'content-type': 'application/json' },
      body: '{}',
      signal: controller.signal,
    });
    const text = await response.text();
    /** @type {any} */
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    if (!response.ok) return { ok: false, status: response.status, detail: clip(text) };
    /** @type {TickReport | undefined} */
    const report = parsed?.report;
    if (!report || !Array.isArray(report.fired) || !Array.isArray(report.unavailable) || !Array.isArray(report.autoDisabled)) {
      return { ok: false, status: response.status, detail: `missing report fields in response: ${clip(text)}` };
    }
    return { ok: true, status: response.status, report };
  } catch (error) {
    return { unreachable: true, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/** @param {TickReport} report */
function printReport(report) {
  const fmt = (/** @type {string[]} */ list) => (list.length ? list.join(',') : 'none');
  console.log(
    `${timestamp()}  evaluated=${report.evaluated} fired=${report.fired.length} [${fmt(report.fired)}] ` +
    `unavailable=${report.unavailable.length} [${fmt(report.unavailable)}] ` +
    `autoDisabled=${report.autoDisabled.length} [${fmt(report.autoDisabled)}]`,
  );
}

// A tick that fired is healthy; a watch whose source was unreadable is a
// reported degradation worth a nonzero exit in a one-shot cron run (the cron
// log surfaces it) but it never kills a --watch loop.
/** @param {TickReport} report */
function reportIsHealthy(report) {
  return report.unavailable.length === 0 && report.autoDisabled.length === 0;
}

if (!WATCH) {
  const result = await tick();
  if ('unreachable' in result) {
    console.error(`cannot reach ${KERNEL_URL}: ${result.detail} - is Zeus running?`);
    process.exit(2);
  }
  if (!result.ok) {
    console.error(`tick rejected: HTTP ${result.status}: ${result.detail}`);
    process.exit(1);
  }
  printReport(result.report);
  process.exit(reportIsHealthy(result.report) ? 0 : 1);
}

// --watch: caller-owned cadence. SIGTERM/SIGINT exit cleanly (a systemd stop is
// not an error). An unreachable kernel backs off with a capped exponential
// delay so a restart window does not spam the endpoint.
console.log(`${timestamp()}  watch scheduler started: ${KERNEL_URL} every ${INTERVAL_SECONDS}s (Ctrl-C / SIGTERM to stop)`);
let stopping = false;
let backoff = 1000;
for (const signal of /** @type {const} */ (['SIGTERM', 'SIGINT'])) {
  process.on(signal, () => {
    stopping = true;
    console.log(`${timestamp()}  ${signal} received, stopping after this iteration`);
  });
}
while (!stopping) {
  const result = await tick();
  if ('unreachable' in result) {
    const wait = Math.min(backoff, MAX_BACKOFF_MS);
    console.error(`${timestamp()}  cannot reach kernel: ${result.detail} - retrying in ${wait}ms`);
    await sleep(wait);
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    continue;
  }
  backoff = 1000;
  if (!result.ok) {
    // A 4xx repeats the same rejection each interval; log loudly but keep the
    // loop so fixing the token/config self-heals on the next interval.
    console.error(`${timestamp()}  tick rejected: HTTP ${result.status}: ${result.detail}`);
  } else {
    printReport(result.report);
  }
  const cycleMs = INTERVAL_SECONDS * 1000;
  for (let waited = 0; waited < cycleMs && !stopping; waited += 250) {
    await sleep(Math.min(250, cycleMs - waited));
  }
}
console.log(`${timestamp()}  watch scheduler stopped`);
process.exit(0);
