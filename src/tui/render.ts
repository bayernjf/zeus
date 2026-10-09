/**
 * Pure render layer: DeckSnapshot -> lines of text. No timers, no stdin, no
 * screen clearing here, so the whole view is unit-testable. Colors come only
 * through semantic tokens (tokens.ts); labels only through the i18n translator.
 */
import type { Translator } from './format.js';
import { auditDecisionLabel, statusLabel } from './format.js';
import { auditToken, paintStatus, type Palette } from './tokens.js';
import type { ContractView, ContractsView, DeckSnapshot, DomainsView, EscalationView, RecognizeView, WatchesView, WatchView } from './client.js';

export type RenderInput = {
  snapshot: DeckSnapshot;
  t: Translator;
  palette: Palette;
  /** Wall-clock title string supplied by the runtime, already locale-formatted. */
  updatedAt: string;
};

const rule = '─'.repeat(72);

function heading(palette: Palette, text: string): string {
  return palette.bold(text);
}

function renderState(palette: Palette, t: Translator, snapshot: DeckSnapshot): string[] {
  const state = snapshot.state;
  const lines: string[] = [heading(palette, t('state.title'))];
  if (state?.persistence) {
    const value = state.persistence.enabled
      ? t('state.persistence.on', { file: state.persistence.stateFile ?? '' })
      : t('state.persistence.off');
    lines.push(`  ${t('state.persistence')}: ${value}${state.persistence.restoredFromSnapshot ? ` · ${t('state.restored')}` : ''}`);
  }
  if (state?.audit) {
    const value = state.audit.degraded
      ? t('state.audit.degraded', { failures: state.audit.failures })
      : t('state.audit.ok', { file: state.audit.file ?? '' });
    lines.push(`  ${t('state.audit')}: ${value}`);
  }
  if (state?.driverGrants) {
    const value =
      state.driverGrants.authority === 'signed'
        ? t('state.driverGrant.signed', { keyId: state.driverGrants.keyId ?? '' })
        : t('state.driverGrant.shapeOnly');
    lines.push(`  ${t('state.driverGrant')}: ${value}`);
  }
  if (state?.counts) {
    const c = state.counts;
    lines.push(
      '  ' +
        t('state.counts', {
          vassals: c.vassals,
          revoked: c.vassalsRevoked,
          intents: c.intents,
          escalations: c.escalations,
          skills: c.skills,
        }),
    );
  }
  return lines;
}

function renderMetrics(palette: Palette, t: Translator, snapshot: DeckSnapshot): string[] {
  const m = snapshot.metrics;
  if (!m) return [];
  const lines: string[] = [heading(palette, t('metrics.title'))];
  if (m.finished === 0 && m.inFlight === 0) {
    lines.push(`  ${t('metrics.empty')}`);
    return lines;
  }
  lines.push(
    '  ' +
      t('metrics.line', {
        inFlight: m.inFlight,
        maxInFlight: m.maxInFlight,
        queueDepth: m.queueDepth,
        completed: m.completed,
        failed: m.failed,
        timedOut: m.timedOut,
      }),
  );
  return lines;
}

export function skillList(entry: { skills: Array<{ id?: string; name?: string }> }): string {
  return entry.skills.map(skill => skill.id ?? skill.name ?? '?').join(',');
}

function renderRoster(palette: Palette, t: Translator, snapshot: DeckSnapshot): string[] {
  const entries = snapshot.roster.entries;
  const lines: string[] = [heading(palette, t('roster.title', { total: entries.length }))];
  if (entries.length === 0) {
    lines.push(`  ${t('roster.empty')}`);
    return lines;
  }
  for (const entry of entries) {
    const label = statusLabel(t, entry.status);
    const badge = paintStatus(palette, entry.status, label);
    const health = entry.health && entry.health !== 'healthy' ? ` ${palette.paint('warning', entry.health)}` : '';
    lines.push(`  ${badge}  ${palette.bold(entry.name)}  [${skillList(entry)}]${health}`);
  }
  return lines;
}

export function escalationKindLabel(t: Translator, kind: EscalationView['kind']): string {
  const key = `escalation.kind.${kind}` as Parameters<Translator>[0];
  return t(key);
}

export function escalationOptions(escalation: EscalationView): string[] {
  if (escalation.kind === 'intent-conflict' && escalation.stances && escalation.stances.length > 0) {
    return escalation.stances.map(stance => stance.stance);
  }
  return escalation.options;
}

