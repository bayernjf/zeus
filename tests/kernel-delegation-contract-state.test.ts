import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyKernelState, collectKernelState, FileKernelStateStore, type KernelComponents } from '../src/state/kernel-state.js';
import { DelegationContractRegistry, deriveExecutionDelegation, issueDelegationContract } from '../src/delegation/delegation-contract.js';
import { Ed25519MemorySigner } from '../src/registry/signing.js';
import { VassalRegistry } from '../src/registry/registry.js';
import { OversightDesk } from '../src/oversight/oversight.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import type { DagRunner } from '../src/orchestrator/dag-runner.js';
import type { DispatchPort, TargetLookup } from '../src/orchestrator/types.js';

const T0 = new Date('2026-10-05T00:00:00.000Z');
const lookup: TargetLookup = { findBySkill: () => [] };
const unusedPort: DispatchPort = {
  async dispatch() {
    throw new Error('not used in snapshot round-trip');
  },
  async cancel() {},
};

function components(contracts?: DelegationContractRegistry): KernelComponents {
  return {
    registry: new VassalRegistry(),
    oversight: new OversightDesk(),
    orchestrator: new Orchestrator(lookup, unusedPort),
    // The runner is a required component and holds no contract state here.
    dagRunner: {} as DagRunner,
    ...(contracts ? { delegationContracts: contracts } : {}),
  };
}

/** One contract with maxChildTickets 2, already spent once by a real derivation. */
async function spent() {
  const signer = new Ed25519MemorySigner('zeus-rsk-dev');
  const registry = new DelegationContractRegistry();
  const contract = await issueDelegationContract(
    {
      grantedBy: 'operator-1',
      skill: 'research',
      capabilities: ['execute'],
      limits: { maxChildTickets: 2, maxConcurrent: 2, windowEndsAt: new Date(T0.getTime() + 3_600_000).toISOString() },
    },
    { signer, now: () => T0 },
  );
  registry.add(contract);
  const derived = await deriveExecutionDelegation(
    contract.id,
    { capabilities: ['execute'] },
    { registry, signer, verifier: signer.verifier(), now: () => T0 },
  );
  if (!derived.ok) throw new Error(`setup: derivation refused with ${derived.reason}`);
  return { signer, registry, contractId: contract.id };
}

describe('delegation contracts in the kernel snapshot (design-self-host-loop step 1)', () => {
  let sandbox = '';
  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'zeus-contracts-'));
  });
  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  it('collects contracts with their spent counts and restores them', async () => {
    const live = await spent();
    const snapshot = collectKernelState(components(live.registry));
    expect(snapshot.delegationContracts?.contracts).toHaveLength(1);
    expect(snapshot.delegationContracts?.contracts[0]?.used).toEqual({ childTickets: 1, inFlight: 1 });
    expect(snapshot.delegationContracts?.outstanding).toHaveLength(1);

    const restored = new DelegationContractRegistry();
    applyKernelState(components(restored), snapshot);
    expect(restored.list()[0]?.used).toEqual({ childTickets: 1, inFlight: 1 });
    expect(restored.contractOf(snapshot.delegationContracts!.outstanding[0]!.nonce)).toBe(live.contractId);
  });

  it('omits the section when no registry is assembled', () => {
    expect(collectKernelState(components()).delegationContracts).toBeUndefined();
  });

  it('writes the spent counts to disk and does not hand the ceiling back on restart', async () => {
    const live = await spent();
    const file = join(sandbox, 'state.json');
    const store = new FileKernelStateStore(file);
    await store.save(collectKernelState(components(live.registry)));

    const persisted = JSON.parse(await readFile(file, 'utf8')) as { delegationContracts?: { contracts?: { used?: unknown }[] } };
    expect(persisted.delegationContracts?.contracts?.[0]?.used).toEqual({ childTickets: 1, inFlight: 1 });

    // Two tickets allowed, one already spent: after a restart the contract must
    // still authorize one and then refuse. A counter reset to zero would silently
    // authorize a third execution nobody approved.
    const restarted = new DelegationContractRegistry();
    applyKernelState(components(restarted), (await store.load())!);
    // The same operator key across the restart, as in a real deployment: what is
    // being proven here is about the spent counts, not about key custody.
    const context = { signer: live.signer, verifier: live.signer.verifier(), now: () => T0 };
    const first = await deriveExecutionDelegation(live.contractId, { capabilities: ['execute'] }, { registry: restarted, ...context });
    expect(first.ok, `restored contract should still derive: ${first.ok ? '' : first.reason}`).toBe(true);
    const second = await deriveExecutionDelegation(live.contractId, { capabilities: ['execute'] }, { registry: restarted, ...context });
    expect(second).toEqual({ ok: false, reason: 'child-ticket-limit-reached' });
    expect(restarted.get(live.contractId)!.used.childTickets).toBe(2);
  });
});
