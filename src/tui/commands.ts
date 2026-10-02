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
    const accessToken = accessTokenRaw.toLowerCase();
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
  '  q          quit',
].join('\n');
