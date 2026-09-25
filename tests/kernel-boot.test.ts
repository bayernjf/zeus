import { existsSync, statSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VassalRegistry } from '../src/registry/registry.js';
import { OversightDesk } from '../src/oversight/oversight.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import type { DispatchPort, TargetLookup } from '../src/orchestrator/types.js';
import type { DispatchRequest, DispatchResult } from '../src/dispatch/dispatcher.js';
import type { A2AEvent, Task } from '../src/a2a/types.js';
import { bootKernel, KernelBootError, resolveAuditConfig, resolveConcurrencyConfig } from '../src/state/boot.js';
import { DEFAULT_AUDIT_KEEP, DEFAULT_AUDIT_MAX_BYTES, readAuditLog } from '../src/dispatch/audit.js';
import {
  FileKernelStateStore,
  KernelStateError,
  collectKernelState,
} from '../src/state/kernel-state.js';

function cardFor(name: string) {
  return {
    name,
    url: `http://127.0.0.1/${name}/api/a2a/tasks`,
    version: '0.1.0',
    provider: { organization: 'bayjf' },
    capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: true },
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    skills: [{ id: `skill-${name}`, name, description: '', tags: [] }],
    authentication: { schemes: ['bearer'] },
    preferredTransport: 'JSONRPC',
    'x-zeus-fealty': { version: '1', swornTo: 'zeus', domain: 'test-domain', dataRealms: ['personal', 'enterprise'], dataPolicy: 'read-task-scope', reportBack: true, escalationPolicy: 'auto' },
  };
}
const mockFetch = (name: string) =>
  (async () =>
    new Response(JSON.stringify(cardFor(name)), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;

function stanceResult(vassal: string, stance: string): DispatchResult {
  const task: Task = {
    kind: 'task', id: `${vassal}-t`, contextId: 'ctx', status: { state: 'completed' },
    artifacts: [{ artifactId: 'a', name: 'r', parts: [{ kind: 'data', data: { stance } }] }],
  };
  const event: A2AEvent = {
    kind: 'status-update', taskId: task.id, contextId: 'ctx', status: { state: 'completed' }, final: true,
  };
  return { ok: true, task, events: [event], injectedHits: [] };
}
const portFor = (routes: Record<string, DispatchResult>): DispatchPort => ({
  async dispatch(req: DispatchRequest) {
    return routes[req.vassal!];
  },
  async cancel() {},
});
const emptyLookup: TargetLookup = { findBySkill: () => [] };

describe('E5.3 bootKernel assembly', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'zeus-boot-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('assembles all four components and stays in-memory without stateFile', async () => {
    const kernel = await bootKernel();
    expect(kernel.stateFile).toBeNull();
    expect(kernel.restoredFromSnapshot).toBe(false);
    expect(kernel.snapshot).toBeNull();
    // no-op, must not throw or create files
    await kernel.saveState();
    expect(kernel.registry.listAll()).toEqual([]);
    expect(kernel.oversight.list()).toEqual([]);
  });

  it('reports first boot when the state file does not exist yet, then persists on saveState', async () => {
    const file = join(dir, 'kernel-state.json');
    const first = await bootKernel({ stateFile: file, fetchImpl: mockFetch('loom') });
    expect(first.restoredFromSnapshot).toBe(false);
    await first.registry.register('http://x/loom/api/a2a/agent-card');
    first.oversight.importState([
      {
        id: 'esc-1', kind: 'task-input', runId: 'r1', vassal: 'loom', skill: 's1',
        taskId: 'task-1', realm: 'personal', reason: 'need approval', options: ['proceed'],
        status: 'pending', createdAt: '2026-09-22T00:00:00.000Z',
      },
    ]);
    await first.saveState();

    const second = await bootKernel({ stateFile: file, fetchImpl: mockFetch('unused') });
    expect(second.restoredFromSnapshot).toBe(true);
    expect(second.registry.list().map(v => v.card.name)).toEqual(['loom']);
    expect(second.oversight.list().map(e => e.id)).toEqual(['esc-1']);
  });

  it('restores orchestrator intents so a replayed fan-out is zero-dispatch after restart', async () => {
    const file = join(dir, 'nested', 'state.json');

    // Seed a snapshot built the same way a live kernel would produce it.
    const registry = new VassalRegistry(mockFetch('loom'));
    await registry.register('http://x/loom/api/a2a/agent-card');
    const oversight = new OversightDesk();
    const port = portFor({ loom: stanceResult('loom', 'go') });
    const orchestrator = new Orchestrator(emptyLookup, port, {
      newIntentId: () => 'i1',
      newRunId: () => 'r1',
    });
    await orchestrator.fanOut({
      intentId: 'intent-restore', skill: 's', vassals: ['loom'], params: {}, realm: 'personal',
    });
    const store = new FileKernelStateStore(file);
    await store.save(collectKernelState({ registry, oversight, orchestrator }));

    // Fresh boot from disk; the assembled dispatcher has no live vassal but a
    // replayed intent must never reach it.
    const restored = await bootKernel({ stateFile: file, fetchImpl: mockFetch('unused') });
    expect(restored.snapshot?.orchestrator.intents).toHaveLength(1);
    expect(restored.orchestrator.getIntent('intent-restore')?.status).toBe('completed');
    const replay = await restored.orchestrator.fanOut({
      intentId: 'intent-restore', skill: 's', vassals: ['loom'], params: {}, realm: 'personal',
    });
    expect(replay.replayed).toBe(true);
    expect(replay.status).toBe('completed');
  });

  it('rejects a corrupt snapshot during boot', async () => {
    const file = join(dir, 'bad.json');
    await writeFile(file, '{ not json', 'utf8');
    await expect(bootKernel({ stateFile: file })).rejects.toBeInstanceOf(KernelStateError);
  });

  it('writes the audit spine to JSONL and still forwards each entry to the caller sink', async () => {
    const auditFile = join(dir, 'audit.jsonl');
    const seen: string[] = [];
    const kernel = await bootKernel({
      fetchImpl: mockFetch('loom'),
      vassalSeeds: ['http://127.0.0.1/loom/card.json'],
      auditFile,
      dispatchAudit: entry => void seen.push(`${entry.vassal}:${entry.decision}`),
    });
    expect(kernel.auditFile).toBe(auditFile);
    expect(kernel.registry.revoke('loom')).toBe(true);

    // E4.7's governance bridge: a revocation is an audit event, not just a hook.
    expect(readAuditLog(auditFile).map(e => e.decision)).toEqual(['vassal-revoked']);
    expect(seen).toEqual(['loom:vassal-revoked']);
  });

  it('stays silent when no audit file or sink is configured', async () => {
    const kernel = await bootKernel({
      fetchImpl: mockFetch('loom'),
      vassalSeeds: ['http://127.0.0.1/loom/card.json'],
    });
    expect(kernel.auditFile).toBeNull();
    expect(kernel.registry.revoke('loom')).toBe(true);
  });
});

