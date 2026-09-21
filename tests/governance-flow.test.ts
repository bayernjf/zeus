import { describe, expect, it } from 'vitest';
import { VassalRegistry } from '../src/registry/registry.js';
import { Dispatcher, type AuditEntry } from '../src/dispatch/dispatcher.js';
import { memoryAuditSink, revokeAuditBridge } from '../src/dispatch/audit.js';
import type { AgentCard, Task } from '../src/a2a/types.js';

/**
 * Acceptance #5 demonstrable governance loop (design-vassal-protocol.md §7):
 * redaction (dataPolicy), token revocation, and audit logging in one end-to-end
 * run against the real VassalRegistry + Dispatcher wiring.
 */
const CARD_URL = 'http://vassal.internal/api/a2a/agent-card';
const TASK_URL = 'http://vassal.internal/api/a2a/tasks';
const TOKEN = 'zeus-secret';

function prHelperCard(): AgentCard {
  return {
    name: 'pr-helper',
    url: CARD_URL,
    skills: [{ id: 'create-pr', name: 'Create pull request', description: '', tags: [] }],
    'x-zeus-fealty': {
      version: '1',
      swornTo: 'zeus',
      domain: 'pr-release-control',
      dataRealms: ['enterprise'],
      dataPolicy: 'read-task-scope',
      reportBack: true,
      escalationPolicy: 'auto',
    },
  };
}

function finalTask(state: Task['status']['state']): Task {
  return { kind: 'task', id: 'task-1', contextId: 'ctx', status: { state }, artifacts: [] };
}

function sseResponse(): Response {
  const chunks = [
    `data: ${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { kind: 'status-update', taskId: 'task-1', contextId: 'ctx', status: { state: 'working' }, final: false } })}\n\n`,
    `data: ${JSON.stringify({ jsonrpc: '2.0', id: 2, result: finalTask('completed') })}\n\n`,
  ];
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function buildServer() {
  const seen: Array<{ auth: string | null; body: unknown }> = [];
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    if (url === CARD_URL) {
      return new Response(JSON.stringify(prHelperCard()), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url === TASK_URL) {
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
      if (auth !== `Bearer ${TOKEN}`) {
        return new Response(JSON.stringify({ error: { code: -32001, message: 'unauthorized' } }), { status: 401 });
      }
      seen.push({ auth, body: JSON.parse(String(init?.body)) });
      return sseResponse();
    }
    throw new Error(`unexpected url: ${url}`);
  };
  return { fetchImpl, seen };
}

describe('Acceptance #5 governance loop', () => {
  it('dispatches with token + redaction, then revocation blocks all further dispatch and the whole trail is audited', async () => {
    const { fetchImpl, seen } = buildServer();
    const { log, sink } = memoryAuditSink();

    // registry revocation events flow into the SAME audit trail as dispatch decisions
    const registry = new VassalRegistry(fetchImpl, undefined, { onRevoke: revokeAuditBridge(sink) });
    await registry.register(CARD_URL);

    let tokenRequests = 0;
    const dispatcher = new Dispatcher(registry.asVassalLookup(), {
      audit: sink,
      fetchImpl,
      tokenFor: name => {
        tokenRequests += 1;
        return name === 'pr-helper' ? TOKEN : undefined;
      },
    });

    // 1) healthy dispatch: bearer token presented, dispatched + final state audited
    const first = await dispatcher.dispatch({ vassal: 'pr-helper', skill: 'create-pr', params: { repo: 'app' }, realm: 'enterprise', runId: 'run-1' });
    expect(first.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].auth).toBe(`Bearer ${TOKEN}`);

    // 2) redaction: read-task-scope vassal receives only the task-scoped hits offered by the caller
    const second = await dispatcher.dispatch({ vassal: 'pr-helper', skill: 'create-pr', params: {}, realm: 'enterprise', runId: 'run-2', realmHits: [{ itemId: 'hit-9', snippet: 'pr context' }] });
    expect(second.ok).toBe(true);
    const secondBody = seen[1].body as { params: { message: { parts: Array<{ data: Record<string, unknown> }> } } };
    expect(secondBody.params.message.parts[0].data.realmHits).toEqual([{ itemId: 'hit-9', snippet: 'pr context' }]);
    expect(tokenRequests).toBe(2);

    // 3) revocation: governance event lands on the audit trail
    expect(registry.revoke('pr-helper')).toBe(true);
    const revokeEntry = log.find(entry => entry.decision === 'vassal-revoked');
    expect(revokeEntry).toMatchObject({ vassal: 'pr-helper' });

    // 4) named dispatch after revocation: blocked BEFORE any HTTP request or token issuance
    const blocked = await dispatcher.dispatch({ vassal: 'pr-helper', skill: 'create-pr', params: {}, realm: 'enterprise', runId: 'run-3' });
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.audit.decision).toBe('refused-revoked');
    expect(seen).toHaveLength(2); // no new request reached the vassal
    expect(tokenRequests).toBe(2); // tokenFor never consulted for a revoked vassal

    // 5) skill-based auto-selection skips the revoked vassal as well
    const auto = await dispatcher.dispatch({ skill: 'create-pr', params: {}, realm: 'enterprise', runId: 'run-4' });
    expect(auto.ok).toBe(false);
    if (auto.ok) return;
    expect(auto.audit.decision).toBe('refused-unknown-vassal');
    expect(seen).toHaveLength(2);

    // complete audit trail, in order
    expect(log.map((entry: AuditEntry) => entry.decision)).toEqual([
      'dispatched', 'dispatched', // run-1
      'dispatched', 'dispatched', // run-2
      'vassal-revoked',
      'refused-revoked', // run-3 named
      'refused-unknown-vassal', // run-4 auto-selected
    ]);
  });

  it('refuses to dispatch realm content the fealty does not allow (data diode)', async () => {
    const { fetchImpl, seen } = buildServer();
    const { log, sink } = memoryAuditSink();
    const registry = new VassalRegistry(fetchImpl);
    await registry.register(CARD_URL);
    const dispatcher = new Dispatcher(registry.asVassalLookup(), { audit: sink, fetchImpl, tokenFor: () => TOKEN });

    const result = await dispatcher.dispatch({ vassal: 'pr-helper', skill: 'create-pr', params: {}, realm: 'personal', runId: 'run-x' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.audit.decision).toBe('refused-realm-policy');
    expect(seen).toHaveLength(0); // blocked before the network
    expect(log[0]).toMatchObject({ decision: 'refused-realm-policy', vassal: 'pr-helper', realm: 'personal' });
  });
});
