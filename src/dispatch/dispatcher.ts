import type { A2AEvent, PushNotificationConfig, DataDomainType, Task } from '../a2a/types.js';
import type { ExecutorLike, ExecutorLookup } from './types.js';
import type { DataDomainHit } from '../dataDomain/types.js';
import type { ContextAppendixEntry } from '../context/assemble.js';
import type { SkillInputEntry } from '../context/skill-inputs.js';
import { sendTask, sendTaskSubscribe, cancelTask } from './client.js';
import { assertOutboundUrlAllowed } from '../util/outbound-url.js';
import { scanContentSignals } from '../guardrails/content-risk.js';

/**
 * Every decision the governance spine records, as one list. The HTTP filter
 * (`GET /api/audit?decision=…`) validates against this same array, because a
 * second hand-maintained allowlist silently rots: five decisions
 * (`refused-skill-uninstalled`, `refused-no-active-provider`, `branch-diverted`,
 * `dataDomain-disconnected`, `dataDomain-tenant-retargeted`) were written to the audit
 * file but could not be queried, and the new one below would have been the sixth.
 */
export const AUDIT_DECISIONS = [
  'dispatched',
  'refused-dataDomain-policy',
  'refused-unknown-executor',
  'refused-revoked',
  'executor-revoked',
  // A-02: the explicit, audited act that is the only way back from a revocation.
  'executor-reinstated',
  'dispatch-failed',
  'sla-ack-breached',
  // E6.4: a subject crossed (or tried to cross) a dataDomain boundary.
  'domain-read',
  'domain-refused',
  // E6.4: the authorization lifecycle for those crossings.
  'domain-grant-issued',
  'domain-grant-revoked',
  // E3.5 / deferred #14: the single-use write credential for an enterprise dataDomain.
  'operator-grant-issued',
  // deferred #17: explicit dataDomain boundary mutations (teardown / tenant re-scope).
  'dataDomain-disconnected',
  'dataDomain-tenant-retargeted',
  // A write that a operator grant authorized (personal writes are not logged: they
  // are the user writing in their own directory, and logging them buries this).
  'dataDomain-write',
  // E9.1/E9.2: onboarding decisions for a seat in a department.
  'seatGrant-granted',
  'seatGrant-waived',
  'seatGrant-withdrawn',
  'seatGrant-refused',
  // E2.2/E2.3/E2.4: the skill catalogue refused auto-selected fan-out targets.
  'refused-skill-uninstalled',
  'refused-no-active-provider',
  // #9: a saturated/eligible-lacking target re-pointed to an alternate provider.
  'branch-diverted',
  // MemoryPort v1 §6: the settled conclusion that could not be written back
  // because its dataDomain was unmounted at settle time. Like the dropped-claim
  // case below, the skip is a governance fact, not a silent drop.
  'memory-writeback-skipped',
  // deferred #27: finished-intent verdicts that could not become claims (the dataDomain
  // they belonged to was unmounted mid-flight). A dropped claim is a governance
  // fact, so it is announced rather than swallowed.
  'memory-claim-skipped',
  // MemoryPort contract v1 §4 (ruling D-1): every hub embedding call is an
  // authorised out-of-dataDomain call, so it is audited by content hash only.
  'memory-embed-external',
  // MemoryPort contract v1 §7: one line per cross-agent consumer-face call
  // (namespace-bound, content hashes only).
  'memory-service-call',
  // MemoryPort v1 §6: the fire-and-forget settle boundary failed; fail-soft
  // but never silent, or memory would stop updating without a trace.
  'memory-consolidation-failed',
  // A cancellation forwarded to a executor. Dispatch is audited; cancelling used to
  // leave no trace at all, so the governance surface could not see a branch ended.
  'cancel-requested',
  // design-fan-out §7: the operator aborted a live outbound A2A stream through the
  // dispatcher port (no tasks/cancel was sent — there was no task id to name).
  'branch-aborted',
  // design-dataDomain §3.1: dataDomain content was refused because handshake.dataPolicy does
  // not admit its origin (none accepts none; read-task-scope only runtime-resolved;
  // hits without a declared origin fail closed). The refusal is the policy
  // working, so it is visible rather than a silent drop.
  'refused-data-policy',
  // design-dataDomain §3.1: dataDomain content was injected, recording the policy, the
  // origin and the count so "what did this task give that agent" can be traced.
  'content-injected',
  // S1 context engineering V1 (design-context-engineering §10): the memory
  // appendix assembled into the branch dispatch context, and the two ways its
  // assembly shape-changed (a trimmed entry, an over-budget cap) — "what did
  // this branch get" must be replayable, never silent.
  'context-assembled',
  'context-trimmed',
  'context-budget-exceeded',
  // deferred #33: an operator issued a one-time, bounded approval for an
  // executing agent to perform an external write.
  'execution-delegation-issued',
  // deferred #33: the execute gate refused a branch — missing delegation,
  // expired/replayed/mismatched, or no trust anchor assembled. The refusal is
  // the gate working, so it is visible rather than a silent drop.
  'execution-delegation-denied',
  // design-self-host-loop §4.3: the trigger primitive. Registration, firing and
  // the two ways a watch stops are all governance facts, because they decide
  // when an intent exists without anyone present at that moment.
  'watch-registered',
  'watch-fired',
  'watch-disabled',
  'watch-revoked',
  // An unreadable source is not a false condition; it is reported so a watch can
  // never look healthy while silently never firing.
  'watch-eval-unavailable',
  'watch-auto-disabled',
  // M-01: the dispatch boundary recorded a terminal refusal for a fire; the
  // watch advanced its fire sequence rather than replaying a dead intent id.
  'watch-fire-refused',
  // m-14: processing one watch threw; the failure was recorded and the watch
  // skipped without advancing its sequence, so the rest of the tick ran.
  'watch-fire-failed',
  // self-host loop step 4: an unattended execute fire either received a
  // one-time child ticket, or was refused at a delegation ceiling (zero
  // outbound); both are governance facts about the contract.
  'delegation-child-issued',
  'delegation-limit-exceeded',
  // E6.1 / P0-5 pilot gap: the desk's answers (a question raised, an
  // approval, a rejection) are operator decisions and belong on the same
  // spine as every other governance fact. The boot assembly maps the desk's
  // audit hook onto these names; serve.ts never passed the hook, so in real
  // processes the operator's decisions left no trace at all.
  'escalation-escalated',
  'escalation-approved',
  'escalation-rejected',
  // self-host loop step 5: the operator-facing contract face. Issuing a
  // bounded contract is the human answer to a delegation-limit escalation;
  // revocation cuts every future derivation from that contract.
  'delegation-contract-issued',
  'delegation-contract-revoked',
  // design-inbound-a2a §3 (deferred #19): an inbound A2A tasks/send either
  // reached the H2 intent surface or was refused at the gate. The caller and
  // the task id are the audit trail of "who asked Zeus to do what".
  'inbound-task-accepted',
  'inbound-task-refused',
  // E4.11 (design-a2a-push): an execution agent pushed the final task snapshot
  // back to Zeus's callback endpoint — accepted (received, incl. idempotent
  // replays) or refused (bearer-valid but no branch waiting for that task id).
  'push-notification-received',
  'push-notification-refused',
  // design-external-trust (PRD E9.4): the trust face of the same call. A caller
  // card was admitted on a trust tier (1/2/3) or refused at the tier gate
  // (tier-0). Distinct from inbound-task-* — the tier says how much a caller
  // may reach, the task record says which task was or was not accepted.
  'external-agent-admitted',
  'external-agent-refused',
  // design-supervision §7.1 (S4): the intent-level termination guard refused a
  // new spawn — branch budget exhausted, or auto-selected dispatch circuit-open
  // after too many consecutive failures. The refusal is fail-closed: nothing is
  // dispatched, the intent settles failed with the reason attached.
  'intent-branch-budget-exceeded',
  'intent-circuit-opened',
  // design-hil (tech map S10): the interruption-level classification of an
  // intent signal. The three levels are governance facts about when a human is
  // (or is not) required: level-0 auto-resolves, level-1 waits asynchronously,
  // level-2 blocks on an operator decision.
  'interrupt-level-0',
  'interrupt-level-1',
  'interrupt-level-2',
  // design-tool-discovery (tech map S11): the selection/recovery chain —
  // which candidate was chosen, which tool failed, and the recovery action
  // taken (retry/switch/degrade). The chain is auditable so "why this agent
  // and this tool" can be replayed instead of guessed.
  'tool-selected',
  'tool-failed',
  'chain-retried',
  'chain-switched',
  'chain-degraded',
  // design-guardrails (tech map S8): the content-side chain annotated,
  // redacted or refused a content crossing. V1 registers the decision names;
  // provenance attachment at assembly is V2, so these are reserved names until
  // the assembly wiring actually emits them.
  'guardrail-annotated',
  'guardrail-redacted',
  'guardrail-refused',
  // S8 V3 (design-guardrails §5): an execute-mode intent's assembled content
  // hit a deterministic signal and was raised to the oversight queue (L1);
  // nothing was dispatched.
  'guardrail-escalated',
  // design-sandbox (tech map S16): the isolation gate refused a connector
  // registration, or spawned one under a declared isolation level, or a quota
  // enforcement killed it. V1 registers the names; the spawn-side wiring is V2,
  // so these are reserved until the wiring actually emits them.
  'connector-isolation-denied',
  'connector-spawned-isolated',
  'connector-quota-killed',
  // design-long-running (tech map S13): a restart classified an unsettled
  // branch — auto-resumed, awaiting the operator, or settled failed — and a
  // checkpoint was written. V1 registers the names; the boot wiring is V2, so
  // these are reserved until the wiring actually emits them.
  'recovery-auto-resumed',
  'recovery-awaiting-operator',
  'recovery-settled-failed',
  'checkpoint-written',
  // design-planning (tech map S12): a plan draft failed validation, a plan was
  // selected, two feasible plans were close enough to need operator input, all
  // candidates were infeasible, or a re-plan delta was produced. V1 registers
  // the names; the planner wiring is V2, so these are reserved until the
  // wiring actually emits them.
  'plan-malformed',
  'plan-selected',
  'plan-conflict',
  'plan-rejected-unplannable',
  'plan-replanned',
  // design-cost-governance (tech map S9): the cost ledger refused admission
  // (soft cap or rate circuit), a self-reported cost disagreed with the
  // ledger, or the cost backend degraded. V1 registers the names; the ledger
  // wiring is V2, so these are reserved until the wiring actually emits them.
  'cost-budget-exceeded',
  'cost-rate-circuit-open',
  'cost-self-report-mismatch',
  'cost-backend-degraded',
] as const;

