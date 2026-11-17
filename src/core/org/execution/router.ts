/**
 * P0 (M5 execution closure): payload-routed composite executor.
 *
 * `serve.ts` can now assemble more than one execution arm at a time. The
 * router chooses by the task payload instead of a process-wide env switch:
 *
 *   - `templateRef`          → TemplateOrgTaskExecutor (built-in goal templates)
 *   - `system: 'agent-dev'`  → AgentDevOrgTaskExecutor
 *   - `workflow` / `system: 'agent-world'` → AgentWorldOrgTaskExecutor
 *
 * Tool invocations are routed by the registered tool-name prefix. This keeps
 * `ctx.tool` authority (granted tools, grade raises, credentials) in the
 * runner; the router only picks the channel client that implements the tool.
 */
import type { Json } from '../types.js';
import type {
  ExecutorCompletion,
  ExecutorContext,
  OrgTaskExecutorV2,
  ToolInvoker,
} from './contract.js';
import { ExecutorError } from './errors.js';

export interface RoutingOrgTaskExecutorOptions {
  template?: OrgTaskExecutorV2;
  agentWorld?: OrgTaskExecutorV2;
  agentDev?: OrgTaskExecutorV2;
}

export interface RoutingToolInvokerOptions {
  agentWorld?: ToolInvoker;
  agentDev?: ToolInvoker;
}

export class RoutingOrgTaskExecutor implements OrgTaskExecutorV2 {
  private readonly template: OrgTaskExecutorV2 | undefined;
  private readonly agentWorld: OrgTaskExecutorV2 | undefined;
  private readonly agentDev: OrgTaskExecutorV2 | undefined;

  constructor(opts: RoutingOrgTaskExecutorOptions) {
    this.template = opts.template;
    this.agentWorld = opts.agentWorld;
    this.agentDev = opts.agentDev;
  }

  async run(ctx: ExecutorContext): Promise<ExecutorCompletion> {
    const payload = asRecord(ctx.task.payload);
    if (payload && typeof payload.templateRef === 'string') {
      if (!this.template) {
        throw ExecutorError.business('template executor is not assembled for this task');
      }
      return this.template.run(ctx);
    }
    if (payload?.system === 'agent-dev') {
      if (!this.agentDev) {
        throw ExecutorError.business('agent-dev executor is not assembled for this task');
      }
      return this.agentDev.run(ctx);
    }
    if (payload?.system === 'agent-world' || typeof payload?.workflow === 'string') {
      if (!this.agentWorld) {
        throw ExecutorError.business('agent-world executor is not assembled for this task');
      }
      return this.agentWorld.run(ctx);
    }
    throw ExecutorError.business(
      'org task payload does not declare a supported execution arm (templateRef, system=agent-dev, or workflow)',
      { detail: { taskId: ctx.task.id } },
    );
  }
}

export class RoutingToolInvoker implements ToolInvoker {
  private readonly agentWorld: ToolInvoker | undefined;
  private readonly agentDev: ToolInvoker | undefined;

  constructor(opts: RoutingToolInvokerOptions) {
    this.agentWorld = opts.agentWorld;
    this.agentDev = opts.agentDev;
  }

  invoke(tool: string, args: Record<string, unknown>, ctx: ExecutorContext): Promise<Json> {
    if (tool.startsWith('agent-world:')) {
      if (!this.agentWorld) {
        return Promise.reject(ExecutorError.business(`agent-world arm is not assembled for tool "${tool}"`));
      }
      return this.agentWorld.invoke(tool, args, ctx);
    }
    if (tool.startsWith('agent-dev:')) {
      if (!this.agentDev) {
        return Promise.reject(ExecutorError.business(`agent-dev arm is not assembled for tool "${tool}"`));
      }
      return this.agentDev.invoke(tool, args, ctx);
    }
    return Promise.reject(ExecutorError.business(`no tool invoker registered for "${tool}"`));
  }
}

function asRecord(value: Json | undefined): Record<string, Json> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, Json>)
    : undefined;
}
