import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ExecutorEntry } from '../registry/registry.js';
import { ExecutorRegistry } from '../registry/registry.js';
import type { Escalation } from '../oversight/types.js';
import { OversightDesk } from '../oversight/oversight.js';
import { Orchestrator, type OrchestratorSnapshot } from '../orchestrator/orchestrator.js';
import type { DagRunner } from '../orchestrator/dag-runner.js';
import type { PlanFlow } from '../orchestrator/plan-flow.js';
import type { DataDomainConnection } from '../dataDomain/types.js';
import type { DataDomainStore } from '../dataDomain/types.js';
import type { DomainGrantState } from '../dataDomain/authorization.js';
import type { OperatorGrantLedger } from '../dataDomain/grant.js';
import { DomainGrantRegistry } from '../dataDomain/authorization.js';
import type { SeatGrantRecord } from '../onboarding/types.js';
import { SeatGrantLedger } from '../onboarding/seatGrant.js';
import type { SkillSpec } from '../skills/types.js';
import { SkillRegistry } from '../skills/registry.js';
import type { MemoryState } from '../memory/types.js';
import { MemoryStore } from '../memory/memory-store.js';
import type { AuditSink } from '../dispatch/dispatcher.js';
import type { PersistedConnectorRecord } from '../mcp/types.js';
import { ConnectorRegistry } from '../mcp/connectors.js';
import type { MentorshipRecord } from '../skills/mentor.js';
import { MentorshipLedger } from '../skills/mentor.js';
import type { Department } from '../org/types.js';
import type { OrgRegistry } from '../org/registry.js';
import type { ExecutionDelegationNonceLedger } from '../delegation/execution-delegation.js';
import type { DelegationContract, DelegationContractRegistry } from '../delegation/delegation-contract.js';
import type { Watch, WatchRegistry } from '../watch/watch.js';

/**
 * E5.3 minimal runtime persistence (design-http-transport §2.2/§2.3: the H2
 * prerequisite). The registry, oversight queue and orchestrator idempotency
 * tables are snapshotted to one JSON file and restored on restart, so a reboot
 * does not lose registered executors, escalations, in-flight/finished intents or
 * the original requests needed to resume a branch.
 *
 * Writes are atomic (temp file + rename) so a crash mid-write cannot corrupt the
 * snapshot; metrics are deliberately not persisted (runtime-only). The Dispatcher
 * is stateless and has nothing to persist; idempotency lives in the Orchestrator.
 */

export const RUNTIME_STATE_VERSION = 1 as const;

/** Persisted shape of the delegation-contract registry. */
export type RuntimeDelegationContractState = {
  contracts: DelegationContract[];
  outstanding: { nonce: string; contractId: string }[];
};

export type RuntimeSnapshot = {
  version: typeof RUNTIME_STATE_VERSION;
  savedAt: string;
  registry: ExecutorEntry[];
  oversight: Escalation[];
  orchestrator: OrchestratorSnapshot;
  /** G4: connected dataDomains. Optional for backward compat with v1 snapshots. */
  dataDomains?: DataDomainConnection[];
  /** E2.1: skill catalogue. Optional for backward compat. */
  skills?: SkillSpec[];
  /** Memory P1: event log and fact store. Optional for backward compat. */
  memory?: MemoryState;
  /** E7: MCP connector declarations (never their bearer tokens or stdio env maps). Optional for backward compat. */
  connectors?: PersistedConnectorRecord[];
  /** E2.5: mentorship records. Optional for backward compat. */
  mentorships?: MentorshipRecord[];
  /** E9.3: department establishment. Optional for backward compat. */
  org?: Department[];
  /** E6.4: cross-domain grants + spent nonces. Optional for backward compat. */
  domainGrants?: DomainGrantState;
  /** E9.1/E9.2: seatGrant files. Optional for backward compat. */
  seatGrants?: SeatGrantRecord[];
  /**
   * E3.5 / deferred #14: consumed operator write-grant nonces. Optional for
   * backward compat. Without this a restart would re-admit a grant that was
   * already spent - the replay window is exactly the gap in persistence.
   */
  writeGrantNonces?: string[];
  /**
   * deferred #33: consumed execution-delegation nonces. Optional for backward
   * compat. Without this a restart would re-open the replay window this ledger
   * exists to close.
   */
  executionDelegationNonces?: string[];
  /**
   * Self-host loop step 1: delegation contracts with their spent counters.
   * Optional for backward compat. A contract whose `used` reset on restart would
   * hand back tickets the operator already paid for.
   */
  delegationContracts?: RuntimeDelegationContractState;
  /**
   * Self-host loop step 2: registered triggers with their spent budgets.
   * Optional for backward compat. Without this a restart hands every watch a
   * fresh budget, which makes one reboot an unbounded trigger.
   */
  watches?: Watch[];
};

