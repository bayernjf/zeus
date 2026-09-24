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
import { bootKernel } from '../src/state/boot.js';
import { readAuditLog } from '../src/dispatch/audit.js';
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
    'x-zeus-fealty': { version: '1', swornTo: 'zeus', domain: 'test-domain' },
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
