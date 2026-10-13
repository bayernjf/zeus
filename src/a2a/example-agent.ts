#!/usr/bin/env node
/**
 * E4.12: the reference execution agent that ships with the repository.
 *
 * Zeus dispatches; it does not execute. Before this entry a first-time reader
 * had to stand up an A2A agent somewhere else before any command could show a
 * result — `npm run daily` with an empty roster exits 2 (measured 2026-10-13).
 * This is the smallest peer that makes the whole loop demonstrable on one
 * machine: a standard Agent Card, a complete `x-zeus-fealty` declaration, and
 * the JSON-RPC task faces Zeus calls.
 *
 * Boundaries it must never cross, and the reason each one is here:
 *   - it reads nothing but the task message it was sent — no filesystem, no
 *     realm, no user directory;
 *   - it makes no outbound request of any kind (zero egress);
 *   - it does not call a model. Anything it "knows" is what the caller put in
 *     the task, so its report is a shape demonstration, not an answer.
 *
 * It is deliberately not in `src/testing/`: that package is test scaffolding and
 * is not what an operator runs. This is a shipped entry (`npm run agent:example`).
 */
import { createServer, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';

export type ExampleAgentOptions = {
  port?: number;
  host?: string;
  /** Skill the agent advertises and will accept a task for. */
  skill?: string;
  /** Name the roster shows for this peer. */
  name?: string;
};

const PROTOCOL_PATH = '/api/a2a/agent-card';
const TASK_PATH = '/api/a2a/tasks';

export type ExampleAgentHandle = {
  port: number;
  cardUrl: string;
  requests: number;
  close(): Promise<void>;
};

function cardFor(options: Required<Pick<ExampleAgentOptions, 'skill' | 'name'>>, port: number, host: string) {
  return {
    name: options.name,
    description: 'reference execution agent shipped with Zeus; answers from the task input only',
    url: `http://${host}:${port}${TASK_PATH}`,
    version: '0.1.0',
    provider: { organization: 'zeus', url: `http://${host}:${port}` },
    capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: true },
    defaultInputModes: ['application/json', 'text/plain'],
    defaultOutputModes: ['application/json', 'text/plain'],
    skills: [
      {
        id: options.skill,
        name: 'Reference Report',
        description: 'restates the task it was given and reports what it could not answer',
        tags: ['reference'],
      },
    ],
    authentication: { schemes: ['none'] },
    preferredTransport: 'JSONRPC',
    // The registration contract Zeus validates: which realms this peer may serve,
    // and its data policy. Declaring personal only is the narrowest honest claim.
    'x-zeus-fealty': {
      version: '1',
      swornTo: 'zeus',
      domain: 'reference',
      dataRealms: ['personal'],
      dataPolicy: 'read-task-scope',
      reportBack: true,
      escalationPolicy: 'on-failure',
    },
  };
}

/**
 * Builds the task result from the request only. The text part carries what the
 * agent was asked; the data part carries the report-back contract (summary /
 * evidence / cost / followUps) so a caller sees the standard shape rather than
 * a stance this peer has no basis to vote on.
 */
function buildTask(taskId: string, params: unknown) {
  const message = (params as { message?: { parts?: unknown[] } } | undefined)?.message;
  const parts = Array.isArray(message?.parts) ? message.parts : [];
  const text = parts
    .map(part => {
      const p = part as { kind?: string; text?: string; data?: Record<string, unknown> };
      if (p.kind === 'text' && typeof p.text === 'string') return p.text;
      if (p.kind === 'data' && p.data) return Object.entries(p.data).map(([k, v]) => `${k}=${String(v)}`).join(' ');
      return '';
    })
    .filter(Boolean)
    .join(' ');
  const gaps = text ? [] : ['the task carried no text or data part, so nothing was restated'];
  return {
    kind: 'task',
    id: taskId,
    contextId: 'zeus-example-agent',
    status: { state: 'completed', message: text ? undefined : 'no task content was supplied' },
    artifacts: [
      {
        artifactId: 'reference-report',
        name: 'reference report',
        parts: [
          { kind: 'text', text: `restated task input: ${text || '(empty)'}` },
          {
            kind: 'data',
            data: {
              summary: `answered from the task input only (${text.length} characters restated)`,
              evidence: ['no filesystem read', 'no outbound request', 'no model call'],
              cost: { llmTokens: 0, wallSeconds: 0 },
              followUps: gaps,
            },
          },
        ],
        // The report-back contract Zeus presents to its operator (E4.3).
        'x-zeus-report': {
          summary: `reference agent restated the task: ${text.slice(0, 80) || '(empty)'}`,
          evidence: ['task input only', 'zero egress'],
          cost: { llmTokens: 0, wallSeconds: 0 },
          followUps: gaps,
        },
      },
    ],
  };
}

