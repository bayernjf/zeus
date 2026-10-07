import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import type { DispatchPort, FanOutRequest, FanOutResult, TargetLookup } from '../src/orchestrator/types.js';
import type { DispatchRequest, DispatchResult } from '../src/dispatch/dispatcher.js';
import type { A2AEvent, Task, TaskState } from '../src/a2a/types.js';
import { OversightDesk } from '../src/oversight/oversight.js';
import type { Escalation } from '../src/oversight/types.js';
import {
  IntentArchive,
  archiveFilePath,
  parseRetentionMode,
  selectArchivable,
  type RetentionMode,
} from '../src/state/archive.js';
import { bootKernel } from '../src/state/boot.js';
import { createHttpServer } from '../src/http/server.js';
import { VassalRegistry } from '../src/registry/registry.js';
import { Ed25519MemorySigner } from '../src/registry/signing.js';
import type { FastifyInstance } from 'fastify';

// ---- fixtures ---------------------------------------------------------------

function statusEvent(taskId: string, state: TaskState, timestamp?: string): A2AEvent {
  return {
    kind: 'status-update',
    taskId,
    contextId: 'ctx',
    status: { state, ...(timestamp ? { timestamp } : {}) },
    final: state === 'completed' || state === 'failed',
  };
}

function stanceResult(vassal: string, stance: string, state: TaskState = 'completed'): DispatchResult {
  const task: Task = {
    kind: 'task',
    id: `${vassal}-task`,
    contextId: 'ctx',
    status: { state },
    artifacts: [{ artifactId: 'a1', name: 'verdict', parts: [{ kind: 'data', data: { stance } }] }],
  };
  return { ok: true, task, events: [statusEvent(task.id, state)], injectedHits: [] };
}

function makePort(routes: Record<string, DispatchResult | ((req: DispatchRequest) => DispatchResult)>): DispatchPort & { calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async dispatch(req) {
      calls += 1;
      const route = routes[req.vassal!];
      return typeof route === 'function' ? route(req) : route!;
    },
    async cancel() {},
  };
}

function lookupFor(names: string[]): TargetLookup {
  return { findBySkill: () => names.map(name => ({ name })) };
}

function makeIntent(id: string, createdAt: string, overrides: Partial<FanOutResult> = {}): FanOutResult {
  return {
    intentId: id,
    runId: `run-${id}`,
    skill: 'decide',
    realm: 'personal',
    createdAt,
    status: 'completed',
    branches: [{ vassal: 'loom', runId: `run-${id}:loom`, ok: true, events: [statusEvent('t', 'completed', createdAt)] }],
    stream: [
      { source: { vassal: 'loom', runId: `run-${id}:loom`, taskId: 't' }, event: statusEvent('t', 'completed', createdAt) },
    ],
    positions: [{ vassal: 'loom', stance: 'go', weight: 1 }],
    decision: { rule: 'unanimous', conclusion: 'go', reason: 'all agree', positions: [{ vassal: 'loom', stance: 'go', weight: 1 }] },
    conflicts: [],
    ...overrides,
  };
}

function requestFor(id: string, params: Record<string, unknown> = { ticket: id }): FanOutRequest {
  return { intentId: id, skill: 'decide', params, realm: 'personal' };
}

function pendingIntentConflict(escalationId: string, intentId: string): Escalation {
  return {
    id: escalationId,
    kind: 'intent-conflict',
    runId: `run-${intentId}`,
    vassal: '(intent)',
    skill: 'decide',
    realm: 'personal',
    reason: 'split',
    options: ['go', 'no'],
    status: 'pending',
    createdAt: '2026-01-01T00:00:00.000Z',
    intentId,
  };
}

