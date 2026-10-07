#!/usr/bin/env node
/**
 * `npm run daily "<one sentence>"` — the product entry.
 *
 * This file is assembly, not a new mechanism. The kernel already resolves an
 * instruction to a skill (`recognizeIntent`), fans it out to the execution agents
 * that advertise it (`orchestrator.fanOut`), escalates a split to the oversight
 * desk, and writes into the user's own directory (`FsRealmStore`). What was
 * missing is one command that walks a first-time user down that path and shows
 * them the outcome. Step 1 of docs/design-self-host-loop.md.
 *
 * Two boundaries are deliberate:
 *   - Nothing leaves the machine unless `--model` is passed. Without it
 *     recognition is the local ranker, and the fan-out only reaches agents the
 *     operator registered themselves.
 *   - The record is written into the realm the intent operated on. An
 *     enterprise-realm result never lands in a personal directory
 *     (product-portrait constraint 4), so `--realm enterprise` needs a mounted
 *     enterprise root and authorizes its write with the local driver key.
 *
 * Exit codes: 0 the report was produced and stored (including a run that ended
 * in a split waiting for the operator) · 1 nothing dispatchable, no agent
 * delivered, or the write-back failed · 2 configuration/usage error (nothing was
 * dispatched).
 */
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { TextPart } from '../a2a/types.js';
import type { DecisionBackend } from '../decision/types.js';
import {
  bootKernel,
  concurrencyBootOptions,
  KernelBootError,
  resolveAuditConfig,
  resolveConcurrencyConfig,
  resolveDecisionConfig,
  resolveRealmConfig,
  resolveVassalSeedsConfig,
  type KernelBoot,
  type KernelBootOptions,
} from '../state/boot.js';
import { parseRetentionMode } from '../state/archive.js';
import { recognizeIntent, rankCandidates, MODEL_OPTION_LIMIT, type SkillCatalogEntry } from '../intent/recognize.js';
import { loadRskSigner } from '../http/rsk.js';
import { issueDriverWriteGrant } from '../realm/grant.js';
import type { BranchOutcome, FanOutResult } from '../orchestrator/types.js';
import { RealmError, type RealmConnection } from '../realm/types.js';
import { renderDailyReport, type DailyBranchView, type DailyReportModel } from './report.js';

const DEFAULT_STATE_FILE = './data/daily-state.json';
const DEFAULT_BRANCH_TIMEOUT_MS = 60_000;

const USAGE = `usage: npm run daily -- "<one sentence>" [options]

Takes one instruction, picks the skill for it from the capability catalogue of the
agents you have registered, fans the intent out to them, prints the decision with
its evidence, and writes that same page back into your mounted directory as
markdown so a later run can read it.

Options:
  --root DIR            directory to work in, mounted read-write (repeatable;
                        ZEUS_REALM_ROOTS entries are mounted alongside, and the
                        roots saved by an earlier run are re-mounted by default)
  --agent CARD[|TOKEN]  register an execution agent before dispatch (repeatable;
                        merged with ZEUS_VASSAL_SEEDS)
  --skill ID            skip recognition and dispatch this skill instead
  --params JSON         skill parameters, merged over the default
                        {"prompt": "<your sentence>"}; an agent whose skill takes
                        named parameters needs those names
  --record PATH         realm-relative path for the markdown record
                        (default zeus-daily/<timestamp>-<skill>.md)
  --realm personal      'personal' (default) or 'enterprise': the data domain the
                        intent operates on. An enterprise run writes its record
                        into the enterprise realm on a grant signed by the local
                        driver key; it never lands in a personal directory
  --timeout MS          per-branch timeout (default ${DEFAULT_BRANCH_TIMEOUT_MS})
  --model               let this run consult the configured decision backend for
                        recognition and for split arbitration. Without it nothing
                        leaves the machine
  --state FILE          kernel state file (default ${DEFAULT_STATE_FILE},
                        ZEUS_STATE_FILE overrides, 'none' keeps state in memory)
  --help                this page

Exit codes: 0 the report was produced and stored, including a run that ended in a
split waiting for you · 1 nothing dispatchable, no agent delivered, or the
write-back failed · 2 configuration or usage error, nothing was dispatched`;

class UsageError extends Error {}

type DailyArgs = {
  instruction: string;
  roots: string[];
  agents: string[];
  skill?: string;
  params: Record<string, unknown>;
  record?: string;
  realm: 'personal' | 'enterprise';
  timeoutMs: number;
  model: boolean;
  stateFile: string | null;
  help: boolean;
};