export type AuditDecision = (typeof AUDIT_DECISIONS)[number];

export type AuditEntry = {
  ts: string;
  executor: string;
  decision: AuditDecision;
  /** Governance events (executor-revoked) carry no task context. */
  runId?: string;
  skill?: string;
  dataDomain?: DataDomainType;
  taskId?: string;
  state?: Task['status']['state'];
  /** Trust tier of a caller card on the external-agent-* face (PRD E9.4). */
  tier?: 'tier-0' | 'tier-1' | 'tier-2' | 'tier-3';
  detail?: string;
};

export type DispatchRequest = {
  /** executor name; omit to auto-select by skill */
  executor?: string;
  skill: string;
  params: Record<string, unknown>;
  dataDomain: DataDomainType;
  runId?: string;
  /** DataDomain content offered to the executor; gated by handshake.dataPolicy on *origin* (design-dataDomain §3.1). */
  dataDomainHits?: DataDomainHit[];
  /** Where the hits came from. Required whenever dataDomainHits is non-empty; a
   *  request whose hits carry no origin fails closed (the runtime can verify
   *  runtime-resolved hits as task-scoped, and can verify nothing about
   *  caller-asserted ones). */
  dataDomainHitsOrigin?: 'runtime-resolved' | 'caller-asserted';
  /**
   * S1 context engineering V1: the read-only memory appendix assembled by the
   * runtime at dispatch time (design-context-engineering §10). Never supplied
   * by a caller — `FanOutRequest` has no such field — and never written back.
   * Like `dataDomainHits`, it is instantaneous at dispatch and a replay may omit it.
   */
  contextAppendix?: ContextAppendixEntry[];
  /**
   * S1 context engineering V2: skill-declared input assembly (source 2 of the
   * assembly model, design-context-engineering §10.3). Read-only, assembled by
   * the runtime at dispatch time — a caller cannot supply it, a replay may omit
   * it, and an unavailable field is an explicit absence, never a fabricated
   * value. Travels the same outbound layer as `contextAppendix`.
   */
  skillInputs?: SkillInputEntry[];
  /**
   * design-fan-out §7: hard-abort a live outbound A2A stream. Forwarded into
   * `sendTaskSubscribe`'s signal, so an abort while the peer is still streaming
   * closes the socket instead of waiting for the stream to end. The abort is
   * best-effort at the transport edge: once the peer's final task snapshot has
   * arrived and the stream ended, the signal has nothing left to cancel.
   */
  signal?: AbortSignal;
  /**
   * S6 V2 (design-observability §5): W3C-shaped trace context for the outbound
   * A2A request, supplied by the orchestrator from its own runId lineage
   * (`00-<traceId>-<spanId>-01`). Optional protocol metadata: a peer that does
   * not propagate traces stays fully interoperable.
   */
  traceparent?: string;
  /**
   * S15 V2 (design-streaming §5): narrow per-request callback surfaced when an
   * outbound working frame carries an incremental payload. The dispatcher adds
   * the branch's executor and runId before forwarding; preview content stays
   * preview — it never reaches an outcome, memory or a decision path.
   */
  onBranchDelta?: (delta: { executor: string; runId: string; seq: number; preview: string; at: string }) => void;
  /**
   * E4.11 (design-a2a-push): when set, dispatch via plain `tasks/send` and ask
   * the peer to POST the final task back (no long-lived stream). The branch
   * then settles through `Orchestrator.receivePushNotification` instead of the
   * SSE path; SSE/polling for non-armed branches is unchanged.
   */
  pushNotification?: PushNotificationConfig;
};

