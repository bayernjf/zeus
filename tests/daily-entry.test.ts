import { createServer } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runDailyCli, recordItemId, skillCatalogEntry, resolveStateFile } from '../src/daily/cli.js';
import { renderDailyReport, parsePreviousRecord, type DailyReportModel } from '../src/daily/report.js';
import { parseCommand } from '../src/tui/commands.js';

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

describe('recordItemId', () => {
  const AT = '2026-10-08T09:00:00.000Z';

  it('gives two runs inside the same second different records', () => {
    const a = recordItemId(AT, 'research', 'intent-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    const b = recordItemId(AT, 'research', 'intent-11111111-2222-3333-4444-555555555555');
    // The stamp alone is second-resolution: without the intent suffix the two
    // runs erase each other, and the read-back loop loses a page silently.
    expect(a).not.toBe(b);
    expect(a).toMatch(/^zeus-daily\/2026-10-08T09-00-00Z-research-[A-Za-z0-9._-]{1,8}\.md$/);
  });

  it('keeps the zeus-daily prefix and the skill segment the read-back anchors on', () => {
    const id = recordItemId(AT, 'deployment-health', 'intent-abcdef01-2345-6789-abcd-ef0123456789');
    expect(id.startsWith('zeus-daily/')).toBe(true);
    expect(id).toContain('deployment-health');
  });

  it('keeps the old shape when no intent id exists', () => {
    expect(recordItemId(AT, 'unresolved')).toBe('zeus-daily/2026-10-08T09-00-00Z-unresolved.md');
  });

  it('never lets an intent id reach outside the zeus-daily directory', () => {
    const hostile = recordItemId(AT, 'research', 'intent-../../etc/passwd');
    expect(hostile.startsWith('zeus-daily/')).toBe(true);
    expect(hostile).not.toContain('..');
    expect(hostile.split('/')).toHaveLength(2);
  });
});

describe('resolveStateFile (--state none really means none)', () => {
  it('applies the default only when the operator said nothing', () => {
    expect(resolveStateFile(undefined, undefined)).toBe('./data/daily-state.json');
    expect(resolveStateFile(undefined, '/tmp/kernel.json')).toBe('/tmp/kernel.json');
  });

  it('honours an explicit none instead of silently writing the default file', () => {
    // `null ?? env ?? DEFAULT` collapses "said nothing" with "said none", which
    // made the run persist to the repo's own state file and then re-mount a realm
    // root from a temp directory that no longer exists.
    expect(resolveStateFile(null, undefined)).toBeNull();
    expect(resolveStateFile(null, '/tmp/kernel.json')).toBeNull();
    expect(resolveStateFile(undefined, 'none')).toBeNull();
  });

  it('keeps a named state file wins over the environment', () => {
    expect(resolveStateFile('/tmp/mine.json', '/tmp/kernel.json')).toBe('/tmp/mine.json');
  });
});

describe('skillCatalogEntry (E2.7 wiring)', () => {
  it('carries the declared aliases into the recognition catalogue', () => {
    expect(
      skillCatalogEntry({ id: 'research', name: 'Deep Research', description: 'restates notes', aliases: ['归纳要点'] }),
    ).toEqual({ id: 'research', name: 'Deep Research', description: 'restates notes', aliases: ['归纳要点'] });
  });

  it('adds no aliases field when none were declared', () => {
    expect(skillCatalogEntry({ id: 'research', name: 'Deep Research' })).toEqual({
      id: 'research',
      name: 'Deep Research',
      description: '',
    });
  });
});

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

  it('shows the previous record for the same skill when one exists', () => {
    const text = renderDailyReport(
      baseModel({
        previous: {
          itemId: 'zeus-daily/2026-10-07T09-00-00Z-deployment-health.md',
          at: '2026-10-07T09:00:00.000Z',
          intentId: 'intent-prev-1',
          conclusion: 'healthy',
        },
      }),
    );
    expect(text).toContain(
      '- **Previous** `zeus-daily/2026-10-07T09-00-00Z-deployment-health.md` · 2026-10-07T09:00:00.000Z · intent `intent-prev-1` · concluded **healthy**',
    );
    expect(text.indexOf('- **Previous**')).toBeLessThan(text.indexOf('- **Params**'));
  });

  it('omits the previous line when there is no stored page to cite', () => {
    const text = renderDailyReport(baseModel());
    expect(text).not.toContain('Previous');
  });
});

