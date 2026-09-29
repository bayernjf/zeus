/**
 * Line-driven controller for the supervision deck (方案 D). It polls the existing
 * HTTP face, renders pure views, and applies operator commands — every write is
 * a plain API call with a y/N confirm, so it audits identically to curl. IO is
 * injected so the controller is testable without a real TTY; cli.ts owns the
 * readline loop and the refresh interval.
 */
import type { DeckClient, DeckSnapshot, EscalationView } from './client.js';
import { makeTranslator, resolveLocale, type Translator } from './format.js';
import { makePalette, type Palette } from './tokens.js';
import { renderDeck, escalationOptions } from './render.js';
import { COMMAND_HELP, parseCommand, type DeckCommand } from './commands.js';
import type { Locale } from './messages.js';

export type RunnerIo = {
  question(prompt: string): Promise<string>;
  print(text: string): void;
  /** Wall clock for the view header. */
  now(): Date;
};

export type RunnerOptions = {
  client: DeckClient;
  io: RunnerIo;
  locale?: Locale;
  color?: boolean;
};

export type DeckController = {
  /** Fetch the latest snapshot and print the view. */
  refresh(): Promise<void>;
  /** Apply one typed line. Returns false when the operator asked to quit. */
  handle(raw: string): Promise<boolean>;
};

export function createDeck(options: RunnerOptions): DeckController {
  const { client, io } = options;
  const locale = options.locale ?? resolveLocale(process.env.LANG ?? process.env.LC_ALL);
  const t: Translator = makeTranslator(locale);
  const color = options.color ?? (process.stdout.isTTY === true && process.env.NO_COLOR == null);
  const palette: Palette = makePalette(color);

  let snapshot: DeckSnapshot | null = null;

  const draw = async (): Promise<void> => {
    const next = await client.snapshot();
    snapshot = next;
    const stamp = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(io.now());
    io.print(renderDeck({ snapshot: next, t, palette, updatedAt: stamp }));
  };

  const confirm = async (prompt: string): Promise<boolean> => {
    const answer = (await io.question(`${prompt} `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  };

  const applyEscalation = async (
    cmd: Extract<DeckCommand, { kind: 'approve' | 'reject' | 'resolve' }>,
    esc: EscalationView,
  ): Promise<void> => {
    if (cmd.kind === 'resolve') {
      const stance = escalationOptions(esc)[cmd.stanceIndex - 1];
      if (stance === undefined) {
        io.print(`${t('escalation.failed', { message: `stance #${cmd.stanceIndex}` })}\n`);
        return;
      }
      const action = t('escalation.resolve');
      if (!(await confirm(t('escalation.confirm', { action, id: esc.id })))) return;
      await client.resolve(esc.id, stance);
      io.print(`${t('escalation.done', { action, id: esc.id })}\n`);
      return;
    }
    const action = t(cmd.kind === 'approve' ? 'escalation.approve' : 'escalation.reject');
    if (!(await confirm(t('escalation.confirm', { action, id: esc.id })))) return;
    if (cmd.kind === 'approve') await client.approve(esc.id);
    else await client.reject(esc.id);
    io.print(`${t('escalation.done', { action, id: esc.id })}\n`);
  };

  const handle = async (raw: string): Promise<boolean> => {
    const parsed = parseCommand(raw);
    if ('error' in parsed) {
      io.print(`${COMMAND_HELP}\n`);
      return true;
    }
    if (parsed.kind === 'quit') return false;
    if (parsed.kind === 'help') {
      io.print(`${COMMAND_HELP}\n`);
      return true;
    }
    if (parsed.kind === 'refresh') {
      await draw().catch(error =>
        io.print(`${t('common.error.network', { baseUrl: '', message: error instanceof Error ? error.message : String(error) })}\n`),
      );
      return true;
    }
    if (!snapshot) return true;

    if (parsed.kind === 'revoke') {
      const entry = snapshot.roster.entries[parsed.index - 1];
      if (!entry || entry.status === 'revoked') {
        io.print(`${t('roster.revokeFailed', { message: `#${parsed.index}` })}\n`);
        return true;
      }
      if (!(await confirm(t('roster.confirmRevoke', { name: entry.name })))) return true;
      try {
        await client.revoke(entry.name);
        io.print(`${t('roster.revoked', { name: entry.name })}\n`);
      } catch (error) {
        io.print(`${t('roster.revokeFailed', { message: error instanceof Error ? error.message : String(error) })}\n`);
      }
      await draw();
      return true;
    }

    const esc = snapshot.escalations[parsed.index - 1];
    if (!esc) {
      io.print(`${t('escalation.failed', { message: `#${parsed.index}` })}\n`);
      return true;
    }
    try {
      await applyEscalation(parsed, esc);
    } catch (error) {
      io.print(`${t('escalation.failed', { message: error instanceof Error ? error.message : String(error) })}\n`);
    }
    await draw();
    return true;
  };

  return { refresh: draw, handle };
}