type RunContext = {
  args: DailyArgs;
  env: NodeJS.ProcessEnv;
  err: string[];
  kernel: KernelBoot | null;
  report: DailyReportModel | null;
  realm: RealmConnection | null;
};

const VALUE_FLAGS = new Set(['--root', '--agent', '--skill', '--params', '--record', '--realm', '--timeout', '--state']);

function parseArgs(argv: string[]): DailyArgs {
  const args: DailyArgs = {
    instruction: '',
    roots: [],
    agents: [],
    params: {},
    realm: 'personal',
    timeoutMs: DEFAULT_BRANCH_TIMEOUT_MS,
    model: false,
    stateFile: null,
    help: false,
  };
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    if (arg === '--model') {
      args.model = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const value = argv[i + 1];
      if (!VALUE_FLAGS.has(arg)) throw new UsageError(`unknown option: ${arg}`);
      if (value === undefined || value.startsWith('--')) throw new UsageError(`${arg} needs a value`);
      i += 1;
      switch (arg) {
        case '--root':
          args.roots.push(value);
          break;
        case '--agent':
          args.agents.push(value);
          break;
        case '--skill':
          args.skill = value;
          break;
        case '--record':
          args.record = value;
          break;
        case '--realm':
          if (value !== 'personal' && value !== 'enterprise') {
            throw new UsageError(`--realm is 'personal' or 'enterprise', got '${value}'`);
          }
          args.realm = value;
          break;
        case '--timeout':
          args.timeoutMs = Number(value);
          if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
            throw new UsageError(`--timeout must be a positive number of ms, got '${value}'`);
          }
          break;
        case '--state':
          args.stateFile = value === 'none' ? null : value;
          break;
        case '--params':
          try {
            const parsed: unknown = JSON.parse(value);
            if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
            args.params = parsed as Record<string, unknown>;
          } catch (error) {
            throw new UsageError(`--params is not a JSON object: ${(error as Error).message}`);
          }
          break;
      }
      continue;
    }
    positional.push(arg);
  }

  if (args.help) return args;
  if (positional.length === 0) {
    throw new UsageError("an instruction is required: npm run daily -- \"summarize today's deployments\"");
  }
  if (positional.length > 1) {
    throw new UsageError(`expected one instruction, got ${positional.length} (wrap it in quotes: npm run daily -- "<sentence>")`);
  }
  args.instruction = positional[0]!;
  return args;
}

/** Seed order: explicit --agent first (the operator just typed it), then env. */
function collectSeeds(args: DailyArgs, env: NodeJS.ProcessEnv): NonNullable<KernelBootOptions['vassalSeeds']> {
  const seeds: NonNullable<KernelBootOptions['vassalSeeds']> = [];
  for (const entry of args.agents) {
    const separator = entry.indexOf('|');
    const cardUrl = (separator < 0 ? entry : entry.slice(0, separator)).trim();
    if (!cardUrl) throw new UsageError(`--agent has an empty card URL: '${entry}'`);
    const token = separator < 0 ? undefined : entry.slice(separator + 1).trim();
    if (separator >= 0 && !token) throw new UsageError(`--agent '${entry}' has nothing after '|'`);
    seeds.push(token ? { cardUrl, token } : { cardUrl });
  }
  for (const seed of resolveVassalSeedsConfig(env)) {
    if (!seeds.some(existing => cardUrlOf(existing) === cardUrlOf(seed))) seeds.push(seed);
  }
  return seeds;
}

function cardUrlOf(seed: string | { cardUrl: string; token?: string }): string {
  return typeof seed === 'string' ? seed : seed.cardUrl;
}

/**
 * `--root` adds a personal mount; ZEUS_REALM_ROOTS stays in force (it is what the
 * deployment already declared), and the enterprise entries keep working so
 * `--realm enterprise` needs nothing beyond the env the operator set.
 */
function realmRootsFor(args: DailyArgs, env: NodeJS.ProcessEnv): NonNullable<KernelBootOptions['realmRoots']> {
  const configured = resolveRealmConfig(env).realmRoots;
  const personal = configured.filter((entry): entry is string => typeof entry === 'string');
  const enterprise = configured.filter(entry => typeof entry !== 'string');
  return [...new Set([...args.roots, ...personal]), ...enterprise];
}