function pendingTaskInput(escalationId: string, runId: string, vassal: string): Escalation {
  return {
    id: escalationId,
    kind: 'task-input',
    runId,
    vassal,
    skill: 'decide',
    realm: 'personal',
    reason: 'input needed',
    options: [],
    status: 'pending',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function decidedEscalation(escalationId: string, intentId: string): Escalation {
  return {
    ...pendingIntentConflict(escalationId, intentId),
    status: 'approved',
    decidedAt: '2026-02-01T00:00:00.000Z',
  };
}

const NOW = () => new Date('2026-03-01T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

// ---- pure selection ----------------------------------------------------------

describe('selectArchivable (deferred #42 out-window selection)', () => {
  const opts = { maxEntries: 1000, windowMs: 30 * DAY, now: NOW };

  it('keeps everything when both bounds hold', () => {
    const intents = [makeIntent('a', '2026-02-20T00:00:00.000Z'), makeIntent('b', '2026-02-22T00:00:00.000Z')];
    expect(selectArchivable(intents, [], opts)).toEqual([]);
  });

  it('out-windows the oldest intents over the count cap, oldest first', () => {
    const intents = Array.from({ length: 12 }, (_, i) =>
      makeIntent(`i${i}`, `2026-02-${String(10 + i).padStart(2, '0')}T00:00:00.000Z`),
    );
    expect(selectArchivable(intents, [], { ...opts, maxEntries: 10 })).toEqual([
      'i0', 'i1',
    ]);
  });

  it('out-windows records older than the window', () => {
    const intents = [
      makeIntent('old', '2026-01-15T00:00:00.000Z'),
      makeIntent('young', '2026-02-25T00:00:00.000Z'),
    ];
    expect(selectArchivable(intents, [], opts)).toEqual(['old']);
  });

  it('applies both conditions before anything leaves (count then window)', () => {
    // 15 intents, 4 of them over 30 days: 4 leave on the window condition;
    // the remaining 11 are still over the cap of 8, so the oldest 3 of those
    // leave too. Everything within the window stays.
    const intents = [
      ...Array.from({ length: 4 }, (_, i) => makeIntent(`old${i}`, '2026-01-10T00:00:00.000Z')),
      ...Array.from({ length: 11 }, (_, i) => makeIntent(`now${i}`, `2026-02-${String(10 + i).padStart(2, '0')}T00:00:00.000Z`)),
    ];
    const out = selectArchivable(intents, [], { ...opts, maxEntries: 8 });
    expect(out).toHaveLength(7);
    expect(out.slice(0, 4)).toEqual(['old0', 'old1', 'old2', 'old3']);
    expect(intents.map(i => i.intentId).filter(id => !out.includes(id))).toHaveLength(8);
  });

  it('keeps an intent a pending intent-conflict escalation references', () => {
    const intents = [makeIntent('a', '2026-01-10T00:00:00.000Z')];
    expect(selectArchivable(intents, [pendingIntentConflict('e1', 'a')], opts)).toEqual([]);
  });

  it('keeps an intent a pending task-input escalation references (via branch match)', () => {
    const intent = makeIntent('a', '2026-01-10T00:00:00.000Z');
    expect(selectArchivable([intent], [pendingTaskInput('e1', 'run-a:loom', 'loom')], opts)).toEqual([]);
  });

  it('keeps an intent a human already ruled on (decided escalation or driver resolution)', () => {
    const decided = makeIntent('a', '2026-01-10T00:00:00.000Z');
    expect(selectArchivable([decided], [decidedEscalation('e1', 'a')], opts)).toEqual([]);
    const resolved = makeIntent('b', '2026-01-10T00:00:00.000Z', {
      driverResolution: { escalationId: 'e1', stance: 'go', decidedAt: '2026-02-01T00:00:00.000Z' },
    });
    expect(selectArchivable([resolved], [], opts)).toEqual([]);
  });

  it('a referenced-but-windowed intent is still kept (promise outranks space)', () => {
    const intents = [
      makeIntent('kept', '2026-01-01T00:00:00.000Z'),
      makeIntent('free', '2026-01-02T00:00:00.000Z'),
    ];
    expect(selectArchivable(intents, [pendingIntentConflict('e1', 'kept')], opts)).toEqual(['free']);
  });
});

// ---- JSONL archive behaviour --------------------------------------------------

describe('IntentArchive (append-only JSONL)', () => {
  let dir: string;
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('appends records, dedupes by intentId, rebuilds its index on restart', async () => {
    dir = await mkdtemp(join(tmpdir(), 'zeus-archive-'));
    const file = join(dir, 'intent-archive.jsonl');
    const archive = new IntentArchive(file);

    const record = {
      intentId: 'a',
      ts: '2026-03-01T00:00:00.000Z',
      createdAt: '2026-01-10T00:00:00.000Z',
      status: 'completed' as const,
      request: requestFor('a'),
      result: makeIntent('a', '2026-01-10T00:00:00.000Z'),
    };
    await archive.append([record]);
    await archive.append([record]); // duplicate: skipped
    expect((await readFile(file, 'utf8')).split('\n').filter(Boolean)).toHaveLength(1);

    await expect(archive.find('a')).resolves.toMatchObject({ intentId: 'a' });
    await expect(archive.find('missing')).resolves.toBeUndefined();
    await expect(archive.findByBranch('run-a:loom', 'loom')).resolves.toBe('a');

    // A fresh instance re-reads the same file (restart semantics).
    const reopened = new IntentArchive(file);
    await reopened.loadIndex();
    await expect(reopened.find('a')).resolves.toMatchObject({ intentId: 'a' });
  });

  it('loadIndex on a missing file is empty, not an error', async () => {
    dir = await mkdtemp(join(tmpdir(), 'zeus-archive-'));
    const archive = new IntentArchive(join(dir, 'nope.jsonl'));
    await archive.loadIndex();
    expect(archive.size()).toBe(0);
  });
});

// ---- parse / path ---------------------------------------------------------------

describe('retention config', () => {
  it('parses the three modes and rejects unknown values', () => {
    expect(parseRetentionMode(undefined)).toBe('retain');
    expect(parseRetentionMode('archive')).toBe('archive');
    expect(parseRetentionMode('evict')).toBe('evict');
    expect(() => parseRetentionMode('purge')).toThrow(/ZEUS_INTENT_RETENTION/);
  });

  it('places the archive beside the state file', () => {
    expect(archiveFilePath('/srv/zeus/data/kernel.json')).toBe('/srv/zeus/data/intent-archive.jsonl');
  });
});

// ---- orchestrator wiring ---------------------------------------------------------

describe('Orchestrator archive wiring (deferred #42)', () => {
  it('fanOut replays an archived intent with zero dispatch', async () => {
    const archived: FanOutResult = makeIntent('a', '2026-01-10T00:00:00.000Z');
    const request = requestFor('a');
    const archive = {
      async find(id: string) {
        return id === 'a' ? { intentId: 'a', ts: 't', createdAt: archived.createdAt, status: archived.status, request, result: archived } : undefined;
      },
      async findByBranch() {
        return undefined;
      },
    };
    const port = makePort({ loom: stanceResult('loom', 'go') });
    const orch = new Orchestrator(lookupFor(['loom']), port, { archive });
    const result = await orch.fanOut(request);
    expect(result.replayed).toBe(true);
    expect(port.calls).toBe(0); // zero dispatch — the F2 promise survives out-windowing
  });

  it('fanOut still rejects a materially different request on an archived key', async () => {
    const archived: FanOutResult = makeIntent('a', '2026-01-10T00:00:00.000Z');
    const archive = {
      async find(id: string) {
        return id === 'a' ? { intentId: 'a', ts: 't', createdAt: archived.createdAt, status: archived.status, request: requestFor('a'), result: archived } : undefined;
      },
      async findByBranch() {
        return undefined;
      },
    };
    const port = makePort({ loom: stanceResult('loom', 'go') });
    const orch = new Orchestrator(lookupFor(['loom']), port, { archive });
    await expect(orch.fanOut(requestFor('a', { ticket: 'different' }))).rejects.toThrow();
  });

  it('findIntentForBranchRun searches the archive when the state table misses', async () => {
    const archive = {
      async find() {
        return undefined;
      },
      async findByBranch(runId: string, vassal: string) {
        return runId === 'run-ghost:loom' && vassal === 'loom' ? 'ghost' : undefined;
      },
    };
    const orch = new Orchestrator(lookupFor([]), makePort({}), { archive });
    await expect(orch.findIntentForBranchRun('run-ghost:loom', 'loom')).resolves.toBe('ghost');
    await expect(orch.findIntentForBranchRun('run-other:loom', 'loom')).resolves.toBeUndefined();
  });

  it('removeIntents drops settled results and their requests only', async () => {
    const orch = new Orchestrator(lookupFor(['loom']), makePort({ loom: stanceResult('loom', 'go') }), {
      newIntentId: () => 'keep',
    });
    const result = await orch.fanOut(requestFor('keep'));
    orch.removeIntents(['keep', 'never-existed']);
    expect(orch.counts().intents).toBe(0);
    expect(orch.getIntent('keep')).toBeUndefined();
    expect(result.intentId).toBe('keep');
  });
});

// ---- boot integration ------------------------------------------------------------

describe('bootKernel retention (deferred #42)', () => {
  let dir: string;
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function bootWith(retention: RetentionMode, maxEntries: number) {
    dir = await mkdtemp(join(tmpdir(), 'zeus-retention-'));
    const stateFile = join(dir, 'kernel.json');
    const kernel = await bootKernel({
      stateFile,
      intentRetention: retention,
      intentRetentionMaxEntries: maxEntries,
      now: NOW,
      vassalSeeds: [],
      dispatchAudit: () => {},
      oversightAudit: () => {},
    });
    return { kernel, stateFile };
  }

  it('archive mode: saveState out-windows settled intents into the JSONL; a re-fanOut replays with zero dispatch', async () => {
    const { kernel, stateFile } = await bootWith('archive', 2);
    const requestA = requestFor('a');
    // Seed the state table with three settled intents (no live vassals in a
    // bare kernel; retention operates on the table, not on who produced it).
    kernel.orchestrator.importState({
      intents: [
        // All within the 30-day window, so only the count cap applies.
        makeIntent('a', '2026-02-10T00:00:00.000Z'),
        makeIntent('b', '2026-02-12T00:00:00.000Z'),
        makeIntent('c', '2026-02-14T00:00:00.000Z'),
      ],
      requests: [
        { intentId: 'a', request: requestA },
        { intentId: 'b', request: requestFor('b') },
        { intentId: 'c', request: requestFor('c') },
      ],
    });
    expect(kernel.orchestrator.exportState().intents.length).toBe(3);

    await kernel.saveState();
    // Cap is 2 → 'a' (oldest) left the table for the archive.
    expect(kernel.orchestrator.exportState().intents.length).toBe(2);
    const archive = new IntentArchive(archiveFilePath(stateFile));
    await archive.loadIndex();
    await expect(archive.find('a')).resolves.toMatchObject({ intentId: 'a', status: 'completed' });

    // F2 promise: the archived intent replays, and a real dispatcher would not fire.
    const replays = await kernel.orchestrator.fanOut(requestA);
    expect(replays.replayed).toBe(true);
  });

  it('evict mode: out-window intents are dropped outright and nothing is archived', async () => {
    const { kernel, stateFile } = await bootWith('evict', 1);
    for (const id of ['a', 'b']) {
      await kernel.orchestrator.fanOut(requestFor(id));
    }
    await kernel.saveState();
    expect(kernel.orchestrator.exportState().intents.length).toBe(1);
    await expect(readFile(archiveFilePath(stateFile), 'utf8')).rejects.toThrow(/ENOENT/);
  });

  it('retain mode (default) keeps everything', async () => {
    const { kernel } = await bootWith('retain', 1);
    for (const id of ['a', 'b']) {
      await kernel.orchestrator.fanOut(requestFor(id));
    }
    await kernel.saveState();
    expect(kernel.orchestrator.exportState().intents.length).toBe(2);
  });
});

// ---- HTTP face ------------------------------------------------------------

describe('replay HTTP face (deferred #42)', () => {
  let dir: string;
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  });

  async function serveWith(archive?: { record?: Parameters<IntentArchive['append']>[0][number] }, retention?: RetentionMode) {
    dir = await mkdtemp(join(tmpdir(), 'zeus-replay-'));
    const file = join(dir, 'intent-archive.jsonl');
    const intentArchive = new IntentArchive(file);
    if (archive?.record) await intentArchive.append([archive.record]);

    const port = makePort({ loom: stanceResult('loom', 'go') });
    const orch = new Orchestrator(lookupFor(['loom']), port, { archive: intentArchive });
    const oversight = new OversightDesk({ newId: () => 'esc-1' });
    app = await createHttpServer({
      registry: new VassalRegistry(),
      signer: new Ed25519MemorySigner('k'),
      internalToken: 't',
      orchestrator: orch,
      oversight,
      metrics: undefined as never,
      intentArchive,
      ...(retention ? { retention } : {}),
    });
    return { orch, intentArchive };
  }

  it('replays from the archive when the state table misses', async () => {
    const record = {
      intentId: 'archived-1',
      ts: '2026-03-01T00:00:00.000Z',
      createdAt: '2026-01-10T00:00:00.000Z',
      status: 'completed' as const,
      request: requestFor('archived-1'),
      result: makeIntent('archived-1', '2026-01-10T00:00:00.000Z'),
    };
    await serveWith({ record });
    const res = await app.inject({ method: 'GET', url: '/api/intents/archived-1/replay', headers: { authorization: 'Bearer t' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.intentId).toBe('archived-1');
    expect(body.status).toBe('completed');
    expect(body.input).toEqual({ ticket: 'archived-1' });
  });

  it('replay 404s with an eviction marker when retention is evict', async () => {
    await serveWith(undefined, 'evict');
    const res = await app.inject({ method: 'GET', url: '/api/intents/ghost/replay', headers: { authorization: 'Bearer t' } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'not_found', archived: false, evicted: true });
  });

  it('replay 404s plainly when retention is retain', async () => {
    await serveWith();
    const res = await app.inject({ method: 'GET', url: '/api/intents/ghost/replay', headers: { authorization: 'Bearer t' } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found', detail: 'unknown intent: ghost' });
  });
});
