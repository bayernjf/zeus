/**
 * Structured logging (feature-inventory: 结构化日志 ⬜, PRD E10.2 library-side
 * half). One JSON line per event; the process already emits machine-readable
 * audit JSONL on its own spine (dispatch/audit.ts), so this logger is for the
 * operator-facing process log (startup, refusal, transport failures) — never a
 * substitute for the audit trail.
 *
 * Contract:
 * - One JSON object per line: { ts, level, event, msg?, ...fields }.
 * - ts is ISO-8601 UTC; level is error|warn|info|debug; event is a stable
 *   kebab-case identifier for machine filtering.
 * - Level filter: entries below the configured level are dropped before
 *   serialization (default info).
 * - Redaction: a field whose key matches token/secret/key/authorization/
 *   credential/password, or a string value shaped like a bearer credential, is
 *   replaced with "[REDACTED]" before writing. The audit trail is the one place
 *   that may carry governed detail; the operator log never echoes credentials.
 * - Fail-closed for the sink itself: serialization errors never throw (the
 *   caller is usually on a boot/refusal path where throwing would mask the
 *   original error).
 */

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const LEVEL_ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export type LogFields = Record<string, unknown>;

export type LogSink = (line: string) => void;

export type Logger = {
  error: (event: string, msg?: string, fields?: LogFields) => void;
  warn: (event: string, msg?: string, fields?: LogFields) => void;
  info: (event: string, msg?: string, fields?: LogFields) => void;
  debug: (event: string, msg?: string, fields?: LogFields) => void;
};

export type LoggerOptions = {
  level?: LogLevel;
  sink?: LogSink;
};

/** Key-driven redaction: any field whose name smells like a credential. */
const SECRET_KEY = /(token|secret|authorization|credential|password|api[_-]?key|rsk[_-]?key)/i;

/** Value-driven redaction: a string that is itself a bearer credential, or a
 *  detail/URL string carrying an inline bearer (replaced in place so the rest
 *  of the line stays readable). */
const BEARER_VALUE = /^Bearer\s+\S+/i;
const BEARER_INLINE = /Bearer\s+\S+/gi;

export function redact(value: unknown, keyHint?: string): unknown {
  if (keyHint !== undefined && SECRET_KEY.test(keyHint)) return '[REDACTED]';
  if (typeof value === 'string') {
    if (BEARER_VALUE.test(value)) return '[REDACTED]';
    return BEARER_INLINE.test(value) ? value.replace(BEARER_INLINE, 'Bearer [REDACTED]') : value;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redact(v, k);
    }
    return out;
  }
  return value;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const threshold = LEVEL_ORDER[options.level ?? 'info'];
  const sink: LogSink = options.sink ?? ((line) => process.stderr.write(`${line}\n`));

  const emit = (level: LogLevel, event: string, msg: string | undefined, fields: LogFields | undefined): void => {
    if (LEVEL_ORDER[level] > threshold) return;
    let line: string;
    try {
      line = JSON.stringify({
        ts: new Date().toISOString(),
        level,
        event,
        ...(msg !== undefined ? { msg } : {}),
        ...(fields !== undefined ? (redact(fields) as LogFields) : {}),
      });
    } catch {
      // The caller is often on a boot/refusal path; a logger that throws would
      // mask the very error it is reporting.
      line = JSON.stringify({ ts: new Date().toISOString(), level, event: 'logger-serialization-failed' });
    }
    sink(line);
  };

  return {
    error: (event, msg, fields) => emit('error', event, msg, fields),
    warn: (event, msg, fields) => emit('warn', event, msg, fields),
    info: (event, msg, fields) => emit('info', event, msg, fields),
    debug: (event, msg, fields) => emit('debug', event, msg, fields),
  };
}