export type DispatchResult =
  | { ok: true; task: Task; events: A2AEvent[]; injectedHits: DataDomainHit[] }
  | { ok: false; reason: string; audit: AuditEntry };

export type AuditSink = (entry: AuditEntry) => void;

export class Dispatcher {
  private lookup: ExecutorLookup;

  constructor(
    directory: ExecutorLookup | Map<string, ExecutorLike>,
    private options: {
      audit: AuditSink;
      now?: () => Date;
      /** Monotonic millisecond clock for SLA measurement; defaults to Date.now. */
      elapsed?: () => number;
      fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
      tokenFor?: (executorName: string) => string | undefined;
      /**
       * S8 V3 (design-guardrails §5): whether a executor holds a content grant
       * (a valid DomainGrant) for a *specific dataDomain*. DataDomain-scoped since the
       * enterprise gate went dataDomain-granular (an unexpired grant for dataDomain A
       * no longer covers enterprise content from dataDomain B). The dataDomainId is the
       * hit's own dataDomain binding; runtime-resolved hits always carry one,
       * caller-asserted hits never do, and the gate refuses the latter as
       * unverifiable. Present only when the runtime is booted with a DomainGrant
       * registry; absent, the enterprise-content guardrail is off and dispatch
       * keeps its V2 behaviour.
       */
      contentGrant?: (executorName: string, dataDomainId: string) => boolean;
    }
  ) {
    this.lookup = directory instanceof Map ? mapAsLookup(directory) : directory;
  }

