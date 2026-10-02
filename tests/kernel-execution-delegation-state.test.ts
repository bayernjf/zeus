import { describe, expect, it } from 'vitest';
import {
  applyKernelState,
  collectKernelState,
  type KernelComponents,
} from '../src/state/kernel-state.js';
import { ExecutionDelegationNonceLedger } from '../src/delegation/execution-delegation.js';
import { VassalRegistry } from '../src/registry/registry.js';
import { OversightDesk } from '../src/oversight/oversight.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
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
