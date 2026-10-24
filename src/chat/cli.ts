#!/usr/bin/env node
/**
 * `npm run chat` — a local, multi-turn REPL over the already-assembled kernel.
 *
 * design-personal-agent-host §6 P1-3: upgrade the one-shot `daily` sentence into
 * a conversation shell. This file is assembly, not a new mechanism: the kernel
 * already recognizes an instruction (`recognizeIntent`) and fans it out to the
 * registered execution agents (`orchestrator.fanOut`). What is new here is the
 * readline loop that keeps the same booted kernel — and the realm it mounted —
 * alive across many turns, instead of booting and tearing down per sentence.
 *
 * Three boundaries are deliberate, same as `daily`:
 *   - Plan-only. Every recognized sentence goes out with `mode: 'plan'`. No
 *     execute delegation is ever minted here, and no record is written back to
 *     the realm. The shell reads and plans; the driver decides what to run.
 *   - Zero out-of-domain by default. Recognition is the local rule ranker unless
 *     the operator passes `--model` (which attaches the configured decision
 *     backend for that whole session). Without it nothing leaves the machine.
 *   - The kernel owns no timer and this shell owns none either: it is a
 *     foreground process the operator starts, not a daemon.
 *
 * Slash commands: `/exit` or `/quit` close the loop (exit 0); `/help` prints
 * this page; a blank line is ignored. Anything else is one operator sentence.
 *
 * Exit codes: 0 the loop ended cleanly (after /exit, EOF, or a broken pipe we
 * reported) · 2 boot/usage error (nothing was recognized, the kernel did not
 * start, or no writable realm was mounted).
 */
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import type { DecisionBackend } from '../decision/types.js';
import {
  bootKernel,
  concurrencyBootOptions,
  costBootOptions,
  KernelBootError,
  resolveAuditConfig,
  resolveConcurrencyConfig,
  resolveCostConfig,
  resolveDecisionConfig,
  resolveRealmConfig,
  resolveVassalSeedsConfig,
  type KernelBoot,
  type KernelBootOptions,
} from '../state/boot.js';
import { parseRetentionMode } from '../state/archive.js';
import { recognizeIntent, rankCandidates, type SkillCatalogEntry } from '../intent/recognize.js';
import { RealmError, type RealmConnection } from '../realm/types.js';
import type { BranchOutcome, FanOutResult } from '../core/orchestrator/types.js';
import { registerSkillSpecs, skillCatalogEntry } from '../daily/cli.js';

/** Exported so the exit-code contract and the tests key on the identity. */
export class UsageError extends Error {}

const VALUE_FLAGS = new Set(['--root', '--agent', '--state', '--timeout', '--spec']);

const USAGE = `usage: npm run chat [options]

A local multi-turn planning shell. It boots the kernel once, then reads one
operator sentence per line, recognizes which registered skill it means, and
prints a plan (never an execution). The same kernel and realm stay mounted
across turns.

Options:
  --root DIR            directory to work in, mounted read-write (repeatable;
                        ZEUS_REALM_ROOTS entries are mounted alongside)
  --agent CARD[|TOKEN]  register an execution agent before the loop starts
                        (repeatable; merged with ZEUS_VASSAL_SEEDS)
  --spec FILE           register an explicit skill spec before the loop starts
                        (repeatable; JSON object or array). This is how an
                        operator declares aliases on this path.
  --state FILE          kernel state file (default: in-memory, ZEUS_STATE_FILE
                        overrides, 'none' keeps state in memory)
  --model               let recognition consult the configured decision backend.
                        Without it nothing leaves the machine.
  --timeout MS          per-branch timeout for the plan fan-out (default 60000)
  --help                this page

Inside the loop:
  <sentence>            recognize + fan out in plan mode, print the plan
  /exit | /quit         leave the shell (exit 0)
  /help                 print this page
  (blank)               ignored`;

