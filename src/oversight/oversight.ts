import type { A2AEvent } from '../a2a/types.js';
import type { DispatchRequest, DispatchResult } from '../dispatch/dispatcher.js';
import type { CancelTaskFn, Escalation, EscalationStatus, OversightAuditEntry } from './types.js';

const FALLBACK_REASON = 'vassal requests human input';

export type OversightOptions = {
  now?: () => Date;
  newId?: () => string;
  cancelTask?: CancelTaskFn;
  audit?: (entry: OversightAuditEntry) => void;
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
    this.taskIndex.set(escalation.taskId, escalation.id);
    this.audit(escalation, 'escalated');
    return structuredClone(escalation);
  }

  list(status?: EscalationStatus): Escalation[] {
    const all = [...this.escalations.values()].map(entry => structuredClone(entry));
    return status ? all.filter(entry => entry.status === status) : all;
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

  /** Driver rejects: record the decision and cancel the vassal-side task.
   *  If the cancel call fails the escalation stays pending and the error propagates. */
  async reject(id: string, note?: string): Promise<Escalation> {
    const current = this.requirePending(id);
    if (this.options.cancelTask) {
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

  private audit(escalation: Escalation, action: OversightAuditEntry['action'], note?: string, detail?: string): void {
    this.options.audit?.({
      ts: this.now().toISOString(),
      escalationId: escalation.id,
      runId: escalation.runId,
      vassal: escalation.vassal,
      action,
      ...(note ? { note } : {}),
      ...(detail ? { detail } : {}),
    });
  }
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