describe('daily previous-record parsing', () => {
  it('reads back a page the module itself rendered', () => {
    const stored = renderDailyReport(
      baseModel({
        status: 'completed',
        decision: { rule: 'majority', conclusion: 'healthy', reason: 'majority: "healthy" 1/1' },
        intentId: 'intent-abc',
        runId: 'run-1',
      }),
    );
    const parsed = parsePreviousRecord(stored, 'zeus-daily/2026-10-08T09-00-00Z-deployment-health.md');
    expect(parsed).toEqual({
      itemId: 'zeus-daily/2026-10-08T09-00-00Z-deployment-health.md',
      at: '2026-10-08T09:00:00.000Z',
      intentId: 'intent-abc',
      conclusion: 'healthy',
    });
  });

  it('is tolerant of pages without an intent id or an aggregated conclusion', () => {
    const stored = renderDailyReport(
      baseModel({
        status: 'completed',
        decision: { rule: 'majority', conclusion: null, reason: 'no vassal returned a stance' },
      }),
    );
    const parsed = parsePreviousRecord(stored, 'zeus-daily/2026-10-08T09-00-00Z-deployment-health.md');
    expect(parsed).toEqual({
      itemId: 'zeus-daily/2026-10-08T09-00-00Z-deployment-health.md',
      at: '2026-10-08T09:00:00.000Z',
    });
  });

  it('rejects text that is not a daily page', () => {
    expect(parsePreviousRecord('just some notes\nnot a zeus page', 'notes.md')).toBeUndefined();
    expect(parsePreviousRecord('', 'zeus-daily/x.md')).toBeUndefined();
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

  it('closes the read loop: a second run cites the first run\'s page for the same skill', async () => {
    const root = tempRoot('loop');
    const first = await runDailyCli(
      ['--root', root, '--agent', agentUrl('demo-agent'), '--state', join(root, 'state.json'), '--record', 'zeus-daily/first.md', 'check the deployment health'],
      cleanEnv(),
    );
    expect(first.code, first.stderr).toBe(0);
    const intentId = first.stdout.match(/`intent-[0-9a-f-]+`/)?.[0].replace(/`/g, '');
    expect(intentId).toBeTruthy();
    // The first run has no stored page to cite yet, so its report carries no line.
    expect(first.stdout).not.toContain('**Previous**');

    const second = await runDailyCli(
      ['--root', root, '--agent', agentUrl('demo-agent'), '--state', join(root, 'state.json'), '--record', 'zeus-daily/second.md', 'check the deployment health'],
      cleanEnv(),
    );
    expect(second.code, second.stderr).toBe(0);
    // The look-back is a read-only fact: it reaches the page and the stored file,
    // and nowhere else. The dispatch load is untouched, so the intent id the page
    // cites is the previous run's, never this one's.
    expect(second.stdout).toContain('- **Previous** `zeus-daily/first.md`');
    expect(second.stdout).toContain(`intent \`${intentId}\``);
    expect(second.stdout).toContain('concluded **healthy**');
    expect(readFileSync(join(root, 'zeus-daily', 'second.md'), 'utf8')).toContain(
      `intent \`${intentId}\` · concluded **healthy**`,
    );
  });

  it('keeps every page when two runs name their own record', async () => {
    const root = tempRoot('no-clobber');
    const argv = ['--root', root, '--agent', agentUrl('demo-agent'), '--state', join(root, 'state.json'), 'check the deployment health'];
    const first = await runDailyCli(argv, cleanEnv());
    expect(first.code, first.stderr).toBe(0);
    const second = await runDailyCli(argv, cleanEnv());
    expect(second.code, second.stderr).toBe(0);

    const pages = readdirSync(join(root, 'zeus-daily'));
    // Neither run passed --record, so both names come from the stamp + the intent
    // id. Two distinct intents must leave two pages: a second-resolution stamp
    // alone would have made the second run erase the first.
    expect(new Set(pages).size).toBe(pages.length);
    expect(pages).toHaveLength(2);
    // Pin the wiring, not just the naming rule: each page must carry the suffix of
    // the run that wrote it. A call site that drops the intent id still leaves two
    // files whenever the two runs happen to straddle a second, so file count alone
    // cannot see that defect.
    const secondIntent = second.stdout.match(/`intent-([0-9a-f-]+)`/)?.[1];
    expect(secondIntent).toBeTruthy();
    const secondPage = pages.find(page => page.includes(secondIntent!.replace(/-/g, '').slice(0, 8)));
    expect(secondPage, `no page carries the second run's intent id ${secondIntent}: ${pages.join(' ')}`).toBeTruthy();
    expect(second.stdout).toContain('**Previous**');
    const cited = second.stdout.match(/- \*\*Previous\*\* `(zeus-daily\/[^`]+)`/)?.[1];
    expect(cited).toBeTruthy();
    expect(pages).toContain(cited!.replace('zeus-daily/', ''));
  });

  it('exits 1 when the agent reports a failed task, and still keeps the evidence', async () => {
    const root = tempRoot('failed');
    const result = await runDailyCli(
      ['--root', root, '--agent', agentUrl('failing-agent'), '--state', join(root, 'state.json'), '--record', 'failed.md', 'check the deployment health'],
      cleanEnv(),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('no agent delivered: failing-agent=agent state failed');
    // S10 V2: a task that settles failed is now a failed branch — state and
    // outcome agree (`failed`), so the settlement fact reads as the plain
    // agent-state line (the pre-fix "counted `completed`" disambiguation
    // existed only because the failed task used to render as completed).
    expect(result.stdout).toContain('agent state `failed`');
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

  it('resolves a CJK instruction from a --spec alias, with no model involved', async () => {
    const specDir = tempRoot('spec');
    const specPath = join(specDir, 'research.json');
    writeFileSync(specPath, JSON.stringify({
      id: 'research',
      name: 'Deep Research',
      description: 'multi-source research',
      version: '9.9.9',
      tags: [],
      aliases: ['归纳要点'],
      providedBy: ['demo-agent'],
    }));
    const sentence = '帮我把这份材料归纳要点';

    // The control: same instruction, same agent, no declared alias. A card carries
    // no aliases field, so this is the state the flag exists to leave behind.
    const without = await runDailyCli(
      ['--root', tempRoot('spec-off'), '--agent', agentUrl('demo-agent'), '--state', 'none', sentence],
      cleanEnv(),
    );
    expect(without.code).toBe(1);
    expect(without.stdout).toContain('no-candidates');

    const onRoot = tempRoot('spec-on');
    const withSpec = await runDailyCli(
      ['--root', onRoot, '--agent', agentUrl('demo-agent'), '--state', 'none', '--spec', specPath, '--record', 'alias.md', sentence],
      cleanEnv(),
    );
    expect(withSpec.code, withSpec.stderr).toBe(0);
    // Local rules, and no backend configured in the environment: nothing could
    // have left the machine to make this match.
    expect(withSpec.stdout).toContain('**Intent** `research` — chosen by local rules');
    expect(readFileSync(join(onRoot, 'alias.md'), 'utf8')).toContain('**Intent** `research`');
  });

  it('refuses a bad --spec before dispatching anything', async () => {
    const root = tempRoot('spec-bad');
    const result = await runDailyCli(
      ['--root', root, '--agent', agentUrl('demo-agent'), '--state', 'none', '--spec', join(root, 'missing.json'), 'summarize the note'],
      cleanEnv(),
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--spec file is not readable');
    // Exit 2 means nothing was dispatched, so the directory stays untouched.
    expect(readdirSync(root)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The waiting-for-you section: every route out of a stopped run has to exist.
// ---------------------------------------------------------------------------

describe('daily report settle hints agree with the surfaces they name', () => {
  const serverSource = readFileSync(new URL('../src/http/server.ts', import.meta.url), 'utf8');
  const mounted = new Set(
    [...serverSource.matchAll(/app\.post\('\/api\/escalations\/:id\/([a-z-]+)'/g)].map(match => match[1]!),
  );

  it('lists the escalation actions the server actually mounts (positive control)', () => {
    // Without this the assertion below could pass on an empty set.
    expect([...mounted].sort()).toEqual(['approve', 'approve-contract', 'approve-resume', 'reject', 'resolve']);
  });

  it.each([
    ['task-input', 'approve-resume'],
    ['intent-conflict', 'resolve'],
    ['memory-dispute', 'approve'],
    ['delegation-limit', 'approve-contract'],
    // A kind this renderer has never seen still gets a mounted action, not a guess.
    ['some-future-kind', 'approve'],
  ] as const)('sends a %s row to POST /api/escalations/<id>/%s', (kind, action) => {
    expect(mounted.has(action), `${action} is not mounted by src/http/server.ts`).toBe(true);
    const text = renderDailyReport(
      baseModel({ status: 'partial', escalations: [{ id: 'esc-7', kind, reason: 'waiting for the operator', options: [] }] }),
    );
    expect(text).toContain('## Waiting for you');
    expect(text).toContain(`POST /api/escalations/esc-7/${action}`);
    // A templated id cannot be pasted; the page carries the real one.
    expect(text).not.toContain(':id');
  });

  it.each([
    ['task-input', 'r<n> {"key":"value"}', 'resume'],
    ['intent-conflict', 's<n>.<m>', 'resolve'],
    ['memory-dispute', 'a<n>', 'approve'],
    ['delegation-limit', 'a<n>', 'approve'],
  ] as const)('names a deck command the parser accepts for %s', (kind, form, parsedKind) => {
    const text = renderDailyReport(baseModel({ escalations: [{ id: 'esc-7', kind, reason: 'r', options: [] }] }));
    expect(text).toContain(form);
    // What the operator types is the form with the placeholders filled in.
    const typed = form.replace(/<n>/g, '1').replace(/<m>/g, '1');
    const parsed = parseCommand(typed);
    expect('error' in parsed ? `not a deck command: ${parsed.error}` : parsed.kind, typed).toBe(parsedKind);
  });

  it('never points at the endpoint that was never mounted', () => {
    const text = renderDailyReport(
      baseModel({ escalations: [{ id: 'esc-7', kind: 'task-input', reason: 'which environment?', options: [] }] }),
    );
    expect(text).not.toContain('/decision');
  });
});
