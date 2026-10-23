/**
 * T-M7-02: position-routed OrgTaskExecutor that maps an OrgTask onto an
 * agent-world graph run.
 *
 * Payload shape (documented; carried in `task.payload`):
 * ```json
 * {
 *   "workflow": "content" | "listing" | "after-sales",
 *   "input":    "string  — the run input / task brief",
 *   "graphName": "optional graph instance name",
 *   "fieldValues": { "reviewWebhookUrl": "https://…" },
 *   "trigger":  "optional run trigger label"
 * }
 * ```
 *
 * Workflow → template routing:
 *   content      → tpl-xiaohongshu   (小红书种草笔记; fully automatic, no human node)
 *   listing      → tpl-review-publish(人工审核发布; halts at the `human` node)
 *   after-sales → tpl-customer-service(客服工单; branches to humanReview on complex tickets)
 *
 * Idempotency / replay discipline:
 *   - the start effect (create graph + run) is wrapped in `ctx.action('aw:start')`
 *     AND agent-world's own `Idempotency-Key` header, so a retry or a resume
 *     after a suspension never starts a second graph run;
 *   - the human checkpoint uses a stable `idempotencyKey`; on replay the runner
 *     returns the already-decided record instead of creating a new checkpoint;
 *   - the resume effect is a separate `ctx.action` keyed by verdict, so an
 *     approve/resume pair happens exactly once.
 *
 * Checkpoints: listing (public publish) is graded D3 (external/irreversible);
 * after-sales (complex ticket handling) is graded D2 (org/hard). Reject settles
 * the task as a business failure after resuming agent-world with `reject`.
 */
import { ExecutorError } from '../../execution/errors.js';
import type {
  EffectResult,
  ExecutorCompletion,
  ExecutorContext,
  OrgTaskExecutorV2,
} from '../../execution/contract.js';
import type { Grade } from '../../../types.js';
import { AGENT_WORLD_TOOLS } from './tools.js';
import type { AgentWorldRunView } from './client.js';

export type AgentWorldWorkflow = 'content' | 'listing' | 'after-sales';

export interface AgentWorldTaskPayload {
  workflow: AgentWorldWorkflow;
  input: string;
  graphName?: string;
  fieldValues?: Record<string, string>;
  trigger?: string;
}

const WORKFLOW_TEMPLATES: Record<AgentWorldWorkflow, string> = {
  content: 'tpl-xiaohongshu',
  listing: 'tpl-review-publish',
  'after-sales': 'tpl-customer-service',
};

/** Checkpoint grading per workflow: listing publishes externally → D3. */
const WORKFLOW_CHECKPOINT: Record<AgentWorldWorkflow, { grade: Grade; impact: 'external' | 'org'; reversibility: 'irreversible' | 'hard' }> = {
  content: { grade: 'D0', impact: 'org', reversibility: 'hard' },
  listing: { grade: 'D3', impact: 'external', reversibility: 'irreversible' },
  'after-sales': { grade: 'D2', impact: 'org', reversibility: 'hard' },
};

export interface AgentWorldOrgTaskExecutorOptions {
  /** Poll interval ms while the run is active. */
  pollIntervalMs?: number;
  /** Hard cap on polls per wait (the runner deadline is the real backstop). */
  maxPolls?: number;
}

export class AgentWorldOrgTaskExecutor implements OrgTaskExecutorV2 {
  private readonly pollIntervalMs: number;
  private readonly maxPolls: number;

  constructor(opts: AgentWorldOrgTaskExecutorOptions = {}) {
    this.pollIntervalMs = opts.pollIntervalMs ?? 500;
    this.maxPolls = opts.maxPolls ?? 600;
  }