/**
 * Prefer the directory the operator just named. A restored snapshot re-mounts its
 * roots before these, so "first writable match" alone would keep writing the
 * record into last week's directory.
 */
function pickRealm(
  connections: RealmConnection[],
  realm: 'personal' | 'enterprise',
  requested: string[],
): RealmConnection | undefined {
  const candidates = connections.filter(connection => connection.type === realm && !connection.readOnly);
  if (candidates.length === 0) return undefined;
  for (const root of requested) {
    const match = candidates.find(connection => connection.root === safeRealpath(root) || connection.root === resolve(root));
    if (match) return match;
  }
  return candidates[0];
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function branchView(branch: BranchOutcome): DailyBranchView {
  const artifacts = branch.task?.artifacts ?? [];
  const report = artifacts.map(artifact => artifact['x-zeus-report']).find(value => value !== undefined);
  const parts = artifacts.flatMap(artifact => artifact.parts);
  const text = parts
    .filter((part): part is TextPart => part.kind === 'text')
    .map(part => part.text)
    .join('\n')
    .trim();
  const data = parts.find(part => part.kind === 'data');
  return {
    vassal: branch.vassal,
    ok: branch.ok,
    ...(branch.outcome !== undefined ? { outcome: branch.outcome } : {}),
    ...(branch.state !== undefined ? { state: branch.state } : {}),
    ...(report ? { summary: report.summary, evidence: report.evidence } : { evidence: [] }),
    ...(text ? { text } : data && data.kind === 'data' ? { text: JSON.stringify(data.data) } : {}),
    ...(branch.reason !== undefined ? { reason: branch.reason } : {}),
  };
}

function fillFromFanOut(model: DailyReportModel, result: FanOutResult): void {
  model.intentId = result.intentId;
  model.runId = result.runId;
  model.status = result.status;
  model.decision = { rule: result.decision.rule, conclusion: result.decision.conclusion, reason: result.decision.reason };
  model.positions = result.positions.map(position => ({
    vassal: position.vassal,
    stance: position.stance,
    ...(position.rationale !== undefined ? { rationale: position.rationale } : {}),
  }));
  model.branches = result.branches.map(branchView);
  if (result.refused) model.refused = { reason: result.refused.reason, detail: result.refused.detail };
}

function recordItemId(at: string, skill: string): string {
  const stamp = at.replace(/:/g, '-').replace(/\.\d{3}Z$/, 'Z');
  return `zeus-daily/${stamp}-${skill.replace(/[^A-Za-z0-9._-]/g, '-')}.md`;
}

/** Returns true when the record did not reach the realm. */
async function writeRecord(ctx: RunContext): Promise<boolean> {
  const model = ctx.report!;
  const kernel = ctx.kernel!;
  const realm = ctx.realm!;
  const store = kernel.realmStore;
  if (!store) {
    model.writeError = 'this kernel was booted without a realm store';
    return true;
  }
  const itemId = ctx.args.record ?? recordItemId(model.at, model.skill ?? 'unresolved');
  // Named before rendering so the page carries its own path (see report.ts).
  model.itemId = itemId;
  const markdown = renderDailyReport(model);
  if (!store.write) {
    model.writeError = 'the mounted realm store does not support writes in this build';
    return true;
  }
  try {
    if (realm.type === 'enterprise') {
      const signer = kernel.driverSigner;
      if (!signer) {
        model.writeError =
          'an enterprise record needs a driver grant and this process has no driver key (set ZEUS_RSK_KEY or ZEUS_RSK_KEY_FILE)';
        return true;
      }
      const grant = await issueDriverWriteGrant(
        { realmId: realm.realmId, grantedBy: 'driver:daily-cli', reason: `npm run daily: ${model.skill ?? 'unresolved'}` },
        { signer },
      );
      const written = await store.write(realm.realmId, { itemId, data: markdown }, grant);
      model.record = { itemId: written.itemId, bytes: Buffer.byteLength(markdown, 'utf8') };
      return false;
    }
    const written = await store.write(realm.realmId, { itemId, data: markdown });
    model.record = { itemId: written.itemId, bytes: Buffer.byteLength(markdown, 'utf8') };
    return false;
  } catch (error) {
    model.writeError = (error as Error).message;
    ctx.err.push(`record not stored: ${(error as Error).message}`);
    return true;
  }
}

/** The dispatching path. Returns the exit code; fills ctx.report as it goes. */
async function runOnce(ctx: RunContext): Promise<number> {
  const { args, env } = ctx;
  // One backend instance serves both consumers: recognition chooses the intent
  // with it, the orchestrator arbitrates a split with the same one.
  let backend: DecisionBackend | null = null;
  const stateFile = args.stateFile ?? env.ZEUS_STATE_FILE ?? DEFAULT_STATE_FILE;
  const roots = realmRootsFor(args, env);
  const kernelOptions: KernelBootOptions = {
    ...(stateFile ? { stateFile } : {}),
    ...(roots.length > 0 ? { realmRoots: roots } : {}),
    ...(env.ZEUS_AUDIT_FILE ? { auditFile: env.ZEUS_AUDIT_FILE } : {}),
    ...concurrencyBootOptions(resolveConcurrencyConfig(env)),
    ...(env.ZEUS_INTENT_RETENTION ? { intentRetention: parseRetentionMode(env.ZEUS_INTENT_RETENTION) } : {}),
  };
  const seeds = collectSeeds(args, env);
  if (seeds.length > 0) kernelOptions.vassalSeeds = seeds;
  const audit = resolveAuditConfig(env);
  if (audit.auditMaxBytes !== undefined) kernelOptions.auditMaxBytes = audit.auditMaxBytes;
  if (audit.auditKeep !== undefined) kernelOptions.auditKeep = audit.auditKeep;
  if (args.model) {
    const decision = resolveDecisionConfig(env);
    backend = decision.backend ?? null;
    if (backend) {
      kernelOptions.decisionBackend = backend;
      kernelOptions.judgeEnabled = decision.judgeEnabled;
    }
  }
  // The driver key is only needed to authorize an enterprise write, and loading it
  // touches the deployment's key material. A personal run loads none of it.
  if (args.realm === 'enterprise') {
    const { signer } = await loadRskSigner({ env });
    kernelOptions.driverSigner = signer;
  }

  ctx.kernel = await bootKernel(kernelOptions);

  const connections = ctx.kernel.realmStore?.connections() ?? [];
  const realm = pickRealm(connections, args.realm, args.roots);
  if (!realm) {
    ctx.err.push(
      args.realm === 'enterprise'
        ? 'no writable enterprise realm to work in: mount one with ZEUS_REALM_ENTERPRISE="<dir>::<tenant>"'
        : 'no writable directory to work in: pass --root DIR (the folder your notes live in), or set ZEUS_REALM_ROOTS',
    );
    return 2;
  }
  ctx.realm = realm;

  const catalog: SkillCatalogEntry[] = (ctx.kernel.skillRegistry?.list() ?? []).map(spec => ({
    id: spec.id,
    name: spec.name,
    description: spec.description ?? '',
  }));
  const model: DailyReportModel = {
    at: new Date().toISOString(),
    instruction: args.instruction,
    skill: null,
    chosenBy: 'rules',
    candidates: [],
    params: {},
    realm: { realmId: realm.realmId, root: realm.root, type: realm.type, readOnly: realm.readOnly },
    agents: ctx.kernel.registry.listAll().filter(entry => entry.status === 'active').map(entry => entry.card.name),
    positions: [],
    branches: [],
    escalations: [],
  };
  ctx.report = model;

  if (!args.skill && catalog.length === 0) {
    model.writeError = 'nothing was dispatched, so nothing was stored';
    ctx.err.push(
      'no execution agent is registered, so there is no capability catalogue to choose from.',
      'Register one with --agent <agent-card-url> (or ZEUS_VASSAL_SEEDS) and run again.',
    );
    return 2;
  }

  if (args.model && !backend) {
    model.note =
      '`--model` was passed but no decision backend is configured (ZEUS_DECISION_* or ZEUS_LLM_*), so this intent was chosen by the local rules only';
  }

  if (args.skill) {
    model.skill = args.skill;
    model.chosenBy = 'flag';
  } else {
    const recognition = await recognizeIntent({
      text: args.instruction,
      catalog,
      realm: args.realm,
      ...(args.model && backend ? { useModel: true, backend } : {}),
    });
    model.candidates = rankCandidates(catalog, args.instruction, 5).map(candidate => ({
      skill: candidate.skill,
      score: candidate.score,
    }));
    if (!recognition.ok) {
      model.failed = { reason: recognition.reason, ...(recognition.detail ? { detail: recognition.detail } : {}) };
      model.writeError = 'no intent was resolved, so nothing was stored';
      ctx.err.push(
        `no intent: ${recognition.reason}${recognition.detail ? ` — ${recognition.detail}` : ''}`,
        recognition.reason === 'no-candidates'
          ? `the catalogue is: ${catalog.map(entry => entry.id).join(', ') || '(empty)'}. A CJK instruction does not match an English-language` +
            ' catalogue by these rules: say the skill id in the instruction, or pass --skill.'
          : `ranked candidates: ${model.candidates.map(candidate => `${candidate.skill}(${candidate.score})`).join(', ') || '(none)'} — disambiguate with --skill.`,
      );
      return 1;
    }
    model.skill = recognition.intent.skill;
    model.confidence = recognition.confidence;
    if (recognition.backend) {
      model.chosenBy = 'model';
      model.backend = { kind: recognition.backend.kind, model: recognition.backend.model };
      if (model.candidates.length === 0) {
        model.note =
          `the local ranker found no lexical match for this wording, so the model chose among ` +
          `${Math.min(MODEL_OPTION_LIMIT, catalog.length)} of ${catalog.length} catalogue ids`;
      }
    }
  }

  model.params = { prompt: args.instruction, ...args.params };
  const result = await ctx.kernel.orchestrator.fanOut({
    skill: model.skill,
    params: model.params,
    realm: args.realm,
    realmId: realm.realmId,
    mode: 'plan',
    branchTimeoutMs: args.timeoutMs,
  });
  fillFromFanOut(model, result);
  model.escalations = ctx.kernel.oversight
    .list('pending')
    .filter(item => item.intentId === result.intentId)
    .map(item => ({ id: item.id, kind: item.kind, reason: item.reason, options: item.options }));

  // A branch delivered only when the agent itself did not report a failed task:
  // `ok` is the dispatch round trip, and an agent can answer a healthy dispatch
  // with state 'failed'. Reading `ok` alone would call that a success.
  const delivered = result.branches.filter(branch => branch.ok && branch.state !== 'failed');
  if (result.refused) {
    ctx.err.push(`dispatch refused before any request was sent: ${result.refused.reason} — ${result.refused.detail}`);
  } else if (result.branches.length === 0) {
    ctx.err.push(`no registered agent advertises skill '${model.skill}' (agents: ${model.agents.join(', ') || 'none'})`);
  } else if (delivered.length === 0) {
    ctx.err.push(
      `no agent delivered: ${result.branches
        .map(branch => `${branch.vassal}=${branch.state ? `agent state ${branch.state}` : (branch.reason ?? branch.outcome ?? 'failed')}`)
        .join(', ')}`,
    );
  }

  const writeFailed = await writeRecord(ctx);
  return writeFailed ? 1 : delivered.length > 0 ? 0 : 1;
}

export async function runDailyCli(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ code: number; stdout: string; stderr: string }> {
  let args: DailyArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    return { code: 2, stdout: '', stderr: `${(error as Error).message}\n\n${USAGE}\n` };
  }
  if (args.help) return { code: 0, stdout: `${USAGE}\n`, stderr: '' };

  const ctx: RunContext = { args, env, err: [], kernel: null, report: null, realm: null };
  let code: number;
  try {
    code = await runOnce(ctx);
  } catch (error) {
    // An unmountable root and an unfetchable card are both boot-time configuration
    // facts: nothing was dispatched, so they are exit 2, not a failed run.
    code =
      error instanceof KernelBootError || error instanceof UsageError || error instanceof RealmError ? 2 : 1;
    ctx.err.push(`error: ${(error as Error).message}`);
  }

  // A one-shot entry still owns a state file, and the reason it owns one is that
  // this run's intent — and any split it left on the desk — must outlive the
  // process. Saving happens before rendering so a failed save is in the report.
  if (ctx.kernel?.stateFile) {
    try {
      await ctx.kernel.saveState();
    } catch (error) {
      ctx.err.push(`state was not saved: ${(error as Error).message}`);
      if (code === 0) code = 1;
    }
  }

  const storedLine =
    ctx.report?.record && ctx.realm
      ? `\nstored: ${join(ctx.realm.root, ctx.report.record.itemId)} (${ctx.report.record.bytes} bytes)\n`
      : '';
  const stdout = ctx.report ? `${renderDailyReport(ctx.report)}${storedLine}` : '';
  return { code, stdout, stderr: ctx.err.length > 0 ? `${ctx.err.join('\n')}\n` : '' };
}

async function main(): Promise<void> {
  const result = await runDailyCli(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.code);
}

// Only run as a process when invoked directly (not under vitest / imports).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