  async dispatch(request: DispatchRequest): Promise<DispatchResult> {
    const now = this.options.now ?? (() => new Date());
    const runId = request.runId ?? `zeus-run-${crypto.randomUUID()}`;
    let executor: ExecutorLike | undefined;
    let selectionDetail: string | undefined;
    if (request.executor) {
      // Governance gate: a revoked executor is blocked before any request is made
      // or token issued, and the block is audited distinctly from "unknown".
      if (this.lookup.statusOf(request.executor) === 'revoked') {
        const audit: AuditEntry = {
          ts: now().toISOString(), runId, executor: request.executor, skill: request.skill, dataDomain: request.dataDomain,
          decision: 'refused-revoked', detail: `executor ${request.executor} is revoked; dispatch blocked before token issuance`,
        };
        this.options.audit(audit);
        return { ok: false, reason: audit.detail!, audit };
      }
      executor = this.lookup.get(request.executor);
      // Naming a executor is not a licence to ask it for anything: the skill must
      // be one its card declares, or any registered agent could be made to run
      // any skill and the per-skill authorization would be nominal. Auto-select
      // already routes through findBySkill; this is the explicit-name path.
      if (executor && !executor.card.skills.some(skill => skill.id === request.skill)) {
        const audit: AuditEntry = {
          ts: now().toISOString(), runId, executor: executor.name, skill: request.skill, dataDomain: request.dataDomain,
          decision: 'refused-skill-uninstalled',
          detail: `executor ${executor.name} does not declare skill ${request.skill}`,
        };
        this.options.audit(audit);
        return { ok: false, reason: audit.detail!, audit };
      }
    } else {
      try {
        executor = this.selectBySkill(request.skill);
      } catch (error) {
        selectionDetail = error instanceof Error ? error.message : 'executor selection failed';
      }
    }

    if (!executor || selectionDetail) {
      const audit: AuditEntry = { ts: now().toISOString(), runId, executor: request.executor ?? '(auto)', skill: request.skill, dataDomain: request.dataDomain, decision: 'refused-unknown-executor', detail: selectionDetail ?? 'no registered executor provides this skill' };
      this.options.audit(audit);
      return { ok: false, reason: audit.detail!, audit };
    }

    // Data diode: task dataDomain must be allowed by the executor handshake
    if (!executor.handshake.dataDomains.includes(request.dataDomain)) {
      const audit: AuditEntry = { ts: now().toISOString(), runId, executor: executor.name, skill: request.skill, dataDomain: request.dataDomain, decision: 'refused-dataDomain-policy', detail: `handshake.dataDomains=${executor.handshake.dataDomains.join(',')} excludes ${request.dataDomain}` };
      this.options.audit(audit);
      return { ok: false, reason: audit.detail!, audit };
    }

    // design-dataDomain §3.1: handshake.dataPolicy gates the *origin* the dataDomain hits may
    // come from, not the field set (which is the same across policies). The two
    // failure modes — hits that cannot be traced to a declared origin, and a
    // policy that does not admit the origin — refuse the dispatch instead of
    // silently dropping content (the "silent downgrade is a failure shape" rule
    // from #20/#31). Refusals are audited, so a policy that blocked content is
    // visible as the policy working, not as a gap.
    const hits = request.dataDomainHits;
    const origin = request.dataDomainHitsOrigin;
    const policy = executor.handshake.dataPolicy;
    let injectedHits: DataDomainHit[] = [];
    if (hits && hits.length > 0) {
      if (!origin) {
        const audit: AuditEntry = {
          ts: now().toISOString(), runId, executor: executor.name, skill: request.skill, dataDomain: request.dataDomain,
          decision: 'refused-data-policy',
          detail: `handshake.dataPolicy=${policy}: ${hits.length} dataDomain hits carry no origin; dispatch refused (fail-closed)`,
        };
        this.options.audit(audit);
        return { ok: false, reason: audit.detail!, audit };
      }
      if (policy === 'none' || (policy === 'read-task-scope' && origin === 'caller-asserted')) {
        const why = policy === 'none'
          ? `handshake.dataPolicy=none does not accept dataDomain content`
          : `handshake.dataPolicy=read-task-scope accepts only runtime-resolved hits; self-asserted hits cannot be verified as task-scoped`;
        const audit: AuditEntry = {
          ts: now().toISOString(), runId, executor: executor.name, skill: request.skill, dataDomain: request.dataDomain,
          decision: 'refused-data-policy',
          detail: `${why} (origin=${origin})`,
        };
        this.options.audit(audit);
        return { ok: false, reason: audit.detail!, audit };
      }
      injectedHits = hits;
      this.options.audit({
        ts: now().toISOString(), runId, executor: executor.name, skill: request.skill, dataDomain: request.dataDomain,
        decision: 'content-injected',
        detail: `handshake.dataPolicy=${policy}, origin=${origin}, hits=${hits.length}`,
      });
      // S8 V3 (design-guardrails §5): the content-side second gate. Domain
      // isolation already made the hits task-scoped (dataPolicy/origin) and
      // the executor's dataDomains admit the dataDomain type; this gate judges the
      // *content* itself. Enterprise-dataDomain hits carrying a deterministic PII
      // pattern are never shipped verbatim: a content grant (DomainGrant)
      // redacts the PII-bearing entries from the outbound copy, no grant
      // refuses them. Both are audited on the same spine. Personal-dataDomain
      // content and signal-free enterprise content pass through unchanged.
      // The gate is off until boot wires a contentGrant port (absent port =
      // V2 behaviour).
      // DataDomain-scoped (S8 V3 + dataDomain-granular pass): a PII hit is redacted
      // only when the executor holds a content grant for the hit's *own*
      // dataDomain. A hit without a dataDomainId (caller-asserted) has no dataDomain
      // binding a grant could cover, so it is unverifiable and the dispatch
      // fails closed; a hit whose dataDomain the executor has no grant for is
      // refused outright. Any uncovered or unverifiable hit refuses the
      // whole dispatch rather than silently leaking one entry (the "silent
      // downgrade is a failure shape" rule from #20/#31).
      const contentGrant = this.options.contentGrant;
      if (contentGrant && request.dataDomain === 'enterprise' && injectedHits.length > 0) {
        const piiHits = injectedHits.filter(hit => scanContentSignals(hit.snippet).includes('pii-pattern'));
        if (piiHits.length > 0) {
          const unverifiable = piiHits.filter(hit => !hit.dataDomainId);
          const uncovered = piiHits.filter(hit => hit.dataDomainId && !contentGrant(executor.name, hit.dataDomainId));
          if (unverifiable.length > 0 || uncovered.length > 0) {
            const audit: AuditEntry = {
              ts: now().toISOString(), runId, executor: executor.name, skill: request.skill, dataDomain: request.dataDomain,
              decision: 'guardrail-refused',
              detail: `enterprise dataDomain content: ${piiHits.length} PII hit(s) refused (${unverifiable.length} carry no dataDomainId; ${uncovered.length} have no dataDomain-scoped content grant) for executor ${executor.name}`,
            };
            this.options.audit(audit);
            return { ok: false, reason: audit.detail!, audit };
          }
          const covered = piiHits.filter(hit => hit.dataDomainId);
          injectedHits = injectedHits.filter(hit => !covered.includes(hit));
          this.options.audit({
            ts: now().toISOString(), runId, executor: executor.name, skill: request.skill, dataDomain: request.dataDomain,
            decision: 'guardrail-redacted',
            detail: `enterprise dataDomain content: ${covered.length} PII hit(s) redacted from outbound copy (dataDomain-scoped content grant) for executor ${executor.name}`,
          });
        }
      }
    }

    // Re-affirm the revocation gate at the moment the credential is read.
    // `tokenFor` yields nothing for a revoked executor, and a request that leaves
    // without its bearer is a governance decision that failed open: the
    // revocation happened, and the dispatch should have been refused, not sent
    // anonymously. The gate above only ran when the executor was named explicitly,
    // so this check covers both selection paths.
    if (this.lookup.statusOf(executor.name) === 'revoked') {
      const audit: AuditEntry = {
        ts: now().toISOString(), runId, executor: executor.name, skill: request.skill, dataDomain: request.dataDomain,
        decision: 'refused-revoked', detail: `executor ${executor.name} was revoked before its credential was issued; dispatch blocked`,
      };
      this.options.audit(audit);
      return { ok: false, reason: audit.detail!, audit };
    }
    const token = this.options.tokenFor?.(executor.name);

    const events: A2AEvent[] = [];

    // SLA ack enforcement (handshake.sla.ackSeconds): acceptance is the first
    // streamed event, or - for a peer that streams nothing and just returns its
    // terminal snapshot - the arrival of that snapshot. Without the fallback a
    // slow non-streaming peer escaped sla-ack-breached entirely. A breach is
    // audited, never fatal: the task may still succeed, and the audit trail is
    // the governance surface.
    const clock = this.options.elapsed ?? (() => Date.now());
    const ackSeconds = executor.handshake.sla?.ackSeconds;
    const startedAt = clock();
    let ack: { elapsedMs: number; taskId: string } | undefined;

    // Only the outbound request lives inside this catch. Every audit write stays
    // outside it: writing the trail is bookkeeping, and a full disk must not be
    // recorded as the *executor* failing to serve the task.
    let task: Task;
    try {
      // A-12: defense in depth. The registry validates taskUrl at registration,
      // but dispatch is the moment the request actually leaves the process, so
      // the same guard runs here — a stale or restored entry cannot bypass it.
      assertOutboundUrlAllowed(executor.taskUrl);
      // E4.11 (design-a2a-push): an armed branch uses plain tasks/send and
      // carries the receiver config, so the peer pushes the final snapshot back
      // instead of Zeus holding a stream. Unarmed branches keep the SSE path
      // exactly as before.
      task = request.pushNotification
        ? await sendTask(
            {
              taskUrl: executor.taskUrl,
              skill: request.skill,
              params: {
                ...request.params,
                ...(injectedHits.length ? { dataDomainHits: injectedHits } : {}),
                ...(request.contextAppendix !== undefined && request.contextAppendix.length > 0
                  ? { contextAppendix: request.contextAppendix }
                  : {}),
                ...(request.skillInputs !== undefined && request.skillInputs.length > 0
                  ? { skillInputs: request.skillInputs }
                  : {}),
              },
              runId,
              ...(token !== undefined ? { token } : {}),
              ...(request.traceparent === undefined ? {} : { traceparent: request.traceparent }),
              pushNotification: request.pushNotification,
            },
            this.options.fetchImpl,
          )
        : await sendTaskSubscribe(
        {
          taskUrl: executor.taskUrl,
          skill: request.skill,
          params: {
            ...request.params,
            ...(injectedHits.length ? { dataDomainHits: injectedHits } : {}),
            // S1 (design-context-engineering §10): the runtime-assembled memory
            // appendix travels the existing outbound channel — the executor sees
            // what context the runtime gave this branch.
            ...(request.contextAppendix !== undefined && request.contextAppendix.length > 0
              ? { contextAppendix: request.contextAppendix }
              : {}),
            // S1 V2 (design-context-engineering §10.3): skill-declared inputs
            // assembled by the runtime ride the same outbound channel — the
            // executor sees which declared fields were supplied and which absent.
            ...(request.skillInputs !== undefined && request.skillInputs.length > 0
              ? { skillInputs: request.skillInputs }
              : {}),
          },
          runId,
          ...(token !== undefined ? { token } : {}),
          // S6 V2 (design-observability §5): the runtime-derived trace context
          // rides the outbound request as optional metadata.
          ...(request.traceparent === undefined ? {} : { traceparent: request.traceparent }),
        },
        {
          onEvent: event => {
            events.push(event);
            if (!ack) ack = { elapsedMs: clock() - startedAt, taskId: event.taskId };
          },
          ...(request.signal !== undefined ? { signal: request.signal } : {}),
          // S15 V2 (design-streaming §5): forward working-frame increments out
          // of the transport edge, tagged with the branch lineage the client
          // cannot know. Absent a callback the increments are simply not
          // surfaced and the branch stays one-shot-at-settlement.
          ...(request.onBranchDelta === undefined
            ? {}
            : {
                onBranchDelta: delta =>
                  request.onBranchDelta!({ executor: executor.name, runId: delta.runId, seq: delta.seq, preview: delta.preview, at: delta.at }),
              }),
        },
        this.options.fetchImpl
      );
    } catch (error) {
      // design-fan-out §7: an abort is a governance act (the operator cancelled the
      // intent), not the executor failing to serve the task — audit it distinctly
      // so the trail does not read the operator's own cancel as a peer failure.
      const aborted = request.signal?.aborted ?? false;
      const decision = aborted ? 'branch-aborted' : 'dispatch-failed';
      const detail = aborted ? 'aborted by the operator' : error instanceof Error ? error.message : 'dispatch failed';
      this.options.audit({ ts: now().toISOString(), runId, executor: executor.name, skill: request.skill, dataDomain: request.dataDomain, decision, detail });
      return { ok: false, reason: detail, audit: { ts: now().toISOString(), runId, executor: executor.name, skill: request.skill, dataDomain: request.dataDomain, decision, detail } };
    }

    // A peer that streamed no intermediate event still accepted the task by
    // returning it; that completion is the only acceptance signal available.
    if (!ack) ack = { elapsedMs: clock() - startedAt, taskId: task.id };

    if (ackSeconds !== undefined && ack.elapsedMs > ackSeconds * 1000) {
      this.options.audit({
        ts: now().toISOString(), runId, executor: executor.name, skill: request.skill, dataDomain: request.dataDomain,
        decision: 'sla-ack-breached', taskId: ack.taskId,
        detail: `accepted after ${ack.elapsedMs}ms exceeds declared sla.ackSeconds=${ackSeconds}s`,
      });
    }
    this.options.audit({ ts: now().toISOString(), runId, executor: executor.name, skill: request.skill, dataDomain: request.dataDomain, decision: 'dispatched', taskId: task.id, state: task.status.state });
    return { ok: true, task, events, injectedHits };
  }

