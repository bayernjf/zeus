/**
 * Line-driven controller for the supervision deck (方案 D). It polls the existing
 * HTTP face, renders pure views, and applies operator commands — every write is
 * a plain API call with a y/N confirm, so it audits identically to curl. IO is
 * injected so the controller is testable without a real TTY; cli.ts owns the
 * readline loop and the refresh interval.
 */
import type { DeckClient, DeckSnapshot, EscalationView } from './client.js';
import { makeTranslator, resolveLocale, statusLabel, type Translator } from './format.js';
import { makePalette, type Palette } from './tokens.js';
import { renderDeck, renderRecognize, escalationOptions, escalationKindLabel, connectorStatusLabel } from './render.js';
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
    cmd: Extract<DeckCommand, { kind: 'approve' | 'reject' | 'resolve' | 'resume' }>,
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
    if (cmd.kind === 'resume') {
      // The kernel only resumes a branch that stopped for parameters; approving
      // some other kind through this path would record a decision and silently
      // leave the branch parked, so the deck refuses before any request goes out.
      if (esc.kind !== 'task-input') {
        io.print(`${t('escalation.resumeNeedsTaskInput', { kind: escalationKindLabel(t, esc.kind) })}\n`);
        return;
      }
      const action = t('escalation.resume');
      if (!(await confirm(t('escalation.resumeConfirm', { action, id: esc.id, params: JSON.stringify(cmd.params) })))) return;
      await client.resume(esc.id, cmd.params);
      io.print(`${t('escalation.resumed', { id: esc.id, vassal: esc.vassal })}\n`);
      return;
    }
    if (cmd.kind === 'approve' && esc.kind === 'delegation-limit') {
      // The endpoint requires grantedBy and limits; the deck states the narrow
      // shape it approves (execute-only is pinned server-side).
      const shape = { grantedBy: 'operator', maxChildTickets: 4, maxConcurrent: 1, windowEndsAt: new Date(io.now().getTime() + 24 * 3600_000).toISOString() };
      if (!(await confirm(t('escalation.approveContractConfirm', { id: esc.id, tickets: shape.maxChildTickets, concurrent: shape.maxConcurrent })))) return;
      const bound = await client.approveContract(esc.id, shape);
      io.print(
        `${t('escalation.approveContractDone', { contractId: bound.contractId, watchId: bound.watchId, id: esc.id })}\n`,
      );
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
    if (parsed.kind === 'recognize') {
      try {
        const result = await client.recognize(parsed.text, { useModel: parsed.useModel });
        io.print(`${renderRecognize({ result, t, palette })}\n`);
      } catch (error) {
        io.print(`${t('common.error.http', { status: '', message: error instanceof Error ? error.message : String(error) })}\n`);
      }
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

    if (parsed.kind === 'reinstate') {
      const entry = snapshot.roster.entries[parsed.index - 1];
      if (!entry) {
        io.print(`${t('roster.reinstateFailed', { message: `#${parsed.index}` })}\n`);
        return true;
      }
      // Only a revoked entry has a way back; the kernel answers 404 for an
      // active one, and the deck says which state it looked at instead.
      if (entry.status !== 'revoked') {
        io.print(`${t('roster.reinstateNeedsRevoked', { name: entry.name, status: statusLabel(t, entry.status) })}\n`);
        return true;
      }
      if (!(await confirm(t('roster.confirmReinstate', { name: entry.name })))) return true;
      try {
        await client.reinstate(entry.name);
        io.print(`${t('roster.reinstated', { name: entry.name })}\n`);
      } catch (error) {
        io.print(`${t('roster.reinstateFailed', { message: error instanceof Error ? error.message : String(error) })}\n`);
      }
      await draw();
      return true;
    }

    if (parsed.kind === 'grantIssue') {
      const realms = snapshot.domains?.realms ?? [];
      const realm = realms[parsed.realmIndex - 1];
      if (!realm) {
        io.print(`${t('domains.grantFailed', { message: `realm #${parsed.realmIndex}` })}\n`);
        return true;
      }
      if (realm.type !== 'enterprise') {
        io.print(`${t('domains.grantEnterpriseOnly')}\n`);
        return true;
      }
      const access = parsed.access === 'write' ? t('domains.access.write') : t('domains.access.read');
      const promptLine = t('domains.confirmGrant', { subject: parsed.subject, realmId: realm.realmId, access });
      if (!(await confirm(promptLine))) return true;
      try {
        await client.issueGrant({
          subject: parsed.subject,
          realmId: realm.realmId,
          access: parsed.access,
          grantedBy: parsed.grantedBy,
        });
        io.print(`${t('domains.granted', { subject: parsed.subject, realmId: realm.realmId })}\n`);
      } catch (error) {
        io.print(`${t('domains.grantFailed', { message: error instanceof Error ? error.message : String(error) })}\n`);
      }
      await draw();
      return true;
    }

    if (parsed.kind === 'grantRevoke') {
      const grant = snapshot.domains?.grants[parsed.grantIndex - 1];
      if (!grant) {
        io.print(`${t('domains.grantFailed', { message: `grant #${parsed.grantIndex}` })}\n`);
        return true;
      }
      if (!(await confirm(t('domains.confirmRevokeGrant', { grantId: grant.grantId })))) return true;
      try {
        await client.revokeGrant(grant.grantId);
        io.print(`${t('domains.grantRevoked', { grantId: grant.grantId })}\n`);
      } catch (error) {
        io.print(`${t('domains.grantFailed', { message: error instanceof Error ? error.message : String(error) })}\n`);
      }
      await draw();
      return true;
    }

    if (parsed.kind === 'contractIssue') {
      const windowEndsAt = new Date(io.now().getTime() + 24 * 3600_000).toISOString();
      const confirmLine = t('contracts.confirmIssue', {
        skill: parsed.skill,
        tickets: parsed.maxChildTickets,
        concurrent: parsed.maxConcurrent,
      });
      if (!(await confirm(confirmLine))) return true;
      try {
        const contract = await client.issueContract({
          grantedBy: parsed.grantedBy,
          skill: parsed.skill,
          capabilities: ['execute'],
          limits: { maxChildTickets: parsed.maxChildTickets, maxConcurrent: parsed.maxConcurrent, windowEndsAt },
        });
        io.print(`${t('contracts.issued', { id: contract.id })}\n`);
      } catch (error) {
        io.print(`${t('contracts.failed', { message: error instanceof Error ? error.message : String(error) })}\n`);
      }
      await draw();
      return true;
    }

   if (parsed.kind === 'contractRevoke') {
      const contract = snapshot.contracts?.contracts[parsed.index - 1];
      if (!contract) {
        io.print(`${t('contracts.failed', { message: `#${parsed.index}` })}\n`);
        return true;
      }
      if (!(await confirm(t('contracts.confirmRevoke', { id: contract.id })))) return true;
      try {
        await client.revokeContract(contract.id);
        io.print(`${t('contracts.revoked', { id: contract.id })}\n`);
      } catch (error) {
        io.print(`${t('contracts.failed', { message: error instanceof Error ? error.message : String(error) })}\n`);
      }
     await draw();
     return true;
   }

    if (parsed.kind === 'watchTick') {
      try {
        const report = await client.watchTick();
        io.print(`${t('watches.ticked', { evaluated: report.evaluated, fired: report.fired.length, unavailable: report.unavailable.length, autoDisabled: report.autoDisabled.length })}\n`);
      } catch (error) {
        io.print(`${t('watches.failed', { message: error instanceof Error ? error.message : String(error) })}\n`);
      }
      await draw();
      return true;
    }

    if (parsed.kind === 'watchRevoke') {
      const watch = snapshot.watches?.watches[parsed.index - 1];
      if (!watch) {
        io.print(`${t('watches.failed', { message: `#${parsed.index}` })}\n`);
        return true;
      }
      if (!(await confirm(t('watches.confirmRevoke', { id: watch.id })))) return true;
      try {
        await client.revokeWatch(watch.id);
        io.print(`${t('watches.revoked', { id: watch.id })}\n`);
      } catch (error) {
        io.print(`${t('watches.failed', { message: error instanceof Error ? error.message : String(error) })}\n`);
      }
      await draw();
      return true;
    }

    if (parsed.kind === 'connectorConnect' || parsed.kind === 'connectorRevoke' || parsed.kind === 'connectorCall') {
      const connector = snapshot.connectors?.connectors[parsed.index - 1];
      if (!connector) {
        io.print(`${t('connectors.failed', { message: `#${parsed.index}` })}\n`);
        return true;
      }
      const status = connectorStatusLabel(t, connector.status);
      if (parsed.kind === 'connectorConnect') {
        // A handshake leaves the row usable; asking again on a connected row is
        // a no-op upstream, not an error - so the deck says what it saw instead
        // of re-running it silently.
        if (connector.status !== 'declared') {
          io.print(`${t('connectors.needsDeclared', { name: connector.id, status })}\n`);
          return true;
        }
        if (!(await confirm(t('connectors.confirmConnect', { name: connector.name, id: connector.id })))) return true;
        try {
          const bound = await client.connectConnector(connector.id);
          io.print(`${t('connectors.connected', { name: connector.id, tools: (bound.capabilities?.tools ?? []).length })}\n`);
        } catch (error) {
          io.print(`${t('connectors.failed', { message: error instanceof Error ? error.message : String(error) })}\n`);
        }
        await draw();
        return true;
      }
      if (parsed.kind === 'connectorRevoke') {
        if (!(await confirm(t('connectors.confirmRevoke', { id: connector.id })))) return true;
        try {
          await client.revokeConnector(connector.id);
          io.print(`${t('connectors.revoked', { id: connector.id })}\n`);
        } catch (error) {
          io.print(`${t('connectors.failed', { message: error instanceof Error ? error.message : String(error) })}\n`);
        }
        await draw();
        return true;
      }
      // A tool call reaches an external system, so the deck does not carry one
      // out on a connector whose handshake never happened: without it there is
      // no advertised capability list to bound what we are asking for.
      if (connector.status !== 'connected') {
        io.print(`${t('connectors.needsConnected', { name: connector.id, status })}\n`);
        return true;
      }
      const declared = connector.capabilities?.tools ?? [];
      if (declared.length > 0 && !declared.includes(parsed.tool)) {
        io.print(`${t('connectors.failed', { message: `${parsed.tool} is not among this connector's ${declared.length} discovered tools` })}\n`);
        return true;
      }
      if (declared.length === 0) {
        io.print(`${t('connectors.noTools', { name: connector.id })}\n`);
        return true;
      }
      if (!(await confirm(t('connectors.confirmCall', { id: connector.id, tool: parsed.tool, params: JSON.stringify(parsed.args) })))) return true;
      try {
        const result = await client.callConnectorTool(connector.id, parsed.tool, parsed.args);
        io.print(`${t('connectors.called', { tool: parsed.tool, result: JSON.stringify(result ?? null) })}\n`);
      } catch (error) {
        io.print(`${t('connectors.failed', { message: error instanceof Error ? error.message : String(error) })}\n`);
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
