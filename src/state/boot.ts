import { VassalRegistry } from '../registry/registry.js';
import type { FetchLike } from '../dispatch/client.js';
import { Dispatcher, type AuditSink } from '../dispatch/dispatcher.js';
import { OversightDesk, conflictsToDesk } from '../oversight/oversight.js';
import type { OversightAuditEntry } from '../oversight/types.js';
import { Orchestrator } from '../orchestrator/orchestrator.js';
import { ConcurrencyMetrics } from '../orchestrator/metrics.js';
import {
  FileKernelStateStore,
  applyKernelState,
  collectKernelState,
  type KernelComponents,
  type KernelSnapshot,
} from './kernel-state.js';

/**
 * E5.3 process boot assembly (design-http-transport §2.2/§2.3: the long-running
 * service prerequisite). Wires the four live kernel components exactly once —
 * registry, oversight desk, dispatcher and orchestrator — with conflict
 * escalation already bridged into the desk (conflictsToDesk), and optionally
 * restores a JSON snapshot produced by FileKernelStateStore.
 *
 * Without `stateFile` the kernel stays purely in-memory (library/H1 behaviour).
 * With it, boot loads and applies the snapshot when one exists, and saveState()
 * atomically writes the live state for the next restart. The transport layer
 * (serve.js) calls saveState() during graceful shutdown.
 */

export type KernelBoot = KernelComponents & {
  /** E1.7 runtime concurrency metrics (not persisted); wired into the orchestrator. */
  metrics: ConcurrencyMetrics;
  /** Absolute or relative path of the state JSON, or null when in-memory only. */
  stateFile: string | null;
  /** True when a snapshot was found and applied during boot. */
  restoredFromSnapshot: boolean;
  /** The applied snapshot, or null on first boot / in-memory mode. */
  snapshot: KernelSnapshot | null;
  /** Atomically persist live kernel state; a no-op without stateFile. */
  saveState(): Promise<void>;
};

export type KernelBootOptions = {
  /** When set, state is restored from this file on boot and saved on shutdown. */
  stateFile?: string;
  now?: () => Date;
  /** Injected fetch for card registration / outbound A2A calls (tests / proxies). */
  fetchImpl?: FetchLike;
  /** Audit sink for outbound dispatch decisions; defaults to no-op. */
  dispatchAudit?: AuditSink;
  /** Audit sink for oversight actions; defaults to no-op. */
  oversightAudit?: (entry: OversightAuditEntry) => void;
  /** G1: card URLs auto-registered on boot. A URL already present (restored from
   *  snapshot or an earlier seed) is skipped, so seeds never trigger a refetch. */
  vassalSeeds?: string[];
};

const noop = (): void => {};

export async function bootKernel(options: KernelBootOptions = {}): Promise<KernelBoot> {
  const now = options.now ?? (() => new Date());
  const fetchImpl = options.fetchImpl;

  const registry = new VassalRegistry(fetchImpl, now);
  const oversight = new OversightDesk({
    now,
    ...(options.oversightAudit ? { audit: options.oversightAudit } : {}),
  });
  const metrics = new ConcurrencyMetrics({ now });
  const dispatcher = new Dispatcher(registry.asVassalLookup(), {
    audit: options.dispatchAudit ?? noop,
    now,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  const orchestrator = new Orchestrator(registry.asVassalLookup(), dispatcher, {
    now,
    metrics,
    onConflict: conflictsToDesk(oversight),
  });
  const components: KernelComponents = { registry, oversight, orchestrator };

  let store: FileKernelStateStore | null = null;
  let snapshot: KernelSnapshot | null = null;
  if (options.stateFile) {
    store = new FileKernelStateStore(options.stateFile, now);
    snapshot = await store.load();
    if (snapshot) applyKernelState(components, snapshot);
  }

  if (options.vassalSeeds && options.vassalSeeds.length > 0) {
    const known = new Set(registry.listAll().map(entry => entry.cardUrl));
    for (const cardUrl of options.vassalSeeds) {
      if (known.has(cardUrl)) continue;
      await registry.register(cardUrl);
      known.add(cardUrl);
    }
  }

  return {
    ...components,
    metrics,
    stateFile: options.stateFile ?? null,
    restoredFromSnapshot: snapshot !== null,
    snapshot,
    async saveState(): Promise<void> {
      if (!store) return;
      await store.save(collectKernelState(components));
    },
  };
}