  async cancel(executorName: string, taskId: string): Promise<Task> {
    const now = this.options.now ?? (() => new Date());
    // A cancellation is a governance action, not a side channel: it must not
    // reach a executor the revocation gate blocks, and it must be as visible on the
    // trail as the dispatch it ends. Both refusals are audited before throwing so
    // the reason is recorded, not just returned to a caller that may swallow it.
    const status = this.lookup.statusOf(executorName);
    if (status === 'revoked') {
      const audit: AuditEntry = {
        ts: now().toISOString(), executor: executorName, taskId,
        decision: 'refused-revoked', detail: `cancel refused: executor ${executorName} is revoked; no request sent`,
      };
      this.options.audit(audit);
      throw new Error(audit.detail);
    }
    const executor = this.lookup.get(executorName);
    if (!executor) {
      const audit: AuditEntry = {
        ts: now().toISOString(), executor: executorName, taskId,
        decision: 'refused-unknown-executor', detail: `cancel refused: ${executorName} is not a registered executor`,
      };
      this.options.audit(audit);
      throw new Error(audit.detail);
    }
    const task = await cancelTask(executor.taskUrl, taskId, this.options.tokenFor?.(executorName), this.options.fetchImpl);
    this.options.audit({ ts: now().toISOString(), executor: executorName, taskId, decision: 'cancel-requested', state: task.status.state });
    return task;
  }

