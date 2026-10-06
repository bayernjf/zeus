import { describe, expect, it } from 'vitest';
import { COMMAND_HELP, parseCommand } from '../src/tui/commands.js';

describe('TUI contract commands (self-host step 5 face)', () => {
  it('parses contract revoke as a bare index and issue with ceilings', () => {
    expect(parseCommand('c3')).toEqual({ kind: 'contractRevoke', index: 3 });
    expect(parseCommand('c 3')).toEqual({ kind: 'contractRevoke', index: 3 });
    expect(parseCommand('c research 4 2 driver')).toEqual({
      kind: 'contractIssue', skill: 'research', maxChildTickets: 4, maxConcurrent: 2, grantedBy: 'driver',
    });
    expect(parseCommand('c research 4 2')).toEqual({
      kind: 'contractIssue', skill: 'research', maxChildTickets: 4, maxConcurrent: 2, grantedBy: 'operator',
    });
  });

  it('rejects contract forms that would issue a malformed contract', () => {
    expect(parseCommand('c research 0 2')).toEqual({ error: 'contract-bad-limit' });
    expect(parseCommand('c research 2 4')).toEqual({ error: 'contract-bad-limit' });
    expect(parseCommand('c research x 2')).toEqual({ error: 'contract-bad-limit' });
    expect(parseCommand('c')).toEqual({ error: 'contract-needs-args' });
    expect(parseCommand('c research')).toEqual({ error: 'contract-needs-args' });
    expect(COMMAND_HELP).toContain('delegation contract');
  });
});

describe('TUI watch commands (self-host P1 face)', () => {
  it('parses a bare tick and a bare-index revoke', () => {
    expect(parseCommand('wt')).toEqual({ kind: 'watchTick' });
    expect(parseCommand('WT')).toEqual({ kind: 'watchTick' });
    expect(parseCommand('watch-tick')).toEqual({ kind: 'watchTick' });
    expect(parseCommand('w3')).toEqual({ kind: 'watchRevoke', index: 3 });
    expect(parseCommand('w 3')).toEqual({ kind: 'watchRevoke', index: 3 });
  });

  it('rejects watch forms that carry an inline predicate (registration stays on HTTP)', () => {
    expect(parseCommand('w')).toEqual({ error: 'watch-needs-args' });
    expect(parseCommand('w research')).toEqual({ error: 'watch-needs-args' });
    expect(COMMAND_HELP).toContain('watch evaluation tick');
  });
});

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

  it('parses grant issuance with realm#, subject, access token and optional issuer', () => {
    expect(parseCommand('g2 loom r')).toEqual({
      kind: 'grantIssue', realmIndex: 2, subject: 'loom', access: 'read', grantedBy: 'operator',
    });
    expect(parseCommand('G 1 Agent-X W alice')).toEqual({
      kind: 'grantIssue', realmIndex: 1, subject: 'Agent-X', access: 'write', grantedBy: 'alice',
    });
    // Machine identifiers keep their case even though the verb is case-folded.
    expect(parseCommand('g1 Pr-Helper read ops bot')).toMatchObject({ subject: 'Pr-Helper', grantedBy: 'ops bot' });
  });

  it('parses grant revocation by grant index', () => {
    expect(parseCommand('k3')).toEqual({ kind: 'grantRevoke', grantIndex: 3 });
  });

  it('rejects malformed grant commands with a specific error token', () => {
    expect(parseCommand('g1')).toEqual({ error: 'grant-needs-args' });
    expect(parseCommand('g0 loom r')).toEqual({ error: 'bad-index' });
    expect(parseCommand('g1 loom x')).toEqual({ error: 'grant-bad-access' });
    expect(parseCommand('k0')).toEqual({ error: 'bad-index' });
  });

  it('parses operator intent recognition: i = local rules, im = model opt-in', () => {
    expect(parseCommand('i review the pr')).toEqual({ kind: 'recognize', text: 'review the pr', useModel: false });
    expect(parseCommand('  i  复盘双十一活动 ')).toEqual({ kind: 'recognize', text: '复盘双十一活动', useModel: false });
    expect(parseCommand('im research postgres vs sqlite')).toEqual({
      kind: 'recognize',
      text: 'research postgres vs sqlite',
      useModel: true,
    });
    expect(parseCommand('IM replay')).toEqual({ kind: 'recognize', text: 'replay', useModel: true });
    expect(parseCommand('i')).toEqual({ error: 'recognize-needs-text' });
    expect(parseCommand('im   ')).toEqual({ error: 'recognize-needs-text' });
  });

  it('keeps existing single-letter actions unambiguous against i/im', () => {
    expect(parseCommand('d1')).toEqual({ kind: 'revoke', index: 1 });
    expect(parseCommand('a3')).toEqual({ kind: 'approve', index: 3 });
    expect(parseCommand('info')).toEqual({ error: 'unknown' });
  });
});
