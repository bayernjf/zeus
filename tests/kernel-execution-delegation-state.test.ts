import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyKernelState,
  collectKernelState,
  FileKernelStateStore,
  type KernelComponents,
} from '../src/state/kernel-state.js';
import { ExecutionDelegationNonceLedger } from '../src/delegation/execution-delegation.js';
import { VassalRegistry } from '../src/registry/registry.js';
import { OversightDesk } from '../src/oversight/oversight.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import type { DagRunner } from '../src/orchestrator/dag-runner.js';
import type { DispatchPort, TargetLookup } from '../src/orchestrator/types.js';

const lookup: TargetLookup = { findBySkill: () => [] };
const unusedPort: DispatchPort = {
  async dispatch() {
    throw new Error('not used in snapshot round-trip');
  },
  async cancel() {},
};

function components(ledger?: ExecutionDelegationNonceLedger): KernelComponents {
  return {
    registry: new VassalRegistry(),
    oversight: new OversightDesk(),
    orchestrator: new Orchestrator(lookup, unusedPort),
    // The snapshot round-trip under test touches neither DAG state; the runner
    // is a required component, so it is stubbed the way persistence.test.ts does.
    dagRunner: {} as DagRunner,
    ...(ledger ? { executionDelegationLedger: ledger } : {}),
  };
}

describe('deferred #33 — execution-delegation nonces in the kernel snapshot', () => {
  it('collects spent nonces and restores them into a fresh ledger', () => {
    const ledger = new ExecutionDelegationNonceLedger();
    expect(ledger.consume('nonce-1')).toBe(true);
    expect(ledger.consume('nonce-2')).toBe(true);

    const snapshot = collectKernelState(components(ledger));
    expect(snapshot.executionDelegationNonces).toEqual(['nonce-1', 'nonce-2']);

    const restored = new ExecutionDelegationNonceLedger();
    applyKernelState(components(restored), snapshot);
    expect(restored.isSpent('nonce-1')).toBe(true);
    expect(restored.isSpent('nonce-2')).toBe(true);
  });

  it('omits the field when no ledger is assembled', () => {
    const snapshot = collectKernelState(components());
    expect(snapshot.executionDelegationNonces).toBeUndefined();
  });
});

describe('deferred #33 — spent nonces survive a restart', () => {
  let sandbox = '';
  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'zeus-delegation-'));
  });
  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  it('writes the nonces into the snapshot file and restores them from it', async () => {
    const ledger = new ExecutionDelegationNonceLedger();
    expect(ledger.consume('nonce-disk')).toBe(true);

    const file = join(sandbox, 'state.json');
    const store = new FileKernelStateStore(file);
    await store.save(collectKernelState(components(ledger)));

    const persisted = JSON.parse(await readFile(file, 'utf8')) as { executionDelegationNonces?: string[] };
    expect(persisted.executionDelegationNonces).toEqual(['nonce-disk']);

    // The replay window this ledger exists to close is only closed if a restart
    // re-admits nothing: a fresh ledger must come back already holding the nonce.
    const restarted = new ExecutionDelegationNonceLedger();
    applyKernelState(components(restarted), (await store.load())!);
    expect(restarted.isSpent('nonce-disk')).toBe(true);
  });
});
