import { appendFileSync } from 'node:fs';
import type { AuditEntry } from './dispatcher.js';

export function jsonlAuditSink(path: string): (entry: AuditEntry) => void {
  return entry => appendFileSync(path, `${JSON.stringify(entry)}\n`);
}

export function memoryAuditSink(): { log: AuditEntry[]; sink: (entry: AuditEntry) => void } {
  const log: AuditEntry[] = [];
  return { log, sink: entry => log.push(entry) };
}