type ChatArgs = {
  roots: string[];
  agents: string[];
  /** Explicit skill specs registered before the loop starts (E2.7 alias route). */
  specs: string[];
  /** undefined = operator said nothing; null = they passed `--state none`. */
  stateFile?: string | null;
  model: boolean;
  timeoutMs: number;
  help: boolean;
};

export type ChatCliIO = {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  env: NodeJS.ProcessEnv;
  /**
   * Fired once the kernel is booted and the readline loop is attached and
   * listening. Tests use it to feed a burst of lines only after the interface is
   * ready (mimicking a real pipe), instead of writing before boot and relying on
   * stream buffering. Optional; production passes nothing.
   */
  onReady?: () => void;
};

export type ChatCliResult = { code: number; stdout: string; stderr: string };

const PROMPT = 'zeus chat › ';

function parseArgs(argv: string[]): ChatArgs {
  const args: ChatArgs = { roots: [], agents: [], specs: [], model: false, timeoutMs: 60_000, help: false };
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
        case '--spec':
          args.specs.push(value);
          break;
        case '--state':
          args.stateFile = value === 'none' ? null : value;
          break;
        case '--timeout':
          args.timeoutMs = Number(value);
          if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
            throw new UsageError(`--timeout must be a positive number of ms, got '${value}'`);
          }
          break;
      }
      continue;
    }
    throw new UsageError(`unexpected argument: ${arg} (the shell reads sentences line by line, not on the command line)`);
  }
  return args;
}

/** Where kernel state lives. Default in-memory; ZEUS_STATE_FILE is the only env override. */
function resolveStateFile(explicit: string | null | undefined, fromEnv: string | undefined): string | null {
  if (explicit !== undefined) return explicit;
  if (fromEnv === undefined || fromEnv === '') return null;
  return fromEnv === 'none' ? null : fromEnv;
}

function collectSeeds(args: ChatArgs, env: NodeJS.ProcessEnv): NonNullable<KernelBootOptions['vassalSeeds']> {
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
    const url = typeof seed === 'string' ? seed : seed.cardUrl;
    if (!seeds.some(existing => (typeof existing === 'string' ? existing : existing.cardUrl) === url)) seeds.push(seed);
  }
  return seeds;
}

function realmRootsFor(args: ChatArgs, env: NodeJS.ProcessEnv): NonNullable<KernelBootOptions['realmRoots']> {
  const configured = resolveRealmConfig(env).realmRoots;
  const personal = configured.filter((entry): entry is string => typeof entry === 'string');
  const enterprise = configured.filter(entry => typeof entry !== 'string');
  return [...new Set([...args.roots, ...personal]), ...enterprise];
}

function pickWritablePersonal(connections: RealmConnection[]): RealmConnection | undefined {
  return connections.find(connection => connection.type === 'personal' && !connection.readOnly);
}

function branchLine(branch: BranchOutcome): string {
  const vassal = branch.vassal;
  const state = branch.state ?? branch.outcome ?? branch.reason ?? 'no-state';
  const report = branch.task?.artifacts
    .flatMap(artifact => artifact.parts)
    .filter((part): part is Extract<typeof part, { kind: 'text' }> => part.kind === 'text')
    .map(part => part.text)
    .join(' ')
    .trim();
  const summary = report ? ` — ${report.slice(0, 120)}` : '';
  return `    ${vassal}: ${state}${summary}`;
}

/** Renders one completed plan turn. Pure over the fan-out result. */
function renderPlan(opts: {
  skill: string;
  confidence: number;
  candidates: { skill: string; score: number }[];
  result: FanOutResult;
}): string {
  const { skill, confidence, candidates, result } = opts;
  const lines: string[] = [];
  lines.push(`  skill: ${skill} (confidence ${confidence.toFixed(2)})`);
  lines.push(`  mode:  plan — nothing executed, nothing written back`);
  lines.push(`  decision: ${result.decision.rule} → ${result.decision.conclusion}`);
  if (candidates.length > 0) {
    lines.push(
      `  candidates: ${candidates.map(candidate => `${candidate.skill}(${candidate.score.toFixed(2)})`).join(', ')}`,
    );
  }
  if (result.branches.length === 0) {
    lines.push(`  branches: (no registered agent advertises '${skill}')`);
  } else {
    lines.push(`  branches (${result.branches.length}):`);
    for (const branch of result.branches) lines.push(branchLine(branch));
  }
  if (result.refused) lines.push(`  refused: ${result.refused.reason} — ${result.refused.detail}`);
  return lines.join('\n');
}