function interruptionBadge(palette: Palette, t: Translator, level: 0 | 1 | 2 | undefined): string {
  if (level === undefined) return '';
  if (level === 2) return palette.paint('attention', t('escalation.level.2' as Parameters<Translator>[0]));
  if (level === 1) return palette.paint('info', t('escalation.level.1' as Parameters<Translator>[0]));
  return '';
}

function renderEscalations(palette: Palette, t: Translator, snapshot: DeckSnapshot): string[] {
  const items = snapshot.escalations;
  const lines: string[] = [heading(palette, t('escalation.title', { total: items.length }))];
  if (items.length === 0) {
    lines.push(`  ${t('escalation.empty')}`);
    return lines;
  }
  items.forEach((esc, index) => {
    const badge = interruptionBadge(palette, t, esc.interruptLevel);
    lines.push(`  ${palette.paint('attention', `#${index + 1}`)} ${palette.bold(esc.id)} ${palette.paint('info', escalationKindLabel(t, esc.kind))}${badge ? ` ${badge}` : ''} · ${esc.skill} · ${esc.vassal}`);
    lines.push(`      ${esc.reason}`);
    const options = escalationOptions(esc);
    if (options.length > 0) {
      const labelKey = esc.kind === 'intent-conflict' ? 'escalation.stances' : 'escalation.options';
      lines.push(`      ${t(labelKey as Parameters<Translator>[0])}: ${options.map((option, i) => `${i + 1}.${option}`).join('  ')}`);
    }
    if (esc.kind === 'delegation-limit') {
      lines.push(`      ${palette.paint('attention', t('escalation.approveContractHint'))}`);
    }
  });
  lines.push(`  ${t('escalation.prompt')}`);
  return lines;
}

function renderTimeline(palette: Palette, t: Translator, snapshot: DeckSnapshot): string[] {
  const entries = snapshot.audit;
  if (entries === null) {
    return [heading(palette, t('timeline.title', { total: 0 })), `  ${t('timeline.unavailable')}`];
  }
  const lines: string[] = [heading(palette, t('timeline.title', { total: entries.length }))];
  if (entries.length === 0) {
    lines.push(`  ${t('timeline.empty')}`);
    return lines;
  }
  for (const entry of entries) {
    const { token, known } = auditToken(entry.decision);
    const label = auditDecisionLabel(t, entry.decision);
    const badge = known
      ? palette.paint(token, label)
      : palette.paint(token, `${label} (${entry.decision})`);
    const stamp = entry.ts ? `[${entry.ts}] ` : '';
    const context = [entry.vassal, entry.skill, entry.state].filter(Boolean).join(' · ');
    lines.push(`  ${stamp}${badge}  ${context}`.trimEnd());
  }
  return lines;
}

function renderDomains(palette: Palette, t: Translator, domains: DomainsView | null): string[] {
  if (domains === null) {
    return [heading(palette, t('domains.title', { realms: 0, grants: 0 })), `  ${t('domains.unavailable')}`];
  }
  const lines: string[] = [heading(palette, t('domains.title', { realms: domains.realms.length, grants: domains.grants.length }))];
  if (domains.realms.length === 0) {
    lines.push(`  ${t('domains.empty')}`);
    return lines;
  }
  domains.realms.forEach((realm, realmIndex) => {
    const typeLabel = t(realm.type === 'enterprise' ? 'domains.enterprise' : 'domains.personal');
    const flags = [t('domains.items', { count: realm.itemCount })];
    if (realm.readOnly) flags.push(t('domains.readOnly'));
    if (realm.tenant) {
      const tenantPath = [realm.tenant.org, realm.tenant.department, realm.tenant.member].filter(Boolean).join('/');
      flags.push(t('domains.tenant', { tenant: tenantPath }));
    }
    lines.push(`  ${palette.paint('muted', `#${realmIndex + 1}`)} ${palette.paint(realm.type === 'enterprise' ? 'attention' : 'info', typeLabel)}  ${palette.bold(realm.realmId)}  [${flags.join(' · ')}]`);
  });
  lines.push(`  ${t('domains.grantsTitle')}`);
  if (domains.grants.length === 0) {
    lines.push(`    ${t('domains.noGrants')}`);
  } else {
    domains.grants.forEach((grant, grantIndex) => {
      const access = t(grant.access === 'write' ? 'domains.access.write' : 'domains.access.read');
      lines.push(`    ${palette.paint('muted', `#${grantIndex + 1}`)} ${t('domains.grant', { subject: grant.subject, realmId: grant.realmId, access, grantedBy: grant.grantedBy })}`);
    });
  }
  lines.push(`  ${palette.paint('muted', t('domains.grantPrompt'))}`);
  return lines;
}

function renderContract(palette: Palette, t: Translator, contract: ContractView): string {
  const revoked = contract.revokedAt !== undefined;
  const badge = palette.paint(revoked ? 'muted' : 'success', t(revoked ? 'contracts.status.revoked' : 'contracts.status.active'));
  const window = contract.limits.windowEndsAt.slice(0, 16).replace('T', ' ');
  const body = t('contracts.line', {
    id: contract.id.slice(0, 8),
    skill: contract.skill,
    used: contract.used.childTickets,
    tickets: contract.limits.maxChildTickets,
    inFlight: contract.used.inFlight,
    concurrent: contract.limits.maxConcurrent,
    window,
  });
  const scope = contract.vassal ? ` · ${contract.vassal}` : '';
  return `  ${badge}  ${palette.bold(body)}${scope}  [${t('contracts.caps', { caps: contract.capabilities.join(',') })}]`;
}

function renderContracts(palette: Palette, t: Translator, contracts: ContractsView | null): string[] {
  if (contracts === null) {
    return [heading(palette, t('contracts.title', { total: 0 })), `  ${t('contracts.unavailable')}`];
  }
  const items = contracts.contracts;
  const lines: string[] = [heading(palette, t('contracts.title', { total: items.length }))];
  if (items.length === 0) {
    lines.push(`  ${t('contracts.empty')}`);
    return lines;
  }
  for (const contract of items) lines.push(renderContract(palette, t, contract));
  lines.push(`  ${palette.paint('muted', t('contracts.issuePrompt'))}`);
  return lines;
}

function renderWatch(palette: Palette, t: Translator, watch: WatchView): string {
  const badge = palette.paint(watch.enabled ? 'success' : 'muted', t(watch.enabled ? 'watches.status.enabled' : 'watches.status.settled'));
  const last = watch.lastFiredAt ? watch.lastFiredAt.slice(0, 16).replace('T', ' ') : '—';
  const body = t('watches.line', {
    id: watch.id.slice(0, 8),
    skill: watch.intent.skill,
    mode: watch.intent.mode,
    source: watch.predicate.source,
    field: watch.predicate.field,
    fires: watch.used.fires,
    fireBudget: watch.budget.fires,
    last,
  });
  return `  ${badge}  ${palette.bold(body)}`;
}

function renderWatches(palette: Palette, t: Translator, watches: WatchesView | null): string[] {
  if (watches === null) {
    return [heading(palette, t('watches.title', { total: 0 })), `  ${t('watches.unavailable')}`];
  }
  const items = watches.watches;
  const lines: string[] = [heading(palette, t('watches.title', { total: items.length }))];
  if (items.length === 0) {
    lines.push(`  ${t('watches.empty')}`);
    return lines;
  }
  for (const watch of items) lines.push(renderWatch(palette, t, watch));
  lines.push(`  ${palette.paint('muted', t('watches.prompt'))}`);
  return lines;
}

/** Render the full deck to a string ready to print. */
export function renderDeck(input: RenderInput): string {
  const { snapshot, t, palette, updatedAt } = input;
  const blocks: string[][] = [
    [`${palette.bold(t('app.title'))}  ${palette.paint('muted', updatedAt)}`],
    renderState(palette, t, snapshot),
    renderMetrics(palette, t, snapshot),
    renderRoster(palette, t, snapshot),
    renderTimeline(palette, t, snapshot),
    renderDomains(palette, t, snapshot.domains),
    renderContracts(palette, t, snapshot.contracts),
    renderWatches(palette, t, snapshot.watches),
    renderEscalations(palette, t, snapshot),
    [rule, palette.paint('muted', t('app.quit'))],
  ];
  return blocks.map(block => block.join('\n')).join('\n\n') + '\n';
}

/**
 * Render one E2.6 recognition result. The deck never guesses: a hit shows the
 * suggested skill (plan-only), a miss shows the fail-closed reason verbatim.
 */
export function renderRecognize(input: { result: RecognizeView; t: Translator; palette: Palette }): string {
  const { result, t, palette } = input;
  if (result.ok) {
    const backend =
      result.backend === null ? t('recognize.backend.local') : t('recognize.backend.model', result.backend);
    return [
      rule,
      heading(palette, t('recognize.title')),
      t('recognize.ok', { skill: result.skill, confidence: String(result.confidence) }),
      backend,
      palette.paint('muted', t('recognize.planOnly')),
      rule,
    ].join('\n');
  }
  const detail = result.detail !== undefined ? ` · ${result.detail}` : '';
  return [rule, heading(palette, t('recognize.title')), t('recognize.fail', { reason: result.reason, detail }), rule].join('\n');
}
