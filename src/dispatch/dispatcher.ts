import type { A2AEvent, RealmType, Task } from '../a2a/types.js';
import type { VassalLike, VassalLookup } from './types.js';
import { sendTask, sendTaskSubscribe, cancelTask } from './client.js';

export type AuditDecision =
  | 'dispatched'
  | 'refused-realm-policy'
  | 'refused-unknown-vassal'
  | 'refused-revoked'
  | 'vassal-revoked'
  | 'dispatch-failed'
  | 'sla-ack-breached'
  /** E6.4: a subject crossed (or tried to cross) a data-domain boundary. */
  | 'domain-read'
  | 'domain-refused'
  /** E6.4: the authorization lifecycle for those crossings. */
  | 'domain-grant-issued'
  | 'domain-grant-revoked'
  /** E3.5 / deferred #14: the single-use write credential for an enterprise realm. */
  | 'driver-grant-issued'
  /** deferred #17: explicit realm boundary mutations (teardown / tenant re-scope). */
  | 'realm-disconnected'
  | 'realm-tenant-retargeted'
  /** A write that a driver grant authorized (personal writes are not logged: they
   *  are the user writing in their own directory, and logging them buries this). */
  | 'realm-write'
  /** E9.1/E9.2: onboarding decisions for a seat in a department. */
  | 'commission-granted'
  | 'commission-waived'
  | 'commission-withdrawn'
  | 'commission-refused'
  /** E2.2/E2.3/E2.4: the skill catalogue refused auto-selected fan-out targets. */
  | 'refused-skill-uninstalled'
  | 'refused-no-active-provider';

export type AuditEntry = {
  ts: string;
  vassal: string;
  decision: AuditDecision;
  /** Governance events (vassal-revoked) carry no task context. */
  runId?: string;
  skill?: string;
  realm?: RealmType;
  taskId?: string;
  state?: Task['status']['state'];
  detail?: string;
};

export type DispatchRequest = {
  /** vassal name; omit to auto-select by skill */
  vassal?: string;
  skill: string;
  params: Record<string, unknown>;
  realm: RealmType;
  runId?: string;
  /** Realm content offered to the vassal; redacted per fealty.dataPolicy before injection */
  realmHits?: Array<{ itemId: string; snippet: string }>;
};

export type DispatchResult =
  | { ok: true; task: Task; events: A2AEvent[]; injectedHits: Array<{ itemId: string }> }
  | { ok: false; reason: string; audit: AuditEntry };

export type AuditSink = (entry: AuditEntry) => void;

export class Dispatcher {
  private lookup: VassalLookup;

  constructor(
    directory: VassalLookup | Map<string, VassalLike>,
    private options: {
      audit: AuditSink;
      now?: () => Date;
      /** Monotonic millisecond clock for SLA measurement; defaults to Date.now. */
      elapsed?: () => number;
      fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
      tokenFor?: (vassalName: string) => string | undefined;
    }
  ) {
    this.lookup = directory instanceof Map ? mapAsLookup(directory) : directory;
  }