export type RuntimeComponents = {
  registry: ExecutorRegistry;
  oversight: OversightDesk;
  orchestrator: Orchestrator;
  /** S3: DAG wave orchestration over the runtime orchestrator. */
  dagRunner: DagRunner;
  /** S12 V2: planning wired as fan-out over the runtime orchestrator. */
  planFlow?: PlanFlow;
  /** G4: when assembled, its connected dataDomains are snapshotted and reconnected. */
  dataDomainStore?: DataDomainStore;
  /** E2.1: when assembled, the skill catalogue is persisted and restored. */
  skillRegistry?: SkillRegistry;
  /** Memory P1: when assembled, events/facts are persisted and restored. */
  memoryStore?: MemoryStore;
  /** E7: when assembled, connector declarations are persisted and restored. */
  connectorRegistry?: ConnectorRegistry;
  /** E2.5: when assembled, mentorship records are persisted and restored. */
  mentorshipLedger?: MentorshipLedger;
  /** E9.3: when assembled, the department establishment is persisted and restored. */
  orgRegistry?: OrgRegistry;
  /** E6.4: when assembled, cross-domain grants survive a restart. */
  domainGrants?: DomainGrantRegistry;
  /** E9.1/E9.2: when assembled, seatGrant files survive a restart. */
  seatGrantLedger?: SeatGrantLedger;
  /** E3.5 / deferred #14: consumed operator write-grant nonces survive a restart. */
  operatorGrantLedger?: OperatorGrantLedger;
  /** deferred #33: consumed execution-delegation nonces survive a restart. */
  executionDelegationLedger?: ExecutionDelegationNonceLedger;
  /** Self-host loop step 1: when assembled, contracts and their spent counts survive a restart. */
  delegationContracts?: DelegationContractRegistry;
  /** Self-host loop step 2: when assembled, watches and their spent budgets survive a restart. */
  watches?: WatchRegistry;
  /** MemoryPort v1 §7: the dispatch audit spine, surfaced so the HTTP face can
   *  write service-call lines on the same ledger (not persisted in snapshots). */
  auditSink?: AuditSink;
};

export class RuntimeStateError extends Error {}

/** Gather a serializable snapshot from live runtime components. */
export function collectRuntimeState(components: RuntimeComponents): Omit<RuntimeSnapshot, 'version' | 'savedAt'> {
  return {
    registry: components.registry.exportState(),
    oversight: components.oversight.exportState(),
    orchestrator: components.orchestrator.exportState(),
    ...(components.dataDomainStore ? { dataDomains: components.dataDomainStore.connections() } : {}),
    ...(components.skillRegistry ? { skills: components.skillRegistry.exportState() } : {}),
    ...(components.memoryStore ? { memory: components.memoryStore.exportState() } : {}),
    ...(components.connectorRegistry ? { connectors: components.connectorRegistry.exportState() } : {}),
    ...(components.mentorshipLedger ? { mentorships: components.mentorshipLedger.exportState() } : {}),
    ...(components.orgRegistry ? { org: components.orgRegistry.exportState() } : {}),
    ...(components.domainGrants ? { domainGrants: components.domainGrants.exportState() } : {}),
    ...(components.seatGrantLedger ? { seatGrants: components.seatGrantLedger.exportState() } : {}),
    ...(components.operatorGrantLedger ? { writeGrantNonces: components.operatorGrantLedger.exportState() } : {}),
    ...(components.executionDelegationLedger
      ? { executionDelegationNonces: components.executionDelegationLedger.exportState() }
      : {}),
    ...(components.delegationContracts ? { delegationContracts: components.delegationContracts.exportState() } : {}),
    ...(components.watches ? { watches: components.watches.exportState() } : {}),
  };
}