  private selectBySkill(skillId: string): ExecutorLike | undefined {
    const candidates = this.lookup.findBySkill(skillId);
    if (candidates.length > 1) {
      throw new AmbiguousSkillError(`multiple executors provide skill ${skillId}; name one explicitly: ${candidates.map(executor => executor.name).join(', ')}`);
    }
    return candidates[0];
  }
}

export class AmbiguousSkillError extends Error {}

/** Adapt a static executor map (tests / single-process wiring) to ExecutorLookup.
 *  An entry may carry `revoked: true`; the adapter honors it exactly the way
 *  ExecutorRegistry.asExecutorLookup does — invisible to get/findBySkill, reported
 *  by statusOf. Previously the status was hard-coded `active`, so a Map-wired
 *  dispatcher had no revocation gate at all. */
function mapAsLookup(map: Map<string, ExecutorLike>): ExecutorLookup {
  return {
    get: name => {
      const executor = map.get(name);
      return executor && !executor.revoked ? executor : undefined;
    },
    statusOf: name => {
      const executor = map.get(name);
      if (!executor) return 'unknown';
      return executor.revoked ? 'revoked' : 'active';
    },
    findBySkill: skillId =>
      [...map.values()].filter(executor => !executor.revoked && executor.card.skills.some(skill => skill.id === skillId)),
  };
}
