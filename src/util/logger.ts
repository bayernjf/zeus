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
 *   credential/password/cookie, or a string value shaped like a credential
 *   (bearer, PEM private key, `token=`/`apiKey:` assignment, URL userinfo,
 *   credential query parameter), is replaced with "[REDACTED]" before writing —
 *   msg included. The audit trail is the one place that may carry governed
 *   detail; it applies the same value redaction at its sinks, and the operator
 *   log never echoes credentials.
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
const SECRET_KEY =
  /(token|secret|authorization|credential|password|passwd|api[_-]?key|rsk[_-]?key|private[_-]?key|cookie)/i;

/** Value-driven redaction: a string that is itself a bearer credential, or a
 *  detail/URL string carrying an inline bearer (replaced in place so the rest
 *  of the line stays readable). */
const BEARER_VALUE = /^Bearer\s+\S+/i;
const BEARER_INLINE = /Bearer\s+\S+/gi;

/** PEM private key block, or a truncated block header on its own. */
const PEM_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const PEM_HEADER = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g;

/** Inline `token: xxx` / `apiKey=xxx` assignments in free text. The leading
 *  boundary keeps `monToken` safe; the value class stops at '&' so a query
 *  string the URL pass already sanitised is not swallowed past its parameter. */
const CREDENTIAL_ASSIGNMENT =
  /(?<![A-Za-z0-9])(access[_-]?token|client[_-]?secret|api[_-]?key|credential|password|passwd|token|secret)(?![A-Za-z0-9])\s*([:=])\s*([^\s&]+)/gi;

/** Query parameters whose values are credentials even when the URL itself is
 *  not on a secret-bearing key. */
const CREDENTIAL_QUERY_PARAMS = [
  'access_token',
  'token',
  'secret',
  'api_key',
  'apikey',
  'key',
  'password',
  'passwd',
  'signature',
  'sig',
  'credential',
  'auth',
];

const URL_INLINE = /https?:\/\/[^\s"'`<>]+/g;

/** All value-form rules except the URL pass, so redactUrl's unparseable-input
 *  fallback cannot recurse back into URL parsing. */
function redactNonUrl(value: string): string {
  return value
    .replace(PEM_BLOCK, '[REDACTED]')
    .replace(PEM_HEADER, '[REDACTED]')
    .replace(BEARER_INLINE, 'Bearer [REDACTED]')
    .replace(
      CREDENTIAL_ASSIGNMENT,
      (m, key: string, sep: string, secret: string) =>
        // Idempotent over a value the URL pass already marked.
        secret === 'REDACTED' || secret === '[REDACTED]' ? m : `${key}${sep}[REDACTED]`,
    );
}

/**
 * Sanitise one URL-shaped string for logging: strip userinfo credentials and
 * the values of credential-bearing query parameters while preserving scheme,
 * host, path and the other parameters. Input that is not an absolute URL falls
 * back to generic text redaction.
 */
export function redactUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (url.username !== '' || url.password !== '') {
      url.username = '';
      url.password = '';
    }
    for (const name of CREDENTIAL_QUERY_PARAMS) {
      if (url.searchParams.has(name)) url.searchParams.set(name, 'REDACTED');
    }
    return url.toString();
  } catch {
    return redactNonUrl(rawUrl);
  }
}

/**
 * Redact every credential value form from free text: PEM blocks, inline
 * bearers, URLs carrying userinfo or credential query parameters, and
 * `token=`/`secret:` assignments. Ordinary text is returned byte-for-byte.
 */
export function redactText(value: string): string {
  return redactNonUrl(value.replace(URL_INLINE, (match) => redactUrl(match)));
}

export function redact(value: unknown, keyHint?: string): unknown {
  // Arrays recurse before the key-hint short-circuit so a secret-named list
  // (e.g. `tokens: [...]`) keeps its shape while every element is scrubbed.
  if (Array.isArray(value)) return value.map((v) => redact(v, keyHint));
  if (keyHint !== undefined && SECRET_KEY.test(keyHint)) return '[REDACTED]';
  if (typeof value === 'string') {
    if (BEARER_VALUE.test(value)) return '[REDACTED]';
    return redactText(value);
  }
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
        ...(msg !== undefined ? { msg: redactText(msg) } : {}),
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
