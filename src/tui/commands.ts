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
  | { kind: 'grantIssue'; realmIndex: number; subject: string; access: 'read' | 'write'; grantedBy: string }
  | { kind: 'grantRevoke'; grantIndex: number }
  | { kind: 'recognize'; text: string; useModel: boolean }
  | { kind: 'contractIssue'; skill: string; maxChildTickets: number; maxConcurrent: number; grantedBy: string }
  | { kind: 'contractRevoke'; index: number }
  | { kind: 'help' };

export type CommandError = { error: string };

/** Normalize one typed line into a command, or a localized-independent error token. */
export function parseCommand(raw: string): DeckCommand | CommandError {
  const line = raw.trim();
  const verb = line.slice(0, 1).toLowerCase();
  const lower = line.toLowerCase();
  if (line === '' || lower === 'r') return { kind: 'refresh' };
  if (lower === 'q' || lower === 'quit') return { kind: 'quit' };
  if (lower === 'h' || lower === 'help' || line === '?') return { kind: 'help' };

  // Cross-domain grant issuance: `g <enterpriseRealm#> <subject> <r|w> [grantedBy]`.
  if (verb === 'g') {
    const grantMatch = /^g\s*(\d+)\s+(\S+)\s+(\S+)(?:\s+(.+))?$/i.exec(line);
    if (!grantMatch) return { error: 'grant-needs-args' };
    const [, indexStr, subject, accessTokenRaw, issuerRaw] = grantMatch;
    const realmIndex = Number(indexStr);
    const accessToken = accessTokenRaw!.toLowerCase(); // regex guarantees \S+
    if (!Number.isInteger(realmIndex) || realmIndex < 1) return { error: 'bad-index' };
    const access = accessToken === 'r' || accessToken === 'read' ? 'read' : accessToken === 'w' || accessToken === 'write' ? 'write' : null;
    if (access === null) return { error: 'grant-bad-access' };
    // Both \S+ groups are guaranteed by the regex; only the trailing issuer is optional.
    return { kind: 'grantIssue', realmIndex, subject: subject!, access, grantedBy: issuerRaw ?? 'operator' };
  }

  // Cross-domain grant revocation: `k <grant#>` (distinct from `d`, roster revoke).
  if (verb === 'k') {
    const revokeMatch = /^k\s*(\d+)\s*$/i.exec(line);
    if (!revokeMatch) return { error: 'bad-index' };
    const grantIndex = Number(revokeMatch[1]);
    if (!Number.isInteger(grantIndex) || grantIndex < 1) return { error: 'bad-index' };
    return { kind: 'grantRevoke', grantIndex };
  }

  // Operator intent recognition (E2.6): `i <instruction>` resolves locally
  // (zero bytes leave the machine), `im <instruction>` explicitly consults
  // the configured decision backend. Recognition is plan-only - the result
  // is a suggestion, never an execution. The command word must be exactly
  // `i`/`im` (optionally followed by whitespace) so longer words like `info`
  // never collide.
  const imMatch = /^im(?:\s+(.+))?$/i.exec(line);
  if (imMatch) {
    const text = (imMatch[1] ?? '').trim();
    if (text === '') return { error: 'recognize-needs-text' };
    return { kind: 'recognize', text, useModel: true };
  }
  const iMatch = /^i(?:\s+(.+))?$/i.exec(line);
  if (iMatch) {
    const text = (iMatch[1] ?? '').trim();
    if (text === '') return { error: 'recognize-needs-text' };
    return { kind: 'recognize', text, useModel: false };
  }

  // Delegation contracts (self-host step 5 operator face). Revoke is a bare
  // index - `c3` or `c 3`; issue carries the skill and ceilings - `c <skill>
  // <tickets> <concurrent> [by]`. Capabilities stay fixed to `execute` and the
  // window to 24h here: the deck issues the narrowest contract, and an operator
  // who wants a different shape uses the HTTP face where that is a real choice.
  const contractRevokeMatch = /^c\s*(\d+)\s*$/i.exec(line);
  if (contractRevokeMatch) {
    const index = Number(contractRevokeMatch[1]);
    if (!Number.isInteger(index) || index < 1) return { error: 'bad-index' };
    return { kind: 'contractRevoke', index };
  }
  const contractIssueMatch = /^c\s+(\S+)\s+(\S+)\s+(\S+)(?:\s+(.+))?$/i.exec(line);
  if (contractIssueMatch) {
    const [, skill, ticketsStr, concurrentStr, issuerRaw] = contractIssueMatch;
    const maxChildTickets = Number(ticketsStr);
    const maxConcurrent = Number(concurrentStr);
    if (!Number.isInteger(maxChildTickets) || maxChildTickets < 1) return { error: 'contract-bad-limit' };
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > maxChildTickets) return { error: 'contract-bad-limit' };
    return { kind: 'contractIssue', skill: skill!, maxChildTickets, maxConcurrent, grantedBy: issuerRaw?.trim() || 'operator' };
  }
  if (lower === 'c' || /^c\s+\S+$/i.test(line)) return { error: 'contract-needs-args' };

  const match = /^([axsd])\s*(\d+)(?:[\s.:-]+(\d+))?$/.exec(line.toLowerCase());
  if (!match) return { error: 'unknown' };
  const [, letter, indexStr, stanceStr] = match;
  const index = Number(indexStr);
  if (!Number.isInteger(index) || index < 1) return { error: 'bad-index' };

  switch (letter) {
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
  '  g<n> <subject> <r|w> [by]  issue a personal->enterprise grant on realm #n',
  '  k<n>       revoke cross-domain grant #n (asks y/N)',
  '  c <skill> <tickets> <concurrent> [by]  issue a delegation contract (execute, 24h)',
  '  c<n>       revoke delegation contract #n (asks y/N)',
  '  i <text>   recognize an operator instruction locally (plan-only)',
  '  im <text>  recognize using the configured decision backend (opt-in)',
  '  q          quit',
].join('\n');
