/**
 * P0 (M5 execution closure): built-in goal-template executor.
 *
 * The scheduler expands a `templateRef` goal into ordinary org tasks whose
 * payload still carries `{ templateRef, stepId, goalId, goalTitle, period,
 * scheduledFor }`. This executor turns those steps into real work:
 *
 *   - weekly-report.collect    gathers the occurrence's org tasks;
 *   - weekly-report.summarize  formats the collected snapshot as Markdown;
 *   - weekly-report.human-review + content-review.review
 *                              pause at a D2 decision checkpoint;
 *   - content-review.draft     delegates to the configured agent-world arm
 *                              (content workflow) through the same runner
 *                              context, so tool authority still applies.
 *
 * It deliberately does not invent a generic LLM arm: local weekly-report steps
 * are deterministic, and the only generative step reuses the existing
 * agent-world content graph. Missing arms fail as business errors instead of
 * silently leaving the task pending.
 */
import type { Json, OrgTask } from '../types.js';
import type {
  ExecutorCompletion,
  ExecutorContext,
  OrgTaskExecutorV2,
} from './contract.js';
import { ExecutorError } from './errors.js';

export interface TemplateOrgTaskExecutorOptions {
  /** Read-only org access used by the local weekly-report steps. */
  listTasks: (organizationId: string) => OrgTask[];
  getTask: (taskId: string) => OrgTask;
  /** Existing agent-world arm used for content-review.draft. */
  contentExecutor?: OrgTaskExecutorV2;
  /** Test seam; production uses the wall clock. */
  clock?: () => string;
}

interface TemplatePayload {
  templateRef: string;
  stepId: string;
  goalId?: string;
  goalTitle?: string;
  scheduledFor?: string;
  input?: string;
}

interface WeeklyReportTask {
  [key: string]: Json;
  id: string;
  title: string;
  status: string;
  stepId: string;
  updatedAt: string;
}

interface WeeklyReport {
  [key: string]: Json;
  goalId?: string;
  goalTitle?: string;
  scheduledFor?: string;
  generatedAt: string;
  tasks: WeeklyReportTask[];
}

export class TemplateOrgTaskExecutor implements OrgTaskExecutorV2 {
  private readonly listTasks: (organizationId: string) => OrgTask[];
  private readonly getTask: (taskId: string) => OrgTask;
  private readonly contentExecutor: OrgTaskExecutorV2 | undefined;
  private readonly clock: () => string;

  constructor(opts: TemplateOrgTaskExecutorOptions) {
    this.listTasks = opts.listTasks;
    this.getTask = opts.getTask;
    this.contentExecutor = opts.contentExecutor;
    this.clock = opts.clock ?? (() => new Date().toISOString());
  }

  async run(ctx: ExecutorContext): Promise<ExecutorCompletion> {
    const payload = parseTemplatePayload(ctx.task.payload);
    ctx.reportProgress({
      stage: `template:${payload.templateRef}:${payload.stepId}`,
      data: {
        templateRef: payload.templateRef,
        stepId: payload.stepId,
        ...(payload.goalId ? { goalId: payload.goalId } : {}),
      },
    });

    switch (`${payload.templateRef}.${payload.stepId}`) {
      case 'weekly-report.collect':
        return this.collectWeeklyReport(ctx, payload);
      case 'weekly-report.summarize':
        return this.summarizeWeeklyReport(ctx, payload);
      case 'weekly-report.human-review':
      case 'content-review.review':
        return this.humanReview(ctx, payload);
      case 'content-review.draft':
        return this.draftContent(ctx, payload);
      default:
        throw ExecutorError.business(
          `unsupported template step "${payload.templateRef}.${payload.stepId}"`,
          { detail: { templateRef: payload.templateRef, stepId: payload.stepId } },
        );
    }
  }

  private collectWeeklyReport(ctx: ExecutorContext, payload: TemplatePayload): ExecutorCompletion {
    if (!payload.goalId) {
      throw ExecutorError.business('weekly-report.collect requires payload.goalId');
    }
    const tasks = this.listTasks(ctx.task.organizationId)
      .filter(candidate => {
        const candidatePayload = asRecord(candidate.payload);
        const sameGoal = candidatePayload?.goalId === payload.goalId;
        const sameOccurrence = !payload.scheduledFor || candidatePayload?.scheduledFor === payload.scheduledFor;
        return sameGoal && sameOccurrence;
      })
      .map(candidate => {
        const candidatePayload = asRecord(candidate.payload);
        return {
          id: candidate.id,
          title: candidate.title,
          status: candidate.status,
          stepId: typeof candidatePayload?.stepId === 'string' ? candidatePayload.stepId : 'unknown',
          updatedAt: candidate.updatedAt,
        };
      });

    const report: WeeklyReport = {
      ...(payload.goalId ? { goalId: payload.goalId } : {}),
      ...(payload.goalTitle ? { goalTitle: payload.goalTitle } : {}),
      ...(payload.scheduledFor ? { scheduledFor: payload.scheduledFor } : {}),
      generatedAt: this.clock(),
      tasks,
    };
    return {
      outcome: 'complete',
      result: {
        system: 'template',
        templateRef: payload.templateRef,
        stepId: payload.stepId,
        report,
      },
    };
  }

