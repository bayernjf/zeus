import type { A2AEvent } from '../a2a/types.js';
import type { DispatchRequest, DispatchResult } from '../dispatch/dispatcher.js';
import type { Conflict } from '../orchestrator/types.js';
import type { CancelTaskFn, Escalation, EscalationStatus, OversightAuditEntry } from './types.js';

const FALLBACK_REASON = 'vassal requests human input';

export type OversightOptions = {
  now?: () => Date;
  newId?: () => string;
  cancelTask?: CancelTaskFn;
  audit?: (entry: OversightAuditEntry) => void;
  /** Fired after a driver decision is recorded (memory reliability write-back). */
  onDecided?: (escalation: Escalation) => void;
};

/**
 * Minimal oversight deck (A4): collects input-required escalations from vassal
 * dispatches and lets the human driver approve or reject. Reject cancels the
 * vassal-side task; approve records the decision so the caller can re-dispatch
 * with the human-supplied parameters (re-dispatch itself is the caller's job).
 */
export class OversightDesk {
  private escalations = new Map<string, Escalation>();
  private taskIndex = new Map<string, string>(); // taskId -> escalationId
  private conflictIndex = new Map<string, string>(); // intentId (or runId+skill) -> escalationId

  constructor(private options: OversightOptions = {}) {}

  private now(): Date {
    return this.options.now ? this.options.now() : new Date();
  }

  private newId(): string {
    return this.options.newId?.() ?? `esc-${crypto.randomUUID()}`;
  }

  /** Pull an escalation out of a finished dispatch. Idempotent per taskId:
   *  re-ingesting the same input-required task returns the existing record. */
  ingest(result: DispatchResult, request: DispatchRequest): Escalation | null {
    if (!result.ok) return null;
    if (result.task.status.state !== 'input-required') return null;

    const existingId = this.taskIndex.get(result.task.id);
    if (existingId) return this.get(existingId) ?? null;

    const { reason, options } = extractEscalation(result.events);
    const escalation: Escalation = {
      id: this.newId(),
      kind: 'task-input',
      runId: request.runId ?? result.task.metadata?.['x-zeus-runId']?.toString() ?? 'unknown',
      vassal: request.vassal ?? result.task.metadata?.['vassal']?.toString() ?? '(auto)',
      skill: request.skill,
      taskId: result.task.id,
      realm: request.realm,
      reason,
      options,
      status: 'pending',
      createdAt: this.now().toISOString(),
    };
    this.escalations.set(escalation.id, escalation);
    this.taskIndex.set(escalation.taskId!, escalation.id);
    this.audit(escalation, 'escalated');
    return structuredClone(escalation);
  }

  /**
   * E6.2: accept an unresolved intent-level conflict (fan-out split the rule
   * could not conclude). Idempotent per intent (keyed by intentId when present,
   * else runId+skill): re-ingesting the same split returns the existing record.
   */
  ingestConflict(input: {
    intentId?: string;
    runId: string;
    skill: string;
    realm: Escalation['realm'];
    conflict: Conflict;
  }): Escalation {
    const key = input.intentId ?? `${input.runId}::${input.skill}`;
    const existingId = this.conflictIndex.get(key);
    if (existingId) return this.get(existingId)!;

    const escalation: Escalation = {
      id: this.newId(),
      kind: 'intent-conflict',
      runId: input.runId,
      vassal: '(intent)',
      skill: input.skill,
      realm: input.realm,
      reason: input.conflict.reason,
      options: input.conflict.stances.map(stance => stance.stance),
      status: 'pending',
      createdAt: this.now().toISOString(),
      ...(input.intentId ? { intentId: input.intentId } : {}),
      stances: structuredClone(input.conflict.stances),
    };
    this.escalations.set(escalation.id, escalation);
    this.conflictIndex.set(key, escalation.id);
    this.audit(escalation, 'escalated');
    return structuredClone(escalation);
  }

  /**
   * Memory P1: accept a dispute produced by consolidation. The id is the
   * consolidator's deterministic escalation id, so re-consolidating the same
   * dispute (same facts) returns the existing record.
   */
  ingestMemoryDispute(input: {
    id: string;
    runId: string;
    realm: Escalation['realm'];
    factId: string;
    conflictingFacts: string[];
    reason: string;
  }): Escalation {
    const existing = this.get(input.id);
    if (existing) return existing;

    const escalation: Escalation = {
      id: input.id,
      kind: 'memory-dispute',
      runId: input.runId,
      vassal: '(memory)',
      skill: '(memory)',
      realm: input.realm,
      reason: input.reason,
      options: input.conflictingFacts,
      status: 'pending',
      createdAt: this.now().toISOString(),
      factId: input.factId,
      conflictingFacts: [...input.conflictingFacts],
    };
    this.escalations.set(escalation.id, escalation);
    this.audit(escalation, 'escalated');
    return structuredClone(escalation);
  }

  list(status?: EscalationStatus): Escalation[] {
    const all = [...this.escalations.values()].map(entry => structuredClone(entry));
    return status ? all.filter(entry => entry.status === status) : all;
  }

  /** E5.3: serializable snapshot of the escalation queue. */
  exportState(): Escalation[] {
    return [...this.escalations.values()].map(entry => structuredClone(entry));
  }

