/**
 * Pure command parser for the line-driven supervision deck. Keeping this free
 * of stdin/screen makes every operator action unit-testable. The runtime
 * (runner.ts) only fetches, renders and asks for confirmation; no command
 * semantics live there.
 */

export type DeckCommand =
  | { kind: 'refresh' }
  | { kind: 'quit' }
  | { kind: 'approve'; index: number }
  | { kind: 'reject'; index: number }
  | { kind: 'resolve'; index: number; stanceIndex: number }
  | { kind: 'revoke'; index: number }
  | { kind: 'help' };

export type CommandError = { error: string };

/** Normalize one typed line into a command, or a localized-independent error token. */
export function parseCommand(raw: string): DeckCommand | CommandError {
  const line = raw.trim().toLowerCase();
  if (line === '' || line === 'r') return { kind: 'refresh' };
  if (line === 'q' || line === 'quit') return { kind: 'quit' };
  if (line === 'h' || line === 'help' || line === '?') return { kind: 'help' };

  const match = /^(a|x|s|d)\s*(\d+)(?:[\s.:-]+(\d+))?$/.exec(line);
  if (!match) return { error: 'unknown' };
  const [, verb, indexStr, stanceStr] = match;
  const index = Number(indexStr);
  if (!Number.isInteger(index) || index < 1) return { error: 'bad-index' };

  switch (verb) {
    case 'a':
      return { kind: 'approve', index };
    case 'x':
      return { kind: 'reject', index };
    case 'd':
      return { kind: 'revoke', index };
    case 's': {
      if (stanceStr === undefined) return { error: 'resolve-needs-stance' };
      const stanceIndex = Number(stanceStr);
      if (!Number.isInteger(stanceIndex) || stanceIndex < 1) return { error: 'bad-stance' };
      return { kind: 'resolve', index, stanceIndex };
    }
    default:
      return { error: 'unknown' };
  }
}

export const COMMAND_HELP = [
  '  <enter>/r  refresh',
  '  a<n>       approve escalation #n',
  '  x<n>       reject escalation #n',
  '  s<n>.<m>   resolve escalation #n accepting stance #m',
  '  d<n>       revoke roster vassal #n (asks y/N)',
  '  q          quit',
].join('\n');
