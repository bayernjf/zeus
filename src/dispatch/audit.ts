import { appendFileSync } from 'node:fs';
import type { AuditEntry, AuditSink } from './dispatcher.js';

export function jsonlAuditSink(path: string): AuditSink {
  return entry => appendFileSync(path, `${JSON.stringify(entry)}\n`);
}

export function memoryAuditSink(): { log: AuditEntry[]; sink: AuditSink } {
  const log: AuditEntry[] = [];
  return { log, sink: entry => log.push(entry) };
}

/** Bridge registry revocation events into the same dispatch audit trail,
 *  so governance actions (token revocation / demotion to guest) are recorded
 *  alongside dispatch decisions. Wire as VassalRegistry's onRevoke hook. */
export function revokeAuditBridge(audit: AuditSink): (name: string, at: string) => void {
  return (name, at) =>
    audit({
      ts: at,
      vassal: name,
      decision: 'vassal-revoked',
      detail: 'vassal access revoked; demoted to guest/blocked, no further tokens issued',
    });
}
