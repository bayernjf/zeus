import { createServer } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runDailyCli } from '../src/daily/cli.js';
import { renderDailyReport, type DailyReportModel } from '../src/daily/report.js';

/**
 * The product entry (`npm run daily`) is assembly: recognize → fan out → write
 * back into the user's directory. Its defects are not in any one primitive, they
 * are in the wiring, so the cases below drive the real thing — a kernel booted by
 * the CLI itself, an execution agent behind a real socket, and a real directory
 * the record must land in.
 *
 * What this does NOT cover is a real third-party agent's semantics; the agent here
 * answers with the A2A shapes the repo already pins elsewhere. The peer contract is
 * exercised against a live deployment by `npm run acceptance:fanout`.
 */

// ---------------------------------------------------------------------------
// Pure rendering
// ---------------------------------------------------------------------------

function baseModel(overrides: Partial<DailyReportModel> = {}): DailyReportModel {
  return {
    at: '2026-10-08T09:00:00.000Z',
    instruction: 'is the deployment healthy',
    skill: 'deployment-health',
    chosenBy: 'rules',
    confidence: 0.5,
    candidates: [],
    params: { prompt: 'is the deployment healthy' },
    realm: { realmId: 'realm-abc', root: '/notes', type: 'personal', readOnly: false },
    agents: ['demo-a'],
    positions: [],
    branches: [],
    escalations: [],
    ...overrides,
  };
}

describe('daily report rendering', () => {
  it('shows the intent, the realm, the decision and the evidence', () => {
    const text = renderDailyReport(
      baseModel({
        status: 'completed',
        decision: { rule: 'majority', conclusion: 'healthy', reason: 'majority: "healthy" 1/1' },
        positions: [{ vassal: 'demo-a', stance: 'healthy', rationale: 'no failed checks' }],
        branches: [
          {
            vassal: 'demo-a',
            ok: true,
            outcome: 'completed',
            state: 'completed',
            summary: 'all checks green',
            evidence: ['GET /healthz -> 200'],
            text: 'deployment health: 12 checks, 0 failed',
          },
        ],
        record: { itemId: 'zeus-daily/2026-10-08T09-00-00Z-deployment-health.md', bytes: 1234 },
        itemId: 'zeus-daily/2026-10-08T09-00-00Z-deployment-health.md',
      }),
    );
    expect(text).toContain('**Intent** `deployment-health` — chosen by local rules, confidence 0.500');
    expect(text).toContain('`realm-abc` (personal, writable) — /notes');
    expect(text).toContain('rule `majority` → **healthy**');
    expect(text).toContain('- `demo-a` = `healthy` — no failed checks');
    expect(text).toContain('evidence: GET /healthz -> 200');
    expect(text).toContain('Record path: `zeus-daily/2026-10-08T09-00-00Z-deployment-health.md`');
  });

  it('keeps a dispatch that succeeded apart from work that failed', () => {
    // The kernel counts a round trip that returned state 'failed' as a completed
    // branch, so a reader who saw only "ok" would call a failed run a success.
    const text = renderDailyReport(
      baseModel({
        status: 'completed',
        decision: { rule: 'majority', conclusion: null, reason: 'no vassal returned a stance; nothing to aggregate' },
        branches: [{ vassal: 'demo-a', ok: true, outcome: 'completed', state: 'failed', evidence: [] }],
      }),
    );
    expect(text).toContain('dispatch ok · agent state `failed` · counted `completed`');
    expect(text).toContain('intent status `completed` (every branch settled');
  });

  it('drops the redundant metric category when the agent agreed with it', () => {
    const text = renderDailyReport(
      baseModel({
        status: 'completed',
        decision: { rule: 'majority', conclusion: 'healthy', reason: 'unanimous' },
        branches: [{ vassal: 'demo-a', ok: true, outcome: 'completed', state: 'completed', evidence: [] }],
      }),
    );
    expect(text).toContain('dispatch ok · agent state `completed`');
    expect(text).not.toContain('counted');
  });

  it('names the ranked candidates when nothing could be chosen', () => {
    const text = renderDailyReport(
      baseModel({
        skill: null,
        chosenBy: 'rules',
        candidates: [{ skill: 'research', score: 4 }],
        failed: { reason: 'ambiguous', detail: 'tied candidates: research, review' },
        writeError: 'no intent was resolved, so nothing was stored',
      }),
    );
    expect(text).toContain('**Intent** none — `ambiguous`: tied candidates');
    expect(text).toContain('ranked candidates: `research` (4)');
    expect(text).toContain('NOT stored: no intent was resolved');
  });

  it('lists a governance refusal and anything left on the desk', () => {
    const text = renderDailyReport(
      baseModel({
        status: 'failed',
        decision: { rule: 'majority', conclusion: null, reason: 'nothing to aggregate' },
        refused: { reason: 'no-active-provider', detail: 'the skill is uninstalled' },
        escalations: [{ id: 'esc-1', kind: 'intent-conflict', reason: 'tie at 1/2', options: ['healthy', 'degraded'] }],
      }),
    );
    expect(text).toContain('## Refused before dispatch');
    expect(text).toContain('`no-active-provider` — the skill is uninstalled');
    expect(text).toContain('`esc-1` (intent-conflict): tie at 1/2 — options: healthy · degraded');
    expect(text).toContain('npm run tui');
  });
});

