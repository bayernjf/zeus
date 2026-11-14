/**
 * Runtime inventory for the operator face.
 *
 * Answers "will a restart lose anything, and how much is in there" with counts
 * and paths. The snapshot payload itself is deliberately not part of this: it
 * holds connector bearer tokens and the user's memory facts, and an inventory
 * endpoint is exactly the kind of thing that ends up behind a dashboard.
 */
import type { RuntimeBoot } from './boot.js';

export type RuntimeStats = {
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
    executors: number;
    executorsRevoked: number;
    escalations: number;
    intents: number;
    /** Active skill versions; deprecated/uninstalled stay out of this count. */
    skills: number;
    connectors: number;
    mentorships: number;
    departments: number;
    memoryEvents: number;
    memoryFacts: number;
    dataDomains: number;
    /** E3.6: enterprise dataDomains, and how many carry a tenant scope. An unscoped
     *  enterprise dataDomain is only reachable by the operator, so the gap matters. */
    enterpriseDataDomains: number;
    tenantScopedDataDomains: number;
    /** E6.4: cross-domain grants currently on record. */
    domainGrants: number;
    /** E9.1/E9.2: seatGrant files open, and how many are currently signed off. */
    seatGrants: number;
    seatGranted: number;
    /** E3.5 / deferred #14: operator write grants already consumed (replay window). */
    spentWriteGrantNonces: number;
  };
  /** E3.5: how enterprise writes are authorized in this process. */
  operatorGrants: {
    authority: 'signed' | 'shape-only';
    keyId: string | null;
  };
};

/**
 * Read the live inventory. bootRuntime always assembles every component; they are
 * typed optional only because applyRuntimeState tolerates a partial runtime.
 */
export function runtimeStats(runtime: RuntimeBoot): RuntimeStats {
  const executors = runtime.registry.listAll();
  const revoked = executors.filter(entry => entry.revoked).length;
  const memory = runtime.memoryStore!.counts();
  const connections = runtime.dataDomainStore!.connections();
  const enterprise = connections.filter(entry => entry.type === 'enterprise').length;
  const tenantScoped = connections.filter(entry => entry.tenant !== undefined).length;
  const seatGrants = runtime.seatGrantLedger!.list();
  return {
    persistence: {
      enabled: runtime.stateFile !== null,
      stateFile: runtime.stateFile,
      restoredFromSnapshot: runtime.restoredFromSnapshot,
    },
    audit: {
      file: runtime.auditFile,
      maxBytes: runtime.auditMaxBytes === Number.POSITIVE_INFINITY ? 'unlimited' : runtime.auditMaxBytes,
      keep: runtime.auditKeep,
      /** Non-zero = decisions were made but not persisted; the answers stand, the trail does not. */
      failures: runtime.auditFailures,
      degraded: runtime.auditFailures > 0,
    },
    counts: {
      executors: executors.length - revoked,
      executorsRevoked: revoked,
      escalations: runtime.oversight.list().length,
      intents: runtime.orchestrator.counts().intents,
      skills: runtime.skillRegistry!.list().length,
      connectors: runtime.connectorRegistry!.list().length,
      mentorships: runtime.mentorshipLedger!.list().length,
      departments: runtime.orgRegistry!.listDepartments().length,
      memoryEvents: memory.events,
      memoryFacts: memory.facts,
      dataDomains: connections.length,
      enterpriseDataDomains: enterprise,
      tenantScopedDataDomains: tenantScoped,
      domainGrants: runtime.domainGrants!.list().length,
      seatGrants: seatGrants.length,
      seatGranted: seatGrants.filter(record => record.seatGranted && !record.withdrawn).length,
      spentWriteGrantNonces: runtime.operatorGrantLedger?.size ?? 0,
    },
    operatorGrants: {
      authority: runtime.operatorGrantAuthority,
      keyId: runtime.operatorSigner?.keyId ?? null,
    },
  };
}
