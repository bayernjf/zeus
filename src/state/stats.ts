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
    /** Audit lines that could not be written since boot. */
    failures: number;
    degraded: boolean;
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
    /** E3.6: enterprise realms, and how many carry a tenant scope. An unscoped
     *  enterprise realm is only reachable by the driver, so the gap matters. */
    enterpriseRealms: number;
    tenantScopedRealms: number;
    /** E6.4: cross-domain grants currently on record. */
    domainGrants: number;
    /** E9.1/E9.2: commission files open, and how many are currently signed off. */
    commissions: number;
    commissioned: number;
    /** E3.5 / deferred #14: driver write grants already consumed (replay window). */
    spentWriteGrantNonces: number;
  };
  /** E3.5: how enterprise writes are authorized in this process. */
  driverGrants: {
    authority: 'signed' | 'shape-only';
    keyId: string | null;
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
  const connections = kernel.realmStore!.connections();
  const enterprise = connections.filter(entry => entry.type === 'enterprise').length;
  const tenantScoped = connections.filter(entry => entry.tenant !== undefined).length;
  const commissions = kernel.commissionLedger!.list();
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
      /** Non-zero = decisions were made but not persisted; the answers stand, the trail does not. */
      failures: kernel.auditFailures,
      degraded: kernel.auditFailures > 0,
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
      realms: connections.length,
      enterpriseRealms: enterprise,
      tenantScopedRealms: tenantScoped,
      domainGrants: kernel.domainGrants!.list().length,
      commissions: commissions.length,
      commissioned: commissions.filter(record => record.commissioned && !record.withdrawn).length,
      spentWriteGrantNonces: kernel.driverGrantLedger?.size ?? 0,
    },
    driverGrants: {
      authority: kernel.driverGrantAuthority,
      keyId: kernel.driverSigner?.keyId ?? null,
    },
  };
}
