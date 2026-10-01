import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/tui/cli.js';

const ENV_KEYS = ['ZEUS_INTERNAL_TOKEN', 'ZEUS_TUI_INTERVAL_MS', 'ZEUS_BASE_URL', 'LC_ALL', 'LANG', 'NO_COLOR'];

describe('TUI CLI argument contract', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('refuses a --token flag and points at the environment variable', () => {
    expect(() => parseArgs(['--token', 'secret'])).toThrow(/--token is not accepted/);
  });

  it('takes the bearer token from ZEUS_INTERNAL_TOKEN only', () => {
    process.env.ZEUS_INTERNAL_TOKEN = 'from-env';
    expect(parseArgs([]).token).toBe('from-env');
    delete process.env.ZEUS_INTERNAL_TOKEN;
    expect(parseArgs([]).token).toBeUndefined();
  });

  it('rejects a negative or non-numeric --interval', () => {
    expect(() => parseArgs(['--interval', '-1'])).toThrow(/--interval/);
    expect(() => parseArgs(['--interval', 'soon'])).toThrow(/--interval/);
  });

  it('reads flags and strips a trailing slash from the base URL', () => {
    const args = parseArgs([
      '--base-url',
      'http://127.0.0.1:9/',
      '--interval',
      '500',
      '--no-color',
      '--locale',
      'en',
    ]);
    expect(args.baseUrl).toBe('http://127.0.0.1:9');
    expect(args.intervalMs).toBe(500);
    expect(args.color).toBe(false);
    expect(args.locale).toBe('en');
  });
});
