import { describe, expect, it } from 'vitest';
import { bootKernel } from '../src/state/boot.js';
import type { AuditEntry } from '../src/dispatch/dispatcher.js';

/**
 * P0-5 pilot gap (deferred #25 class): the desk's audit hook was optional and
 * serve.ts never passed it, so an operator's approve/reject - and even the
 * question reaching the desk - left no trace on the audit spine in a real
 * process. These cases drive a booted kernel and read the collector, so the
 * wiring is proved at the assembly, not at the unit level.
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

function vassalFetch(): typeof fetch {
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
    const task = { kind: 'task', id: taskId, contextId: 'ctx', status: { state: 'input-required' }, artifacts: [] };
    const frames = [
      `data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { kind: 'status-update', taskId, contextId: 'ctx', status: { state: 'working' }, final: false } })}\n\n`,
      `data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: task })}\n\n`,
    ];
    return new Response(frames.join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }) as typeof fetch;
}

const seeds = ['http://127.0.0.1/loom/api/a2a/agent-card'];

describe('the desk decisions land on the audit spine in a booted kernel', () => {
  it('records escalation-approved when an operator approves a task-input row', async () => {
    const audits: AuditEntry[] = [];
    const kernel = await bootKernel({
      fetchImpl: vassalFetch(),
      vassalSeeds: seeds,
      dispatchAudit: entry => audits.push(entry),
    });

    await kernel.orchestrator.fanOut({ skill: 'review', realm: 'personal', params: {} });
    const pending = kernel.oversight.list('pending');
    expect(pending).toHaveLength(1);
    // The question reaching the desk is itself a governance fact.
    expect(audits.some(entry => entry.decision === 'escalation-escalated')).toBe(true);

    const approved = await kernel.oversight.approve(pending[0]!.id, 'pilot note');
    expect(approved.status).toBe('approved');

    const row = audits.find(entry => entry.decision === 'escalation-approved');
    expect(row).toBeDefined();
    expect(row?.vassal).toBe('loom');
    expect(row?.detail).toContain(pending[0]!.id);
    expect(row?.detail).toContain('pilot note');
  });

  it('records escalation-rejected when an operator rejects one', async () => {
    const audits: AuditEntry[] = [];
    const kernel = await bootKernel({
      fetchImpl: vassalFetch(),
      vassalSeeds: seeds,
      dispatchAudit: entry => audits.push(entry),
    });

    await kernel.orchestrator.fanOut({ skill: 'review', realm: 'personal', params: {} });
    const pending = kernel.oversight.list('pending');
    await kernel.oversight.reject(pending[0]!.id);

    expect(audits.some(entry => entry.decision === 'escalation-rejected')).toBe(true);
  });

  it('S11 V2: records tool-selected with the candidate face the live saturation data produced', async () => {
    const audits: AuditEntry[] = [];
    const kernel = await bootKernel({
      fetchImpl: vassalFetch(),
      vassalSeeds: seeds,
      dispatchAudit: entry => audits.push(entry),
    });

    await kernel.orchestrator.fanOut({ skill: 'review', realm: 'personal', params: {} });

    const row = audits.find(entry => entry.decision === 'tool-selected');
    expect(row).toBeDefined();
    expect(row?.detail).toContain("skill 'review'");
    expect(row?.detail).toContain('live-saturated dropped 0');
  });
});