  private summarizeWeeklyReport(ctx: ExecutorContext, payload: TemplatePayload): ExecutorCompletion {
    const dependencyId = ctx.task.dependsOn?.[0];
    if (!dependencyId) {
      throw ExecutorError.business('weekly-report.summarize requires a collect dependency');
    }
    const dependency = this.getTask(dependencyId);
    if (dependency.status !== 'done' || dependency.result === undefined) {
      throw ExecutorError.business(
        `weekly-report.summarize dependency ${dependencyId} is not done with a result`,
        { detail: { dependencyId, status: dependency.status } },
      );
    }
    const report = readWeeklyReport(dependency.result);
    if (!report) {
      throw ExecutorError.business(`dependency ${dependencyId} did not return a weekly report`);
    }

    const title = report.goalTitle ?? payload.goalTitle ?? ctx.task.title;
    const lines = [
      `# ${title}`,
      '',
      `Occurrence: ${report.scheduledFor ?? payload.scheduledFor ?? 'unscheduled'}`,
      `Generated at: ${report.generatedAt}`,
      '',
      `## Tasks (${report.tasks.length})`,
      '',
      ...report.tasks.map(task => `- [${task.status}] ${task.title} (${task.stepId})`),
    ];
    return {
      outcome: 'complete',
      result: {
        system: 'template',
        templateRef: payload.templateRef,
        stepId: payload.stepId,
        sourceTaskId: dependencyId,
        taskCount: report.tasks.length,
        summary: lines.join('\n'),
      },
    };
  }

  private async humanReview(ctx: ExecutorContext, payload: TemplatePayload): Promise<ExecutorCompletion> {
    const decision = await ctx.requestDecision({
      intent: `${payload.templateRef} ${payload.stepId}: review "${ctx.task.title}"`,
      impact: 'org',
      reversibility: 'hard',
      proposal: {
        system: 'template',
        templateRef: payload.templateRef,
        stepId: payload.stepId,
        taskId: ctx.task.id,
        ...(payload.goalId ? { goalId: payload.goalId } : {}),
        ...(payload.goalTitle ? { goalTitle: payload.goalTitle } : {}),
        ...(payload.scheduledFor ? { scheduledFor: payload.scheduledFor } : {}),
      },
      idempotencyKey: `${ctx.task.id}:review`,
    });
    const outcome = decision.result?.outcome;
    if (outcome === 'rejected' || outcome === 'timed-out') {
      throw ExecutorError.business(
        `human review ${outcome} for template step "${payload.templateRef}.${payload.stepId}"`,
        { detail: { decisionId: decision.id, outcome } },
      );
    }
    return {
      outcome: 'complete',
      result: {
        system: 'template',
        templateRef: payload.templateRef,
        stepId: payload.stepId,
        decisionId: decision.id,
        decisionOutcome: outcome ?? decision.status,
      },
    };
  }

  private async draftContent(ctx: ExecutorContext, payload: TemplatePayload): Promise<ExecutorCompletion> {
    if (!this.contentExecutor) {
      throw ExecutorError.business(
        'content-review.draft requires the agent-world content executor; configure ZEUS_AGENT_WORLD_BASE_URL',
      );
    }
    const input = payload.input?.trim()
      || `${payload.goalTitle ?? ctx.task.title}\n\nDraft a content review package for: ${ctx.task.title}`;
    ctx.reportProgress({
      stage: 'template:content-review:draft',
      data: { delegatedTo: 'agent-world', workflow: 'content' },
    });
    // Keep the runner's context (tool authority, deadline, action store) while
    // swapping only the arm-specific payload. `remainingMs` stays live.
    const innerCtx: ExecutorContext = {
      ...ctx,
      task: {
        ...ctx.task,
        payload: { workflow: 'content', input, trigger: `template:${payload.templateRef}:${payload.stepId}` },
      },
      get remainingMs() {
        return ctx.remainingMs;
      },
    };
    return this.contentExecutor.run(innerCtx);
  }
}

function parseTemplatePayload(payload: Json): TemplatePayload {
  const record = asRecord(payload);
  if (!record) throw ExecutorError.business('template task payload must be an object');
  if (typeof record.templateRef !== 'string' || record.templateRef.trim() === '') {
    throw ExecutorError.business('template task payload.templateRef must be a non-empty string');
  }
  if (typeof record.stepId !== 'string' || record.stepId.trim() === '') {
    throw ExecutorError.business('template task payload.stepId must be a non-empty string');
  }
  return {
    templateRef: record.templateRef,
    stepId: record.stepId,
    ...(typeof record.goalId === 'string' ? { goalId: record.goalId } : {}),
    ...(typeof record.goalTitle === 'string' ? { goalTitle: record.goalTitle } : {}),
    ...(typeof record.scheduledFor === 'string' ? { scheduledFor: record.scheduledFor } : {}),
    ...(typeof record.input === 'string' ? { input: record.input } : {}),
  };
}

function readWeeklyReport(result: Json): WeeklyReport | undefined {
  const record = asRecord(result);
  const report = record ? asRecord(record.report) : undefined;
  if (!report || !Array.isArray(report.tasks)) return undefined;
  const tasks: WeeklyReportTask[] = [];
  for (const item of report.tasks) {
    const task = asRecord(item);
    if (!task) continue;
    tasks.push({
      id: typeof task.id === 'string' ? task.id : '',
      title: typeof task.title === 'string' ? task.title : '(untitled)',
      status: typeof task.status === 'string' ? task.status : 'unknown',
      stepId: typeof task.stepId === 'string' ? task.stepId : 'unknown',
      updatedAt: typeof task.updatedAt === 'string' ? task.updatedAt : '',
    });
  }
  return {
    ...(typeof report.goalId === 'string' ? { goalId: report.goalId } : {}),
    ...(typeof report.goalTitle === 'string' ? { goalTitle: report.goalTitle } : {}),
    ...(typeof report.scheduledFor === 'string' ? { scheduledFor: report.scheduledFor } : {}),
    generatedAt: typeof report.generatedAt === 'string' ? report.generatedAt : '',
    tasks,
  };
}

function asRecord(value: Json | undefined): Record<string, Json> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, Json>)
    : undefined;
}