  async run(ctx: ExecutorContext): Promise<ExecutorCompletion> {
    const payload = parsePayload(ctx.task.payload);
    const template = WORKFLOW_TEMPLATES[payload.workflow];
    const checkpoint = WORKFLOW_CHECKPOINT[payload.workflow];

    ctx.reportProgress({
      stage: 'agent-world:start',
      data: { workflow: payload.workflow, template },
    });

    // Idempotent start: at most one graph + run per task, across retries/replays.
    const started = (await ctx.action('aw:start', async () =>
      ctx.tool(AGENT_WORLD_TOOLS.runGraph, {
        template,
        ...(payload.graphName ? { name: payload.graphName } : {}),
        ...(payload.fieldValues ? { fieldValues: payload.fieldValues } : {}),
        input: payload.input,
        ...(payload.trigger ? { trigger: payload.trigger } : {}),
        idempotencyKey: ctx.task.id,
      }),
    )) as unknown as { graphId: string; runId: string; replay: boolean };

    let view = await this.waitForTerminalOrHalt(ctx, started.runId);

    // Human checkpoint: listing and after-sales park on a human node.
    if (view.status === 'halted') {
      ctx.reportProgress({
        stage: 'agent-world:awaiting-decision',
        data: { runId: started.runId, haltedNodeId: view.haltedNodeId, haltedReason: view.haltedReason },
      });
      const decision = await ctx.requestDecision({
        intent: `agent-world run ${started.runId} (${payload.workflow}) halted at ${view.haltedNodeId ?? 'human node'}: ${view.haltedReason ?? 'human review required'}`,
        impact: checkpoint.impact,
        reversibility: checkpoint.reversibility,
        proposal: {
          system: 'agent-world',
          workflow: payload.workflow,
          graphId: started.graphId,
          runId: started.runId,
          haltedNodeId: view.haltedNodeId,
          haltedReason: view.haltedReason,
        },
        // Stable across replays: resume reuses the resolved record by this key.
        idempotencyKey: `${ctx.task.id}:human`,
      });

      const rejected = decision.result?.outcome === 'rejected';
      const verdict = rejected ? 'reject' : 'approve';
      await ctx.action(`aw:resume:${verdict}`, async () =>
        ctx.tool(AGENT_WORLD_TOOLS.resumeRun, { runId: started.runId, action: verdict }),
      );
      if (rejected) {
        throw ExecutorError.business(`human reviewer rejected agent-world run ${started.runId}`);
      }
      view = await this.waitForTerminalOrHalt(ctx, started.runId, false);
    }

    if (view.status !== 'done') {
      // A failed/tripped/cancelled run is a definitive channel outcome.
      throw ExecutorError.business(
        `agent-world run ${started.runId} ended with status "${view.status}"`,
        { detail: { runId: started.runId, status: view.status, reason: view.haltedReason } },
      );
    }

    const artifacts = (await ctx.tool(AGENT_WORLD_TOOLS.getRun, {
      runId: started.runId,
      view: 'artifacts',
    })) as unknown as AgentWorldArtifactSummary[];

    ctx.reportProgress({
      stage: 'agent-world:done',
      data: { runId: started.runId, nodes: view.haltedNodeId ?? null },
    });

    return {
      outcome: 'complete',
      result: {
        system: 'agent-world',
        workflow: payload.workflow,
        template,
        graphId: started.graphId,
        runId: started.runId,
        finalStatus: view.status,
        checkpointGrade: checkpoint.grade,
        artifacts: artifacts.map(a => ({ id: a.id, kind: a.kind, ...(a.label ? { label: a.label } : {}) })),
      },
    };
  }

  /**
   * Poll until the run leaves `running` (done/failed) or parks on a human halt.
   * When `treatHaltedAsTerminal` is false (right after a resume), a still-`halted`
   * run means the resume is still propagating, so we keep polling instead of
   * treating it as a non-done terminal state.
   */
  private async waitForTerminalOrHalt(
    ctx: ExecutorContext,
    runId: string,
    treatHaltedAsTerminal = true,
  ): Promise<AgentWorldRunView> {
    let view = await this.readView(ctx, runId);
    const inFlight = (s: string) =>
      s === 'running' || (!treatHaltedAsTerminal && s === 'halted');
    for (let i = 0; i < this.maxPolls && inFlight(view.status); i++) {
      if (ctx.remainingMs < this.pollIntervalMs + 250) break;
      await sleep(this.pollIntervalMs);
      view = await this.readView(ctx, runId);
    }
    return view;
  }

  private async readView(ctx: ExecutorContext, runId: string): Promise<AgentWorldRunView> {
    return (await ctx.tool(AGENT_WORLD_TOOLS.getRun, { runId, view: 'timeline' })) as unknown as AgentWorldRunView;
  }
}

interface AgentWorldArtifactSummary {
  id: string;
  kind: string;
  label?: string;
}

function parsePayload(payload: EffectResult): AgentWorldTaskPayload {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw ExecutorError.business('org task payload must be an object');
  }
  const p = payload as Record<string, unknown>;
  const workflow = p.workflow;
  if (workflow !== 'content' && workflow !== 'listing' && workflow !== 'after-sales') {
    throw ExecutorError.business('payload.workflow must be "content" | "listing" | "after-sales"');
  }
  if (typeof p.input !== 'string' || p.input.trim() === '') {
    throw ExecutorError.business('payload.input must be a non-empty string');
  }
  return {
    workflow,
    input: p.input,
    ...(typeof p.graphName === 'string' ? { graphName: p.graphName } : {}),
    ...(isStringRecord(p.fieldValues) ? { fieldValues: p.fieldValues } : {}),
    ...(typeof p.trigger === 'string' ? { trigger: p.trigger } : {}),
  };
}

function isStringRecord(v: unknown): v is Record<string, string> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    && Object.values(v as Record<string, unknown>).every(x => typeof x === 'string');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
