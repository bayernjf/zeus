#!/usr/bin/env node
/**
 * Zeus terminal supervision deck (UI design option D).
 *
 * Read-only monitoring + escalation settlement + roster revocation over the
 * existing bearer HTTP face. No kernel route is added and no token is written
 * to disk; pass it by env or flag for one process only.
 *
 *   ZEUS_INTERNAL_TOKEN=... npm run tui
 *   node dist/tui/cli.js --base-url http://127.0.0.1:8787 --token ... --locale en
 */
import { createInterface } from 'node:readline/promises';
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

function parseArgs(argv: string[]): CliArgs {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
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
  const intervalMs = Number(flags.get('interval') ?? process.env.ZEUS_TUI_INTERVAL_MS ?? '3000');
  if (!Number.isFinite(intervalMs) || intervalMs < 0) {
    throw new Error('--interval must be a non-negative number of milliseconds');
  }
  const localeArg = flags.get('locale') ?? process.env.LC_ALL ?? process.env.LANG;
  return {
    baseUrl: (flags.get('base-url') ?? process.env.ZEUS_BASE_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, ''),
    token: flags.get('token') ?? process.env.ZEUS_INTERNAL_TOKEN,
    locale: resolveLocale(localeArg),
    color: flags.has('no-color') ? false : process.env.NO_COLOR == null,
    intervalMs,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.token) {
    process.stdout.write('missing bearer token: set ZEUS_INTERNAL_TOKEN or pass --token\n');
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
  if (args.intervalMs > 0) {
    setInterval(() => {
      void controller.refresh();
    }, args.intervalMs).unref();
  }

  let running = true;
  while (running) {
    const line = await rl.question('');
    running = await controller.handle(line);
  }
  rl.close();
}

main().catch(error => {
  process.stdout.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