export async function runChatCli(argv: string[], io: ChatCliIO): Promise<ChatCliResult> {
  const { stdin, stdout, stderr, env } = io;
  const out: string[] = [];
  const err: string[] = [];
  const writeOut = (chunk: string) => {
    out.push(chunk);
    stdout.write(chunk);
  };
  const writeErr = (chunk: string) => {
    err.push(chunk);
    stderr.write(chunk);
  };

  let args: ChatArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    writeErr(`${(error as Error).message}\n\n${USAGE}\n`);
    return { code: 2, stdout: '', stderr: err.join('') };
  }
  if (args.help) {
    writeOut(`${USAGE}\n`);
    return { code: 0, stdout: out.join(''), stderr: '' };
  }

  let kernel: KernelBoot;
  let realm: RealmConnection;
  let backend: DecisionBackend | null = null;
  try {
    const stateFile = resolveStateFile(args.stateFile, env.ZEUS_STATE_FILE);
    const roots = realmRootsFor(args, env);
    const kernelOptions: KernelBootOptions = {
      ...(stateFile ? { stateFile } : {}),
      ...(roots.length > 0 ? { realmRoots: roots } : {}),
      ...(env.ZEUS_AUDIT_FILE ? { auditFile: env.ZEUS_AUDIT_FILE } : {}),
      ...concurrencyBootOptions(resolveConcurrencyConfig(env)),
      ...costBootOptions(resolveCostConfig(env)),
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
    kernel = await bootKernel(kernelOptions);
    // Registered before the loop starts: a rejected spec is a configuration fact.
    registerSkillSpecs(kernel.skillRegistry, args.specs);
    const connections = kernel.realmStore?.connections() ?? [];
    const picked = pickWritablePersonal(connections);
    if (!picked) {
      writeErr(
        'no writable personal realm to work in: pass --root DIR (the folder your notes live in), or set ZEUS_REALM_ROOTS.\n',
      );
      try {
        await kernel.releaseLock();
      } catch {
        // The lock was ours; a release failure here is not the operator's error.
      }
      return { code: 2, stdout: '', stderr: err.join('') };
    }
    realm = picked;
  } catch (error) {
    const code = error instanceof KernelBootError || error instanceof UsageError || error instanceof RealmError ? 2 : 1;
    writeErr(`error: ${(error as Error).message}\n`);
    return { code, stdout: '', stderr: err.join('') };
  }

  const agents = kernel.registry.listAll().filter(entry => entry.status === 'active').map(entry => entry.card.name);
  writeOut(
    `Zeus chat (plan-only, local${args.model ? ' + model backend' : ''}). ` +
      `Realm: ${realm.root} · agents: ${agents.join(', ') || 'none'}\n` +
      `Type a sentence to plan, /help for commands, /exit to quit.\n`,
  );

  const rl = readline.createInterface({ input: stdin, terminal: false });

  const prompt = () => writeOut(PROMPT);

  const finish = async (code: number): Promise<ChatCliResult> => {
    try {
      rl.close();
    } catch {
      // Already closed; teardown below still runs.
    }
    if (kernel.stateFile) {
      try {
        await kernel.saveState();
      } catch (error) {
        writeErr(`state was not saved: ${(error as Error).message}\n`);
      }
    }
    try {
      await kernel.releaseLock();
    } catch (error) {
      writeErr(`state lock was not released: ${(error as Error).message}\n`);
    }
    return { code, stdout: out.join(''), stderr: err.join('') };
  };

  /**
   * Process one raw line. Returns true when the line asked to exit.
   *
   * Deliberately plan-only: a recognized sentence fans out with `mode: 'plan'`
   * and nothing is written back to the realm. A blank line is ignored.
   */
  const processLine = async (raw: string): Promise<boolean> => {
    const line = raw.trim();
    if (line === '') return false; // blank line: ignore, reprompt
    if (line === '/exit' || line === '/quit') {
      writeOut('bye.\n');
      return true;
    }
    if (line === '/help') {
      writeOut(`${USAGE}\n`);
      return false;
    }

    const catalog: SkillCatalogEntry[] = (kernel.skillRegistry?.list() ?? []).map(skillCatalogEntry);
    if (catalog.length === 0) {
      writeErr('no execution agent is registered, so there is no capability catalogue to choose from.\n');
      return false;
    }
    const recognition = await recognizeIntent({
      text: line,
      catalog,
      realm: 'personal',
      ...(args.model && backend ? { useModel: true, backend } : {}),
    });
    if (!recognition.ok) {
      const candidates = rankCandidates(catalog, line, 5).map(candidate => ({ skill: candidate.skill, score: candidate.score }));
      writeOut(
        `  no intent: ${recognition.reason}${recognition.detail ? ` — ${recognition.detail}` : ''}\n` +
          `  ranked candidates: ${candidates.map(c => `${c.skill}(${c.score.toFixed(2)})`).join(', ') || '(none)'}\n`,
      );
      return false;
    }
    const result = await kernel.orchestrator.fanOut({
      skill: recognition.intent.skill,
      params: { prompt: line },
      realm: 'personal',
      realmId: realm.realmId,
      mode: 'plan',
      branchTimeoutMs: args.timeoutMs,
    });
    writeOut(
      `${renderPlan({
        skill: recognition.intent.skill,
        confidence: recognition.confidence,
        candidates: rankCandidates(catalog, line, 5),
        result,
      })}\n`,
    );
    return false;
  };

  // Explicit FIFO serialization. readline fires one 'line' per newline, but when
  // a whole script arrives in a single piped chunk those events are already queued
  // in the stream — rl.pause() cannot hold them back, so multiple line handlers
  // would interleave and a synchronous /exit (which closes the interface) could
  // tear the process down before an earlier turn's await recognize/fanOut prints
  // its plan. We instead buffer raw lines here and drain them strictly one at a
  // time: /exit only ends the loop after every queued turn has fully rendered,
  // and EOF only settles once the queue is drained.
  const queue: string[] = [];
  let draining = false;
  let exitRequested = false;
  let eof = false;

  return await new Promise<ChatCliResult>(resolve => {
    let settled = false;
    const settle = async (code: number) => {
      if (settled) return;
      settled = true;
      writeOut('\n');
      resolve(await finish(code));
    };

    const pump = async () => {
      if (draining) return;
      draining = true;
      try {
        while (queue.length > 0) {
          const raw = queue.shift()!;
          let wantsExit = false;
          try {
            wantsExit = await processLine(raw);
          } catch (error) {
            writeErr(`turn failed: ${(error as Error).message}\n`);
          }
          if (wantsExit) {
            exitRequested = true;
            break;
          }
          prompt();
        }
      } finally {
        draining = false;
      }
      // Settle only once the queue is drained AND the run is actually over
      // (operator asked to exit, or stdin reached EOF). Otherwise keep waiting
      // for more lines — pump will be re-entered by the next 'line' or 'close'.
      if ((eof || exitRequested) && !settled) void settle(0);
    };

    rl.on('line', raw => {
      queue.push(raw);
      void pump();
    });
    rl.on('close', () => {
      eof = true;
      void pump();
    });
    prompt();
    io.onReady?.();
  });
}

async function main(): Promise<void> {
  // runChatCli already streams to the provided stdio (the REPL needs a live
  // output); the returned strings are for tests. Do not double-write here.
  const result = await runChatCli(process.argv.slice(2), {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
  });
  process.exit(result.code);
}

// Only run as a process when invoked directly (not under vitest / imports).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
