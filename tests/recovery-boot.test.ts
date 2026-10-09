import { describe, expect, it } from 'vitest';
import { bootKernel } from '../src/state/boot.js';
import { executeRecovery, type RecoveryCheckpoint } from '../src/orchestrator/recovery.js';
import type { AuditEntry } from '../src/dispatch/dispatcher.js';

/**
 * S13 V2 (design-long-running §5): the boot recovery sequence classifies and
 * executes every unsettled intent between state restoration and the first new
 * intent — auto-resume re-enters the fan-out idempotency gate, await-operator
 * keeps the restored escalation desk authoritative, settle-failed/canceled
 * overwrite the stored status. The crash window is "since the last graceful
 * save", so the integration tests model a crash as: saveState, drop the old
 * kernel without graceful shutdown, boot the same state file again.
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
      dataRealms: ['personal'], dataPolicy: 'read-task-scope',
      reportBack: true, escalationPolicy: 'on-failure',
    },
  };
}

function stanceFetch(stance: Record<string, 'approve' | 'reject' | 'fail'>): { fetchImpl: typeof fetch; dispatched: string[] } {
  const dispatched: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const name = url.split('/')[3]!;
    if (url.includes('/api/a2a/agent-card')) {
      return new Response(JSON.stringify(cardFor(name)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    dispatched.push(name);
    const how = stance[name] ?? 'approve';
    if (how === 'fail') {
      return new Response('boom', { status: 500 });
    }
    const taskId = `${name}-task`;
    const task = {
      kind: 'task',
      id: taskId,
      contextId: 'ctx',
      status: { state: 'completed' },
      artifacts: [{ artifactId: 'a', name: 'verdict', parts: [{ kind: 'data', data: { stance: how } }] }],
    };
    return new Response(
      `data: ${JSON.stringify({ jsonrpc: '2.0', id: 2, result: task })}\n\n`,
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    );
  }) as typeof fetch;
  return { fetchImpl, dispatched };
}

function auditsOf(entries: AuditEntry[]): string[] {
  return entries.filter(e => e.decision.startsWith('recovery-')).map(e => `${e.decision}:${e.detail}`);
}

describe('S13 V2 crash recovery in a booted kernel', () => {
  it('keeps a restored needs-driver intent awaiting the operator', async () => {
    const stateFile = `${process.cwd()}/.tmp-recovery-needs-driver-${Date.now()}.json`;
    try {
      const { fetchImpl } = stanceFetch({ alpha: 'approve', beta: 'reject' });
      const first = await bootKernel({ fetchImpl, stateFile, vassalSeeds: ['http://127.0.0.1/alpha/api/a2a/agent-card', 'http://127.0.0.1/beta/api/a2a/agent-card'] });
      const result = await first.orchestrator.fanOut({
        intentId: 'intent-needs-driver', skill: 'review', params: { message: 'x' }, realm: 'personal',
        vassals: ['alpha', 'beta'],
      });
      expect(result.status).toBe('needs-driver');
      await first.saveState();

      // Crash: drop the kernel without graceful shutdown, boot the same file.
      const secondAudits: AuditEntry[] = [];
      const second = await bootKernel({
        fetchImpl,
        stateFile,
        vassalSeeds: ['http://127.0.0.1/alpha/api/a2a/agent-card', 'http://127.0.0.1/beta/api/a2a/agent-card'],
        dispatchAudit: e => secondAudits.push(e),
      });
      expect(auditsOf(secondAudits).some(a => a.startsWith('recovery-awaiting-operator:awaiting operator:') && a.includes('intent-needs-driver'))).toBe(true);
      // State stays needs-driver; no branch was re-dispatched.
      expect(second.orchestrator.getIntent('intent-needs-driver')?.status).toBe('needs-driver');
    } finally {
      await import('node:fs/promises').then(fs => fs.rm(stateFile, { force: true }));
    }
  });

  it('settles a restored failed intent as failed', async () => {
    const stateFile = `${process.cwd()}/.tmp-recovery-failed-${Date.now()}.json`;
    try {
      const { fetchImpl } = stanceFetch({ alpha: 'fail' });
      const first = await bootKernel({ fetchImpl, stateFile, vassalSeeds: ['http://127.0.0.1/alpha/api/a2a/agent-card'] });
      const result = await first.orchestrator.fanOut({
        intentId: 'intent-failed', skill: 'review', params: { message: 'x' }, realm: 'personal',
        vassals: ['alpha'],
      });
      expect(result.status).toBe('failed');
      await first.saveState();

      const secondAudits: AuditEntry[] = [];
      const second = await bootKernel({
        fetchImpl,
        stateFile,
        vassalSeeds: ['http://127.0.0.1/alpha/api/a2a/agent-card'],
        dispatchAudit: e => secondAudits.push(e),
      });
      expect(auditsOf(secondAudits)).toContain('recovery-settled-failed:settled failed: no-fallback-provider (intent-failed)');
      expect(second.orchestrator.getIntent('intent-failed')?.status).toBe('failed');
    } finally {
      await import('node:fs/promises').then(fs => fs.rm(stateFile, { force: true }));
    }
  });

  it('auto-resume re-enters the fan-out gate and never double-dispatches', async () => {
    // The checkpoint projection is conservative (execute-like, no idempotency
    // declaration) so boot-level auto-resume cannot fire; the executor itself
    // must drive an auto-resume through the idempotency gate exactly once.
    const { fetchImpl, dispatched } = stanceFetch({ alpha: 'approve' });
    const audits: AuditEntry[] = [];
    const first = await bootKernel({
      fetchImpl,
      vassalSeeds: ['http://127.0.0.1/alpha/api/a2a/agent-card'],
      dispatchAudit: e => audits.push(e),
    });
    // Settle once (populates the F2 cache), then execute an auto-resume row
    // twice with the same intentId: the fan-out cache answers the second call.
    const original = await first.orchestrator.fanOut({
      intentId: 'intent-resume', skill: 'review', params: { message: 'x' }, realm: 'personal',
      vassals: ['alpha'],
    });
    expect(original.replayed).toBeUndefined();
    const checkpoint: RecoveryCheckpoint = {
      takenAt: '2026-10-10T00:00:00.000Z',
      intents: [
        {
          intentId: 'intent-resume',
          status: 'needs-driver',
          branch: {
            mode: 'plan',
            skillDeclaresIdempotent: true,
            idempotencyKeyReusable: true,
            unconsumedDelegationNonce: false,
            lastOutcome: 'running',
            hasFallbackProvider: true,
            circuitOpen: false,
            budgetExhausted: false,
          },
        },
      ],
    };
    const records = await executeRecovery(
      checkpoint,
      {
        settleIntent: () => {},
        awaitOperator: () => {},
        autoResume: async intentId => {
          const resumed = await first.orchestrator.fanOut({
            intentId, skill: 'review', params: { message: 'x' }, realm: 'personal', vassals: ['alpha'],
          });
          expect(resumed.replayed).toBe(true);
        },
      },
      { now: () => new Date('2026-10-10T00:00:00.000Z'), audit: e => audits.push(e) },
    );
    expect(records.map(r => r.decision)).toEqual(['recovery-auto-resumed']);
    expect(auditsOf(audits)).toContain('recovery-auto-resumed:auto-resumed intent-resume (resume 1)');
    // F2 single-flight/cache: the second auto-resume call is a replay, not a
    // new dispatch.
    expect(dispatched).toHaveLength(1);
  });

  it('classifies and executes all four verdicts through the executor', async () => {
    const audits: AuditEntry[] = [];
    const actions: string[] = [];
    const checkpoint: RecoveryCheckpoint = {
      takenAt: '2026-10-10T00:00:00.000Z',
      intents: [
        { intentId: 'c', status: 'canceled', branch: { mode: 'execute', skillDeclaresIdempotent: false, idempotencyKeyReusable: false, unconsumedDelegationNonce: false, cancelIssued: true, hasFallbackProvider: false, circuitOpen: false, budgetExhausted: false } },
        { intentId: 'o', status: 'failed', branch: { mode: 'execute', skillDeclaresIdempotent: false, idempotencyKeyReusable: false, unconsumedDelegationNonce: false, lastOutcome: 'failed', hasFallbackProvider: false, circuitOpen: false, budgetExhausted: false } },
        { intentId: 'a', status: 'needs-driver', branch: { mode: 'plan', skillDeclaresIdempotent: true, idempotencyKeyReusable: true, unconsumedDelegationNonce: false, lastOutcome: 'running', hasFallbackProvider: true, circuitOpen: false, budgetExhausted: false } },
        { intentId: 'x', status: 'failed', branch: { mode: 'execute', skillDeclaresIdempotent: false, idempotencyKeyReusable: false, unconsumedDelegationNonce: false, circuitOpen: true, budgetExhausted: false, hasFallbackProvider: false } },
      ],
    };
    const records = await executeRecovery(
      checkpoint,
      {
        settleIntent: (intentId, status) => actions.push(`settle:${intentId}:${status}`),
        awaitOperator: intentId => actions.push(`await:${intentId}`),
        autoResume: async (intentId, resumeNo) => { actions.push(`resume:${intentId}:${resumeNo}`); },
      },
      { now: () => new Date('2026-10-10T00:00:00.000Z'), audit: e => audits.push(e) },
    );
    expect(actions).toEqual(['settle:c:canceled', 'settle:o:failed', 'resume:a:1', 'settle:x:failed']);
    expect(records.map(r => r.decision)).toEqual([
      'recovery-settled-failed', 'recovery-settled-failed', 'recovery-auto-resumed', 'recovery-settled-failed',
    ]);
    expect(records[0]!.detail).toBe('settled canceled (c)');
    expect(audits.filter(e => e.decision.startsWith('recovery-'))).toHaveLength(4);
  });
});
