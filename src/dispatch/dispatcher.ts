import type { A2AEvent, RealmType, Task } from '../a2a/types.js';
import type { VassalLike, VassalLookup } from './types.js';
import type { RealmHit } from '../realm/types.js';
import { sendTaskSubscribe, cancelTask } from './client.js';
import { assertOutboundUrlAllowed } from '../util/outbound-url.js';

/**
 * Every decision the governance spine records, as one list. The HTTP filter
 * (`GET /api/audit?decision=…`) validates against this same array, because a
 * second hand-maintained allowlist silently rots: five decisions
 * (`refused-skill-uninstalled`, `refused-no-active-provider`, `branch-diverted`,
 * `realm-disconnected`, `realm-tenant-retargeted`) were written to the audit
 * file but could not be queried, and the new one below would have been the sixth.
 */
export const AUDIT_DECISIONS = [
  'dispatched',
  'refused-realm-policy',
  'refused-unknown-vassal',
  'refused-revoked',
  'vassal-revoked',
  // A-02: the explicit, audited act that is the only way back from a revocation.
  'vassal-reinstated',
  'dispatch-failed',
  'sla-ack-breached',
  // E6.4: a subject crossed (or tried to cross) a data-domain boundary.
  'domain-read',
  'domain-refused',
  // E6.4: the authorization lifecycle for those crossings.
  'domain-grant-issued',
  'domain-grant-revoked',
  // E3.5 / deferred #14: the single-use write credential for an enterprise realm.
  'driver-grant-issued',
  // deferred #17: explicit realm boundary mutations (teardown / tenant re-scope).
  'realm-disconnected',
  'realm-tenant-retargeted',
  // A write that a driver grant authorized (personal writes are not logged: they
  // are the user writing in their own directory, and logging them buries this).
  'realm-write',
  // E9.1/E9.2: onboarding decisions for a seat in a department.
  'commission-granted',
  'commission-waived',
  'commission-withdrawn',
  'commission-refused',
  // E2.2/E2.3/E2.4: the skill catalogue refused auto-selected fan-out targets.
  'refused-skill-uninstalled',
  'refused-no-active-provider',
  // #9: a saturated/eligible-lacking target re-pointed to an alternate provider.
  'branch-diverted',
  // deferred #27: finished-intent verdicts that could not become claims (the realm
  // they belonged to was unmounted mid-flight). A dropped claim is a governance
  // fact, so it is announced rather than swallowed.
  'memory-claim-skipped',
  // A cancellation forwarded to a vassal. Dispatch is audited; cancelling used to
  // leave no trace at all, so the governance surface could not see a branch ended.
  'cancel-requested',
  // design-fan-out §7: the driver aborted a live outbound A2A stream through the
  // dispatcher port (no tasks/cancel was sent — there was no task id to name).
  'branch-aborted',
  // design-realm §3.1: realm content was refused because fealty.dataPolicy does
  // not admit its origin (none accepts none; read-task-scope only kernel-resolved;
  // hits without a declared origin fail closed). The refusal is the policy
  // working, so it is visible rather than a silent drop.
  'refused-data-policy',
  // design-realm §3.1: realm content was injected, recording the policy, the
  // origin and the count so "what did this task give that agent" can be traced.
  'content-injected',
  // deferred #33: an operator issued a one-time, bounded approval for an
  // executing agent to perform an external write.
  'execution-delegation-issued',
  // deferred #33: the execute gate refused a branch — missing delegation,
  // expired/replayed/mismatched, or no trust anchor assembled. The refusal is
  // the gate working, so it is visible rather than a silent drop.
  'execution-delegation-denied',
] as const;

export type AuditDecision = (typeof AUDIT_DECISIONS)[number];

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
  /** Realm content offered to the vassal; gated by fealty.dataPolicy on *origin* (design-realm §3.1). */
  realmHits?: RealmHit[];
  /** Where the hits came from. Required whenever realmHits is non-empty; a
   *  request whose hits carry no origin fails closed (the kernel can verify
   *  kernel-resolved hits as task-scoped, and can verify nothing about
   *  caller-asserted ones). */
  realmHitsOrigin?: 'kernel-resolved' | 'caller-asserted';
  /**
   * design-fan-out §7: hard-abort a live outbound A2A stream. Forwarded into
   * `sendTaskSubscribe`'s signal, so an abort while the peer is still streaming
   * closes the socket instead of waiting for the stream to end. The abort is
   * best-effort at the transport edge: once the peer's final task snapshot has
   * arrived and the stream ended, the signal has nothing left to cancel.
   */
  signal?: AbortSignal;
};

