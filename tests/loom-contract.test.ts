import { describe, expect, it } from 'vitest';
import { VassalRegistry } from '../src/registry/registry.js';
import { Dispatcher } from '../src/dispatch/dispatcher.js';
import { A2AClientError, cancelTask, sendTask, sendTaskSubscribe } from '../src/dispatch/client.js';
import { memoryAuditSink } from '../src/dispatch/audit.js';
import { OversightDesk } from '../src/oversight/oversight.js';
import type { AgentCard, Task } from '../src/a2a/types.js';

/**
 * Zeus ↔ loom contract compatibility suite.
 *
 * Every fixture below is copied from loom's real implementation, not invented:
 *  - card shape:      backend/app/core/a2a/card.py build_agent_card()
 *  - plan skills:     backend/app/core/a2a/skills.py SKILLS / required params
 *  - task lifecycle:  backend/app/core/a2a/rpc.py execute_task/handle_jsonrpc
 *  - SSE framing:     backend/app/core/a2a/router.py _subscribe_stream
 *                     (event frames: data:{jsonrpc,id,result:event}; final frame: data:{jsonrpc,id,result:task})
 *  - auth:            POST /api/a2a/tasks is behind the Q88 Agent API key (Bearer).
 *
 * This is a mock-HTTP contract test; the real end-to-end run still waits for a
 * loom test environment (handoff Active work 6).
 */

const BASE = 'http://loom.test';
const CARD_URL = `${BASE}/api/a2a/agent-card`;
const TASK_URL = `${BASE}/api/a2a/tasks`;
const TOKEN = 'loom-q88-key';

// --- fixtures copied from card.py / skills.py --------------------------------

function loomCard(): AgentCard {
  return {
    name: 'loom',
    description:
      'Private-domain content production whitelist platform (CHAIN_13). Vassal skills are plan-only: candidates and plans, human gates decide.',
    url: TASK_URL,
    version: '0.1.0',
    capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: true },
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    skills: [
      {
        id: 'generate-content',
        name: 'Plan content generation',
        description:
          'Plan a segment-12 content generation run: advisory plan only, no chain mutation, no LLM token spend, human gates untouched.',
        tags: ['chain-seg12', 'plan-only', 'human-gate'],
      },
      {
        id: 'compliance-check',
        name: 'Plan compliance cleaning',
        description:
          'Plan a segment-11 compliance cleaning pass: advisory plan only, no chain mutation, results never bypass manual gates.',
        tags: ['chain-seg11', 'plan-only', 'advisory'],
      },
      {
        id: 'effect-backfill',
        name: 'Plan effect feedback backfill',
        description:
          'Plan a segment-13 effect backfill through the Q128 customer channel semantics: advisory plan only, no records written.',
        tags: ['chain-seg13', 'plan-only', 'effect-loop'],
      },
    ],
    authentication: { schemes: ['bearer'] },
    preferredTransport: 'JSONRPC',
    'x-zeus-fealty': {
      version: '1',
      swornTo: 'zeus',
      domain: 'content-production',
      dataRealms: ['enterprise'],
      dataPolicy: 'read-task-scope',
      reportBack: true,
      escalationPolicy: 'auto',
      sla: { ackSeconds: 10 },
      notes:
        'Plan-mode vassal: every skill returns an advisory plan artifact and never touches the 13-segment chain, spends tokens, or bypasses a human gate.',
    },
  } as AgentCard;
}

const REQUIRED_PARAMS: Record<string, string[]> = {
  'generate-content': ['tenant_id', 'product_id'],
  'compliance-check': ['tenant_id', 'content_id'],
  'effect-backfill': ['tenant_id', 'content_id'],
};

const PLAN_STEPS: Record<string, string[]> = {
  'generate-content': ['定位租户与产品', '规划候选生成批次', '列出人工 Gate', '给出前置条件清单'],
  'compliance-check': ['定位成品与发布位', '规划合规清洗检查项', '标注 advisory 与人工裁决项'],
  'effect-backfill': ['规划 records 批次', '列出幂等核对点', '规划孤儿/认领路径'],
};

