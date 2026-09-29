import { describe, expect, it } from 'vitest';
import { COMMAND_HELP, parseCommand } from '../src/tui/commands.js';

describe('TUI command parser', () => {
  it('parses refresh and quit (case/space tolerant)', () => {
    expect(parseCommand('')).toEqual({ kind: 'refresh' });
    expect(parseCommand('  R ')).toEqual({ kind: 'refresh' });
    expect(parseCommand('q')).toEqual({ kind: 'quit' });
    expect(parseCommand('QUIT')).toEqual({ kind: 'quit' });
  });

  it('parses escalation actions with 1-based indices', () => {
    expect(parseCommand('a2')).toEqual({ kind: 'approve', index: 2 });
    expect(parseCommand('x1')).toEqual({ kind: 'reject', index: 1 });
    expect(parseCommand('s1.2')).toEqual({ kind: 'resolve', index: 1, stanceIndex: 2 });
    expect(parseCommand('d3')).toEqual({ kind: 'revoke', index: 3 });
  });

  it('requires a stance index for resolve and rejects a zero index', () => {
    expect(parseCommand('s1')).toEqual({ error: 'resolve-needs-stance' });
    expect(parseCommand('a0')).toEqual({ error: 'bad-index' });
    expect(parseCommand('s1.0')).toEqual({ error: 'bad-stance' });
  });

  it('returns an error token for unknown input and ships help text', () => {
    expect(parseCommand('zzz')).toEqual({ error: 'unknown' });
    expect(COMMAND_HELP).toContain('approve');
    expect(COMMAND_HELP).toContain('revoke');
  });
});
