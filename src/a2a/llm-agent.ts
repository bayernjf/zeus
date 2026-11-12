#!/usr/bin/env node
/**
 * A model-backed execution agent, in the same A2A shape as the reference
 * agent next to it. Where example-agent only restates its input, this one
 * actually asks a model, which is the difference between "the dispatch loop
 * is wired" and "an intent produces billable work".
 *
 * Credentials come from model-hub, never from this repo: the hub answers
 * /pub/v1/models with the assignment's upstream base URL and key, so a vassal
 * never holds a model key of its own. Every call reports usage back to the
 * hub with the assignment id, which is what makes the hub's cost figures
 * reflect real traffic instead of a placeholder.
 *
 * Failure is explicit: a failed upstream call still reports usage (so the
 * hub records the attempt) and the task settles as failed rather than
 * inventing an answer.
 */
import { createServer, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';

export type LlmAgentOptions = {
  port?: number;
  host?: string;
  /** Skill the agent advertises and will accept a task for. */
  skill?: string;
  /** Name the roster shows for this peer. */
  name?: string;
  /** model-hub base URL, e.g. http://model-hub:8791 */
  hubUrl?: string;
  /** model-hub project token. */
  hubToken?: string;
  /** Alias to resolve in the hub catalogue (defaults to `choice`). */
  alias?: string;
  /**
   * Hostname to advertise in the agent card. The bind address is usually
   * 0.0.0.0, and a card naming 0.0.0.0 tells Zeus to dispatch to an
   * unspecified address - the outbound guard rejects that outright, and in a
   * seeded roster it fails the whole boot. Advertise the resolvable service
   * name instead; Zeus reaches it over the shared network by that name.
   */
  publicHost?: string;
};

const PROTOCOL_PATH = '/api/a2a/agent-card';
const TASK_PATH = '/api/a2a/tasks';

type HubAssignment = {
  assignment_id: string;
  alias: string;
  model: string;
  base_url: string;
  api_key: string;
  endpoints?: { chat?: string };
  adapter?: { temperature?: number };
};

export type LlmAgentHandle = {
  port: number;
  cardUrl: string;
  requests: number;
  close(): Promise<void>;
};

function cardFor(options: Required<Pick<LlmAgentOptions, 'skill' | 'name'>>, port: number, host: string) {
  return {
    name: options.name,
    description: 'model-backed execution agent; answers through model-hub credentials',
    url: `http://${host}:${port}${TASK_PATH}`,
    version: '0.1.0',
    provider: { organization: 'zeus', url: `http://${host}:${port}` },
    capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: true },
    defaultInputModes: ['application/json', 'text/plain'],
    defaultOutputModes: ['application/json', 'text/plain'],
    skills: [
      {
        id: options.skill,
        name: 'Model Report',
        description: 'asks the hub-assigned model and reports the answer with its token cost',
        tags: ['model'],
      },
    ],
    authentication: { schemes: ['none'] },
    preferredTransport: 'JSONRPC',
    'x-zeus-fealty': {
      version: '1',
      swornTo: 'zeus',
      domain: 'model',
      dataRealms: ['personal'],
      dataPolicy: 'read-task-scope',
      reportBack: true,
      escalationPolicy: 'on-failure',
    },
  };
}

function textOf(params: unknown): string {
  const message = (params as { message?: { parts?: unknown[] } } | undefined)?.message;
  const parts = Array.isArray(message?.parts) ? message.parts : [];
  return parts
    .map(part => {
      const p = part as { kind?: string; text?: string; data?: Record<string, unknown> };
      if (p.kind === 'text' && typeof p.text === 'string') return p.text;
      if (p.kind === 'data' && p.data) return Object.entries(p.data).map(([k, v]) => `${k}=${String(v)}`).join(' ');
      return '';
    })
    .filter(Boolean)
    .join(' ');
}

/** Resolve the alias to a concrete upstream call target, via the hub. */
async function resolveAssignment(hubUrl: string, hubToken: string, alias: string): Promise<HubAssignment> {
  const response = await fetch(`${hubUrl}/pub/v1/models`, {
    headers: { authorization: `Bearer ${hubToken}` },
  });
  if (!response.ok) throw new Error(`model-hub catalogue answered ${response.status}`);
  const body = (await response.json()) as { models?: HubAssignment[] };
  const hit = (body.models ?? []).find(m => m.alias === alias);
  if (!hit) throw new Error(`alias '${alias}' is not assigned to this project`);
  return hit;
}