// --- minimal faithful port of rpc.py + router.py framing ---------------------

type SeenRequest = { url: string; method: string; auth: string | null; accept: string | null; body: any };

function loomFetch(seen: SeenRequest[], options: { requireAuth?: boolean } = {}) {
  const tasks = new Map<string, Task['status']['state']>();
  let rpcId = 100;

  const ts = () => '2026-09-21T12:00:00Z';

  function statusEvent(taskId: string, contextId: string, state: Task['status']['state'], final: boolean, runId?: string) {
    return {
      kind: 'status-update',
      taskId,
      contextId,
      status: { state, timestamp: ts() },
      final,
      ...(runId ? { 'x-zeus': { runId } } : {}),
    };
  }

  function executeTask(message: any) {
    const dataPart = message.parts.find((p: any) => p.kind === 'data' && typeof p.data === 'object');
    const { skill, ...params } = dataPart?.data ?? {};
    const runId = message.metadata?.['x-zeus-runId'];
    const taskId = `loom-${Math.abs(hashish(skill + JSON.stringify(params)))}`;
    const contextId = `ctx-${taskId}`;
    const missing = (REQUIRED_PARAMS[skill] ?? []).filter(key => !params[key]);

    const task: any = {
      kind: 'task',
      id: taskId,
      contextId,
      status: { state: 'submitted', timestamp: ts() },
      artifacts: [],
      metadata: runId ? { 'x-zeus-runId': runId } : null,
    };
    const events: any[] = [
      statusEvent(taskId, contextId, 'submitted', false, runId),
      statusEvent(taskId, contextId, 'working', false, runId),
    ];

    if (!(skill in REQUIRED_PARAMS)) {
      task.status = { state: 'failed', timestamp: ts() };
      events.push(statusEvent(taskId, contextId, 'failed', true, runId));
    } else if (missing.length > 0) {
      task.status = { state: 'input-required', timestamp: ts() };
      events.push(statusEvent(taskId, contextId, 'input-required', true, runId));
    } else {
      const artifact = {
        artifactId: `art-${taskId}`,
        name: `${skill}-plan`,
        parts: [
          { kind: 'data', data: { mode: 'plan', skill, params } },
          { kind: 'text', text: PLAN_STEPS[skill].map((step, i) => `${i + 1}. ${step}`).join('\n') },
        ],
        'x-zeus-report': {
          summary: `${skill}: plan generated for tenant=${params.tenant_id}.`,
          evidence: [
            `parameters validated: ${Object.keys(params).sort().join(', ')}`,
            'plan-only: no chain mutation, no token spend, no gate bypass',
          ],
          cost: { llmTokens: 0, wallSeconds: 0 },
          followUps: [],
        },
      };
      task.artifacts = [artifact];
      task.status = { state: 'completed', timestamp: ts() };
      events.push({
        kind: 'artifact-update',
        taskId,
        contextId,
        artifact,
        ...(runId ? { 'x-zeus': { runId } } : {}),
      });
      events.push(statusEvent(taskId, contextId, 'completed', true, runId));
    }
    tasks.set(taskId, task.status.state);
    return { task, events };
  }

  function sse(body: any): Response {
    const reqId = body.id;
    const { task, events } = executeTask(body.params.message);
    const frames = [
      ...events.map(event => `data: ${JSON.stringify({ jsonrpc: '2.0', id: reqId, result: event })}\n\n`),
      `data: ${JSON.stringify({ jsonrpc: '2.0', id: reqId, result: task })}\n\n`,
    ];
    return new Response(frames.join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }

  return async (url: string, init?: RequestInit): Promise<Response> => {
    if (url === CARD_URL) {
      return new Response(JSON.stringify(loomCard()), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    const body = JSON.parse(String(init?.body)) as any;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push({ url, method: body.method, auth: headers.Authorization ?? null, accept: headers.Accept ?? null, body });

    if (options.requireAuth !== false && headers.Authorization !== `Bearer ${TOKEN}`) {
      return new Response(JSON.stringify({ detail: 'unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    if (body.method === 'tasks/sendSubscribe') return sse(body);
    if (body.method === 'tasks/send') {
      const { task } = executeTask(body.params.message);
      return rpc(body.id, task);
    }
    if (body.method === 'tasks/cancel') {
      const state = tasks.get(body.params.id);
      if (!state) return rpcError(body.id, -32001, 'Task not found');
      if (['completed', 'failed', 'canceled'].includes(state)) return rpcError(body.id, -32002, 'Task not cancelable');
      tasks.set(body.params.id, 'canceled');
      return rpc(body.id, { kind: 'task', id: body.params.id, contextId: 'ctx', status: { state: 'canceled' }, artifacts: [] });
    }
    return rpcError(body.id, -32601, 'Method not found');
  };

  function rpc(id: number, result: unknown): Response {
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  function rpcError(id: number, code: number, message: string): Response {
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

function hashish(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i++) h = (h * 31 + input.charCodeAt(i)) | 0;
  return h;
}

// --- tests -------------------------------------------------------------------

describe('Zeus ↔ loom A2A contract compatibility', () => {
  it('registers the loom card: fealty v1 accepted, three plan skills routable, task endpoint derived', async () => {
    const seen: SeenRequest[] = [];
    const registry = new VassalRegistry(loomFetch(seen, { requireAuth: false }));
    const entry = await registry.register(CARD_URL);

    expect(entry.card.name).toBe('loom');
    expect(entry.taskUrl).toBe(TASK_URL);
    expect(entry.fealty).toMatchObject({ version: '1', domain: 'content-production', dataPolicy: 'read-task-scope', sla: { ackSeconds: 10 } });
    expect(entry.card.defaultInputModes).toEqual(['application/json']);
    for (const skillId of ['generate-content', 'compliance-check', 'effect-backfill']) {
      expect(registry.findVassalsForSkill(skillId).map(v => v.card.name)).toEqual(['loom']);
    }
    expect(registry.findVassalsForDomain('content-production')).toHaveLength(1);
  });

  it('dispatches generate-content over sendSubscribe with the exact loom wire shape and consumes the plan report', async () => {
    const seen: SeenRequest[] = [];
    const fetchImpl = loomFetch(seen);
    const registry = new VassalRegistry(fetchImpl);
    await registry.register(CARD_URL);
    const { sink } = memoryAuditSink();
    const dispatcher = new Dispatcher(registry.asVassalLookup(), { audit: sink, fetchImpl, tokenFor: () => TOKEN });

    const result = await dispatcher.dispatch({
      skill: 'generate-content',
      params: { tenant_id: 't-7', product_id: 'p-9' },
      realm: 'enterprise',
      runId: 'zeus-run-loom-1',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // the request loom's rpc.py expects: user message, data.skill + flat params, runId metadata
    const taskCalls = seen.filter(s => s.url === TASK_URL);
    expect(taskCalls).toHaveLength(1);
    const call = taskCalls[0];
    expect(call.method).toBe('tasks/sendSubscribe');
    expect(call.auth).toBe(`Bearer ${TOKEN}`);
    expect(call.accept).toContain('text/event-stream');
    const message = call.body.params.message;
    expect(message.role).toBe('user');
    expect(message.metadata['x-zeus-runId']).toBe('zeus-run-loom-1');
    expect(message.parts[0].data).toMatchObject({ skill: 'generate-content', tenant_id: 't-7', product_id: 'p-9' });

    // full loom event sequence consumed
    expect(result.events.map(e => e.kind)).toEqual(['status-update', 'status-update', 'artifact-update', 'status-update']);
    expect(result.task.status.state).toBe('completed');

    // plan report with the four v1 contract fields, zero token spend (plan-only)
    const report = result.task.artifacts[0]['x-zeus-report'];
    expect(report).toBeDefined();
    expect(report?.summary).toContain('generate-content');
    expect(report?.evidence).toHaveLength(2);
    expect(report?.cost).toEqual({ llmTokens: 0, wallSeconds: 0 });
    expect(report?.followUps).toEqual([]);

    // runId round-trips on loom events
    const echoedRunIds = result.events.flatMap(e => ('x-zeus' in e && e['x-zeus'] ? [e['x-zeus'].runId] : []));
    expect(echoedRunIds.every(id => id === 'zeus-run-loom-1')).toBe(true);
    expect(echoedRunIds.length).toBeGreaterThan(0);
  });

  it('turns a loom missing-params input-required (no escalation payload) into a neutral oversight escalation', async () => {
    const seen: SeenRequest[] = [];
    const fetchImpl = loomFetch(seen);
    const registry = new VassalRegistry(fetchImpl);
    await registry.register(CARD_URL);
    const { sink } = memoryAuditSink();
    const dispatcher = new Dispatcher(registry.asVassalLookup(), { audit: sink, fetchImpl, tokenFor: () => TOKEN });

    const result = await dispatcher.dispatch({
      skill: 'compliance-check',
      params: { tenant_id: 't-7' }, // missing content_id -> skills.py returns input-required
      realm: 'enterprise',
      runId: 'zeus-run-loom-2',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.task.status.state).toBe('input-required');
    expect(result.task.artifacts).toEqual([]);
    // loom does not emit x-zeus-escalation; Zeus must still open a neutral escalation
    const desk = new OversightDesk({ newId: () => 'esc-loom-1' });
    const escalation = desk.ingest(result, {
      vassal: 'loom',
      skill: 'compliance-check',
      params: { tenant_id: 't-7' },
      realm: 'enterprise',
      runId: 'zeus-run-loom-2',
    });
    expect(escalation?.status).toBe('pending');
    expect(escalation?.reason).toBe('vassal requests human input');
  });

  it('consumes a synchronous tasks/send JSON response (non-streaming path)', async () => {
    const seen: SeenRequest[] = [];
    const task = await sendTask(
      { taskUrl: TASK_URL, skill: 'effect-backfill', params: { tenant_id: 't-1', content_id: 'c-2' }, runId: 'zeus-run-loom-3', token: TOKEN },
      loomFetch(seen)
    );
    expect(task.kind).toBe('task');
    expect(task.status.state).toBe('completed');
    expect(seen[0].method).toBe('tasks/send');
    expect(seen[0].accept).toBeNull(); // sync call does not negotiate SSE
  });

  it('maps loom JSON-RPC error -32002 when canceling an already-terminal task', async () => {
    const seen: SeenRequest[] = [];
    const fetchImpl = loomFetch(seen);
    const completed = await sendTask(
      { taskUrl: TASK_URL, skill: 'generate-content', params: { tenant_id: 't', product_id: 'p' }, runId: 'zeus-run-loom-4', token: TOKEN },
      fetchImpl
    );
    // loom plan tasks run synchronously to a terminal state, so cancel is refused with TASK_NOT_CANCELABLE
    await expect(cancelTask(TASK_URL, completed.id, TOKEN, fetchImpl)).rejects.toMatchObject({ code: -32002 });
  });

  it('fails loudly when the Q88 Bearer key is missing (loom returns 401)', async () => {
    const seen: SeenRequest[] = [];
    await expect(
      sendTaskSubscribe(
        { taskUrl: TASK_URL, skill: 'generate-content', params: { tenant_id: 't', product_id: 'p' }, runId: 'zeus-run-loom-5' },
        {},
        loomFetch(seen)
      )
    ).rejects.toMatchObject({ code: -32000 });
    const taskCall = seen.find(s => s.url === TASK_URL);
    expect(taskCall?.auth).toBeNull();
  });
});
