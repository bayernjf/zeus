import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildNotification, notify, selectChannel } from '../src/watch/notify.js';

/**
 * The notification layer is the shell the user's daemon pops when a watch fires.
 * It has no kernel timer and no side effects on import, so the tests drive it
 * through injected execFile/which fakes — never a real osascript.
 */

describe('buildNotification', () => {
  const base = { evaluated: 3, fired: [], unavailable: [], autoDisabled: [] };

  it('returns null when nothing fired (a healthy empty tick must not nag)', () => {
    expect(buildNotification({ ...base, fired: [] })).toBeNull();
    expect(buildNotification({ ...base, fired: [], unavailable: ['w1'] })).toBeNull();
  });

  it('builds title/body from the fired ids', () => {
    const out = buildNotification({ ...base, fired: ['watch-demo', 'watch-price'] });
    expect(out).toEqual({
      title: 'Zeus watch fired (2)',
      body: 'watch-demo, watch-price',
    });
  });
});

describe('selectChannel', () => {
  it('picks osascript when it exists (macOS default)', async () => {
    const channel = await selectChannel({
      which: name => (name === 'osascript' ? '/usr/bin/osascript' : null),
    });
    expect(channel).toBe('osascript');
  });

  it('falls back to terminal-notifier when osascript is absent', async () => {
    const channel = await selectChannel({
      which: name => (name === 'terminal-notifier' ? '/opt/homebrew/bin/terminal-notifier' : null),
    });
    expect(channel).toBe('terminal-notifier');
  });

  it('returns null when neither is installed', async () => {
    const channel = await selectChannel({ which: () => null });
    expect(channel).toBeNull();
  });
});

describe('notify', () => {
  const fired = { evaluated: 1, fired: ['watch-demo'], unavailable: [], autoDisabled: [] };

  it('does nothing (log channel) when nothing fired', async () => {
    const calls: string[][] = [];
    const result = await notify({ evaluated: 0, fired: [], unavailable: [], autoDisabled: [] }, {
      execFile: async (_cmd, args) => { calls.push(args); },
      which: () => '/usr/bin/osascript',
    });
    expect(result).toEqual({ delivered: false, channel: 'log', title: '', body: '' });
    expect(calls).toHaveLength(0);
  });

  it('runs osascript with a display-notification command carrying the fired ids', async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const result = await notify(fired, {
      execFile: async (cmd, args) => { calls.push({ cmd, args }); },
      which: name => (name === 'osascript' ? '/usr/bin/osascript' : null),
    });
    expect(result.delivered).toBe(true);
    expect(result.channel).toBe('osascript');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe('osascript');
    expect(calls[0]!.args[0]).toBe('-e');
    expect(calls[0]!.args[1]).toContain('display notification "watch-demo"');
    expect(calls[0]!.args[1]).toContain('with title "Zeus watch fired (1)"');
  });

  it('uses terminal-notifier args when that is the chosen channel', async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const result = await notify(fired, {
      execFile: async (cmd, args) => { calls.push({ cmd, args }); },
      which: name => (name === 'terminal-notifier' ? '/bin/terminal-notifier' : null),
    });
    expect(result.delivered).toBe(true);
    expect(result.channel).toBe('terminal-notifier');
    expect(calls[0]!.args).toContain('watch-demo');
  });

  it('degrades to log when no channel exists, and never throws', async () => {
    const logs: string[] = [];
    const result = await notify(fired, {
      execFile: async () => { throw new Error('should not be called'); },
      which: () => null,
      log: line => logs.push(line),
    });
    expect(result.delivered).toBe(false);
    expect(result.channel).toBe('log');
    expect(logs[0]).toContain('watch-demo');
  });
});

describe('run-watch-tick daemon (controlled e2e)', () => {
  let stubPort = 0;
  let closeStub: () => void = () => {};
  const tickHits: number[] = [];

  beforeAll(async () => {
    const server = createServer((req, res) => {
      if (req.url === '/api/watch-tick' && req.method === 'POST') {
        tickHits.push(Date.now());
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            report: { evaluated: 1, fired: ['watch-demo'], unavailable: [], autoDisabled: [] },
          }),
        );
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('stub did not bind');
    stubPort = address.port;
    closeStub = () => server.close();
  });

  afterAll(() => closeStub());

  it('ticks periodically against a loopback stub and exits cleanly on SIGTERM', async () => {
    const script = fileURLToPath(new URL('../scripts/run-watch-tick.mjs', import.meta.url));
    const child = spawn(
      process.execPath,
      [script, '--watch', '--interval', '1', '--timeout', '2000', '--notify'],
      {
        env: {
          ...process.env,
          KERNEL_URL: `http://127.0.0.1:${stubPort}`,
          ZEUS_INTERNAL_TOKEN: 'test-token',
          ZEUS_NOTIFY: '0', // never pop a real notification in the test
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let out = '';
    child.stdout.on('data', chunk => (out += chunk.toString()));
    child.stderr.on('data', chunk => (out += chunk.toString()));

    // Wait long enough for at least two interval ticks (interval=1s).
    await new Promise(resolve => setTimeout(resolve, 2500));
    expect(tickHits.length).toBeGreaterThanOrEqual(2);
    expect(out).toContain('fired=1 [watch-demo]');

    child.kill('SIGTERM');
    const code = await new Promise<number>(resolve => child.on('exit', resolve));
    expect(code).toBe(0);
    expect(out).toContain('scheduler stopped');
  }, 15_000);
});
