/**
 * Markdown rendering for the `npm run daily` entry.
 *
 * This module has no imports on purpose: the CLI gathers facts from the kernel,
 * and this turns them into the text the operator reads and the file that goes
 * back into their directory. Keeping the two apart is what makes the product
 * surface testable without a kernel, a socket or a filesystem, and it is the
 * same text in both places — what you read is what was stored.
 */

export type DailyBranchView = {
  vassal: string;
  /** Whether the dispatch round trip succeeded — not whether the work did. */
  ok: boolean;
  /** The kernel's metric category ('completed' | 'failed' | 'timeout' | 'canceled'). */
  outcome?: string;
  /** The agent's own A2A task state, when a task was reached. */
  state?: string;
  /** The vassal's own report summary (x-zeus-report.summary), when it sent one. */
  summary?: string;
  /** Evidence lines from that report. */
  evidence: string[];
  /** Text the agent returned, clipped. */
  text?: string;
  /** Failure / refusal reason as the kernel recorded it. */
  reason?: string;
};

export type DailyReportModel = {
  at: string;
  instruction: string;
  /** null when recognition did not resolve an intent. */
  skill: string | null;
  /** What picked the skill: the local ranker, a decision backend, or --skill. */
  chosenBy: 'rules' | 'model' | 'flag';
  confidence?: number;
  /** Backend identity when chosenBy is 'model'. */
  backend?: { kind: string; model: string };
  /** Recognition's fail-closed reason when there is no intent. */
  failed?: { reason: string; detail?: string };
  /** One line about something the run could not do, next to what it did. */
  note?: string;
  /** Ranked catalogue rows, so a rejection names what could have been chosen. */
  candidates: Array<{ skill: string; score: number }>;
  params: Record<string, unknown>;
  intentId?: string;
  runId?: string;
  realm: { realmId: string; root: string; type: string; readOnly: boolean };
  agents: string[];
  status?: string;
  decision?: { rule: string; conclusion: string | null; reason: string };
  positions: Array<{ vassal: string; stance: string; rationale?: string }>;
  branches: DailyBranchView[];
  /** Governance refusal that stopped dispatch before any request was sent. */
  refused?: { reason: string; detail: string };
  /** Items this run put on the oversight desk. */
  escalations: Array<{ id: string; kind: string; reason: string; options: string[] }>;
  /** The realm-relative path this run's page is stored at, when it was stored. */
  itemId?: string;
  /** The record written back into the mounted directory. */
  record?: { itemId: string; bytes: number };
  writeError?: string;
};