export type DispatchResult =
  | { ok: true; task: Task; events: A2AEvent[]; injectedHits: RealmHit[] }
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
      // Naming a vassal is not a licence to ask it for anything: the skill must
      // be one its card declares, or any registered agent could be made to run
      // any skill and the per-skill authorization would be nominal. Auto-select
      // already routes through findBySkill; this is the explicit-name path.
      if (vassal && !vassal.card.skills.some(skill => skill.id === request.skill)) {
        const audit: AuditEntry = {
          ts: now().toISOString(), runId, vassal: vassal.name, skill: request.skill, realm: request.realm,
          decision: 'refused-skill-uninstalled',
          detail: `vassal ${vassal.name} does not declare skill ${request.skill}`,
        };
        this.options.audit(audit);
        return { ok: false, reason: audit.detail!, audit };
      }
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

    // design-realm §3.1: fealty.dataPolicy gates the *origin* the realm hits may
    // come from, not the field set (which is the same across policies). The two
    // failure modes — hits that cannot be traced to a declared origin, and a
    // policy that does not admit the origin — refuse the dispatch instead of
    // silently dropping content (the "silent downgrade is a failure shape" rule
    // from #20/#31). Refusals are audited, so a policy that blocked content is
    // visible as the policy working, not as a gap.
    const hits = request.realmHits;
    const origin = request.realmHitsOrigin;
    const policy = vassal.fealty.dataPolicy;
    let injectedHits: RealmHit[] = [];
    if (hits && hits.length > 0) {
      if (!origin) {
        const audit: AuditEntry = {
          ts: now().toISOString(), runId, vassal: vassal.name, skill: request.skill, realm: request.realm,
          decision: 'refused-data-policy',
          detail: `fealty.dataPolicy=${policy}: ${hits.length} realm hits carry no origin; dispatch refused (fail-closed)`,
        };
        this.options.audit(audit);
        return { ok: false, reason: audit.detail!, audit };
      }
      if (policy === 'none' || (policy === 'read-task-scope' && origin === 'caller-asserted')) {
        const why = policy === 'none'
          ? `fealty.dataPolicy=none does not accept realm content`
          : `fealty.dataPolicy=read-task-scope accepts only kernel-resolved hits; self-asserted hits cannot be verified as task-scoped`;
        const audit: AuditEntry = {
          ts: now().toISOString(), runId, vassal: vassal.name, skill: request.skill, realm: request.realm,
          decision: 'refused-data-policy',
          detail: `${why} (origin=${origin})`,
        };
        this.options.audit(audit);
        return { ok: false, reason: audit.detail!, audit };
      }
      injectedHits = hits;
      this.options.audit({
        ts: now().toISOString(), runId, vassal: vassal.name, skill: request.skill, realm: request.realm,
        decision: 'content-injected',
        detail: `fealty.dataPolicy=${policy}, origin=${origin}, hits=${hits.length}`,
      });
    }

    // Re-affirm the revocation gate at the moment the credential is read.
    // `tokenFor` yields nothing for a revoked vassal, and a request that leaves
    // without its bearer is a governance decision that failed open: the
    // revocation happened, and the dispatch should have been refused, not sent
    // anonymously. The gate above only ran when the vassal was named explicitly,
    // so this check covers both selection paths.
    if (this.lookup.statusOf(vassal.name) === 'revoked') {
      const audit: AuditEntry = {
        ts: now().toISOString(), runId, vassal: vassal.name, skill: request.skill, realm: request.realm,
        decision: 'refused-revoked', detail: `vassal ${vassal.name} was revoked before its credential was issued; dispatch blocked`,
      };
      this.options.audit(audit);
      return { ok: false, reason: audit.detail!, audit };
    }
    const token = this.options.tokenFor?.(vassal.name);

    const events: A2AEvent[] = [];

    // SLA ack enforcement (fealty.sla.ackSeconds): acceptance is the first
    // streamed event, or - for a peer that streams nothing and just returns its
    // terminal snapshot - the arrival of that snapshot. Without the fallback a
    // slow non-streaming peer escaped sla-ack-breached entirely. A breach is
    // audited, never fatal: the task may still succeed, and the audit trail is
    // the governance surface.
    const clock = this.options.elapsed ?? (() => Date.now());
    const ackSeconds = vassal.fealty.sla?.ackSeconds;
    const startedAt = clock();
    let ack: { elapsedMs: number; taskId: string } | undefined;

    // Only the outbound request lives inside this catch. Every audit write stays
    // outside it: writing the trail is bookkeeping, and a full disk must not be
    // recorded as the *vassal* failing to serve the task.
    let task: Task;
    try {
      // A-12: defense in depth. The registry validates taskUrl at registration,
      // but dispatch is the moment the request actually leaves the process, so
      // the same guard runs here — a stale or restored entry cannot bypass it.
      assertOutboundUrlAllowed(vassal.taskUrl);
      task = await sendTaskSubscribe(
        {
          taskUrl: vassal.taskUrl,
          skill: request.skill,
          params: { ...request.params, ...(injectedHits.length ? { realmHits: injectedHits } : {}) },
          runId,
          ...(token !== undefined ? { token } : {}),
        },
        {
          onEvent: event => {
            events.push(event);
            if (!ack) ack = { elapsedMs: clock() - startedAt, taskId: event.taskId };
          },
          ...(request.signal !== undefined ? { signal: request.signal } : {}),
        },
        this.options.fetchImpl
      );
    } catch (error) {
      // design-fan-out §7: an abort is a governance act (the driver cancelled the
      // intent), not the vassal failing to serve the task — audit it distinctly
      // so the trail does not read the operator's own cancel as a peer failure.
      const aborted = request.signal?.aborted ?? false;
      const decision = aborted ? 'branch-aborted' : 'dispatch-failed';
      const detail = aborted ? 'aborted by the driver' : error instanceof Error ? error.message : 'dispatch failed';
      this.options.audit({ ts: now().toISOString(), runId, vassal: vassal.name, skill: request.skill, realm: request.realm, decision, detail });
      return { ok: false, reason: detail, audit: { ts: now().toISOString(), runId, vassal: vassal.name, skill: request.skill, realm: request.realm, decision, detail } };
    }

    // A peer that streamed no intermediate event still accepted the task by
    // returning it; that completion is the only acceptance signal available.
    if (!ack) ack = { elapsedMs: clock() - startedAt, taskId: task.id };

    if (ackSeconds !== undefined && ack.elapsedMs > ackSeconds * 1000) {
      this.options.audit({
        ts: now().toISOString(), runId, vassal: vassal.name, skill: request.skill, realm: request.realm,
        decision: 'sla-ack-breached', taskId: ack.taskId,
        detail: `accepted after ${ack.elapsedMs}ms exceeds declared sla.ackSeconds=${ackSeconds}s`,
      });
    }
    this.options.audit({ ts: now().toISOString(), runId, vassal: vassal.name, skill: request.skill, realm: request.realm, decision: 'dispatched', taskId: task.id, state: task.status.state });
    return { ok: true, task, events, injectedHits };
  }

  async cancel(vassalName: string, taskId: string): Promise<Task> {
    const now = this.options.now ?? (() => new Date());
    // A cancellation is a governance action, not a side channel: it must not
    // reach a vassal the revocation gate blocks, and it must be as visible on the
    // trail as the dispatch it ends. Both refusals are audited before throwing so
    // the reason is recorded, not just returned to a caller that may swallow it.
    const status = this.lookup.statusOf(vassalName);
    if (status === 'revoked') {
      const audit: AuditEntry = {
        ts: now().toISOString(), vassal: vassalName, taskId,
        decision: 'refused-revoked', detail: `cancel refused: vassal ${vassalName} is revoked; no request sent`,
      };
      this.options.audit(audit);
      throw new Error(audit.detail!);
    }
    const vassal = this.lookup.get(vassalName);
    if (!vassal) {
      const audit: AuditEntry = {
        ts: now().toISOString(), vassal: vassalName, taskId,
        decision: 'refused-unknown-vassal', detail: `cancel refused: ${vassalName} is not a registered vassal`,
      };
      this.options.audit(audit);
      throw new Error(audit.detail!);
    }
    const task = await cancelTask(vassal.taskUrl, taskId, this.options.tokenFor?.(vassalName), this.options.fetchImpl);
    this.options.audit({ ts: now().toISOString(), vassal: vassalName, taskId, decision: 'cancel-requested', state: task.status.state });
    return task;
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

/** Adapt a static vassal map (tests / single-process wiring) to VassalLookup.
 *  An entry may carry `revoked: true`; the adapter honors it exactly the way
 *  VassalRegistry.asVassalLookup does — invisible to get/findBySkill, reported
 *  by statusOf. Previously the status was hard-coded `active`, so a Map-wired
 *  dispatcher had no revocation gate at all. */
function mapAsLookup(map: Map<string, VassalLike>): VassalLookup {
  return {
    get: name => {
      const vassal = map.get(name);
      return vassal && !vassal.revoked ? vassal : undefined;
    },
    statusOf: name => {
      const vassal = map.get(name);
      if (!vassal) return 'unknown';
      return vassal.revoked ? 'revoked' : 'active';
    },
    findBySkill: skillId =>
      [...map.values()].filter(vassal => !vassal.revoked && vassal.card.skills.some(skill => skill.id === skillId)),
  };
}
