/**
 * Experience candidate store port (F4.2).
 *
 * Memory implementation serves tests/demo; the SQLite implementation
 * (persistence/sqlite-experience-store.ts) satisfies the same contract for
 * durable deployments. Uniqueness inside the port is `(taskId, ruleId)` so a
 * replayed settlement cannot manufacture duplicate candidates.
 */
import type { ExperienceCandidate } from './types.js';

export interface ExperienceStore {
  putCandidate(candidate: ExperienceCandidate): void;
  getCandidate(id: string): ExperienceCandidate | undefined;
  listCandidates(organizationId?: string): ExperienceCandidate[];
  findCandidate(taskId: string, ruleId: string): ExperienceCandidate | undefined;
}

export class MemoryExperienceStore implements ExperienceStore {
  private readonly byId = new Map<string, ExperienceCandidate>();
  private readonly byKey = new Map<string, string>();

  putCandidate(candidate: ExperienceCandidate): void {
    this.byId.set(candidate.id, candidate);
    this.byKey.set(`${candidate.taskId}\u0000${candidate.ruleId}`, candidate.id);
  }

  getCandidate(id: string): ExperienceCandidate | undefined {
    return this.byId.get(id);
  }

  listCandidates(organizationId?: string): ExperienceCandidate[] {
    const all = [...this.byId.values()];
    return organizationId ? all.filter(c => c.organizationId === organizationId) : all;
  }

  findCandidate(taskId: string, ruleId: string): ExperienceCandidate | undefined {
    const id = this.byKey.get(`${taskId}\u0000${ruleId}`);
    return id ? this.byId.get(id) : undefined;
  }
}
