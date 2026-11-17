/**
 * F1.3: agent-dev ToolInvoker.
 *
 * The executor never sees the HTTP client; it calls explicit tool names and
 * the runner enforces the bound position's allow-list. The daemon token is
 * held by the client created by the assembler, not by the task payload.
 */
import { ExecutorError } from '../../execution/errors.js';
import type { EffectResult, ExecutorContext, ToolInvoker } from '../../execution/contract.js';
import { AgentDevApiError, AgentDevClient } from './client.js';

export const AGENT_DEV_TOOLS = {
  getFeatureTask: 'agent-dev:get-feature-task',
  prepareRuntime: 'agent-dev:prepare-runtime',
  executeRuntime: 'agent-dev:execute-runtime',
  getGitEvidence: 'agent-dev:git-evidence',
  getLastCommit: 'agent-dev:last-commit',
} as const;

export interface AgentDevToolInvokerOptions {
  client: AgentDevClient;
}

export class AgentDevToolInvoker implements ToolInvoker {
  private readonly client: AgentDevClient;

  constructor(opts: AgentDevToolInvokerOptions) {
    this.client = opts.client;
  }

  async invoke(tool: string, args: Record<string, unknown>, _ctx: ExecutorContext): Promise<EffectResult> {
    try {
      switch (tool) {
        case AGENT_DEV_TOOLS.getFeatureTask:
          return await this.getFeatureTask(args);
        case AGENT_DEV_TOOLS.prepareRuntime:
          return await this.prepareRuntime(args);
        case AGENT_DEV_TOOLS.executeRuntime:
          return await this.executeRuntime(args);
        case AGENT_DEV_TOOLS.getGitEvidence:
          return await this.getGitEvidence(args);
        case AGENT_DEV_TOOLS.getLastCommit:
          return await this.getLastCommit(args);
        default:
          throw ExecutorError.business(`agent-dev invoker has no tool "${tool}"`);
      }
    } catch (error) {
      if (error instanceof AgentDevApiError) {
        throw error.retryable
          ? ExecutorError.retryable(error.message, { cause: error })
          : ExecutorError.business(error.message, { cause: error });
      }
      throw error;
    }
  }

  private async getFeatureTask(args: Record<string, unknown>): Promise<EffectResult> {
    const task = await this.client.getFeatureTask({
      projectId: requireProjectId(args.projectId),
    });
    return task as unknown as EffectResult;
  }

  private async prepareRuntime(args: Record<string, unknown>): Promise<EffectResult> {
    const prepared = await this.client.prepareRuntime({
      projectId: requireProjectId(args.projectId),
      ...(typeof args.agentId === 'string' && args.agentId.trim() ? { agentId: args.agentId.trim() } : {}),
    });
    return prepared as unknown as EffectResult;
  }

  private async executeRuntime(args: Record<string, unknown>): Promise<EffectResult> {
    const executed = await this.client.executeRuntime({
      projectId: requireProjectId(args.projectId),
    });
    return executed as unknown as EffectResult;
  }

  private async getGitEvidence(args: Record<string, unknown>): Promise<EffectResult> {
    const evidence = await this.client.getGitEvidence({
      projectId: requireProjectId(args.projectId),
    });
    return evidence as unknown as EffectResult;
  }

  private async getLastCommit(args: Record<string, unknown>): Promise<EffectResult> {
    const lastCommit = await this.client.getLastCommit({
      projectId: requireProjectId(args.projectId),
    });
    return lastCommit as unknown as EffectResult;
  }
}

function requireProjectId(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw ExecutorError.business('agent-dev tool call requires a non-empty string "projectId"');
  }
  return value.trim();
}
