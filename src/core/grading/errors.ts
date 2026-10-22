/**
 * 决策侧错误码（Tier0-设计文档 §8.1），传输无关：
 * 错误只携带 code + message + details，HTTP 层负责映射状态码与响应体。
 * 通道侧错误码（CHANNEL_UNAVAILABLE / CREDENTIAL_MISSING）由 M3 commerce-os 消费。
 */

export const DECISION_ERROR_CODES = {
  POLICY_NOT_FOUND: 'POLICY_NOT_FOUND',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  GRADE_REQUIRES_APPROVAL: 'GRADE_REQUIRES_APPROVAL',
  APPROVAL_TIMEOUT: 'APPROVAL_TIMEOUT',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
} as const;

export type DecisionErrorCode =
  (typeof DECISION_ERROR_CODES)[keyof typeof DECISION_ERROR_CODES];

export class DecisionError extends Error {
  readonly code: string;
  readonly details?: unknown;
  /** 机器可判的重试语义（设计 §8.1）；默认 false，由构造点覆盖。 */
  readonly retryable: boolean;

  constructor(code: string, message: string, options?: { details?: unknown; retryable?: boolean }) {
    super(message);
    this.name = 'DecisionError';
    this.code = code;
    if (options?.details !== undefined) this.details = options.details;
    this.retryable = options?.retryable ?? false;
  }
}

/** 结构化校验失败（非法策略 / 非法请求）；details 为全部问题清单，一次报全。 */
export class ValidationError extends DecisionError {
  constructor(message: string, issues: string[]) {
    super(DECISION_ERROR_CODES.VALIDATION_FAILED, message, { details: issues });
  }
  get issues(): string[] {
    return Array.isArray(this.details) ? (this.details as string[]) : [];
  }
}

/** 无可用策略（存储为空或指定版本不存在）。 */
export class PolicyNotFoundError extends DecisionError {
  constructor(version?: number) {
    super(
      DECISION_ERROR_CODES.POLICY_NOT_FOUND,
      version === undefined
        ? 'no decision policy available'
        : `decision policy version ${version} not found`
    );
  }
}
