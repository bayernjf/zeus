/**
 * Kernel inventory for the operator face.
 *
 * Answers "will a restart lose anything, and how much is in there" with counts
 * and paths. The snapshot payload itself is deliberately not part of this: it
 * holds connector bearer tokens and the user's memory facts, and an inventory
 * endpoint is exactly the kind of thing that ends up behind a dashboard.
 */
import type { KernelBoot } from './boot.js';

export type KernelStats = {
  persistence: {
    enabled: boolean;
    stateFile: string | null;
    /** True when this process started by restoring a snapshot. */
    restoredFromSnapshot: boolean;
  };
  audit: {
    file: string | null;
    maxBytes: number | 'unlimited';
    keep: number;
  };
  counts: {
    vassals: number;
    vassalsRevoked: number;
    escalations: number;
    intents: number;
    /** Active skill versions; deprecated/uninstalled stay out of this count. */
    skills: number;
    connectors: number;
    mentorships: number;
    departments: number;
    memoryEvents: number;
    memoryFacts: number;
    realms: number;
  };
};

/**
 * Read the live inventory. bootKernel always assembles every component; they are
 * typed optional only because applyKernelState tolerates a partial kernel.
 */
export function kernelStats(kernel: KernelBoot): KernelStats {
  const vassals = kernel.registry.listAll();
  const revoked = vassals.filter(entry => entry.revoked).length;
  const memory = kernel.memoryStore!.counts();
  return {
    persistence: {
      enabled: kernel.stateFile !== null,
      stateFile: kernel.stateFile,
      restoredFromSnapshot: kernel.restoredFromSnapshot,
    },
    audit: {
      file: kernel.auditFile,
      maxBytes: kernel.auditMaxBytes === Number.POSITIVE_INFINITY ? 'unlimited' : kernel.auditMaxBytes,
      keep: kernel.auditKeep,
    },
    counts: {
      vassals: vassals.length - revoked,
      vassalsRevoked: revoked,
      escalations: kernel.oversight.list().length,
      intents: kernel.orchestrator.counts().intents,
      skills: kernel.skillRegistry!.list().length,
      connectors: kernel.connectorRegistry!.list().length,
      mentorships: kernel.mentorshipLedger!.list().length,
      departments: kernel.orgRegistry!.listDepartments().length,
      memoryEvents: memory.events,
      memoryFacts: memory.facts,
      realms: kernel.realmStore!.connections().length,
    },
  };
}