describe('E1.5 resolveConcurrencyConfig', () => {
  it('leaves the kernel unbounded when nothing is configured', () => {
    expect(resolveConcurrencyConfig({})).toEqual({});
    expect(resolveConcurrencyConfig({ ZEUS_MAX_CONCURRENT_BRANCHES: '' })).toEqual({});
  });

  it('reads a cap and a queue limit, including a zero limit that refuses instead of waiting', () => {
    expect(resolveConcurrencyConfig({
      ZEUS_MAX_CONCURRENT_BRANCHES: '8',
      ZEUS_BRANCH_QUEUE_LIMIT: '0',
    })).toEqual({ maxConcurrentBranches: 8, branchQueueLimit: 0 });
  });

  it('fails the boot on a cap it would otherwise silently ignore', () => {
    expect(() => resolveConcurrencyConfig({ ZEUS_MAX_CONCURRENT_BRANCHES: 'auto' })).toThrow(KernelBootError);
    expect(() => resolveConcurrencyConfig({ ZEUS_MAX_CONCURRENT_BRANCHES: '0' })).toThrow(/>= 1/);
    expect(() => resolveConcurrencyConfig({ ZEUS_MAX_CONCURRENT_BRANCHES: '2.5' })).toThrow(/ZEUS_MAX_CONCURRENT_BRANCHES/);
    expect(() => resolveConcurrencyConfig({ ZEUS_BRANCH_QUEUE_LIMIT: '-3' })).toThrow(/>= 0/);
  });
});

describe('audit rotation config', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'zeus-audit-boot-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('defaults to the sink ceiling when nothing is set', async () => {
    const kernel = await bootKernel({ auditFile: join(dir, 'audit.jsonl') });
    expect(kernel.auditMaxBytes).toBe(DEFAULT_AUDIT_MAX_BYTES);
    expect(kernel.auditKeep).toBe(DEFAULT_AUDIT_KEEP);
  });

  it('honours an explicit ceiling and generation count', () => {
    expect(resolveAuditConfig({
      ZEUS_AUDIT_MAX_BYTES: '1048576',
      ZEUS_AUDIT_KEEP: '3',
    })).toEqual({ auditMaxBytes: 1048576, auditKeep: 3 });
  });

  it('treats 0/off/unlimited as a deliberate opt-out rather than a typo', () => {
    expect(resolveAuditConfig({ ZEUS_AUDIT_MAX_BYTES: 'unlimited' })).toEqual({
      auditMaxBytes: Number.POSITIVE_INFINITY,
    });
    expect(resolveAuditConfig({ ZEUS_AUDIT_MAX_BYTES: '0' })).toEqual({
      auditMaxBytes: Number.POSITIVE_INFINITY,
    });
  });

  it('passes the ceiling down to the sink so the file on disk actually respects it', async () => {
    const auditFile = join(dir, 'audit.jsonl');
    const seeds = Array.from({ length: 8 }, (_, i) => `http://127.0.0.1/v${i}/card.json`);
    // vassal name follows the URL, so each seed registers a distinct vassal
    const nameAwareFetch = (async (input: RequestInfo | URL) => {
      const name = String(input).match(/\/(v\d+)\//)?.[1] ?? 'v';
      return new Response(JSON.stringify(cardFor(name)), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const kernel = await bootKernel({
      auditFile,
      auditMaxBytes: 200,
      auditKeep: 1,
      fetchImpl: nameAwareFetch,
      vassalSeeds: seeds,
    });

    // Each revocation writes one line through the booted sink - the exact path
    // the ceiling has to bound.
    for (const url of seeds) {
      expect(kernel.registry.revoke(url.match(/\/(v\d+)\//)?.[1] ?? '')).toBe(true);
    }

    expect(statSync(auditFile).size).toBeLessThanOrEqual(400); // ceiling + one oversized write
    expect(existsSync(`${auditFile}.1`)).toBe(true);
    expect(existsSync(`${auditFile}.2`)).toBe(false); // keep=1 caps the generations
    const retained = readAuditLog(auditFile).length + readAuditLog(`${auditFile}.1`).length;
    expect(retained).toBeLessThan(8); // proof lines were actually dropped, not kept forever
  });

  it('refuses a garbage ceiling', () => {
    expect(() => resolveAuditConfig({ ZEUS_AUDIT_MAX_BYTES: 'big' })).toThrow(KernelBootError);
    expect(() => resolveAuditConfig({ ZEUS_AUDIT_KEEP: '0' })).toThrow(/>= 1/);
  });
});
