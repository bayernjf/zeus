/**
 * F1.3: the second execution arm — drive agent-dev's local CLI through its
 * governed project-scoped HTTP surface.
 *
 * Payload shape (carried in `task.payload`):
 * ```json
 * {
 *   "system": "agent-dev",
 *   "projectId": "…",
 *   "blueprintRevision": 3,
 *   "featureTaskId": "…",
 *   "agentId": "codex"
 * }
 * ```
 *
 * A Feature Task must already be approved by a human in agent-dev Studio. The
 * adapter never creates or approves one; it reads the approved task, prepares
 * the Runtime run, executes it and returns the Git diff. That keeps the
 * governance boundary in the layer that owns it and avoids a second "current"
 * Feature Task per Blueprint revision.
 *
 * Prepare + execute are idempotent `ctx.action`s, so a runner replay does not
 * start a second CLI run.
 */
import { ExecutorError } from '../../execution/errors.js';
import type { ExecutorCompletion, ExecutorContext, OrgTaskExecutorV2 } from '../../execution/contract.js';
import type { Json } from '../../types.js';
import { AGENT_DEV_TOOLS } from './tools.js';
import type { AgentDevFeatureTask, AgentDevGitEvidence, AgentDevRuntimeRun } from './client.js';

export interface AgentDevTaskPayload {
  system: 'agent-dev';
  projectId: string;
  blueprintRevision: number;
  featureTaskId: string;
  agentId?: string;
}

export class AgentDevOrgTaskExecutor implements OrgTaskExecutorV2 {
  async run(ctx: ExecutorContext): Promise<ExecutorCompletion> {
    const payload = parsePayload(ctx.task.payload);

    ctx.reportProgress({
      stage: 'agent-dev:read-feature-task',
      data: { projectId: payload.projectId, blueprintRevision: payload.blueprintRevision },
    });
    const current = (await ctx.tool(AGENT_DEV_TOOLS.getFeatureTask, {
      projectId: payload.projectId,
    })) as unknown as { task: AgentDevFeatureTask | null };
    const task = current.task;
    if (!task) {
      throw ExecutorError.business(
        `agent-dev project ${payload.projectId} has no Feature Task; create and approve one in Studio first`,
      );
    }
    if (task.id !== payload.featureTaskId) {
      throw ExecutorError.business(
        `agent-dev Feature Task changed from ${payload.featureTaskId} to ${task.id}; refresh the org task payload`,
      );
    }
    if (task.status !== 'approved') {
      throw ExecutorError.business(`agent-dev Feature Task ${task.id} is "${task.status}", not approved`);
    }

    ctx.reportProgress({ stage: 'agent-dev:prepare-runtime', data: { taskId: task.id } });
    const prepared = (await ctx.action('agentdev:prepare-runtime', async () =>
      ctx.tool(AGENT_DEV_TOOLS.prepareRuntime, {
        projectId: payload.projectId,
        ...(payload.agentId ? { agentId: payload.agentId } : {}),
      }),
    )) as unknown as { run: AgentDevRuntimeRun };
    if (!prepared.run?.id) throw ExecutorError.business('agent-dev prepare-runtime returned no run id');

    ctx.reportProgress({ stage: 'agent-dev:execute-runtime', data: { runId: prepared.run.id } });
    const executed = (await ctx.action('agentdev:execute-runtime', async () =>
      ctx.tool(AGENT_DEV_TOOLS.executeRuntime, { projectId: payload.projectId }),
    )) as unknown as { run: AgentDevRuntimeRun };
    const run = executed.run;
    if (!run) throw ExecutorError.business('agent-dev execute-runtime returned no run');

    if (run.status !== 'completed') {
      throw ExecutorError.business(
        `agent-dev run ${run.id} ended with status "${run.status}"`,
        {
          detail: {
            runId: run.id,
            status: run.status,
            exitCode: run.result?.exitCode ?? null,
            output: run.result?.output ?? null,
          },
        },
      );
    }

    const evidence = (await ctx.tool(AGENT_DEV_TOOLS.getGitEvidence, {
      projectId: payload.projectId,
    })) as unknown as { evidence: AgentDevGitEvidence };
    const lastCommit = (await ctx.tool(AGENT_DEV_TOOLS.getLastCommit, {
      projectId: payload.projectId,
    })) as unknown as { lastCommit: { hash: string; subject: string; diffStat: string } | null };

    ctx.reportProgress({
      stage: 'agent-dev:done',
      data: {
        runId: run.id,
        status: run.status,
        diffStat: evidence.evidence?.diffStat ?? lastCommit.lastCommit?.diffStat ?? null,
      },
    });

    return {
      outcome: 'complete',
      result: {
        system: 'agent-dev',
        projectId: payload.projectId,
        featureTaskId: task.id,
        runId: run.id,
        agentId: run.agentId,
        status: run.status,
        output: run.result?.output ?? '',
        git: {
          branch: evidence.evidence?.branch ?? '',
          head: evidence.evidence?.head ?? '',
          status: evidence.evidence?.status ?? '',
          diffStat: evidence.evidence?.diffStat ?? '',
          lastCommit: lastCommit.lastCommit,
        },
      } as unknown as Json,
    };
  }
}

export function parsePayload(raw: Json): AgentDevTaskPayload {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw ExecutorError.business('agent-dev task payload must be an object');
  }
  const p = raw as Record<string, unknown>;
  if (p.system !== 'agent-dev') throw ExecutorError.business('agent-dev task payload must declare system "agent-dev"');
  const projectId = nonEmpty(p.projectId, 'projectId');
  const featureTaskId = nonEmpty(p.featureTaskId, 'featureTaskId');
  if (typeof p.blueprintRevision !== 'number' || !Number.isInteger(p.blueprintRevision) || p.blueprintRevision <= 0) {
    throw ExecutorError.business('agent-dev task payload requires a positive integer blueprintRevision');
  }
  return {
    system: 'agent-dev',
    projectId,
    blueprintRevision: p.blueprintRevision,
    featureTaskId,
    ...(typeof p.agentId === 'string' && p.agentId.trim() ? { agentId: p.agentId.trim() } : {}),
  };
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw ExecutorError.business(`agent-dev task payload requires a non-empty string "${field}"`);
  }
  return value.trim();
}
