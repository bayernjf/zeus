import type { DecisionRecord, DecisionListFilter } from './types.js';

/** Persistence port for decision records. M1 ships the in-memory
 *  implementation; the SQLite/PG tables (design §5.1) arrive with the
 *  deployment slice. */
export interface DecisionRecordStore {
  put(record: DecisionRecord): Promise<void> | void;
  get(id: string): Promise<DecisionRecord | undefined> | DecisionRecord | undefined;
  findByIdempotencyKey(key: string): Promise<DecisionRecord | undefined> | DecisionRecord | undefined;
  list(filter?: DecisionListFilter): Promise<DecisionRecord[]> | DecisionRecord[];
}

/** Volatile store used by tests, local wiring and the single-process demo.
 *  Records are returned by reference; callers must mutate only through
 *  DecisionService (which re-puts after every transition). */
export class MemoryDecisionStore implements DecisionRecordStore {
  private readonly byId = new Map<string, DecisionRecord>();
  private readonly byIdempotency = new Map<string, DecisionRecord>();

  put(record: DecisionRecord): void {
    const existing = this.byId.get(record.id);
    this.byId.set(record.id, record);
    const key = record.idempotencyKey ?? existing?.idempotencyKey;
    if (key !== undefined) this.byIdempotency.set(key, record);
  }

  get(id: string): DecisionRecord | undefined {
    return this.byId.get(id);
  }

  findByIdempotencyKey(key: string): DecisionRecord | undefined {
    return this.byIdempotency.get(key);
  }

  list(filter: DecisionListFilter = {}): DecisionRecord[] {
    return [...this.byId.values()]
      .filter(r => filter.domain === undefined || r.domain === filter.domain)
      .filter(r => filter.status === undefined || r.status === filter.status)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}