const clip = (value: string, max = 300): string => {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

function quote(value: string): string {
  return value.includes('\n') || value === '' ? JSON.stringify(value) : value;
}

/**
 * The lines that answer "what did you decide, and on what authority". Ordered
 * so the operator reads the conclusion before the evidence: intent, decision,
 * then the branches behind it, then anything that stopped this run.
 */
export function renderDailyReport(model: DailyReportModel): string {
  const lines: string[] = [];
  lines.push(`# Zeus · ${model.at}`);
  lines.push('');
  lines.push(`> ${clip(model.instruction, 500)}`);
  lines.push('');

  if (model.skill !== null) {
    const how =
      model.chosenBy === 'flag'
        ? 'chosen by --skill'
        : model.chosenBy === 'model'
          ? `chosen by ${model.backend ? `${model.backend.kind} / ${model.backend.model}` : 'decision backend'}${
              model.confidence !== undefined ? `, confidence ${model.confidence.toFixed(3)}` : ''
            }`
          : `chosen by local rules${model.confidence !== undefined ? `, confidence ${model.confidence.toFixed(3)}` : ''}`;
    lines.push(`- **Intent** \`${model.skill}\` — ${how}`);
  } else {
    const detail = model.failed?.detail ? `: ${clip(model.failed.detail, 200)}` : '';
    lines.push(`- **Intent** none — \`${model.failed?.reason ?? 'unresolved'}\`${detail}`);
    if (model.candidates.length > 0) {
      lines.push(`  - ranked candidates: ${model.candidates.map(c => `\`${c.skill}\` (${c.score})`).join(', ')}`);
    }
  }

  if (model.note) lines.push(`- **Note** ${model.note}`);
  lines.push(`- **Params** ${JSON.stringify(model.params)}`);
  lines.push(
    `- **Realm** \`${model.realm.realmId}\` (${model.realm.type}, ${model.realm.readOnly ? 'read-only' : 'writable'}) — ${model.realm.root}`,
  );
  lines.push(`- **Agents** ${model.agents.length > 0 ? model.agents.map(a => `\`${a}\``).join(', ') : 'none registered'}`);
  if (model.intentId) {
    lines.push(`- **Intent id** \`${model.intentId}\`${model.runId ? ` · run \`${model.runId}\`` : ''}`);
  }

  if (model.status !== undefined) {
    lines.push('');
    lines.push('## Decision');
    // The kernel's status means "every branch settled", not "the work succeeded":
    // an agent that reports a failed task still settles its branch. Saying which
    // field this is keeps a settled-but-failed run from reading as a success.
    lines.push(`- intent status \`${model.status}\` (every branch settled; read the agents below for what they reported)`);
    if (model.decision) {
      const conclusion =
        model.decision.conclusion === null ? 'no conclusion' : `**${quote(model.decision.conclusion)}**`;
      lines.push(`- rule \`${model.decision.rule}\` → ${conclusion}`);
      lines.push(`- ${clip(model.decision.reason, 400)}`);
    } else {
      lines.push('- the kernel returned no aggregated decision');
    }
    if (model.positions.length > 0) {
      lines.push('- positions:');
      for (const position of model.positions) {
        const rationale = position.rationale ? ` — ${clip(position.rationale, 200)}` : '';
        lines.push(`  - \`${position.vassal}\` = \`${clip(position.stance, 120)}\`${rationale}`);
      }
    }
  }

  if (model.branches.length > 0) {
    lines.push('');
    lines.push('## What each agent returned');
    for (const branch of model.branches) {
      const facts = [`dispatch ${branch.ok ? 'ok' : 'failed'}`];
      if (branch.state) facts.push(`agent state \`${branch.state}\``);
      // The metric category only earns its line when it differs from what the
      // agent reported: 'completed' next to 'completed' is noise, 'completed'
      // next to a failed task state is the whole story.
      if (branch.outcome && branch.outcome !== branch.state) facts.push(`counted \`${branch.outcome}\``);
      lines.push(`- **${branch.vassal}** — ${facts.join(' · ')}`);
      if (branch.summary) lines.push(`  - report: ${clip(branch.summary, 300)}`);
      for (const fact of branch.evidence) lines.push(`  - evidence: ${clip(fact, 300)}`);
      if (branch.text) lines.push(`  - text: ${clip(branch.text, 500)}`);
      if (branch.reason) lines.push(`  - reason: ${clip(branch.reason, 300)}`);
    }
  }

  if (model.refused) {
    lines.push('');
    lines.push('## Refused before dispatch');
    lines.push(`- \`${model.refused.reason}\` — ${clip(model.refused.detail, 300)}`);
  }

  if (model.escalations.length > 0) {
    lines.push('');
    lines.push('## Waiting for you');
    for (const item of model.escalations) {
      const options = item.options.length > 0 ? ` — options: ${item.options.map(o => clip(o, 80)).join(' · ')}` : '';
      lines.push(`- \`${item.id}\` (${item.kind}): ${clip(item.reason, 200)}${options}`);
    }
    lines.push('  - settle it with `npm run tui` (escalation panel) or `POST /api/escalations/:id/decision`.');
  }

  lines.push('');
  // The page names its own path rather than reporting the write: the bytes that
  // land in the file are the bytes rendered before that write, so a line claiming
  // "stored" inside the file it describes would always be false. The confirmation
  // belongs to the console, which the CLI prints from the write result.
  if (model.writeError) lines.push(`NOT stored: ${clip(model.writeError, 300)}`);
  else if (model.itemId) lines.push(`Record path: \`${model.itemId}\``);
  else lines.push('NOT stored: the run did not reach the write step.');

  return `${lines.join('\n')}\n`;
}