// ---------------------------------------------------------------------------
// The entry itself
// ---------------------------------------------------------------------------

const { privateKey } = generateKeyPairSync('ed25519');
const DRIVER_KEY_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const FEALTY = {
  version: '1',
  swornTo: 'zeus',
  domain: 'test-domain',
  dataRealms: ['personal', 'enterprise'],
  dataPolicy: 'read-task-scope',
  reportBack: true,
  escalationPolicy: 'on-failure',
} as const;

function cardFor(name: string, port: number) {
  return {
    name,
    url: `http://127.0.0.1:${port}/${name}/api/a2a/agent-card`,
    version: '0.1.0',
    capabilities: { streaming: true },
    skills: [
      { id: 'deployment-health', name: 'Deployment Health', description: 'check a deployment for health', tags: [] },
      { id: 'research', name: 'Deep Research', description: 'multi-source research', tags: [] },
    ],
    'x-zeus-fealty': FEALTY,
  };
}

let agentPort = 0;
let closeAgent: () => void = () => {};
const tempDirs: string[] = [];

function tempRoot(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `zeus-daily-${label}-`));
  tempDirs.push(dir);
  return dir;
}

beforeAll(async () => {
  const server = createServer((req, res) => {
    const match = req.url?.match(/^\/([a-z-]+)\/api\/a2a\/agent-card$/);
    if (match && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(cardFor(match[1]!, agentPort)));
      return;
    }
    let raw = '';
    req.on('data', chunk => (raw += chunk));
    req.on('end', () => {
      const rpc = JSON.parse(raw || '{}') as { id?: unknown; method?: string };
      if (req.url === '/v1/chat/completions') {
        // A loopback OpenAI-compatible endpoint, so the --model path is exercised
        // through the real backend (fetch, JSON parsing, choice extraction) without
        // anything leaving this machine.
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            choices: [{ message: { content: '{"choice":"deployment-health","confidence":0.9}' } }],
            usage: { prompt_tokens: 40, completion_tokens: 12 },
          }),
        );
        return;
      }
      const failing = req.url?.startsWith('/failing-agent/');
      const task = {
        kind: 'task',
        id: 'task-1',
        contextId: 'ctx-1',
        status: { state: failing ? 'failed' : 'completed' },
        artifacts: failing
          ? []
          : [
              {
                artifactId: 'a-1',
                name: 'health-report',
                parts: [
                  { kind: 'text', text: 'deployment health: 12 checks, 0 failed' },
                  { kind: 'data', data: { stance: 'healthy', rationale: 'no failed checks' } },
                ],
                'x-zeus-report': {
                  summary: 'deployment-health-plan: all checks green',
                  evidence: ['GET /healthz -> 200'],
                  cost: { llmTokens: 0, wallSeconds: 1 },
                  followUps: [],
                },
              },
            ],
      };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        `data: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { kind: 'status-update', taskId: 'task-1', contextId: 'ctx-1', status: { state: 'working' }, final: false } })}\n\n`,
      );
      res.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: task })}\n\n`);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('agent server did not bind a port');
  agentPort = address.port;
  closeAgent = () => server.close();
});

afterAll(() => {
  closeAgent();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function agentUrl(name: string): string {
  return `http://127.0.0.1:${agentPort}/${name}/api/a2a/agent-card`;
}

