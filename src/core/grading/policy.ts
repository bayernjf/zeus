/**
 * 决策分级策略契约（T-M1-03，Tier0-设计文档 §4.1）。
 *
 * 纯类型：策略描述"什么匹配条件 → 落哪一级"，不包含匹配实现（见 grade.ts），
 * 也不包含存储（文件/DB 版本化存储在外壳装配，core 只提供 MemoryPolicyStore）。
 */
import type { Grade, Impact, Reversibility } from '../types.js';

/**
 * 金额条件：闭区间 [min, max]，currency 必须与请求金额一致（不同币种不匹配）。
 * max 省略表示上不封顶（用于 ">5000 → D3" 这类高档规则）；min 必填。
 */
export interface AmountRange {
  min: number;
  max?: number;
  currency: string;
}

/**
 * 规则匹配条件。给出的字段全部满足才命中（字段间 AND）；
 * 数组类字段（domains / intents / riskTags）命中任一即可（数组内 OR）。
 * 一个字段都不给的规则匹配一切（catch-all，应排在最后）。
 */
export interface RuleMatch {
  domains?: string[];
  intents?: string[];
  amount?: AmountRange;
  riskTags?: string[];
  /** 命中任一即匹配（数组内 OR）。 */
  impact?: Impact[];
  reversibility?: Reversibility[];
}

export interface PolicyRule {
  /** 规则稳定标识，审计记录引用；同一策略内唯一。 */
  id: string;
  match: RuleMatch;
  grade: Grade;
  /** 该级别异步审批的超时小时数（D1/D2 用）；缺省由服务层默认值填充。 */
  slaHours?: number;
  /** 超时/升级去向（设计 §4.2，D1 超时 remind/escalate 用）。 */
  escalation?: string;
}

export interface DecisionPolicy {
  /** 单调递增版本号；每次更新 +1，历史版本保留可回滚（设计 §5.1）。 */
  version: number;
  /** 无规则命中时的默认级；拍板结论：D2 fail-closed（PRD §11）。 */
  defaultGrade: Grade;
  /** 自上而下匹配，第一条命中即决定分级（顺序敏感）。 */
  rules: PolicyRule[];
}

/** 金额（与 AmountRange 同币种比较）。 */
export interface Amount {
  value: number;
  currency: string;
}

/**
 * 决策请求。分级所需的全部输入（设计 §4.1）；
 * requestId / decisionId / 调用方等由服务层补充，不进纯函数。
 */
export interface DecisionRequest {
  /** 意图，如 refund / publish / purchase。 */
  intent: string;
  /** 业务域，如 commerce / hr / finance。 */
  domain: string;
  amount?: Amount;
  riskTags?: string[];
  impact?: Impact;
  reversibility?: Reversibility;
  /** Agent 形成的候选提案（D2/D3 供人审，透传，不参与匹配）。 */
  proposal?: unknown;
  /** 幂等键，同键重复提交返回同一决策（服务层去重）。 */
  idempotencyKey?: string;
}

/** gradeDecision 纯函数结果。 */
export interface GradeDecision {
  grade: Grade;
  /** 命中的规则 id；无规则命中为 'default'。 */
  ruleId: string | 'default';
  /** 人类可读的判定依据（进审计，不做控制流）。 */
  reason: string;
  /** 命中规则携带的 SLA，缺省由服务层补。 */
  slaHours?: number;
  escalation?: string;
}