export async function startExampleAgent(options: ExampleAgentOptions = {}): Promise<ExampleAgentHandle> {
  const host = options.host ?? '127.0.0.1';
  const skill = options.skill ?? 'research';
  const name = options.name ?? 'example-agent';
  const handle: ExampleAgentHandle = {
    port: 0,
    cardUrl: '',
    requests: 0,
    close: () => Promise.resolve(),
  };

  const server: Server = createServer((req, res) => {
    const url = req.url ?? '';
    if (req.method === 'GET' && url === PROTOCOL_PATH) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(cardFor({ skill, name }, handle.port, host)));
      return;
    }
    if (req.method !== 'POST' || !url.startsWith(TASK_PATH)) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    let raw = '';
    req.on('data', chunk => (raw += chunk));
    req.on('end', () => {
      let rpc: { id?: unknown; method?: string; params?: unknown };
      try {
        rpc = JSON.parse(raw || '{}') as typeof rpc;
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' })
          .end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }));
        return;
      }
      handle.requests += 1;
      const taskId = `example-task-${handle.requests}`;
      const task = buildTask(taskId, rpc.params);
      const responseId = rpc.id ?? null;
      if (rpc.method === 'tasks/cancel') {
        res.writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ jsonrpc: '2.0', id: responseId, result: { ...task, status: { state: 'canceled' } } }));
        return;
      }
      if (rpc.method === 'tasks/sendSubscribe' || String(req.headers.accept ?? '').includes('text/event-stream')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: responseId, result: { kind: 'status-update', taskId, contextId: task.contextId, status: { state: 'working' }, final: false } })}\n\n`);
        res.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: responseId, result: task })}\n\n`);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: responseId, result: task }));
    });
  });

  await new Promise<void>(resolve => server.listen(options.port ?? 0, host, () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('the example agent did not bind a port');
  }
  handle.port = address.port;
  handle.cardUrl = `http://${host}:${handle.port}${PROTOCOL_PATH}`;
  handle.close = () => new Promise<void>(resolve => server.close(() => resolve()));
  return handle;
}

const USAGE = `usage: npm run agent:example [-- --port 8090 --skill research --name example-agent]

Starts the reference execution agent advertised over standard A2A. It answers
from the task input only: no filesystem read, no outbound request, no model call.
Point Zeus at it with:

  npm run daily -- "<one sentence>" --root <dir> --agent <printed card URL>`;

async function main(argv: string[]): Promise<void> {
  const options: ExampleAgentOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--help' || flag === '-h') {
      console.log(USAGE);
      return;
    }
    if (flag === '--port') {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) throw new Error(`--port must be 1-65535, got ${value}`);
      options.port = parsed;
      i += 1;
    } else if (flag === '--skill') {
      if (!value) throw new Error('--skill needs a value');
      options.skill = value;
      i += 1;
    } else if (flag === '--name') {
      if (!value) throw new Error('--name needs a value');
      options.name = value;
      i += 1;
    } else {
      throw new Error(`unknown option: ${String(flag)}`);
    }
  }
  const handle = await startExampleAgent(options);
  console.log(`card url: ${handle.cardUrl}`);
  console.log('register it with Zeus:  npm run daily -- "<one sentence>" --root <dir> --agent ' + handle.cardUrl);
  console.log('serving until the process is stopped (Ctrl-C)');
  process.once('SIGINT', () => {
    void handle.close().then(() => process.exit(0));
  });
}

export async function runExampleAgentCli(argv: string[]): Promise<void> {
  await main(argv);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runExampleAgentCli(process.argv.slice(2)).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
}
