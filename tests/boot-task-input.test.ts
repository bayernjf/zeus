import { describe, expect, it } from 'vitest';
import { bootKernel } from '../src/state/boot.js';

/**
 * E6.1 / audit C-28: `OversightDesk.ingest` had no caller anywhere in `src/`, so
 * a vassal that stopped at input-required never reached the desk in a booted
 * process - only intent conflicts (conflictsToDesk) and memory disputes did.
 * These cases drive a real kernel so the gap is closed at the wiring, not at
 * the unit level: a hook nobody calls still passes a unit test that calls it.
 */

function cardFor(name: string) {
  return {
    name,
    url: `http://127.0.0.1/${name}/api/a2a/tasks`,
    version: '0.1.0',
    provider: { organization: 'bayjf', url: 'http://bayjf.test' },
    capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: true },
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    skills: [{ id: 'review', name: 'Review', description: '', tags: [] }],
    authentication: { schemes: ['bearer'] },
    preferredTransport: 'JSONRPC',
    'x-zeus-fealty': {
      version: '1', swornTo: 'zeus', domain: 'test-domain',
      dataRealms: ['personal', 'enterprise'], dataPolicy: 'read-task-scope',
      reportBack: true, escalationPolicy: 'auto',
    },
  };
}

/** One vassal; its terminal state and the escalation payload it carries. */
function vassalFetch(options: {
  state: 'completed' | 'input-required';
  reason?: string;
  escalationOptions?: string[];
}): typeof fetch {
  return (async (input: unknown) => {
    const url = String(input);
    const name = url.split('/')[3]!;
    if (url.includes('/api/a2a/agent-card')) {
      return new Response(JSON.stringify(cardFor(name)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const taskId = `${name}-task`;
    const task = {
      kind: 'task',
      id: taskId,
      contextId: 'ctx',
      status: { state: options.state },
      artifacts: options.state === 'completed'
        ? [{ artifactId: 'a', name: 'verdict', parts: [{ kind: 'data', data: { stance: 'approve' } }] }]
        : [],
    };
    const frames = [
      `data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { kind: 'status-update', taskId, contextId: 'ctx', status: { state: 'working' }, final: false } })}\n\n`,
      `data: ${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: {
          kind: 'status-update',
          taskId,
          contextId: 'ctx',
          status: { state: options.state },
          final: true,
          ...(options.reason || options.escalationOptions
            ? {
                'x-zeus-escalation': {
                  level: 'driver',
                  ...(options.reason ? { reason: options.reason } : {}),
                  ...(options.escalationOptions ? { options: options.escalationOptions } : {}),
                },
              }
            : {}),
        },
      })}\n\n`,
      `data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: task })}\n\n`,
    ];
    return new Response(frames.join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }) as typeof fetch;
}

const seeds = ['http://127.0.0.1/loom/api/a2a/agent-card'];

describe('E6.1 task-input escalations reach the oversight desk in a booted kernel', () => {
  it('raises a pending escalation when a branch stops at input-required', async () => {
    const kernel = await bootKernel({
      fetchImpl: vassalFetch({
        state: 'input-required',
        reason: 'irreversible: merge',
        escalationOptions: ['approve', 'reject'],
      }),
      vassalSeeds: seeds,
    });

    const result = await kernel.orchestrator.fanOut({ skill: 'review', realm: 'personal', params: {} });
    expect(result.branches[0]?.state).toBe('input-required');

    const escalations = kernel.oversight.list();
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toMatchObject({
      kind: 'task-input',
      status: 'pending',
      vassal: 'loom',
      skill: 'review',
      taskId: 'loom-task',
      reason: 'irreversible: merge',
      options: ['approve', 'reject'],
    });
  });

  it('raises nothing when the branch completes', async () => {
    // The negative control: without it, a hook that fires on every settled
    // branch would look identical to one that fires only on input-required.
    const kernel = await bootKernel({
      fetchImpl: vassalFetch({ state: 'completed' }),
      vassalSeeds: seeds,
    });
    await kernel.orchestrator.fanOut({ skill: 'review', realm: 'personal', params: {} });
    expect(kernel.oversight.list()).toEqual([]);
  });
});