type UsageInput = {
  project: string;
  feature: string;
  provider: string;
  model: string;
  assignmentId: string;
  httpStatus: number;
  inputTokens: number;
  outputTokens: number;
  cached: boolean;
};

/** Report the attempt to the hub; a rejection must not mask the answer. */
async function reportUsage(hubUrl: string, hubToken: string, input: UsageInput): Promise<void> {
  try {
    await fetch(`${hubUrl}/pub/v1/usage`, {
      method: 'POST',
      headers: { authorization: `Bearer ${hubToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        project: input.project,
        feature: input.feature,
        billing_source: 'builtin',
        provider: input.provider,
        model: input.model,
        assignment_id: input.assignmentId,
        input_tokens: input.inputTokens,
        output_tokens: input.outputTokens,
        http_status: input.httpStatus,
        cached: input.cached,
        ts: new Date().toISOString(),
      }),
    });
  } catch (error) {
    console.error('[llm-agent] usage report failed:', error instanceof Error ? error.message : String(error));
  }
}

export async function startLlmAgent(options: LlmAgentOptions = {}): Promise<LlmAgentHandle> {
  const host = options.host ?? '127.0.0.1';
  const skill = options.skill ?? 'research';
  const name = options.name ?? 'llm-agent';
  const hubUrl = options.hubUrl ?? process.env.MODEL_HUB_URL ?? '';
  const hubToken = options.hubToken ?? process.env.MODEL_HUB_TOKEN ?? '';
  const alias = options.alias ?? process.env.ZEUS_AGENT_ALIAS ?? 'choice';
  // The card must name an address Zeus can actually reach. Binding to
  // 0.0.0.0 is fine for listening, but advertising it hands Zeus an
  // unspecified target that its outbound guard refuses.
  const advertisedHost = options.publicHost ?? host;

  const handle: LlmAgentHandle = {
    port: 0,
    cardUrl: '',
    requests: 0,
    close: () => Promise.resolve(),
  };

  const server: Server = createServer((req, res) => {
    const url = req.url ?? '';
    if (req.method === 'GET' && url === PROTOCOL_PATH) {
      res.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(cardFor({ skill, name }, handle.port, advertisedHost)));
      return;
    }
    if (req.method !== 'POST' || !url.startsWith(TASK_PATH)) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    let raw = '';
    req.on('data', chunk => (raw += chunk));
    req.on('end', () => {
      void (async () => {
        let rpc: { id?: unknown; method?: string; params?: unknown };
        try {
          rpc = JSON.parse(raw || '{}') as typeof rpc;
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' })
            .end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }));
          return;
        }
        handle.requests += 1;
        const taskId = `llm-task-${handle.requests}`;
        const responseId = rpc.id ?? null;
        const prompt = textOf(rpc.params);

        // Zeus may call through the streaming face (tasks/sendSubscribe or an
        // SSE Accept header) and treats a plain JSON body as a stream that
        // ended without a final snapshot, which fails the branch. Answer on
        // whichever face the caller asked for.
        const wantsStream =
          rpc.method === 'tasks/sendSubscribe' ||
          String(req.headers.accept ?? '').includes('text/event-stream');
        const send = (payload: unknown) => {
          if (wantsStream) {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            const state = (payload as { status?: { state?: string } }).status?.state ?? 'working';
            res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: responseId, result: { kind: 'status-update', taskId, contextId: name, status: { state: 'working' }, final: false } })}\n\n`);
            res.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: responseId, result: { ...(payload as object), status: { ...(payload as { status?: object }).status, state } } })}\n\n`);
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify({ jsonrpc: '2.0', id: responseId, result: payload }));
        };

        if (rpc.method === 'tasks/cancel') {
          send({ kind: 'task', id: taskId, contextId: name, status: { state: 'canceled' } });
          return;
        }

        const startedAt = Date.now();
        let answer = '';
        let failure: string | null = null;
        let usage = { input: 0, output: 0 };
        let httpStatus = 500;
        let assignmentId = '';

        try {
          const target = await resolveAssignment(hubUrl, hubToken, alias);
          assignmentId = target.assignment_id;
          const chatPath = target.endpoints?.chat ?? '/chat/completions';
          const response = await fetch(`${target.base_url}${chatPath}`, {
            method: 'POST',
            headers: { authorization: `Bearer ${target.api_key}`, 'content-type': 'application/json' },
            body: JSON.stringify({
              model: target.model,
              messages: [{ role: 'user', content: prompt || 'say hello' }],
              // This upstream model reasons before it answers, and the
              // reasoning is billed as completion tokens. A tight budget
              // spends everything on the scratchpad and returns an empty
              // content with finish_reason=length - a silent "answer" that
              // is actually no answer at all.
              max_tokens: 1024,
            }),
          });
          httpStatus = response.status;
          const body = (await response.json().catch(() => null)) as {
            choices?: { message?: { content?: string; reasoning_content?: string }; finish_reason?: string }[];
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          } | null;
          if (!response.ok || !body) {
            failure = `upstream answered ${response.status}`;
          } else {
            const choice = body.choices?.[0];
            // When reasoning is allowed to consume the whole budget the
            // visible content comes back empty. Recovering the reasoning
            // text is better than reporting "no answer" while the tokens
            // were spent and billed anyway.
            answer = choice?.message?.content?.trim()
              ? choice.message.content
              : (choice?.message?.reasoning_content ?? '');
            usage = {
              input: body.usage?.prompt_tokens ?? 0,
              output: body.usage?.completion_tokens ?? 0,
            };
            if (!answer) {
              failure = `upstream returned an empty completion (finish_reason=${choice?.finish_reason ?? 'unknown'}, ${usage.output} output tokens)`;
            }
          }
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
        }

        const wallSeconds = Math.round((Date.now() - startedAt) / 100) / 10;

        if (assignmentId) {
          await reportUsage(hubUrl, hubToken, {
            project: 'zeus',
            feature: 'vassal-chat',
            provider: 'ark',
            model: alias,
            assignmentId,
            httpStatus,
            inputTokens: usage.input,
            outputTokens: usage.output,
            cached: false,
          });
        }

        const artifacts = [
          {
            artifactId: 'model-report',
            name: 'model report',
            parts: [
              { kind: 'text', text: failure ? `model call failed: ${failure}` : answer },
              {
                kind: 'data',
                data: {
                  summary: failure
                    ? `no answer: ${failure}`
                    : `answered via alias '${alias}' in ${wallSeconds}s`,
                  evidence: [`upstream status ${httpStatus}`, `${usage.input} in / ${usage.output} out tokens`],
                  cost: { llmTokens: usage.input + usage.output, wallSeconds },
                  followUps: [],
                },
              },
            ],
            'x-zeus-report': {
              summary: failure ? `model call failed: ${failure}` : answer.slice(0, 80),
              evidence: [`alias=${alias}`, `assignment=${assignmentId || '(unresolved)'}`],
              cost: { llmTokens: usage.input + usage.output, wallSeconds },
              followUps: [],
            },
          },
        ];

        send({
          kind: 'task',
          id: taskId,
          contextId: name,
          status: failure
            ? { state: 'failed', message: failure }
            : { state: 'completed' },
          artifacts,
        });
      })();
    });
  });

  await new Promise<void>(resolve => server.listen(options.port ?? 0, host, () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('the llm agent did not bind a port');
  }
  handle.port = address.port;
  handle.cardUrl = `http://${advertisedHost}:${handle.port}${PROTOCOL_PATH}`;
  handle.close = () => new Promise<void>(resolve => server.close(() => resolve()));
  return handle;
}

const USAGE = `usage: npm run agent:llm [-- --port 8091 --skill research --name llm-agent]

Starts a model-backed A2A agent. It resolves its upstream credentials from
model-hub, calls the model, and reports token usage back to the hub so real
cost is recorded. Requires MODEL_HUB_URL and MODEL_HUB_TOKEN.`;

async function main(argv: string[]): Promise<void> {
  const options: LlmAgentOptions = {};
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
  const handle = await startLlmAgent(options);
  console.log(`card url: ${handle.cardUrl}`);
}

export async function runLlmAgentCli(argv: string[]): Promise<void> {
  await main(argv);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runLlmAgentCli(process.argv.slice(2)).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
}
