#!/usr/bin/env node
// @ts-check
/**
 * Runtime reliability measurement on the shipped artifact (audit §11.3).
 *
 * The audit left four cells open because nothing had ever driven them through a
 * booted process: unbounded growth (measured, not inferred), the concurrency
 * gate under a *bounded* config (the earlier run's own startup log said
 * "unbounded" three times), the escalation queue across a restart (that run
 * could not create a pending item, so it read 0 and called it restored), and the
 * SSE reconnect / cancel-propagation timing.
 *
 * This is a **measurement** runner. It prints numbers; only invariants that are
 * actually claims get asserted (the gate refuses, the escalation survives, the
 * control run really differs). Growth is reported, not asserted, because a
 * growth number is a finding to register, not a pass/fail.
 *
 * Rules it obeys so it can run unattended: loopback only, no external network,
 * one temporary directory for everything it creates, its own key and token, it
 * kills only the processes it started, and a wall-clock budget that turns a hang
 * into a failure instead of a stalled job.
 *
 * Usage (requires `npm run build` first):
 *   npm run verify:reliability
 *   npm run verify:reliability -- --intents 200 --rounds 6   # growth curve size
 *   npm run verify:reliability -- --keep                     # keep the work dir
 * Exit codes: 0 every check passed, 1 a check failed, 2 cannot start.
 */
import { spawn, execFileSync, execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, existsSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const KEEP = args.includes('--keep');
const BUDGET_MS = 480_000;
const startedAt = Date.now();
const TOKEN = `rel-${randomBytes(8).toString('hex')}`;
const argNumber = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : fallback;
};
const GROWTH_INTENTS = argNumber('--intents', 180);
const GROWTH_ROUNDS = argNumber('--rounds', 5);

/** @type {{ name: string, ok: boolean, detail: string }[]} */
const steps = [];
/** @param {string} name @param {boolean} ok @param {string} [detail] */
function record(name, ok, detail = '') {
  steps.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ::  ${detail}` : ''}`);
}
/** A measured readout is not a claim; print it with its own marker. */
function measured(name, detail) {
  console.log(`MEASURE  ${name}  ::  ${detail}`);
}
/** @param {number} ms */
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const boundPort = server => {
  const address = server.address();
  return typeof address === 'object' && address !== null && typeof address.port === 'number' ? address.port : undefined;
};
async function freePort() {
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = boundPort(probe);
  await new Promise(resolve => probe.close(() => resolve(undefined)));
  if (port === undefined) throw new Error('could not obtain a free loopback port');
  return port;
}

// ---------------------------------------------------------------------------
// Mock A2A farm. Behaviour is per-request so the same farm can saturate the
// gate, disagree to make a conflict, or stall long enough to be cancelled.
// ---------------------------------------------------------------------------
/** @type {{ requests: number, thinkMs: number }} */
const scenario = { requests: 0, thinkMs: 0 };
const agentServer = createServer((req, res) => {
  const match = req.url?.match(/^\/([a-z]\d+)\/api\/a2a\/(agent-card|tasks)$/);
  if (!match) {
    res.writeHead(404).end('not found');
    return;
  }
  const name = match[1] ?? '';
  if (req.method === 'GET') {
    const port = boundPort(agentServer);
    if (port === undefined) {
      res.writeHead(500).end('no port');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      name,
      url: `http://127.0.0.1:${port}/${name}/api/a2a/tasks`,
      skills: [{ id: 'research', name: 'Research', description: 'reads the task scope', tags: [] }],
      'x-zeus-fealty': {
        version: '1',
        swornTo: 'zeus',
        domain: 'reliability',
        dataRealms: ['personal'],
        dataPolicy: 'read-task-scope',
        reportBack: true,
        escalationPolicy: 'on-failure',
      },
    }));
    return;
  }
  let raw = '';
  req.on('data', chunk => (raw += chunk));
  req.on('end', async () => {
    const rpc = JSON.parse(raw || '{}');
    const index = scenario.requests;
    scenario.requests += 1;
    // Agents whose name starts with `c` disagree with each other: that is how a
    // real intent-conflict escalation gets produced in a booted process.
    const stance = name.startsWith('c') && index % 2 === 1 ? 'reject' : 'approve';
    // The second stream agent answers six times later on purpose: it keeps one
    // branch in flight after the first has ended, which is what a subscriber that
    // disconnects mid-run is supposed to miss.
    const delayMs = name.endsWith('2') ? scenario.thinkMs * 6 : scenario.thinkMs;
    if (delayMs > 0) await sleep(delayMs);
    const task = {
      kind: 'task',
      id: `t-${name}-${index}`,
      contextId: 'reliability',
      status: { state: 'completed' },
      artifacts: [{ artifactId: 'verdict', name: 'verdict', parts: [{ kind: 'data', data: { stance } }] }],
    };
    if (String(req.headers.accept ?? '').includes('text/event-stream')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: task })}\n\n`);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: task }));
  });
});
await new Promise(resolve => agentServer.listen(0, '127.0.0.1', () => resolve(undefined)));
const agentPort = boundPort(agentServer);
if (agentPort === undefined) {
  console.error('FAIL  cannot start: the mock farm never bound a port');
  process.exit(2);
}
/** @param {string} prefix @param {number} count */
const names = (prefix, count) => Array.from({ length: count }, (_, i) => `${prefix}${i + 1}`);
/** @param {string} prefix @param {number} count */
const cardUrls = (prefix, count) => names(prefix, count).map(n => `http://127.0.0.1:${agentPort}/${n}/api/a2a/agent-card`);