/** Nothing from the developer's own shell reaches the run under test. */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...extra } as NodeJS.ProcessEnv;
}

describe('npm run daily', () => {
  it('prints the usage page and exits 0 on --help', async () => {
    const result = await runDailyCli(['--help'], cleanEnv());
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('usage: npm run daily');
    expect(result.stdout).toContain('--agent CARD[|TOKEN]');
    expect(result.stderr).toBe('');
  });

  it.each([
    { argv: [], reason: 'an instruction is required' },
    { argv: ['one', 'two'], reason: 'expected one instruction' },
    { argv: ['--bogus', 'x', 'hello'], reason: 'unknown option: --bogus' },
    { argv: ['hello', '--realm', 'both'], reason: "--realm is 'personal' or 'enterprise'" },
    { argv: ['hello', '--params', '[1]'], reason: '--params is not a JSON object' },
    { argv: ['hello', '--timeout', '0'], reason: '--timeout must be a positive number' },
  ])('rejects "$reason" before booting anything', async ({ argv, reason }) => {
    const result = await runDailyCli(argv, cleanEnv());
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(reason);
    expect(result.stdout).toBe('');
  });

  it('runs one sentence end to end and stores the same page it printed', async () => {
    const root = tempRoot('run');
    const result = await runDailyCli(
      ['--root', root, '--agent', agentUrl('demo-agent'), '--state', join(root, 'state.json'), '--record', 'zeus-daily/record.md', 'check the deployment health'],
      cleanEnv(),
    );
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('**Intent** `deployment-health` — chosen by local rules');
    expect(result.stdout).toContain('rule `majority` → **healthy**');
    expect(result.stdout).toContain('- `demo-agent` = `healthy` — no failed checks');
    expect(result.stdout).toContain('dispatch ok · agent state `completed`');

    const stored = readFileSync(join(root, 'zeus-daily', 'record.md'), 'utf8');
    // What the operator read is what sits in their directory, not a second rendering.
    expect(stored).toBe(result.stdout.slice(0, result.stdout.indexOf('\nstored: ')));

    const intentId = result.stdout.match(/`intent-[0-9a-f-]+`/)?.[0].replace(/`/g, '');
    expect(intentId).toBeTruthy();
    const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')) as { orchestrator: { intents: Array<{ intentId: string }> } };
    expect(state.orchestrator.intents.map(intent => intent.intentId)).toContain(intentId);
  });

  it('exits 1 when the agent reports a failed task, and still keeps the evidence', async () => {
    const root = tempRoot('failed');
    const result = await runDailyCli(
      ['--root', root, '--agent', agentUrl('failing-agent'), '--state', join(root, 'state.json'), '--record', 'failed.md', 'check the deployment health'],
      cleanEnv(),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('no agent delivered: failing-agent=agent state failed');
    expect(result.stdout).toContain('agent state `failed` · counted `completed`');
    expect(readFileSync(join(root, 'failed.md'), 'utf8')).toContain('agent state `failed`');
  });

  it('exits 1 and writes nothing when the sentence matches no capability', async () => {
    const root = tempRoot('no-intent');
    const result = await runDailyCli(
      ['--root', root, '--agent', agentUrl('demo-agent'), '--state', join(root, 'state.json'), '整理今天的部署状态'],
      cleanEnv(),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('no intent: no-candidates');
    // The ranker matches ASCII words and CJK runs against an English catalogue, so
    // this is the everyday first-run failure and it must say what to do.
    expect(result.stderr).toContain('the catalogue is: deployment-health, research');
    expect(readdirSync(root)).toEqual(['state.json']);
  });

  it('exits 2 with no realm and no catalogue rather than inventing a work surface', async () => {
    const root = tempRoot('no-realm');
    const noRealm = await runDailyCli(['--state', join(root, 'a.json'), 'check the deployment health'], cleanEnv());
    expect(noRealm.code).toBe(2);
    expect(noRealm.stderr).toContain('no writable directory to work in');

    const noAgent = await runDailyCli(
      ['--root', root, '--state', join(root, 'b.json'), 'check the deployment health'],
      cleanEnv(),
    );
    expect(noAgent.code).toBe(2);
    expect(noAgent.stderr).toContain('no execution agent is registered');

    const missing = await runDailyCli(
      ['--root', join(root, 'does-not-exist'), '--state', join(root, 'c.json'), '--agent', agentUrl('demo-agent'), 'check the deployment health'],
      cleanEnv(),
    );
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain('realm root not accessible');
    // The failed boot never got as far as owning a ledger.
    expect(readdirSync(root).sort()).toEqual(['a.json', 'b.json']);
  });

  it('refuses to dispatch a skill no agent advertises, and says so in the record', async () => {
    const root = tempRoot('no-provider');
    const result = await runDailyCli(
      ['--root', root, '--agent', agentUrl('demo-agent'), '--state', join(root, 'state.json'), '--record', 'missing.md', '--skill', 'unheard-of', 'do the thing nobody offers'],
      cleanEnv(),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("no registered agent advertises skill 'unheard-of'");
    expect(readFileSync(join(root, 'missing.md'), 'utf8')).toContain('**Agents** `demo-agent`');
  });

  it('writes an enterprise run into the enterprise realm, never into the personal directory', async () => {
    const personal = tempRoot('iso-personal');
    const enterprise = tempRoot('iso-enterprise');
    const result = await runDailyCli(
      ['--root', personal, '--agent', agentUrl('demo-agent'), '--state', join(personal, 'state.json'), '--realm', 'enterprise', '--record', 'run.md', 'check the deployment health'],
      cleanEnv({
        ZEUS_REALM_ENTERPRISE: `${enterprise}::acme`,
        ZEUS_RSK_KEY: DRIVER_KEY_PEM,
        ZEUS_RSK_KEY_ID: 'zeus-rsk-test',
      }),
    );
    expect(result.code, result.stderr).toBe(0);
    expect(readFileSync(join(enterprise, 'run.md'), 'utf8')).toContain('**Intent** `deployment-health`');
    // Constraint 4: a result derived in the enterprise domain does not get copied
    // into the user's personal directory by a command that mounted both.
    expect(readdirSync(personal)).toEqual(['state.json']);
  });

  it('says so when --model is asked for but no backend is configured', async () => {
    const root = tempRoot('model');
    const result = await runDailyCli(
      ['--root', root, '--agent', agentUrl('demo-agent'), '--state', join(root, 'state.json'), '--model', 'check the deployment health'],
      cleanEnv(),
    );
    // The instruction is still resolved by the local ranker, so the run completes -
    // but the report must not let a model look like it chose anything.
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('chosen by local rules');
    expect(result.stdout).toContain('**Note** `--model` was passed but no decision backend is configured');
  });

  it('resolves a CJK instruction once a backend is reachable, and says the model chose it', async () => {
    const root = tempRoot('model-cjk');
    const result = await runDailyCli(
      ['--root', root, '--agent', agentUrl('demo-agent'), '--state', join(root, 'state.json'), '--model', '--record', 'cjk.md', '整理今天的部署状态'],
      cleanEnv({
        ZEUS_LLM_BASE_URL: `http://127.0.0.1:${agentPort}/v1`,
        ZEUS_LLM_API_KEY: 'loopback-key',
        ZEUS_LLM_MODEL: 'fake-chat',
      }),
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('**Intent** `deployment-health` — chosen by llm / fake-chat, confidence 0.900');
    expect(result.stdout).toContain('the local ranker found no lexical match');
    expect(readFileSync(join(root, 'cjk.md'), 'utf8')).toContain('**Intent** `deployment-health`');
  });
});
