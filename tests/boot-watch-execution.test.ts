import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootKernel } from '../src/state/boot.js';
import { Ed25519MemorySigner } from '../src/registry/signing.js';
import { issueDelegationContract } from '../src/delegation/delegation-contract.js';
import type { WatchRegistry } from '../src/watch/watch.js';
import type { AuditEntry } from '../src/dispatch/dispatcher.js';

/**
 * design-self-host-loop §7 step 4, proved on the assembled kernel: an
 * unattended execute watch derives a real one-time child ticket from its
 * signed contract, that ticket passes the orchestrator's execute gate, and the
 * dispatch actually happens. Every failure mode (no signer, no contract, a
 * ceiling) must instead produce zero outbound and a desk escalation.
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
const TICK_AT = new Date('2026-10-05T12:00:00.000Z');
const WINDOW = new Date(TICK_AT.getTime() + 3_600_000).toISOString();

function registerExecuteWatch(watches: WatchRegistry, delegationId: string) {
  watches.register({
    id: 'w1',
    owner: 'operator@bayjf',
    realm: 'personal',
    predicate: { source: 'metrics', op: 'above', field: 'finished', value: -1 },
    intent: { skill: 'review', subject: 'queue is deep', mode: 'execute', maxFanOut: 1 },
    delegationId,
    intervalSeconds: 60,
    startsAt: '2026-10-05T11:00:00.000Z',
    expiresAt: '2026-10-05T13:00:00.000Z',
    budget: { fires: 1, executes: 1 },
  });
}

describe('an execute watch on a booted kernel (step 4)', () => {
  let dir = '';
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'zeus-boot-watch-exec-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('derives a child ticket from the signed contract and really executes', async () => {
    const audits: AuditEntry[] = [];
    const signer = new Ed25519MemorySigner('zeus-rsk-dev');
    const kernel = await bootKernel({
      now: () => TICK_AT,
      fetchImpl: vassalFetch(),
      vassalSeeds: seeds,
      driverSigner: signer,
      dispatchAudit: entry => audits.push(entry),
    });

    const contract = await issueDelegationContract(
      {
        grantedBy: 'operator@bayjf',
        skill: 'review',
        capabilities: ['execute'],
        limits: { maxChildTickets: 2, maxConcurrent: 1, windowEndsAt: WINDOW },
      },
      { signer, now: () => TICK_AT },
    );
    kernel.delegationContracts!.add(contract);
    registerExecuteWatch(kernel.watches!, contract.id);

    const report = await kernel.runWatchTick(TICK_AT);
    expect(report.fired).toEqual(['w1']);

    // The intent really ran in execute mode and completed against the vassal.
    const intent = kernel.orchestrator.getIntent('watch:w1:1');
    expect(intent?.status).toBe('completed');
    expect(intent?.branches.every(branch => branch.ok)).toBe(true);

    // The contract slot was spent then released when the dispatch settled, so
    // maxConcurrent is not permanently consumed by a finished fire.
    const stored = kernel.delegationContracts!.get(contract.id)!;
    expect(stored.used.childTickets).toBe(1);
    expect(stored.used.inFlight).toBe(0);

    expect(audits.some(entry => entry.decision === 'delegation-child-issued')).toBe(true);
    expect(kernel.oversight.list(undefined, 'delegation-limit')).toHaveLength(0);
  });

  it('escalates with zero outbound when the named contract does not exist', async () => {
    const signer = new Ed25519MemorySigner('zeus-rsk-dev');
    const kernel = await bootKernel({
      now: () => TICK_AT,
      fetchImpl: vassalFetch(),
      vassalSeeds: seeds,
      driverSigner: signer,
    });
    registerExecuteWatch(kernel.watches!, 'missing-contract');

    const report = await kernel.runWatchTick(TICK_AT);
    expect(report.fired).toEqual([]);
    expect(kernel.orchestrator.getIntent('watch:w1:1')).toBeUndefined();

    const rows = kernel.oversight.list('pending', 'delegation-limit');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.limitReason).toBe('unknown-contract');
    expect(rows[0]!.watchId).toBe('w1');
    expect(kernel.watches!.get('w1')!.used.executes).toBe(0);
  });

  it('fails closed to a desk escalation when no driver signer is assembled', async () => {
    const kernel = await bootKernel({ now: () => TICK_AT, fetchImpl: vassalFetch(), vassalSeeds: seeds });
    registerExecuteWatch(kernel.watches!, 'contract-1');

    const report = await kernel.runWatchTick(TICK_AT);
    expect(report.fired).toEqual([]);
    expect(kernel.orchestrator.getIntent('watch:w1:1')).toBeUndefined();

    const rows = kernel.oversight.list('pending', 'delegation-limit');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.limitReason).toBe('no-trust-anchor');
  });
});
