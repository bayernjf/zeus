import type { A2AEvent, RealmType, Task } from '../a2a/types.js';
import type { VassalLike } from './types.js';
import { sendTask, sendTaskSubscribe, cancelTask } from './client.js';

export type AuditEntry = {
  ts: string;
  runId: string;
  vassal: string;
  skill: string;
  realm: RealmType;
  decision: 'dispatched' | 'refused-realm-policy' | 'refused-unknown-vassal' | 'dispatch-failed';
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
  constructor(
    private vassals: Map<string, VassalLike>,
    private options: {
      audit: AuditSink;
      now?: () => Date;
      fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
      tokenFor?: (vassalName: string) => string | undefined;
    }
  ) {}

  async dispatch(request: DispatchRequest): Promise<DispatchResult> {
    const now = this.options.now ?? (() => new Date());
    const runId = request.runId ?? `zeus-run-${crypto.randomUUID()}`;
    let vassal: VassalLike | undefined;
    let selectionDetail: string | undefined;
    if (request.vassal) {
      vassal = this.vassals.get(request.vassal);
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
    try {
      const task = await sendTaskSubscribe(
        {
          taskUrl: vassal.taskUrl,
          skill: request.skill,
          params: { ...request.params, ...(injectedHits.length ? { realmHits: injectedHits } : {}) },
          runId,
          token: this.options.tokenFor?.(vassal.name),
        },
        { onEvent: event => events.push(event) },
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
    const vassal = this.vassals.get(vassalName);
    if (!vassal) throw new Error(`unknown vassal: ${vassalName}`);
    return cancelTask(vassal.taskUrl, taskId, this.options.tokenFor?.(vassalName), this.options.fetchImpl);
  }

  private selectBySkill(skillId: string): VassalLike | undefined {
    const candidates = [...this.vassals.values()].filter(vassal => vassal.card.skills.some(skill => skill.id === skillId));
    if (candidates.length > 1) {
      throw new AmbiguousSkillError(`multiple vassals provide skill ${skillId}; name one explicitly: ${candidates.map(vassal => vassal.name).join(', ')}`);
    }
    return candidates[0];
  }
}

export class AmbiguousSkillError extends Error {}