/** Restore a snapshot into (typically freshly constructed) components. */
export function applyRuntimeState(components: RuntimeComponents, snapshot: Omit<RuntimeSnapshot, 'version' | 'savedAt'>): void {
  components.registry.importState(snapshot.registry);
  components.oversight.importState(snapshot.oversight);
  components.orchestrator.importState(snapshot.orchestrator);
  if (components.skillRegistry && snapshot.skills) components.skillRegistry.importState(snapshot.skills);
  if (components.memoryStore && snapshot.memory) components.memoryStore.importState(snapshot.memory);
  if (components.connectorRegistry && snapshot.connectors) components.connectorRegistry.importState(snapshot.connectors);
  if (components.mentorshipLedger && snapshot.mentorships) components.mentorshipLedger.importState(snapshot.mentorships);
  if (components.orgRegistry && snapshot.org) components.orgRegistry.importState(snapshot.org);
  if (components.domainGrants && snapshot.domainGrants) components.domainGrants.importState(snapshot.domainGrants);
  if (components.seatGrantLedger && snapshot.seatGrants) components.seatGrantLedger.importState(snapshot.seatGrants);
  if (components.operatorGrantLedger && snapshot.writeGrantNonces) components.operatorGrantLedger.importState(snapshot.writeGrantNonces);
  if (components.executionDelegationLedger && snapshot.executionDelegationNonces) {
    components.executionDelegationLedger.importState(snapshot.executionDelegationNonces);
  }
  if (components.delegationContracts) components.delegationContracts.importState(snapshot.delegationContracts);
  if (components.watches && snapshot.watches) components.watches.importState(snapshot.watches);
}

/** JSON-file persistence with atomic replace. One file per Zeus data directory. */
export class FileRuntimeStateStore {
  constructor(
    private filePath: string,
    private now: () => Date = () => new Date()
  ) {}

  async save(state: Omit<RuntimeSnapshot, 'version' | 'savedAt'>): Promise<void> {
    const snapshot: RuntimeSnapshot = {
      version: RUNTIME_STATE_VERSION,
      savedAt: this.now().toISOString(),
      registry: state.registry,
      oversight: state.oversight,
      orchestrator: state.orchestrator,
      ...(state.dataDomains ? { dataDomains: state.dataDomains } : {}),
      ...(state.skills ? { skills: state.skills } : {}),
      ...(state.memory ? { memory: state.memory } : {}),
      ...(state.connectors ? { connectors: state.connectors } : {}),
      ...(state.mentorships ? { mentorships: state.mentorships } : {}),
      ...(state.org ? { org: state.org } : {}),
      ...(state.domainGrants ? { domainGrants: state.domainGrants } : {}),
      ...(state.seatGrants ? { seatGrants: state.seatGrants } : {}),
      ...(state.writeGrantNonces ? { writeGrantNonces: state.writeGrantNonces } : {}),
      ...(state.executionDelegationNonces ? { executionDelegationNonces: state.executionDelegationNonces } : {}),
      ...(state.delegationContracts ? { delegationContracts: state.delegationContracts } : {}),
      ...(state.watches ? { watches: state.watches } : {}),
    };
    const dir = dirname(this.filePath);
    // The snapshot holds the user's memory facts and connector declarations in
    // plain JSON (connector bearer tokens and stdio env maps are stripped before
    // persistence). A 0755 directory (the umask default) lets any local user
    // list and read it, so the directory is created owner-only. mkdir does not
    // re-chmod a directory that already exists.
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.tmp`;
    // Durability, not only atomicity: fsync the temp file so its bytes reach the
    // disk before the rename publishes it, then fsync the directory so the rename
    // itself survives a power loss. rename() orders the operations but does not
    // flush them, so without the fsyncs the old comment's "atomic" write can
    // still lose the whole snapshot. Owner-readable only applies on create;
    // renaming over a file an older build left world-readable tightens it.
    const handle = await open(tmp, 'w', 0o600);
    try {
      await handle.writeFile(JSON.stringify(snapshot, null, 2), { encoding: 'utf8' });
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, this.filePath);
    const dirHandle = await open(dir, 'r');
    try {
      await dirHandle.sync();
    } catch (error) {
      // Windows cannot fsync a directory handle (EPERM); the directory-fsync
      // durability contract is not expressible there and NTFS journaling covers
      // the rename. Ignore EPERM on win32 only; any other failure still throws.
      if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    } finally {
      await dirHandle.close();
    }
  }

  /** Load and validate; returns null when no snapshot file exists yet. */
  async load(): Promise<RuntimeSnapshot | null> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new RuntimeStateError(`runtime state file is not valid JSON: ${(error as Error).message}`);
    }
    const snapshot = parsed as Partial<RuntimeSnapshot>;
    if (snapshot.version !== RUNTIME_STATE_VERSION) {
      throw new RuntimeStateError(`unsupported runtime state version: ${String(snapshot.version)}`);
    }
    if (!Array.isArray(snapshot.registry) || !Array.isArray(snapshot.oversight) || !snapshot.orchestrator) {
      throw new RuntimeStateError('runtime state file is missing registry/oversight/orchestrator sections');
    }
    return snapshot as RuntimeSnapshot;
  }
}
