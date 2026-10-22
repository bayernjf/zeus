/**
 * gradeDecision 纯函数（T-M1-04，Tier0-设计文档 §4.1/§4.2）。
 *
 * 规则自上而下匹配，第一条命中即定级（顺序敏感，高档规则必须排在前面）；
 * 无规则命中 → policy.defaultGrade（拍板结论为 D2 fail-closed，PRD §11）。
 * 字段间 AND、数组内 OR；条件给出但请求无对应值 = 不匹配（不降级为无条件）。
 */
import type { Grade } from '../types.js';
import type { DecisionPolicy, DecisionRequest, GradeDecision, PolicyRule, RuleMatch } from './policy.js';

/** 分级 → 执行模式（设计 §4.2）。 */
export const GRADE_MODES = {
  D0: 'auto',
  D1: 'approve-async',
  D2: 'approve-sync',
  D3: 'human-led',
} as const;

export type GradeMode = (typeof GRADE_MODES)[keyof typeof GRADE_MODES];

export function modeForGrade(grade: Grade): GradeMode {
  return GRADE_MODES[grade];
}

/** 条件缺省（undefined）= 不限；条件给出但请求无值 = 不匹配。数组内命中任一即可。 */
function listMatches(ruleValues: string[] | undefined, actual: string | undefined): boolean {
  if (ruleValues === undefined) return true;
  if (actual === undefined) return false;
  return ruleValues.includes(actual);
}

/** 风险标签：请求带任一规则点名标签即命中（OR）。 */
function tagsMatch(ruleTags: string[] | undefined, actual: string[] | undefined): boolean {
  if (ruleTags === undefined) return true;
  if (actual === undefined) return false;
  return actual.some(tag => ruleTags.includes(tag));
}

/** 金额：币种一致且落在闭区间内（max 省略 = 上不封顶）；条件给出但请求无金额 = 不匹配。 */
function amountMatches(
  rule: RuleMatch['amount'],
  actual: DecisionRequest['amount']
): boolean {
  if (rule === undefined) return true;
  if (actual === undefined) return false;
  if (actual.currency !== rule.currency) return false;
  if (actual.value < rule.min) return false;
  if (rule.max !== undefined && actual.value > rule.max) return false;
  return true;
}

function matches(match: RuleMatch, req: DecisionRequest): boolean {
  return (
    listMatches(match.domains, req.domain) &&
    listMatches(match.intents, req.intent) &&
    amountMatches(match.amount, req.amount) &&
    tagsMatch(match.riskTags, req.riskTags) &&
    listMatches(match.impact, req.impact) &&
    listMatches(match.reversibility, req.reversibility)
  );
}

/** 列出命中的具体条件，用于审计 reason（人类可读，不参与控制流）。 */
function describeMatch(match: RuleMatch, req: DecisionRequest): string {
  const parts: string[] = [];
  if (match.domains) parts.push(`domain="${req.domain}" ∈ [${match.domains.join(',')}]`);
  if (match.intents) parts.push(`intent="${req.intent}" ∈ [${match.intents.join(',')}]`);
  if (match.amount) {
    const a = req.amount;
    parts.push(
      `amount=${a ? `${a.value} ${a.currency}` : '∅'} ∈ [${match.amount.min},${match.amount.max ?? '∞'} ${match.amount.currency}]`
    );
  }
  if (match.riskTags) parts.push(`riskTags=[${req.riskTags?.join(',') ?? '∅'}] ∩ [${match.riskTags.join(',')}]`);
  if (match.impact) parts.push(`impact=${req.impact ?? '∅'} ∈ [${match.impact.join(',')}]`);
  if (match.reversibility) parts.push(`reversibility=${req.reversibility ?? '∅'} ∈ [${match.reversibility.join(',')}]`);
  if (parts.length === 0) return 'catch-all (empty match)';
  return parts.join(' AND ');
}

/**
 * 纯函数：按策略给请求分级。policy 假定已经过 parsePolicy 校验。
 */
export function gradeDecision(policy: DecisionPolicy, req: DecisionRequest): GradeDecision {
  for (const rule of policy.rules as PolicyRule[]) {
    if (matches(rule.match, req)) {
      return {
        grade: rule.grade,
        ruleId: rule.id,
        reason: `matched rule "${rule.id}": ${describeMatch(rule.match, req)} → ${rule.grade}`,
        ...(rule.slaHours !== undefined ? { slaHours: rule.slaHours } : {}),
        ...(rule.escalation !== undefined ? { escalation: rule.escalation } : {}),
      };
    }
  }
  return {
    grade: policy.defaultGrade,
    ruleId: 'default',
    reason: `no rule matched (policy v${policy.version}); fail-closed defaultGrade ${policy.defaultGrade}`,
  };
}
