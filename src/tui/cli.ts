#!/usr/bin/env node
/**
 * Zeus terminal supervision deck (UI design option D).
 *
 * Read-only monitoring + escalation settlement + roster revocation over the
 * existing bearer HTTP face. No kernel route is added and the bearer token is
 * read from the environment only — never from a flag, which would be visible in
 * `ps` output and the shell history. This mirrors the vault CLI's rule for key
 * material.
 *
 *   ZEUS_INTERNAL_TOKEN=... npm run tui
 *   ZEUS_INTERNAL_TOKEN=... node dist/tui/cli.js --base-url http://127.0.0.1:8787 --locale en
 */
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { createDeckClient } from './client.js';
import { createDeck } from './runner.js';
import { resolveLocale } from './format.js';
import type { Locale } from './messages.js';

type CliArgs = {
  baseUrl: string;
  token: string | undefined;
  locale: Locale;
  color: boolean;
  intervalMs: number;
};

export function parseArgs(argv: string[]): CliArgs {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i]!; // loop bound guarantees existence
    if (current.startsWith('--')) {
      const key = current.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(key, next);
        i += 1;
      } else {
        flags.set(key, 'true');
      }
    }
  }
  if (flags.has('token')) {
    // A secret on the command line is readable from `ps` and lands in the shell
    // history; refuse it rather than quietly accepting a leaky invocation.
    throw new Error('--token is not accepted: set ZEUS_INTERNAL_TOKEN instead (a flag is visible in `ps` and the shell history)');
  }
  const intervalMs = Number(flags.get('interval') ?? process.env.ZEUS_TUI_INTERVAL_MS ?? '3000');
  if (!Number.isFinite(intervalMs) || intervalMs < 0) {
    throw new Error('--interval must be a non-negative number of milliseconds');
  }
  const localeArg = flags.get('locale') ?? process.env.LC_ALL ?? process.env.LANG;
  return {
    baseUrl: (flags.get('base-url') ?? process.env.ZEUS_BASE_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, ''),
    token: process.env.ZEUS_INTERNAL_TOKEN,
    locale: resolveLocale(localeArg),
    color: flags.has('no-color') ? false : process.env.NO_COLOR == null,
    intervalMs,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.token) {
    process.stdout.write('missing bearer token: set ZEUS_INTERNAL_TOKEN\n');
    process.exitCode = 2;
    return;
  }

  const client = createDeckClient(args.baseUrl, args.token);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const controller = createDeck({
    client,
    locale: args.locale,
    color: args.color,
    io: {
      print: text => process.stdout.write(text),
      question: prompt => rl.question(prompt),
      now: () => new Date(),
    },
  });

  await controller.refresh();

  // The auto-refresh and the input line share one stdout. A refresh that lands
  // while `rl.question` has a prompt on screen paints over the operator's
  // half-typed line and corrupts the echo, so polling is stopped before the
  // prompt is drawn and restarted once the line has been read. `inFlight` is
  // drained first: a tick already fetching must finish before the prompt opens.
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> = Promise.resolve();
  const startPolling = (): void => {
    if (args.intervalMs <= 0 || timer) return;
    timer = setInterval(() => {
      inFlight = controller.refresh().catch(error => {
        process.stdout.write(`${error instanceof Error ? error.message : String(error)}\n`);
      });
    }, args.intervalMs);
    timer.unref();
  };
  const stopPolling = async (): Promise<void> => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    await inFlight;
  };
  startPolling();

  let running = true;
  while (running) {
    await stopPolling();
    const line = await rl.question('');
    startPolling();
    running = await controller.handle(line);
  }
  await stopPolling();
  rl.close();
}

// Only run as a process when invoked directly (not under vitest / imports).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stdout.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