  async dispatch(request: DispatchRequest): Promise<DispatchResult> {
    const now = this.options.now ?? (() => new Date());
    const runId = request.runId ?? `zeus-run-${crypto.randomUUID()}`;
    let vassal: VassalLike | undefined;
    let selectionDetail: string | undefined;
    if (request.vassal) {
      // Governance gate: a revoked vassal is blocked before any request is made
      // or token issued, and the block is audited distinctly from "unknown".
      if (this.lookup.statusOf(request.vassal) === 'revoked') {
        const audit: AuditEntry = {
          ts: now().toISOString(), runId, vassal: request.vassal, skill: request.skill, realm: request.realm,
          decision: 'refused-revoked', detail: `vassal ${request.vassal} is revoked; dispatch blocked before token issuance`,
        };
        this.options.audit(audit);
        return { ok: false, reason: audit.detail!, audit };
      }
      vassal = this.lookup.get(request.vassal);
    } else {
      try {
        vassal = this.selectBySkill(request.skill);
      } catch (error) {
        selectionDetail = error instanceof Error ? error.message : 'vassal selection failed';
      }
    }

    if (!vassal || selectionDetail) {
      const audit: AuditEntry = { ts: now().toISOString(), runId, vassal: request.vassal ?? '(auto)', skill: request.skill, realm: request.realm, decision: 'refused-unknown-vassal', detail: selectionDetail ?? 'no registered vassal provides this skill' };
      this.options.audit(audit);
      return { ok: false, reason: audit.detail!, audit };
    }

    // Data diode: task realm must be allowed by the vassal fealty
    if (!vassal.fealty.dataRealms.includes(request.realm)) {
      const audit: AuditEntry = { ts: now().toISOString(), runId, vassal: vassal.name, skill: request.skill, realm: request.realm, decision: 'refused-realm-policy', detail: `fealty.dataRealms=${vassal.fealty.dataRealms.join(',')} excludes ${request.realm}` };
      this.options.audit(audit);
      return { ok: false, reason: audit.detail!, audit };
    }

    // Redaction: realm content injection is bounded by fealty.dataPolicy
    const injectedHits = vassal.fealty.dataPolicy === 'none' ? [] : (request.realmHits ?? []);

    const events: A2AEvent[] = [];
    this.options.audit({ ts: now().toISOString(), runId, vassal: vassal.name, skill: request.skill, realm: request.realm, decision: 'dispatched' });

    // SLA ack enforcement (fealty.sla.ackSeconds): the first streamed event is
    // the acceptance signal. A breach is audited, never fatal — the task itself
    // may still succeed; the audit trail is the governance surface.
    const clock = this.options.elapsed ?? (() => Date.now());
    const ackSeconds = vassal.fealty.sla?.ackSeconds;
    const startedAt = clock();
    let ackMeasured = false;

    try {
      const task = await sendTaskSubscribe(
        {
          taskUrl: vassal.taskUrl,
          skill: request.skill,
          params: { ...request.params, ...(injectedHits.length ? { realmHits: injectedHits } : {}) },
          runId,
          token: this.options.tokenFor?.(vassal.name),
        },
        {
          onEvent: event => {
            events.push(event);
            if (!ackMeasured) {
              ackMeasured = true;
              if (ackSeconds !== undefined) {
                const elapsedMs = clock() - startedAt;
                if (elapsedMs > ackSeconds * 1000) {
                  this.options.audit({
                    ts: now().toISOString(), runId, vassal: vassal.name, skill: request.skill, realm: request.realm,
                    decision: 'sla-ack-breached', taskId: event.taskId,
                    detail: `first event after ${elapsedMs}ms exceeds declared sla.ackSeconds=${ackSeconds}s`,
                  });
                }
              }
            }
          },
        },
        this.options.fetchImpl
      );
      this.options.audit({ ts: now().toISOString(), runId, vassal: vassal.name, skill: request.skill, realm: request.realm, decision: 'dispatched', taskId: task.id, state: task.status.state });
      return { ok: true, task, events, injectedHits };
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'dispatch failed';
      this.options.audit({ ts: now().toISOString(), runId, vassal: vassal.name, skill: request.skill, realm: request.realm, decision: 'dispatch-failed', detail });
      return { ok: false, reason: detail, audit: { ts: now().toISOString(), runId, vassal: vassal.name, skill: request.skill, realm: request.realm, decision: 'dispatch-failed', detail } };
    }
  }

  async cancel(vassalName: string, taskId: string): Promise<Task> {
    const vassal = this.lookup.get(vassalName);
    if (!vassal) throw new Error(`unknown or revoked vassal: ${vassalName}`);
    return cancelTask(vassal.taskUrl, taskId, this.options.tokenFor?.(vassalName), this.options.fetchImpl);
  }

  private selectBySkill(skillId: string): VassalLike | undefined {
    const candidates = this.lookup.findBySkill(skillId);
    if (candidates.length > 1) {
      throw new AmbiguousSkillError(`multiple vassals provide skill ${skillId}; name one explicitly: ${candidates.map(vassal => vassal.name).join(', ')}`);
    }
    return candidates[0];
  }
}

export class AmbiguousSkillError extends Error {}

/** Adapt a static vassal map (tests / single-process wiring) to VassalLookup. */
function mapAsLookup(map: Map<string, VassalLike>): VassalLookup {
  return {
    get: name => map.get(name),
    statusOf: name => (map.has(name) ? 'active' : 'unknown'),
    findBySkill: skillId => [...map.values()].filter(vassal => vassal.card.skills.some(skill => skill.id === skillId)),
  };
}