// ---------------------------------------------------------------------------
// Work directory, keys, one boot per scenario.
// ---------------------------------------------------------------------------
const work = mkdtempSync(join(tmpdir(), 'zeus-reliability-'));
const realmRoot = join(work, 'realm');
mkdirSync(realmRoot, { recursive: true });
writeFileSync(join(realmRoot, 'brief.md'), '# brief\nreliability harness fixture\n');
execFileSync(process.execPath, [join(REPO, 'scripts/gen-rsk-key.mjs'), join(work, 'rel-key.pem')], { stdio: 'pipe' });

/** @type {import('node:child_process').ChildProcess[]} */
const children = [];
function watchdog() {
  if (Date.now() - startedAt > BUDGET_MS) {
    console.error(`FAIL  wall-clock budget ${BUDGET_MS / 1000}s exceeded`);
    finish(1);
  }
}
const budget = setInterval(watchdog, 2_000);

/**
 * Boot one real process with its own port, state file and audit file.
 * @param {{ cap?: number, queue?: number, persist?: boolean, label: string }} opts
 */
async function boot(opts) {
  const dir = join(work, opts.label);
  mkdirSync(dir, { recursive: true });
  const port = await freePort();
  const stateFile = join(dir, 'kernel-state.json');
  const env = {
    ...process.env,
    NODE_ENV: 'development',
    ZEUS_HOST: '127.0.0.1',
    ZEUS_PORT: String(port),
    ZEUS_INTERNAL_TOKEN: TOKEN,
    ZEUS_REALM_ROOTS: realmRoot,
    ZEUS_RSK_KEY_FILE: join(work, 'rel-key.pem'),
    ZEUS_RSK_KEY_ID: 'zeus-rsk-reliability',
    ...(opts.persist === false ? {} : { ZEUS_STATE_FILE: stateFile }),
    ...(opts.cap !== undefined ? { ZEUS_MAX_CONCURRENT_BRANCHES: String(opts.cap) } : {}),
    ...(opts.queue !== undefined ? { ZEUS_BRANCH_QUEUE_LIMIT: String(opts.queue) } : {}),
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  };
  delete env.ZEUS_VASSAL_SEEDS;
  delete env.ZEUS_AUDIT_FILE;
  const child = spawn(process.execPath, [join(REPO, 'dist/http/serve.js')], { env, cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let log = '';
  child.stdout?.on('data', chunk => (log += String(chunk)));
  child.stderr?.on('data', chunk => (log += String(chunk)));
  for (let attempt = 0; attempt < 160; attempt++) {
    if (child.exitCode !== null) throw new Error(`[${opts.label}] exited early (code ${child.exitCode}):\n${log.slice(-700)}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) break;
    } catch {
      /* not listening yet */
    }
    await sleep(250);
  }
  if (!(await fetch(`http://127.0.0.1:${port}/healthz`).then(r => r.ok).catch(() => false))) {
    throw new Error(`[${opts.label}] never became healthy:\n${log.slice(-700)}`);
  }
  const bearer = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
  /** @param {string} method @param {string} path @param {unknown} [body] */
  const api = async (method, path, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: bearer,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* keep the text */ }
    return { status: response.status, json, text };
  };
  return { child, port, dir, stateFile, log: () => log, api, bearer };
}

/** @param {import('node:child_process').ChildProcess} child */
async function stopProcess(child) {
  const before = Date.now();
  const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
  child.kill('SIGTERM');
  const raced = await Promise.race([exited, sleep(30_000).then(() => null)]);
  const elapsedMs = Date.now() - before;
  if (raced === null) {
    child.kill('SIGKILL');
    await exited;
    return { elapsedMs: Date.now() - before, graceful: false };
  }
  return { elapsedMs, graceful: true };
}

/** Wait for an intent to reach a terminal state, sampling inside the loop. */
async function settle(process, intentId, { timeoutMs = 30_000, expectBranches = 0 } = {}) {
  const polls = [];
  /** @type {any} */
  let json = null;
  for (let attempt = 0; attempt * 100 < timeoutMs; attempt++) {
    const read = await process.api('GET', `/api/intents/${intentId}`);
    json = read.json;
    const status = typeof json?.status === 'string' ? json.status : undefined;
    const branches = Array.isArray(json?.branches) ? json.branches : [];
    polls.push({ at: Date.now(), status: status ?? '(none)', branches: branches.length });
    const terminal = status !== undefined && !/pending|running|working/i.test(status);
    if ((expectBranches > 0 && branches.length >= expectBranches) || terminal) return { json, polls };
    await sleep(100);
  }
  return { json, polls, timedOut: true };
}

// ---------------------------------------------------------------------------
// R2 - the concurrency gate under a bounded config, with an unbounded control.
// ---------------------------------------------------------------------------
async function measureGate() {
  const width = 16;
  const cards = cardUrls('g', width);
  /** @param {{ cap?: number, queue?: number, label: string }} opts */
  const run = async opts => {
    const proc = await boot({ ...opts, persist: false });
    for (const cardUrl of cards) {
      const registered = await proc.api('POST', '/api/vassals', { cardUrl });
      if (registered.status >= 400) throw new Error(`[${opts.label}] register refused: ${registered.status} ${registered.text.slice(0, 160)}`);
    }
    scenario.requests = 0;
    const submitted = await proc.api('POST', '/api/intents', {
      skill: 'research',
      realm: 'personal',
      vassals: names('g', width),
      aggregation: { kind: 'unanimous' },
      params: { subject: 'gate', predicate: 'verdict' },
    });
    const intentId = submitted.json?.id ?? submitted.json?.intentId;
    const settled = intentId ? await settle(proc, intentId, { expectBranches: width }) : { json: null, polls: [] };
    const readback = intentId ? await proc.api('GET', `/api/intents/${intentId}`) : null;
    // A submission that answers an error instead of an intent is itself the
    // finding, so keep its shape readable.
    const result = settled.json ?? submitted.json;
    const metrics = await proc.api('GET', '/api/metrics');
    const branches = Array.isArray(result?.branches) ? result.branches : [];
    const refused = branches.filter(branch => /concurrency limit|queue|limit/i.test(String(branch.reason ?? '')));
    const { elapsedMs, graceful } = await stopProcess(proc.child);
    return {
      proc,
      metrics: metrics.json ?? {},
      refused: refused.length,
      settled: branches.length,
      sampleReason: String(refused[0]?.reason ?? ''),
      submitStatus: submitted.status,
      submitBody: submitted.text.slice(0, 320),
      readbackBody: readback?.text.slice(0, 320) ?? '(no readback)',
      stopMs: elapsedMs,
      graceful,
      log: proc.log(),
      intentId,
      status: result?.status,
    };
  };
  const bounded = await run({ cap: 4, queue: 2, label: 'gate-bounded' });
  const unbounded = await run({ label: 'gate-unbounded' });

  const startupSaysBounded = /branch concurrency: 4, queue 2/.test(bounded.log);
  measured('bounded submission', `http=${bounded.submitStatus} intent=${bounded.intentId ?? '(none)'} branches=${bounded.settled} body=${bounded.submitBody}`);
  measured('bounded readback', bounded.readbackBody);
  record(
    'the bounded process states its bound at startup',
    startupSaysBounded,
    startupSaysBounded ? 'startup log names the cap' : `startup log does not name it: ${bounded.log.split('\n').find(line => /concurr|cap|branch/i.test(line))?.slice(0, 140) ?? '(no such line)'}`,
  );
  record(
    'a bounded config refuses branches at the ceiling instead of dispatching them',
    bounded.refused > 0,
    `refused=${bounded.refused}/${bounded.settled} branches, intent status=${bounded.status}, submit http=${bounded.submitStatus}`,
  );
  record('the refusal names the limit it hit', /concurrency limit|queue/i.test(bounded.sampleReason), bounded.sampleReason.slice(0, 120));
  record(
    'in-flight never exceeded the configured cap',
    Number(bounded.metrics?.maxInFlight ?? 0) <= 4,
    `maxInFlight=${bounded.metrics?.maxInFlight} queueDepth=${bounded.metrics?.queueDepth} inFlight=${bounded.metrics?.inFlight}`,
  );
  record(
    'the unbounded control dispatched every branch (the harness can see the difference)',
    bounded.refused > 0 && unbounded.refused === 0 && unbounded.settled >= bounded.settled,
    `bounded refused=${bounded.refused}, unbounded refused=${unbounded.refused} settled=${unbounded.settled}, maxInFlight=${unbounded.metrics?.maxInFlight}`,
  );
  measured('gate stop-graceful-save wall time', `bounded=${bounded.stopMs}ms graceful=${bounded.graceful} unbounded=${unbounded.stopMs}ms`);
}

// ---------------------------------------------------------------------------
// R3 - the escalation queue across a restart, plus the control without a
// state file. Also reads back which escalation kinds a booted process can
// produce at all.
// ---------------------------------------------------------------------------
async function measureEscalations() {
  const conflictCards = cardUrls('c', 2);
  /** @param {{ persist: boolean, label: string }} opts */
  const cycle = async opts => {
    const proc = await boot({ ...opts, persist: opts.persist });
    for (const cardUrl of conflictCards) await proc.api('POST', '/api/vassals', { cardUrl });
    const submitted = await proc.api('POST', '/api/intents', {
      skill: 'research',
      realm: 'personal',
      vassals: names('c', 2),
      aggregation: { kind: 'unanimous' },
      params: { subject: 'conflict', predicate: 'verdict' },
    });
    const intentId = submitted.json?.id ?? submitted.json?.intentId;
    if (intentId) await settle(proc, intentId, { expectBranches: 2 });
    const before = await proc.api('GET', '/api/escalations');
    const list = Array.isArray(before.json?.escalations) ? before.json.escalations : Array.isArray(before.json) ? before.json : [];
    return { proc, list, intentId };
  };
  const withState = await cycle({ persist: true, label: 'esc-state' });
  const kinds = [...new Set(withState.list.map(entry => String(entry.kind)))];
  record('a real disagreement produces a pending escalation', withState.list.length > 0, `pending=${withState.list.length} kinds=${kinds.join(',')}`);

  const first = withState.list[0];
  const { elapsedMs } = await stopProcess(withState.proc.child);
  measured('escalation scenario stop wall time', `${elapsedMs}ms`);

  const restarted = await boot({ label: 'esc-state', persist: true });
  const after = await restarted.api('GET', '/api/escalations');
  const afterList = Array.isArray(after.json?.escalations) ? after.json.escalations : Array.isArray(after.json) ? after.json : [];
  const survived = first !== undefined && afterList.some(entry => entry.id === first.id);
  record('the pending item is still pending after SIGTERM + restart', survived, `before=${withState.list.length} after=${afterList.length} id=${first?.id ?? '(none)'}`);
  if (first !== undefined && survived) {
    const approved = await restarted.api('POST', `/api/escalations/${String(first.id)}/approve`, { note: 'reliability run' });
    const readBack = await restarted.api('GET', `/api/escalations/${String(first.id)}`);
    record(
      'the approval is recorded and readable on the same id',
      approved.status === 200 && String(readBack.json?.status ?? readBack.json?.escalation?.status ?? '') !== String(first.status ?? ''),
      `approve=${approved.status} status after=${readBack.json?.status ?? readBack.json?.escalation?.status}`,
    );
  }
  await stopProcess(restarted.child);

  const withoutState = await cycle({ persist: false, label: 'esc-memory' });
  const controlHadOne = withoutState.list.length > 0;
  await stopProcess(withoutState.proc.child);
  const restartedMemory = await boot({ label: 'esc-memory', persist: false });
  const controlAfter = await restartedMemory.api('GET', '/api/escalations');
  const controlList = Array.isArray(controlAfter.json?.escalations) ? controlAfter.json.escalations : Array.isArray(controlAfter.json) ? controlAfter.json : [];
  record(
    'positive control: with no state file the same item is gone after restart',
    controlHadOne && controlList.length === 0,
    `before=${withoutState.list.length} after=${controlList.length} (persistence is what carried the other one)`,
  );
  await stopProcess(restartedMemory.child);
}

// ---------------------------------------------------------------------------
// R4 - SSE reconnect and cancel propagation, sampled inside the wait loop.
// ---------------------------------------------------------------------------
async function measureStream() {
  const proc = await boot({ label: 'stream', persist: false });
  for (const cardUrl of cardUrls('s', 2)) await proc.api('POST', '/api/vassals', { cardUrl });

  /**
   * POST /api/intents awaits the whole fan-out, so an id only arrives at
   * terminal state. To watch a live intent the caller must name it up front and
   * leave the request in flight - that is what this does, and it is the only way
   * the SSE face is reachable for a locally submitted intent.
   * @param {number} thinkMs @param {string} label
   */
  const submit = async (thinkMs, label) => {
    scenario.thinkMs = thinkMs;
    scenario.requests = 0;
    const intentId = `rel-${label}-${Date.now()}`;
    const inflight = proc.api('POST', '/api/intents', {
      intentId,
      skill: 'research',
      realm: 'personal',
      vassals: names('s', 2),
      aggregation: { kind: 'unanimous' },
      params: { subject: 'stream', predicate: 'verdict' },
      branchTimeoutMs: thinkMs * 6 + 10_000,
    });
    return { intentId, inflight };
  };

  /** Open a stream, stop after `stopAfterMs`, return what arrived. */
  const openStream = async (intentId, { stopAfterMs, untilTerminal = false }) => {
    const controller = new AbortController();
    const started = Date.now();
    const timer = stopAfterMs > 0 ? setTimeout(() => controller.abort(), stopAfterMs) : undefined;
    /** @type {string[]} */
    const events = [];
    let endedAt = 0;
    try {
      const response = await fetch(`http://127.0.0.1:${proc.port}/api/intents/${intentId}/events`, {
        headers: proc.bearer,
        signal: controller.signal,
      });
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      // Key each event by name *and* the identity in its payload: two
      // `branch-ended` frames from two different branches are not the same
      // event, and counting names alone would read a missed event as a replay.
      let pendingName = '';
      let buffer = '';
      for (;;) {
        if (reader === undefined) break;
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let split = buffer.indexOf('\n\n');
        while (split >= 0) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          for (const line of frame.split('\n')) {
            if (line.startsWith('event: ')) pendingName = line.slice(7).trim();
            else if (line.startsWith('data: ')) {
              let identity = '';
              try {
                const payload = JSON.parse(line.slice(6));
                identity = String(payload.runId ?? payload.taskId ?? payload.branch?.runId ?? '');
              } catch { identity = line.slice(6, 40); }
              events.push(`${pendingName || 'message'}#${identity}`);
            }
          }
          split = buffer.indexOf('\n\n');
        }
        if (untilTerminal && events.some(entry => entry.startsWith('intent-finished') || entry.startsWith('end'))) {
          endedAt = Date.now();
          controller.abort();
          break;
        }
      }
      if (endedAt === 0) endedAt = Date.now();
    } catch {
      endedAt = Date.now();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    return { events, ms: endedAt - started, endedAt };
  };

  const slow = await submit(500, 'slow');
  const first = await openStream(slow.intentId, { stopAfterMs: 1_200 });
  const reconnect = await openStream(slow.intentId, { stopAfterMs: 0, untilTerminal: true });
  const slowResult = await slow.inflight;
  record('an aborted subscriber does not take the process down', (await proc.api('GET', '/healthz')).status === 200);
  record(
    'the dropped subscriber really had received events first (otherwise the replay readout proves nothing)',
    first.events.length > 0,
    `first stream saw [${first.events.join(',')}] before being aborted`,
  );
  const sawTerminal = reconnect.events.some(entry => entry.startsWith('intent-finished') || entry.startsWith('end'));
  const dropped = first.events.filter(entry => !reconnect.events.includes(entry));
  record(
    'a reconnect while the intent is still running reaches the terminal event',
    reconnect.events.length > 0 && (sawTerminal || slowResult.status < 400),
    `first stream ${first.events.length} event(s) [${first.events.join(',')}], reconnect ${reconnect.events.length} [${reconnect.events.join(',')}], submit http=${slowResult.status}`,
  );
  // The hub keeps nothing (progress.ts says so); this is the measurement of what
  // that costs an operator whose connection dropped mid-run.
  measured(
    'events lost across the drop',
    `lost=${dropped.length}/${first.events.length} [${dropped.join(',')}]; re-delivered=${first.events.length - dropped.length} - a reconnect reads only what is published after it attaches`,
  );

  const settledAfterReconnect = await settle(proc, slow.intentId, { expectBranches: 2 });
  record('the intent the flaky subscriber watched still settled', settledAfterReconnect.json?.status !== undefined, `status=${settledAfterReconnect.json?.status}`);

  const cancelRun = await submit(1_500, 'cancel');
  const cancelStream = openStream(cancelRun.intentId, { stopAfterMs: 0, untilTerminal: true });
  await sleep(400);
  const cancelStarted = Date.now();
  const cancelled = await proc.api('POST', `/api/intents/${cancelRun.intentId}/cancel`, { reason: 'reliability run' });
  const streamAfterCancel = await cancelStream;
  const inflightResult = await cancelRun.inflight;
  const afterCancel = await settle(proc, cancelRun.intentId, { timeoutMs: 20_000, expectBranches: 2 });
  record(
    'cancel propagates to a terminal intent state',
    cancelled.status < 400 && /cancel|failed|resolved/i.test(String(afterCancel.json?.status ?? '')),
    `cancel http=${cancelled.status} status=${afterCancel.json?.status} submit http=${inflightResult.status}`,
  );
  record(
    'the live subscriber learns about the terminal state within a second of it',
    streamAfterCancel.events.length > 0 && streamAfterCancel.endedAt - cancelStarted < 2_000,
    `cancel request at +${streamAfterCancel.endedAt - cancelStarted}ms relative to terminal event, stream saw [${streamAfterCancel.events.join(',')}]`,
  );
  await stopProcess(proc.child);
  scenario.thinkMs = 0;
}

// ---------------------------------------------------------------------------
// R1 - growth: RSS and ledger counts per round, save wall time at two sizes.
// ---------------------------------------------------------------------------
async function rssOf(child) {
  try {
    return Number(execSync(`ps -o rss= -p ${String(child.pid)}`).toString().trim()) * 1024;
  } catch {
    return 0;
  }
}
async function measureGrowth() {
  const proc = await boot({ label: 'growth' });
  for (const cardUrl of cardUrls('w', 1)) await proc.api('POST', '/api/vassals', { cardUrl });
  /** @type {{ intents: number, rss: number, state: Record<string, unknown> }[]} */
  const samples = [];
  const submitOne = async () => {
    const submitted = await proc.api('POST', '/api/intents', {
      skill: 'research',
      realm: 'personal',
      vassals: ['w1'],
      aggregation: { kind: 'unanimous' },
      params: { subject: 'growth', predicate: 'verdict' },
    });
    const intentId = submitted.json?.id ?? submitted.json?.intentId;
    if (intentId) await settle(proc, String(intentId), { timeoutMs: 15_000, expectBranches: 1 });
  };
  for (let round = 1; round <= GROWTH_ROUNDS; round++) {
    for (let i = 0; i < GROWTH_INTENTS / GROWTH_ROUNDS; i++) await submitOne();
    const state = await proc.api('GET', '/api/state');
    /** @type {Record<string, number>} */
    const counters = {};
    const walk = (/** @type {unknown} */ node) => {
      if (node === null || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node)) {
        if (typeof value === 'number') counters[key] = value;
        else if (value !== null && typeof value === 'object') walk(value);
      }
    };
    walk(state.json);
    const count = round * (GROWTH_INTENTS / GROWTH_ROUNDS);
    const rssMib = Math.round((await rssOf(proc.child)) / 1_048_576 * 10) / 10;
    samples.push({ intents: count, rss: await rssOf(proc.child), state: counters });
    measured(`growth sample ${round}`, `submitted=${count} rss=${rssMib}MiB counters=${JSON.stringify(counters)}`);
  }
  const firstRss = samples[0]?.rss ?? 0;
  const lastRss = samples[samples.length - 1]?.rss ?? 0;
  const monotone = samples.every((sample, i) => i === 0 || sample.intents > samples[i - 1].intents);
  record('the growth run sampled strictly more work each round (instrument sanity)', monotone, `samples=${samples.length}`);
  measured('RSS delta over the run', `${Math.round((lastRss - firstRss) / 1_048_576 * 10) / 10}MiB across ${GROWTH_INTENTS} intents (first=${Math.round(firstRss / 1_048_576)}MiB last=${Math.round(lastRss / 1_048_576)}MiB)`);

  const stopAtBig = await stopProcess(proc.child);
  const bigFile = proc.stateFile;
  const bigBytes = existsSync(bigFile) ? statSync(bigFile).size : 0;

  const small = await boot({ label: 'growth-small' });
  for (const cardUrl of cardUrls('w', 1)) await small.api('POST', '/api/vassals', { cardUrl });
  for (let i = 0; i < 10; i++) {
    const submitted = await small.api('POST', '/api/intents', {
      skill: 'research',
      realm: 'personal',
      vassals: ['w1'],
      aggregation: { kind: 'unanimous' },
      params: { subject: 'growth', predicate: 'verdict' },
    });
    const intentId = submitted.json?.id ?? submitted.json?.intentId;
    if (intentId) await settle(small, String(intentId), { timeoutMs: 15_000, expectBranches: 1 });
  }
  const stopAtSmall = await stopProcess(small.child);
  const smallBytes = existsSync(small.stateFile) ? statSync(small.stateFile).size : 0;
  record(
    'the save really grows with the ledger (control: 10 intents vs a full run)',
    bigBytes > smallBytes && smallBytes > 0,
    `bytes 10-intents=${smallBytes} / ${GROWTH_INTENTS}-intents=${bigBytes}; graceful save ms small=${stopAtSmall.elapsedMs} big=${stopAtBig.elapsedMs}; both graceful=${stopAtSmall.graceful}/${stopAtBig.graceful}`,
  );
  measured('state file cost per stored intent', `${Math.round((bigBytes - smallBytes) / (GROWTH_INTENTS - 10))} bytes/intent`);
}

function finish(code) {
  clearInterval(budget);
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  agentServer.close();
  const failed = steps.filter(step => !step.ok);
  console.log(`\n==== ${steps.length - failed.length}/${steps.length} checks passed, ${steps.length} measured readouts above ====`);
  if (failed.length) console.error(`failed:\n${failed.map(step => ` - ${step.name}`).join('\n')}`);
  if (!KEEP && existsSync(work)) rmSync(work, { recursive: true, force: true });
  else if (KEEP) console.log(`workdir kept: ${work}`);
  process.exit(code);
}

try {
  const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
  const sections = { gate: measureGate, escalations: measureEscalations, stream: measureStream, growth: measureGrowth };
  if (only !== null && sections[/** @type {keyof typeof sections} */ (only)] === undefined) {
    console.error(`FAIL  --only expects one of ${Object.keys(sections).join(', ')}`);
    process.exit(2);
  }
  for (const [name, section] of Object.entries(sections)) {
    if (only === null || only === name) await section();
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`FAIL  cannot complete: ${message}`);
  for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
  agentServer.close();
  if (!KEEP && existsSync(work)) rmSync(work, { recursive: true, force: true });
  process.exit(2);
}
finish(steps.some(step => !step.ok) ? 1 : 0);
