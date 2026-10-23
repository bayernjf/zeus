/**
 * 默认决策策略 v1（PRD §6.2 分级矩阵 + §11 拍板结论 2026-10-22）。
 *
 * 金额阈值（CNY，按 0.01 元最小单位做半开边界）：
 *   ≤500 → D1；500.01–5000 → D2；>5000 → D3
 * 维度（任一命中即升级，规则高档在前）：
 *   team → D1；org / 难逆(hard) → D2；external / 不可逆(irreversible) / 法律合规标签 → D3
 * 无金额、无 impact、无风险标签等任何规则都不命中 → defaultGrade D2（fail-closed）。
 * 非 CNY 金额不命中金额规则，走其余维度或默认 D2；多币种启用时由新版策略扩展。
 */
import type { DecisionPolicy } from './policy.js';
import { parsePolicy } from './policy-loader.js';

const DEFAULT_POLICY_V1_RAW: DecisionPolicy = {
  version: 1,
  defaultGrade: 'D2',
  rules: [
    { id: 'd3-amount-large', match: { amount: { min: 5000.01, currency: 'CNY' } }, grade: 'D3' },
    { id: 'd3-external', match: { impact: ['external'] }, grade: 'D3' },
    { id: 'd3-irreversible', match: { reversibility: ['irreversible'] }, grade: 'D3' },
    { id: 'd3-risk', match: { riskTags: ['legal', 'compliance'] }, grade: 'D3' },
    { id: 'd2-amount', match: { amount: { min: 500.01, max: 5000, currency: 'CNY' } }, grade: 'D2' },
    { id: 'd2-org', match: { impact: ['org'] }, grade: 'D2' },
    { id: 'd2-hard', match: { reversibility: ['hard'] }, grade: 'D2' },
    { id: 'd1-amount', match: { amount: { min: 0, max: 500, currency: 'CNY' } }, grade: 'D1' },
    { id: 'd1-team', match: { impact: ['team'] }, grade: 'D1' },
    { id: 'd0-self-reversible', match: { impact: ['self'], reversibility: ['reversible'] }, grade: 'D0' },
  ],
};

/** 模块加载即校验：种子策略非法会直接暴露为构建/测试期错误，而不是运行时。 */
export const DEFAULT_POLICY_V1: DecisionPolicy = parsePolicy(DEFAULT_POLICY_V1_RAW);
