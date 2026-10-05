import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootKernel } from '../src/state/boot.js';
import type { AuditEntry } from '../src/dispatch/dispatcher.js';

/**
 * design-self-host-loop §3.2 step 2, proved on a real kernel rather than on a
 * registry with stubs: a satisfied watch must raise exactly one real intent, and
 * the budget it spent must come back after a restart. Both are properties about
 * the assembled process - a watch that fires in a unit test and cannot fire in
 * boot is the gap this file exists to close.
 */

function cardFor(name: string) {
  return {
    name,
    url: `http://127.0.0.1/${name}/api/a2a/tasks`,
    version: '0.1.0',
    provider: { organization: 'bayjf', url: 'http://bayjf.test' },
    capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: true },
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    skills: [{ id: 'review', name: 'Review', description: '', tags: [] }],
    authentication: { schemes: ['bearer'] },
    preferredTransport: 'JSONRPC',
    'x-zeus-fealty': {
      version: '1', swornTo: 'zeus', domain: 'test-domain',
      dataRealms: ['personal', 'enterprise'], dataPolicy: 'read-task-scope',
      reportBack: true, escalationPolicy: 'auto',
    },
  };
}

function vassalFetch(): typeof fetch {
  return (async (input: unknown) => {
    const url = String(input);
    const name = url.split('/')[3]!;
    if (url.includes('/api/a2a/agent-card')) {
      return new Response(JSON.stringify(cardFor(name)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const taskId = `${name}-task`;
    const task = {
      kind: 'task',
      id: taskId,
      contextId: 'ctx',
      status: { state: 'completed' },
      artifacts: [{ artifactId: 'a', name: 'verdict', parts: [{ kind: 'data', data: { stance: 'approve' } }] }],
    };
    const frames = [
      `data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { kind: 'status-update', taskId, contextId: 'ctx', status: { state: 'working' }, final: false } })}\n\n`,
      `data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: task })}\n\n`,
    ];
    return new Response(frames.join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }) as typeof fetch;
}

const seeds = ['http://127.0.0.1/loom/api/a2a/agent-card'];

describe('a watch fires on a booted kernel', () => {
  let dir = '';
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'zeus-boot-watch-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('raises exactly one real intent and records it on the audit spine', async () => {
    const audits: AuditEntry[] = [];
    const kernel = await bootKernel({
      fetchImpl: vassalFetch(),
      vassalSeeds: seeds,
      dispatchAudit: entry => audits.push(entry),
    });

    kernel.watches!.register({
      id: 'w1',
      owner: 'operator@bayjf',
      realm: 'personal',
      // metrics.finished is 0 at boot, so this predicate holds immediately.
      predicate: { source: 'metrics', op: 'above', field: 'finished', value: -1 },
      intent: { skill: 'review', subject: 'queue is deep', mode: 'plan', maxFanOut: 1 },
      intervalSeconds: 60,
      startsAt: '2026-10-05T11:00:00.000Z',
      expiresAt: '2026-10-05T13:00:00.000Z',
      budget: { fires: 1, executes: 0 },
    });

    const report = await kernel.runWatchTick(new Date('2026-10-05T12:00:00.000Z'));
    expect(report.fired).toEqual(['w1']);

    // The intent really exists in the orchestrator's table, named by the
    // deterministic id - not merely reported as fired.
    const intent = kernel.orchestrator.getIntent('watch:w1:1');
    expect(intent?.branches.map(branch => branch.vassal)).toEqual(['loom']);
    expect(intent?.status).toBe('completed');
    expect(audits.some(entry => entry.decision === 'watch-fired')).toBe(true);

    // Budget spent: a second tick within the interval must not fire again.
    const second = await kernel.runWatchTick(new Date('2026-10-05T12:00:01.000Z'));
    expect(second.evaluated).toBe(0);
  });

  it('brings the spent budget back after a restart', async () => {
    const file = join(dir, 'kernel-state.json');
    const first = await bootKernel({ fetchImpl: vassalFetch(), vassalSeeds: seeds, stateFile: file });
    first.watches!.register({
      id: 'w1',
      owner: 'operator@bayjf',
      realm: 'personal',
      predicate: { source: 'metrics', op: 'above', field: 'finished', value: -1 },
      intent: { skill: 'review', subject: 'queue is deep', mode: 'plan', maxFanOut: 1 },
      intervalSeconds: 60,
      startsAt: '2026-10-05T11:00:00.000Z',
      expiresAt: '2026-10-05T13:00:00.000Z',
      budget: { fires: 1, executes: 0 },
    });
    await first.runWatchTick(new Date('2026-10-05T12:00:00.000Z'));
    expect(first.watches!.get('w1')!.used.fires).toBe(1);
    await first.saveState();

    const restarted = await bootKernel({ fetchImpl: vassalFetch(), stateFile: file });
    expect(restarted.restoredFromSnapshot).toBe(true);
    // A reset budget would make every restart an unbounded trigger, which is
    // exactly the failure this persistence exists to prevent.
    expect(restarted.watches!.get('w1')!.used.fires).toBe(1);
    const after = await restarted.runWatchTick(new Date('2026-10-05T12:05:00.000Z'));
    expect(after.fired).toEqual([]);
  });
});
