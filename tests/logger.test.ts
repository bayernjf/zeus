import { describe, expect, it } from 'vitest';
import { createLogger, redact, redactText, redactUrl } from '../src/util/logger.js';

function capture(level?: 'error' | 'warn' | 'info' | 'debug') {
  const lines: string[] = [];
  const logger = createLogger({ ...(level !== undefined ? { level } : {}), sink: (line) => lines.push(line) });
  return { logger, lines };
}

function parseAll(lines: string[]): Array<Record<string, unknown>> {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('structured logger', () => {
  it('emits one JSON line per event with ts/level/event', () => {
    const { logger, lines } = capture();
    logger.info('listening', 'http server listening', { host: '0.0.0.0', port: 8787 });
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry.level).toBe('info');
    expect(entry.event).toBe('listening');
    expect(entry.msg).toBe('http server listening');
    expect(entry.host).toBe('0.0.0.0');
    expect(entry.port).toBe(8787);
    expect(typeof entry.ts).toBe('string');
    expect(new Date(entry.ts as string).toString()).not.toBe('Invalid Date');
  });

  it('omits msg when absent and merges fields flat', () => {
    const { logger, lines } = capture();
    logger.error('boot-refused', undefined, { errorClass: 'RskConfigError' });
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry.msg).toBeUndefined();
    expect(entry.errorClass).toBe('RskConfigError');
  });

  it('drops entries below the configured level', () => {
    const { logger, lines } = capture('warn');
    logger.debug('some-debug', 'should not appear');
    logger.info('some-info', 'should not appear');
    logger.warn('some-warn', 'appears');
    logger.error('some-error', 'appears');
    const events = parseAll(lines).map((e) => e.event);
    expect(events).toEqual(['some-warn', 'some-error']);
  });

  it('defaults to info level', () => {
    const { logger, lines } = capture();
    logger.debug('debug-event', 'dropped by default');
    logger.info('info-event', 'kept');
    expect(parseAll(lines).map((e) => e.event)).toEqual(['info-event']);
  });

  it('redacts credential-shaped fields by key', () => {
    const { logger, lines } = capture();
    logger.info('boot', undefined, {
      internalToken: 'abc-123-secret',
      rskKeyFile: '/data/rsk.key',
      host: '0.0.0.0',
    });
    const entry = parseAll(lines)[0]!;
    expect(entry.internalToken).toBe('[REDACTED]');
    expect(entry.rskKeyFile).toBe('[REDACTED]');
    expect(entry.host).toBe('0.0.0.0');
  });

  it('redacts bearer-shaped values inside nested structures', () => {
    const { logger, lines } = capture();
    logger.warn('seed-failed', 'card fetch failed', {
      detail: 'GET https://vassal.example/api/a2a/agent-card with Authorization: Bearer xyz123',
      nested: { headers: { authorization: 'Bearer abc' } },
    });
    const entry = parseAll(lines)[0]!;
    expect(entry.detail).toContain('Bearer [REDACTED]');
    expect(entry.detail).not.toContain('xyz123');
    expect((entry.nested as Record<string, unknown>).headers).toEqual({ authorization: '[REDACTED]' });
  });

  it('does not redact ordinary long strings (run ids, urls)', () => {
    const { logger, lines } = capture();
    const runId = 'a'.repeat(48);
    logger.info('dispatched', undefined, { runId, url: 'https://vassal.example/a1/api' });
    const entry = parseAll(lines)[0]!;
    expect(entry.runId).toBe(runId);
    expect(entry.url).toBe('https://vassal.example/a1/api');
  });

  it('never throws on unserializable fields and falls back to a minimal line', () => {
    const { logger, lines } = capture();
    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular;
    logger.error('boot-refused', 'boom', { circular });
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry.event).toBe('logger-serialization-failed');
    expect(entry.level).toBe('error');
  });

  it('redact helper works standalone on arrays and scalars', () => {
    expect(redact('Bearer secret-token')).toBe('[REDACTED]');
    expect(redact('plain text')).toBe('plain text');
    expect(redact({ token: 't', arr: [{ apiKey: 'k' }, 'Bearer v'] }, undefined)).toEqual({
      token: '[REDACTED]',
      arr: [{ apiKey: '[REDACTED]' }, '[REDACTED]'],
    });
  });

  it('accepts empty fields and empty msg', () => {
    const { logger, lines } = capture();
    logger.info('heartbeat');
    const entry = parseAll(lines)[0]!;
    expect(entry.event).toBe('heartbeat');
    expect(entry.msg).toBeUndefined();
  });

  it('redacts credentials embedded in msg (the message used to pass through untouched)', () => {
    const { logger, lines } = capture();
    logger.error(
      'dispatch-failed',
      'POST http://ops:hunter2@10.0.0.9/card?token=abc123&q=1 failed: Bearer xyz789',
    );
    const msg = parseAll(lines)[0]!.msg as string;
    expect(msg).not.toContain('hunter2');
    expect(msg).not.toContain('abc123');
    expect(msg).not.toContain('xyz789');
    expect(msg).toContain('10.0.0.9');
    expect(msg).toContain('Bearer [REDACTED]');
    expect(msg).toMatch(/token=REDACTED/);
    expect(msg).toContain('q=1');
  });
});

describe('redactText / redactUrl value-form redaction', () => {
  it('strips URL userinfo and credential query parameters but keeps the URL body', () => {
    expect(redactUrl('http://ops:hunter2@host.example:8080/card?token=abc&page=2'))
      .toBe('http://host.example:8080/card?token=REDACTED&page=2');
    expect(redactUrl('https://vassal.example/a1/api')).toBe('https://vassal.example/a1/api');
    expect(redactText('fetch http://ops:pw@host/x?access_token=t1&q=1 done'))
      .toBe('fetch http://host/x?access_token=REDACTED&q=1 done');
  });

  it('redacts PEM private key blocks and credential assignments inside text', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nAAAAbbbb\nCCCCdddd\n-----END PRIVATE KEY-----';
    const out = redactText(`load failed\n${pem}\napiKey: k-live-123`);
    expect(out).not.toContain('AAAAbbbb');
    expect(out).not.toContain('CCCCdddd');
    expect(out).not.toContain('k-live-123');
    expect(out).toContain('[REDACTED]');
    expect(out).toContain('load failed');
  });

  it('redacts userinfo URLs and assignments nested inside field values', () => {
    expect(redact('connect to http://ops:secret@host/x or set token=plain-text-value'))
      .toBe('connect to http://host/x or set token=[REDACTED]');
  });

  it('leaves ordinary prose, run ids and credential-free URLs untouched', () => {
    const text = 'fetched https://vassal.example/a1/api over plain http with no credentials';
    expect(redactText(text)).toBe(text);
    expect(redactText('pilot note: research skill completed in 42ms')).toBe(
      'pilot note: research skill completed in 42ms',
    );
  });

  it('propagates the key hint while recursing arrays', () => {
    expect(redact(['Bearer abc', 'plain'], 'authorization')).toEqual(['[REDACTED]', '[REDACTED]']);
    expect(redact([{ token: 't' }, 'Bearer v'])).toEqual([{ token: '[REDACTED]' }, '[REDACTED]']);
  });
});
