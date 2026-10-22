/**
 * 决策策略加载与校验（T-M1-03，Tier0-设计文档 §4.1 / §5.1）。
 *
 * fail-closed：策略是分级的唯一事实源，非法结构（未知 grade、非法金额区间、
 * 缺版本号、重复规则 id、拼写错误的多余字段……）一律拒绝并一次报全，
 * 绝不"忽略多余字段继续跑"——一个拼写错误的字段静默不生效，比启动失败更危险。
 */
import type { DecisionPolicy, AmountRange } from './policy.js';
import type { Grade, Impact, Reversibility } from '../types.js';
import { PolicyNotFoundError, ValidationError } from './errors.js';

const GRADES: readonly Grade[] = ['D0', 'D1', 'D2', 'D3'];
const IMPACTS: readonly Impact[] = ['self', 'team', 'org', 'external'];
const REVERSIBILITIES: readonly Reversibility[] = ['reversible', 'hard', 'irreversible'];
const CURRENCY_RE = /^[A-Z]{3}$/;

const POLICY_KEYS = new Set(['version', 'defaultGrade', 'rules']);
const RULE_KEYS = new Set(['id', 'match', 'grade', 'slaHours', 'escalation']);
const MATCH_KEYS = new Set(['domains', 'intents', 'amount', 'riskTags', 'impact', 'reversibility']);
const AMOUNT_KEYS = new Set(['min', 'max', 'currency']);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const isPosInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;

function unknownKeys(obj: Record<string, unknown>, allowed: Set<string>, at: string, out: string[]): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) out.push(`${at}: unknown field "${key}"`);
  }
}

function validateStringList(v: unknown, at: string, out: string[]): void {
  if (!Array.isArray(v)) {
    out.push(`${at}: expected an array of strings`);
    return;
  }
  v.forEach((item, i) => {
    if (!isNonEmptyString(item)) out.push(`${at}[${i}]: expected a non-empty string`);
  });
}

function validateAmount(v: unknown, at: string, out: string[]): AmountRange | null {
  if (!isRecord(v)) {
    out.push(`${at}: expected an object {min,max?,currency}`);
    return null;
  }
  unknownKeys(v, AMOUNT_KEYS, at, out);
  const { min, max, currency } = v;
  if (!isFiniteNumber(min) || min < 0) out.push(`${at}.min: expected a finite number >= 0`);
  if (max !== undefined && (!isFiniteNumber(max) || max < 0)) {
    out.push(`${at}.max: expected a finite number >= 0, or omit for an open upper bound`);
  }
  if (isFiniteNumber(min) && isFiniteNumber(max) && min > (max as number)) {
    out.push(`${at}: min ${min} must be <= max ${max}`);
  }
  if (!isNonEmptyString(currency) || !CURRENCY_RE.test(currency)) {
    out.push(`${at}.currency: expected an ISO 4217 code like "CNY" (3 uppercase letters)`);
  }
  return null;
}

function validateRule(raw: unknown, index: number, seenIds: Set<string>, out: string[]): void {
  const at = `rules[${index}]`;
  if (!isRecord(raw)) {
    out.push(`${at}: expected an object`);
    return;
  }
  unknownKeys(raw, RULE_KEYS, at, out);

  if (!isNonEmptyString(raw.id)) {
    out.push(`${at}.id: expected a non-empty string`);
  } else if (seenIds.has(raw.id)) {
    out.push(`${at}.id: duplicate rule id "${raw.id}"`);
  } else {
    seenIds.add(raw.id);
  }

  if (!GRADES.includes(raw.grade as Grade)) {
    out.push(`${at}.grade: expected one of D0/D1/D2/D3, got ${String(raw.grade)}`);
  }

  if (raw.slaHours !== undefined && (!isFiniteNumber(raw.slaHours) || raw.slaHours <= 0)) {
    out.push(`${at}.slaHours: expected a finite number of hours > 0`);
  }
  if (raw.escalation !== undefined && !isNonEmptyString(raw.escalation)) {
    out.push(`${at}.escalation: expected a non-empty string`);
  }

  if (!isRecord(raw.match)) {
    out.push(`${at}.match: expected an object`);
    return;
  }
  const match = raw.match as Record<string, unknown>;
  unknownKeys(match, MATCH_KEYS, `${at}.match`, out);
  if (match.domains !== undefined) validateStringList(match.domains, `${at}.match.domains`, out);
  if (match.intents !== undefined) validateStringList(match.intents, `${at}.match.intents`, out);
  if (match.riskTags !== undefined) validateStringList(match.riskTags, `${at}.match.riskTags`, out);
  if (match.impact !== undefined) {
    if (!Array.isArray(match.impact) || !match.impact.every(v => IMPACTS.includes(v as Impact))) {
      out.push(`${at}.match.impact: expected an array of self/team/org/external, got ${JSON.stringify(match.impact)}`);
    }
  }
  if (match.reversibility !== undefined) {
    if (!Array.isArray(match.reversibility) || !match.reversibility.every(v => REVERSIBILITIES.includes(v as Reversibility))) {
      out.push(`${at}.match.reversibility: expected an array of reversible/hard/irreversible, got ${JSON.stringify(match.reversibility)}`);
    }
  }
  if (match.amount !== undefined) validateAmount(match.amount, `${at}.match.amount`, out);
}

