import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { VassalEntry } from '../registry/registry.js';
import { VassalRegistry } from '../registry/registry.js';
import type { Escalation } from '../oversight/types.js';
import { OversightDesk } from '../oversight/oversight.js';
import { Orchestrator, type OrchestratorSnapshot } from '../orchestrator/orchestrator.js';
import type { RealmConnection } from '../realm/types.js';
import type { RealmStore } from '../realm/types.js';
import type { SkillSpec } from '../skills/types.js';
import { SkillRegistry } from '../skills/registry.js';
import type { MemoryState } from '../memory/types.js';
import { MemoryStore } from '../memory/memory-store.js';
import type { ConnectorRecord } from '../mcp/types.js';
import { ConnectorRegistry } from '../mcp/connectors.js';

/**
 * E5.3 minimal kernel persistence (design-http-transport §2.2/§2.3: the H2
 * prerequisite). The registry, oversight queue and orchestrator idempotency
 * tables are snapshotted to one JSON file and restored on restart, so a reboot
 * does not lose registered vassals, escalations, in-flight/finished intents or
 * the original requests needed to resume a branch.
 *
 * Writes are atomic (temp file + rename) so a crash mid-write cannot corrupt the
 * snapshot; metrics are deliberately not persisted (runtime-only). The Dispatcher
 * is stateless and has nothing to persist; idempotency lives in the Orchestrator.
 */

export const KERNEL_STATE_VERSION = 1 as const;

export type KernelSnapshot = {
  version: typeof KERNEL_STATE_VERSION;
  savedAt: string;
  registry: VassalEntry[];
  oversight: Escalation[];
  orchestrator: OrchestratorSnapshot;
  /** G4: connected realms. Optional for backward compat with v1 snapshots. */
  realms?: RealmConnection[];
  /** E2.1: skill catalogue. Optional for backward compat. */
  skills?: SkillSpec[];
  /** Memory P1: event log and fact store. Optional for backward compat. */
  memory?: MemoryState;
  /** E7: MCP connector declarations. Optional for backward compat. */
  connectors?: ConnectorRecord[];
};

export type KernelComponents = {
  registry: VassalRegistry;
  oversight: OversightDesk;
  orchestrator: Orchestrator;
  /** G4: when assembled, its connected realms are snapshotted and reconnected. */
  realmStore?: RealmStore;
  /** E2.1: when assembled, the skill catalogue is persisted and restored. */
  skillRegistry?: SkillRegistry;
  /** Memory P1: when assembled, events/facts are persisted and restored. */
  memoryStore?: MemoryStore;
  /** E7: when assembled, connector declarations are persisted and restored. */
  connectorRegistry?: ConnectorRegistry;
};

export class KernelStateError extends Error {}

/** Gather a serializable snapshot from live kernel components. */
export function collectKernelState(components: KernelComponents): Omit<KernelSnapshot, 'version' | 'savedAt'> {
  return {
    registry: components.registry.exportState(),
    oversight: components.oversight.exportState(),
    orchestrator: components.orchestrator.exportState(),
    ...(components.realmStore ? { realms: components.realmStore.connections() } : {}),
    ...(components.skillRegistry ? { skills: components.skillRegistry.exportState() } : {}),
    ...(components.memoryStore ? { memory: components.memoryStore.exportState() } : {}),
    ...(components.connectorRegistry ? { connectors: components.connectorRegistry.exportState() } : {}),
  };
}

/** Restore a snapshot into (typically freshly constructed) components. */
export function applyKernelState(components: KernelComponents, snapshot: Omit<KernelSnapshot, 'version' | 'savedAt'>): void {
  components.registry.importState(snapshot.registry);
  components.oversight.importState(snapshot.oversight);
  components.orchestrator.importState(snapshot.orchestrator);
  if (components.skillRegistry && snapshot.skills) components.skillRegistry.importState(snapshot.skills);
  if (components.memoryStore && snapshot.memory) components.memoryStore.importState(snapshot.memory);
  if (components.connectorRegistry && snapshot.connectors) components.connectorRegistry.importState(snapshot.connectors);
}

/** JSON-file persistence with atomic replace. One file per Zeus data directory. */
export class FileKernelStateStore {
  constructor(
    private filePath: string,
    private now: () => Date = () => new Date()
  ) {}

  async save(state: Omit<KernelSnapshot, 'version' | 'savedAt'>): Promise<void> {
    const snapshot: KernelSnapshot = {
      version: KERNEL_STATE_VERSION,
      savedAt: this.now().toISOString(),
      registry: state.registry,
      oversight: state.oversight,
      orchestrator: state.orchestrator,
      ...(state.realms ? { realms: state.realms } : {}),
      ...(state.skills ? { skills: state.skills } : {}),
      ...(state.memory ? { memory: state.memory } : {}),
      ...(state.connectors ? { connectors: state.connectors } : {}),
    };
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
    await rename(tmp, this.filePath);
  }

  /** Load and validate; returns null when no snapshot file exists yet. */
  async load(): Promise<KernelSnapshot | null> {
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
      throw new KernelStateError(`kernel state file is not valid JSON: ${(error as Error).message}`);
    }
    const snapshot = parsed as Partial<KernelSnapshot>;
    if (snapshot.version !== KERNEL_STATE_VERSION) {
      throw new KernelStateError(`unsupported kernel state version: ${String(snapshot.version)}`);
    }
    if (!Array.isArray(snapshot.registry) || !Array.isArray(snapshot.oversight) || !snapshot.orchestrator) {
      throw new KernelStateError('kernel state file is missing registry/oversight/orchestrator sections');
    }
    return snapshot as KernelSnapshot;
  }
}