  /** E5.3: replace the queue from a snapshot, rebuilding the task/conflict indexes. */
  importState(escalations: Escalation[]): void {
    this.escalations = new Map();
    this.taskIndex = new Map();
    this.conflictIndex = new Map();
    for (const original of escalations) {
      const entry = structuredClone(original);
      this.escalations.set(entry.id, entry);
      if (entry.kind === 'task-input' && entry.taskId) {
        this.taskIndex.set(entry.taskId, entry.id);
      } else if (entry.kind === 'intent-conflict') {
        const key = entry.intentId ?? `${entry.runId}::${entry.skill}`;
        this.conflictIndex.set(key, entry.id);
      }
      // memory-dispute rows are keyed directly by their deterministic id.
    }
  }

  get(id: string): Escalation | undefined {
    const entry = this.escalations.get(id);
    return entry ? structuredClone(entry) : undefined;
  }

  /** Driver approves continuing. note may carry the human-supplied parameters;
   *  the caller is responsible for the follow-up dispatch. */
  approve(id: string, note?: string): Escalation {
    return this.decide(id, 'approved', note);
  }

  /** E6.2: driver settles an intent-conflict by accepting one of the stances.
   *  The accepted stance is returned for the orchestrator to write back into the
   *  aggregated decision (applyConflictResolution). */
  decideConflict(id: string, stance: string, note?: string): Escalation {
    const current = this.requirePending(id);
    if (current.kind !== 'intent-conflict') {
      throw new Error(`escalation ${id} is ${current.kind}; use approve/reject`);
    }
    if (!current.stances?.some(entry => entry.stance === stance)) {
      throw new Error(`stance "${stance}" is not one of the conflict options: ${current.options.join(', ')}`);
    }
    const decided: Escalation = {
      ...current,
      status: 'approved',
      decidedAt: this.now().toISOString(),
      decidedStance: stance,
      decisionNote: note,
    };
    this.escalations.set(id, decided);
    this.audit(decided, 'approved', note, undefined, stance);
    this.options.onDecided?.(decided);
    return structuredClone(decided);
  }

  /** Driver rejects: record the decision. For a task-input escalation the
   *  vassal-side task is cancelled; an intent-conflict has no single task to
   *  cancel (cancelling the whole intent is the orchestrator's job), so only the
   *  decision is recorded. If the cancel call fails the escalation stays pending. */
  async reject(id: string, note?: string): Promise<Escalation> {
    const current = this.requirePending(id);
    if (current.kind === 'task-input' && this.options.cancelTask && current.taskId) {
      await this.options.cancelTask(current.vassal, current.taskId);
    }
    const decided: Escalation = {
      ...current,
      status: 'rejected',
      decidedAt: this.now().toISOString(),
      decisionNote: note,
    };
    this.escalations.set(id, decided);
    this.audit(decided, 'rejected', note);
    this.options.onDecided?.(decided);
    return structuredClone(decided);
  }

  private decide(id: string, status: Extract<EscalationStatus, 'approved'>, note?: string): Escalation {
    const current = this.requirePending(id);
    const decided: Escalation = {
      ...current,
      status,
      decidedAt: this.now().toISOString(),
      decisionNote: note,
    };
    this.escalations.set(id, decided);
    this.audit(decided, status, note);
    this.options.onDecided?.(decided);
    return structuredClone(decided);
  }

  private requirePending(id: string): Escalation {
    const entry = this.escalations.get(id);
    if (!entry) throw new Error(`unknown escalation: ${id}`);
    if (entry.status !== 'pending') {
      throw new Error(`escalation ${id} already ${entry.status}`);
    }
    return entry;
  }

  private audit(escalation: Escalation, action: OversightAuditEntry['action'], note?: string, detail?: string, decidedStance?: string): void {
    this.options.audit?.({
      ts: this.now().toISOString(),
      escalationId: escalation.id,
      runId: escalation.runId,
      vassal: escalation.vassal,
      action,
      ...(note ? { note } : {}),
      ...(detail ? { detail } : {}),
      ...(decidedStance ? { decidedStance } : {}),
    });
  }
}

/**
 * Assembly helper: bridge an Orchestrator's onConflict callback into the desk so
 * unresolved splits enter the oversight queue automatically. The orchestrator
 * never imports the desk (design: governance is injected, not hard-wired):
 *   new Orchestrator(lookup, dispatcher, { onConflict: conflictsToDesk(desk) })
 */
export function conflictsToDesk(
  desk: OversightDesk
): (conflicts: Conflict[], result: { intentId: string; runId: string; skill: string; realm: Escalation['realm'] }) => void {
  return (conflicts, result) => {
    for (const conflict of conflicts) {
      desk.ingestConflict({ intentId: result.intentId, runId: result.runId, skill: result.skill, realm: result.realm, conflict });
    }
  };
}

/** Find the terminal input-required status event and read its escalation payload. */
export function extractEscalation(events: A2AEvent[]): { reason: string; options: string[] } {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.kind === 'status-update' && event.status.state === 'input-required') {
      const payload = event['x-zeus-escalation'];
      if (payload) {
        return { reason: payload.reason || FALLBACK_REASON, options: payload.options ?? [] };
      }
      return { reason: FALLBACK_REASON, options: [] };
    }
  }
  return { reason: FALLBACK_REASON, options: [] };
}
