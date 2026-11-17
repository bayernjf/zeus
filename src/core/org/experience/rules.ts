/**
 * Deterministic candidate rules (F4.2 auto stage).
 *
 * Every rule is a pure function of the settlement record — zero model calls,
 * zero cost, reproducible in tests. Adding a rule later is a code change with
 * a new `ruleId`, so old candidates stay dedupable by `(taskId, ruleId)`.
 */
import type { OrgTask, OrgTaskOutcome } from '../types.js';
import type { ExperienceCandidateKind } from './types.js';

export interface CandidateDraft {
  ruleId: string;
  kind: ExperienceCandidateKind;
  title: string;
  detail: string;
}

const ERROR_EXCERPT = 160;

function excerpt(error: string | undefined): string {
  if (!error) return '';
  return error.length > ERROR_EXCERPT ? `${error.slice(0, ERROR_EXCERPT)}…` : error;
}

function failureDraft(outcome: OrgTaskOutcome): CandidateDraft {
  const base = `任务「${outcome.status === 'failed' ? '失败' : '完成'}」`;
  switch (outcome.failedKind) {
    case 'timeout':
      return {
        ruleId: 'failure.timeout',
        kind: 'failure-avoidance',
        title: '超时失败：先拆步或放宽 deadline',
        detail: `${base}在 deadline 内未结束（${outcome.durationMs ?? '未知'}ms）。下次派发前把长步骤拆小，或只对确需长跑的岗位放宽 taskDeadlineMs。`,
      };
    case 'tool_denied':
      return {
        ruleId: 'failure.tool-denied',
        kind: 'failure-avoidance',
        title: '工具越权被拒：补齐岗位授权或复核动作等级',
        detail: `${base}调用了岗位未授权的工具${outcome.error ? `（${excerpt(outcome.error)}）` : ''}。先确认这是能力缺口还是设计意图：要放行就补 allowedTools，不该放行就保留拒绝。`,
      };
    case 'retryable_exhausted':
      return {
        ruleId: 'failure.retry-exhausted',
        kind: 'failure-avoidance',
        title: '重试耗尽：先修可重试错误再派发',
        detail: `${base}在重试上限内仍未成功${outcome.error ? `：${excerpt(outcome.error)}` : ''}。这类错误通常不是抖动而是稳定缺陷，先把错误修掉再派发，避免每次都烧满重试预算。`,
      };
    case 'business':
      return {
        ruleId: 'failure.business',
        kind: 'failure-avoidance',
        title: '业务失败：把错误前置成校验',
        detail: `${base}在业务层失败${outcome.error ? `：${excerpt(outcome.error)}` : ''}。把这条错误转成派发前的检查（payload 字段、凭证、模板配置），避免重复消耗一次执行。`,
      };
    default:
      return {
        ruleId: 'failure.other',
        kind: 'failure-avoidance',
        title: '失败：先归类失败类型',
        detail: `${base}结束但未归类失败类型${outcome.error ? `：${excerpt(outcome.error)}` : ''}。先补齐 failedKind，再决定是改岗位授权、改 payload 还是改模板。`,
      };
  }
}

function successDrafts(outcome: OrgTaskOutcome): CandidateDraft[] {
  const drafts: CandidateDraft[] = [];
  if (outcome.attempts > 1) {
    drafts.push({
      ruleId: 'success.retry',
      kind: 'success-recipe',
      title: '重试后成功：把上次失败条件写进前置校验',
      detail: `任务重试 ${outcome.attempts} 次后才成功。把第一次失败的原因固化成派发前检查，能把这条链路的期望耗时降下来。`,
    });
  }
  if (outcome.decisions.length > 0) {
    drafts.push({
      ruleId: 'success.checkpoint',
      kind: 'success-recipe',
      title: '含人审检查点：保留 D2/D3 闸门',
      detail: `任务经过 ${outcome.decisions.length} 个人审检查点后成功。这类流程不要为了提速去掉闸门，闸门本身就是质量来源。`,
    });
  }
  return drafts;
}

/**
 * Derive candidates for one settlement. A clean single-attempt success
 * yields nothing on purpose: "it worked normally" is not an experience worth
 * teaching.
 */
export function deriveCandidateDrafts(
  task: OrgTask,
  outcome: OrgTaskOutcome,
): CandidateDraft[] {
  void task;
  if (outcome.status === 'failed') return [failureDraft(outcome)];
  return successDrafts(outcome);
}