/** 返回全部结构问题；空数组 = 合法。 */
export function validatePolicy(raw: unknown): string[] {
  const out: string[] = [];
  if (!isRecord(raw)) {
    return ['policy: expected an object {version, defaultGrade, rules}'];
  }
  unknownKeys(raw, POLICY_KEYS, 'policy', out);

  if (!isPosInt(raw.version)) out.push('policy.version: expected a positive integer');
  if (!GRADES.includes(raw.defaultGrade as Grade)) {
    out.push('policy.defaultGrade: expected one of D0/D1/D2/D3');
  }
  if (!Array.isArray(raw.rules)) {
    out.push('policy.rules: expected an array');
    return out;
  }
  const seenIds = new Set<string>();
  raw.rules.forEach((rule, i) => validateRule(rule, i, seenIds, out));
  return out;
}

/** 严格解析：非法结构抛 ValidationError（issues 为全部问题）。 */
export function parsePolicy(raw: unknown): DecisionPolicy {
  const issues = validatePolicy(raw);
  if (issues.length > 0) throw new ValidationError('decision policy validation failed', issues);
  return raw as DecisionPolicy;
}

/** 从 JSON 文本加载；JSON 语法错误也归为 VALIDATION_FAILED。 */
export function loadPolicyFromJson(text: string): DecisionPolicy {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ValidationError('decision policy is not valid JSON', [
      error instanceof Error ? error.message : String(error),
    ]);
  }
  return parsePolicy(raw);
}

/**
 * 版本化策略仓（设计 §5.1：按版本保存、可回滚）。
 * 外壳装配提供文件/DB 实现；core 给出内存实现供测试与本地演示。
 */
export interface PolicyStore {
  /** 放入策略（先校验）；同版本号重复放入即冲突，调用方必须递增版本。 */
  put(policy: DecisionPolicy): DecisionPolicy;
  /** 取指定版本；version 省略时取最新版本。不存在 → POLICY_NOT_FOUND。 */
  get(version?: number): DecisionPolicy;
  has(version: number): boolean;
  versions(): number[];
}

export class MemoryPolicyStore implements PolicyStore {
  private readonly byVersion = new Map<number, DecisionPolicy>();

  put(policy: DecisionPolicy): DecisionPolicy {
    // 即使调用方拿的是已标注类型，也过一遍结构校验：
    // 来自 JSON/外部的对象可能在类型系统之外被拼坏。
    const parsed = parsePolicy(policy);
    if (this.byVersion.has(parsed.version)) {
      throw new ValidationError(`policy version ${parsed.version} already exists; bump the version`, [
        'put() is append-only; versions are immutable and retained for rollback',
      ]);
    }
    this.byVersion.set(parsed.version, parsed);
    return parsed;
  }

  get(version?: number): DecisionPolicy {
    if (version === undefined) {
      const latest = this.latestVersion();
      if (latest === undefined) throw new PolicyNotFoundError();
      return this.byVersion.get(latest)!;
    }
    const found = this.byVersion.get(version);
    if (!found) throw new PolicyNotFoundError(version);
    return found;
  }

  has(version: number): boolean {
    return this.byVersion.has(version);
  }

  versions(): number[] {
    return [...this.byVersion.keys()].sort((a, b) => a - b);
  }

  private latestVersion(): number | undefined {
    const all = this.versions();
    return all.length === 0 ? undefined : all[all.length - 1];
  }
}
