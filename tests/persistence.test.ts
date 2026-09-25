import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VassalRegistry } from '../src/registry/registry.js';
import { OversightDesk } from '../src/oversight/oversight.js';
import type { Escalation } from '../src/oversight/types.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import type { DispatchPort, TargetLookup } from '../src/orchestrator/types.js';
import type { DispatchRequest, DispatchResult } from '../src/dispatch/dispatcher.js';
import type { A2AEvent, Task } from '../src/a2a/types.js';
import {
  FileKernelStateStore,
  applyKernelState,
  collectKernelState,
  KernelStateError,
  KERNEL_STATE_VERSION,
  type KernelComponents,
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
    skills: [{ id: `skill-${name}`, name: name, description: '', tags: [] }],
    authentication: { schemes: ['bearer'] },
    preferredTransport: 'JSONRPC',
    'x-zeus-fealty': { version: '1', swornTo: 'zeus', domain: 'test-domain', dataRealms: ['personal', 'enterprise'], dataPolicy: 'read-task-scope', reportBack: true, escalationPolicy: 'auto' },
  };
}
const mockFetch = (name: string) => (async () => new Response(JSON.stringify(cardFor(name)), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;

function stanceResult(vassal: string, stance: string): DispatchResult {
  const task: Task = {
    kind: 'task', id: `${vassal}-t`, contextId: 'ctx', status: { state: 'completed' },
    artifacts: [{ artifactId: 'a', name: 'r', parts: [{ kind: 'data', data: { stance } }] }],
  };
  const event: A2AEvent = { kind: 'status-update', taskId: task.id, contextId: 'ctx', status: { state: 'completed' }, final: true };
  return { ok: true, task, events: [event], injectedHits: [] };
}
function portFor(routes: Record<string, DispatchResult>): DispatchPort {
  return { async dispatch(req: DispatchRequest) { return routes[req.vassal!]; }, async cancel() {} };
}
const lookup: TargetLookup = { findBySkill: () => [] };

const taskInputEscalation: Escalation = {
  id: 'esc-task', kind: 'task-input', runId: 'r1', vassal: 'loom', skill: 's1',
  taskId: 'task-1', realm: 'personal', reason: 'need approval', options: ['proceed', 'abort'],
  status: 'pending', createdAt: '2026-09-22T00:00:00.000Z',
};
const conflictEscalation: Escalation = {
  id: 'esc-conf', kind: 'intent-conflict', runId: 'r2', vassal: '(intent)', skill: 's2',
  realm: 'personal', reason: 'split', options: ['go', 'stop'], status: 'pending',
  createdAt: '2026-09-22T00:01:00.000Z', intentId: 'intent-x',
  stances: [{ stance: 'go', vassals: ['a'] }, { stance: 'stop', vassals: ['b'] }],
};

describe('E5.3 component snapshots', () => {
  it('registry round-trips active and revoked vassals', async () => {
    const a = new VassalRegistry(mockFetch('loom'));
    await a.register('http://x/loom/api/a2a/agent-card');
    const b = new VassalRegistry(mockFetch('atlas'));
    await b.register('http://x/atlas/api/a2a/agent-card');
    b.revoke('atlas');

    const restored = new VassalRegistry(mockFetch('unused'));
    restored.importState(b.exportState());
    // only the entries present in the snapshot are restored (replacement, not merge)
    expect(restored.list().map(v => v.card.name)).toEqual([]); // atlas revoked -> hidden
    expect(restored.listAll().map(v => `${v.card.name}:${v.status}`)).toEqual(['atlas:revoked']);
    expect(restored.asVassalLookup().statusOf('atlas')).toBe('revoked');

    // merge a second snapshot by exporting both
    const merged = new VassalRegistry(mockFetch('unused'));
    merged.importState([...a.exportState(), ...b.exportState()]);
    expect(merged.list().map(v => v.card.name)).toEqual(['loom']);
    expect(merged.asVassalLookup().statusOf('atlas')).toBe('revoked');
  });

  it('oversight round-trips and rebuilds idempotency indexes', () => {
    const desk = new OversightDesk({ newId: () => 'new-id' });
    desk.importState([taskInputEscalation, conflictEscalation]);

    const restored = new OversightDesk({ newId: () => 'new-id' });
    restored.importState(desk.exportState());
    expect(restored.list().map(e => e.id).sort()).toEqual(['esc-conf', 'esc-task']);

    // task index rebuilt: re-ingesting the same task id returns the stored escalation
    const task: Task = {
      kind: 'task', id: 'task-1', contextId: 'ctx', status: { state: 'input-required' }, artifacts: [],
    };
    const event: A2AEvent = {
      kind: 'status-update', taskId: 'task-1', contextId: 'ctx', status: { state: 'input-required' }, final: false,
      'x-zeus-escalation': { level: 'driver', reason: 'again', options: [] },
    };
    const again = restored.ingest(
      { ok: true, task, events: [event], injectedHits: [] },
      { vassal: 'loom', skill: 's1', params: {}, realm: 'personal', runId: 'r1' }
    );
    expect(again?.id).toBe('esc-task');

    // conflict index rebuilt: same intent id returns the stored conflict escalation
    const reConflict = restored.ingestConflict({
      intentId: 'intent-x', runId: 'r2', skill: 's2', realm: 'personal',
      conflict: { reason: 'split', stances: [{ stance: 'go', vassals: ['a'] }, { stance: 'stop', vassals: ['b'] }] },
    });
    expect(reConflict.id).toBe('esc-conf');
    expect(restored.list()).toHaveLength(2); // no duplicates
  });

  it('orchestrator round-trips intents for idempotent replay and keeps requests for resume', async () => {
    const port = portFor({ loom: stanceResult('loom', 'go'), atlas: stanceResult('atlas', 'go') });
    const orch = new Orchestrator(lookup, port, { newIntentId: () => 'i1', newRunId: () => 'r1' });
    await orch.fanOut({ intentId: 'intent-keep', skill: 's', vassals: ['loom', 'atlas'], params: { ticket: 'OPS-1' }, realm: 'personal' });

    // fresh orchestrator with a dispatcher that counts calls
    let dispatchCalls = 0;
    const countingPort: DispatchPort = {
      async dispatch() {
        dispatchCalls += 1;
        return stanceResult('loom', 'go');
      },
      async cancel() {},
    };
    const restored = new Orchestrator(lookup, countingPort, { newIntentId: () => 'x', newRunId: () => 'x' });
    restored.importState(orch.exportState());

    const replayed = await restored.fanOut({ intentId: 'intent-keep', skill: 's', vassals: ['loom', 'atlas'], params: {}, realm: 'personal' });
    expect(replayed.replayed).toBe(true);
    expect(dispatchCalls).toBe(0); // idempotent: no re-dispatch after restart

    // original request retained -> resumeBranch can re-dispatch with supplied params
    const resumed = await restored.resumeBranch('intent-keep', 'loom', { approved: true });
    expect(dispatchCalls).toBe(1);
    expect(resumed.status).toBe('completed');
  });
});

describe('E5.3 FileKernelStateStore', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'zeus-state-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns null when no snapshot exists', async () => {
    const store = new FileKernelStateStore(join(dir, 'state.json'));
    expect(await store.load()).toBeNull();
  });

  it('round-trips a full kernel snapshot through disk and restores components', async () => {
    const registry = new VassalRegistry(mockFetch('loom'));
    await registry.register('http://x/loom/api/a2a/agent-card');
    const oversight = new OversightDesk();
    oversight.importState([conflictEscalation]);
    const port = portFor({ loom: stanceResult('loom', 'go') });
    const orchestrator = new Orchestrator(lookup, port, { newIntentId: () => 'i', newRunId: () => 'r' });
    await orchestrator.fanOut({ intentId: 'intent-disk', skill: 's', vassals: ['loom'], params: {}, realm: 'personal' });
    const live: KernelComponents = { registry, oversight, orchestrator };

    const file = join(dir, 'kernel', 'state.json');
    const store = new FileKernelStateStore(file, () => new Date('2026-09-22T12:00:00.000Z'));
    await store.save(collectKernelState(live));

    const raw = JSON.parse(await readFile(file, 'utf8'));
    expect(raw.version).toBe(1);
    expect(raw.savedAt).toBe('2026-09-22T12:00:00.000Z');
    // no temp file left behind
    const loaded = await store.load();
    expect(loaded?.registry).toHaveLength(1);
    expect(loaded?.oversight.map(e => e.id)).toEqual(['esc-conf']);
    expect(loaded?.orchestrator.intents.map(i => i.intentId)).toEqual(['intent-disk']);

    // restore into brand-new components
    const freshRegistry = new VassalRegistry(mockFetch('unused'));
    const freshOversight = new OversightDesk();
    const freshOrchestrator = new Orchestrator(lookup, port, { newIntentId: () => 'x', newRunId: () => 'x' });
    applyKernelState({ registry: freshRegistry, oversight: freshOversight, orchestrator: freshOrchestrator }, loaded!);
    expect(freshRegistry.list().map(v => v.card.name)).toEqual(['loom']);
    expect(freshOversight.list()).toHaveLength(1);
    expect(freshOrchestrator.getIntent('intent-disk')?.status).toBe('completed');
  });

  it('rejects a corrupt or wrong-version snapshot', async () => {
    const file = join(dir, 'state.json');
    const store = new FileKernelStateStore(file);
    await store.save({ registry: [], oversight: [], orchestrator: { intents: [], requests: [] } });

    // corrupt JSON
    await writeFile(file, '{ not json');
    await expect(store.load()).rejects.toThrow(KernelStateError);

    await writeFile(file, JSON.stringify({ version: 999, registry: [], oversight: [], orchestrator: {} }));
    await expect(store.load()).rejects.toThrow(/version/);
  });

  it('keeps the snapshot owner-readable, tightening a file an older build left open', async () => {
    const file = join(dir, 'state.json');
    await writeFile(file, '{"version":1}');
    await chmod(file, 0o644);

    const store = new FileKernelStateStore(file);
    await store.save({ registry: [], oversight: [], orchestrator: { intents: [], requests: [] } });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    // still readable by its owner, i.e. the round trip is unaffected
    expect(await store.load()).toMatchObject({ version: KERNEL_STATE_VERSION });
  });
});
