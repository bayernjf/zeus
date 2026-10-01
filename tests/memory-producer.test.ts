import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bootKernel } from '../src/state/boot.js';
import { MemoryStore } from '../src/memory/memory-store.js';
import { branchVerdictClaims, claimPredicate, claimSubject, MAX_STANCE_CHARS } from '../src/memory/producer.js';
import { isClaimContent } from '../src/memory/consolidate.js';
import type { FanOutRequest, FanOutResult } from '../src/orchestrator/types.js';
import type { AgentCard } from '../src/a2a/types.js';

/**
 * The memory layer was complete and tested end to end - except for the thing
 * that puts data into it. Nothing outside src/memory ever appended an event, so
 * a running process folded an empty log into no facts and every dependent face
 * (recall, disputes, forgetting, diary) returned empty while looking healthy.
 * These cases pin the producer that closes that hole, and the last group is the
 * regression that would have caught the gap years of unit tests could not see.
 */

function fanOut(overrides: Partial<FanOutResult> = {}): FanOutResult {
  const base = {
    intentId: 'intent-1',
    runId: 'run-1',
    skill: 'research',
    realm: 'personal',
    realmId: 'realm-a',
    branches: [
      { vassal: 'vassal-a', runId: 'run-1', ok: true, taskId: 't-a', events: [] },
      { vassal: 'vassal-b', runId: 'run-1', ok: true, taskId: 't-b', events: [] },
    ],
    stream: [],
    positions: [
      { vassal: 'vassal-a', stance: 'typescript' },
      { vassal: 'vassal-b', stance: 'typescript' },
    ],
    decision: { rule: 'unanimous', conclusion: 'typescript', positions: [], reason: 'unanimous' },
    conflicts: [],
    status: 'completed',
    createdAt: '2026-09-27T00:00:00.000Z',
  } as unknown as FanOutResult;
  return { ...base, ...overrides };
}

function request(overrides: Partial<FanOutRequest> = {}): FanOutRequest {
  return { skill: 'research', realm: 'personal', params: { q: 'language of pr-helper' }, ...overrides } as FanOutRequest;
}

const claimOptions = { realmId: 'realm-a', occurredAt: '2026-09-27T00:00:00.000Z' };

describe('branchVerdictClaims (the claim contract)', () => {
  it('turns every stance into a claim the consolidator can actually use', () => {
    const events = branchVerdictClaims(fanOut(), request(), claimOptions);
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.kind).toBe('claim');
      // Not merely shaped - isClaimContent is the gate consolidate.ts applies
      // before an event becomes a fact, so a claim failing it is a silent no-op.
      expect(isClaimContent(event.content)).toBe(true);
      expect(event.realmId).toBe('realm-a');
      expect(event.source.taskId).toMatch(/^t-/);
      expect(event.confidence).toBe(0.5);
    }
    expect(events.map(e => e.source.agentId)).toEqual(['vassal-a', 'vassal-b']);
  });

  it('derives a subject that repeats across runs, because repetition is what makes a dispute possible', () => {
    const same = claimSubject(request());
    const otherRun = fanOut({ runId: 'run-2', intentId: 'intent-2' });
    expect(claimSubject(request())).toBe(same);
    // Different question, different subject.
    expect(claimSubject(request({ params: { q: 'something else' } }))).not.toBe(same);
    expect(claimPredicate(request())).toBe('research');
    // A per-intent subject would never collide and would make the whole layer
    // write-once-read-never; assert the derived key does not contain the intent.
    const events = branchVerdictClaims(otherRun, request(), claimOptions);
    expect((events[0].content as { subject: string }).subject).toBe(same);
  });

  it('honours an explicit subject and predicate from the request', () => {
    const events = branchVerdictClaims(fanOut(), request({ params: { subject: 'pr-helper', predicate: 'primary-language' } }), claimOptions);
    for (const event of events) {
      expect(event.content).toMatchObject({ subject: 'pr-helper', predicate: 'primary-language' });
    }
  });

  it('is idempotent per run and refuses to grow on replay', async () => {
    const store = new MemoryStore();
    const events = branchVerdictClaims(fanOut(), request(), claimOptions);
    for (const event of events) store.append(event);
    for (const event of branchVerdictClaims(fanOut(), request(), claimOptions)) store.append(event);
    expect(store.exportState().events).toHaveLength(2);
    expect(store.counts().facts).toBe(0); // nothing consolidated yet
  });

  it('truncates a long stance, drops blank ones, and records one event per distinct answer', () => {
    const long = 'x'.repeat(MAX_STANCE_CHARS + 200);
    const events = branchVerdictClaims(
      fanOut({
        positions: [
          { vassal: 'vassal-a', stance: long },
          { vassal: 'vassal-b', stance: '   ' },
          { vassal: 'vassal-b', stance: 'typescript' },
          { vassal: 'vassal-b', stance: 'typescript' },
        ],
      }),
      request(),
      claimOptions,
    );
    expect(events).toHaveLength(2);
    const truncated = (events[0].content as { object: string }).object;
    expect(truncated.length).toBe(MAX_STANCE_CHARS);
    expect(truncated.endsWith('…')).toBe(true);
    expect((events[1].content as { object: string }).object).toBe('typescript');
  });

  it('produces nothing for an intent with no stances, so an empty fan-out cannot fake a fact source', () => {
    expect(branchVerdictClaims(fanOut({ positions: [] }), request(), claimOptions)).toEqual([]);
  });

  it('#16 keys a claim by realm too, so one run across two realms does not collide', () => {
    const result = fanOut();
    const req = request();
    const personal = branchVerdictClaims(result, req, { realmId: 'realm-a', occurredAt: '2026-09-27T00:00:00.000Z' });
    const enterprise = branchVerdictClaims(result, req, { realmId: 'realm-b', occurredAt: '2026-09-27T00:00:00.000Z' });
    // Same run, same vassal, same stance - but a different realm is a different
    // claim, or the second realm's event would be dropped by dedupe.
    expect(personal[0].eventId).not.toBe(enterprise[0].eventId);
    // Within one realm the id is still stable, so a replay stays idempotent.
    const replay = branchVerdictClaims(result, req, { realmId: 'realm-a', occurredAt: '2026-09-27T00:00:00.000Z' });
    expect(replay[0].eventId).toBe(personal[0].eventId);
  });
});

describe('runtime producer (bootKernel, end to end)', () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  function cardFor(name: string): AgentCard {
    return {
      name,
      url: `http://127.0.0.1/${name}`,
      skills: [{ id: 'research', name: 'Research', description: '', tags: [] }],
      'x-zeus-fealty': {
        version: '1', swornTo: 'zeus', domain: 'test-domain',
        dataRealms: ['personal'], dataPolicy: 'read-task-scope', reportBack: true, escalationPolicy: 'auto',
      },
    } as unknown as AgentCard;
  }

  /** One fetch serving cards for any name and a per-vassal stance over SSE. */
  function fetchServing(stances: Record<string, string>): typeof fetch {
    return (async (input: RequestInfo | URL) => {
      const url = String(input);
      const name = url.split('/')[3];
      if (url.includes('/api/a2a/agent-card')) {
        return new Response(JSON.stringify(cardFor(name)), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      const stance = stances[name] ?? 'approve';
      const task = {
        kind: 'task', id: `${name}-task`, contextId: 'ctx', status: { state: 'completed' },
        artifacts: [{ artifactId: 'a', name: 'verdict', parts: [{ kind: 'data', data: { stance } }] }],
      };
      const frames = [
        `data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { kind: 'status-update', taskId: `${name}-task`, contextId: 'ctx', status: { state: 'working' }, final: false } })}\n\n`,
        `data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: task })}\n\n`,
      ];
      return new Response(frames.join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }) as typeof fetch;
  }

  const seeds = ['vassal-a', 'vassal-b'].map(name => `http://127.0.0.1/${name}/api/a2a/agent-card`);

  async function boot(stances: Record<string, string>, audit: Array<Record<string, unknown>> = []) {
    dir = await mkdtemp(join(tmpdir(), 'zeus-mem-producer-'));
    const kernel = await bootKernel({
      fetchImpl: fetchServing(stances),
      vassalSeeds: seeds,
      realmRoots: [dir],
      dispatchAudit: entry => audit.push({ ...entry }),
    });
    const realmId = kernel.realmStore!.connections()[0].realmId;
    return { kernel, realmId };
  }

  it('a finished fan-out leaves claims and facts in the store - the gap deferred #27 described', async () => {
    const { kernel, realmId } = await boot({ 'vassal-a': 'typescript', 'vassal-b': 'typescript' });
    const result = await kernel.orchestrator.fanOut({
      skill: 'research', realm: 'personal', realmId,
      params: { subject: 'pr-helper', predicate: 'primary-language', q: 'what language' },
    });
    expect(result.status).toBe('completed');

    const events = kernel.memoryStore!.exportState().events;
    expect(events).toHaveLength(2);
    expect(events.every(e => e.kind === 'claim' && e.realmId === realmId)).toBe(true);
    // Consolidation is wired on the same seam, so the intent has already folded:
    // two authors agreeing produce ONE fact carrying both provenances.
    const facts = kernel.memoryStore!.facts(realmId, realmId);
    expect(facts).toHaveLength(1);
    expect(facts[0].provenance).toHaveLength(2);
    expect(facts[0].subject).toBe('pr-helper');
  });

  it('disagreement between authors becomes a memory dispute on the desk', async () => {
    const { kernel, realmId } = await boot({ 'vassal-a': 'typescript', 'vassal-b': 'python' });
    await kernel.orchestrator.fanOut({
      skill: 'research', realm: 'personal', realmId,
      params: { subject: 'pr-helper', predicate: 'primary-language' },
      aggregation: { kind: 'unanimous' },
    });
    const disputes = kernel.oversight.list('pending', 'memory-dispute');
    expect(disputes).toHaveLength(1);
    expect(disputes[0].conflictingFacts?.length ?? 0).toBeGreaterThan(0);
  });

  it('drops claims for a realm that is no longer mounted, and says so on the audit spine', async () => {
    const audit: Array<Record<string, unknown>> = [];
    const { kernel } = await boot({ 'vassal-a': 'typescript', 'vassal-b': 'typescript' }, audit);
    const result = await kernel.orchestrator.fanOut({
      skill: 'research', realm: 'personal', realmId: 'realm-never-mounted',
      params: { subject: 'pr-helper', predicate: 'primary-language' },
    });
    expect(result.status).toBe('completed');
    expect(kernel.memoryStore!.exportState().events).toHaveLength(0);
    const skipped = audit.filter(entry => entry.decision === 'memory-claim-skipped');
    expect(skipped).toHaveLength(1);
    expect(String(skipped[0].detail)).toContain('realm-never-mounted');
  });

  it('an intent that named no realm stays out of memory, so no claim lands without an owner', async () => {
    const { kernel } = await boot({ 'vassal-a': 'typescript', 'vassal-b': 'typescript' });
    await kernel.orchestrator.fanOut({ skill: 'research', realm: 'personal', params: { subject: 'x' } });
    expect(kernel.memoryStore!.exportState().events).toHaveLength(0);
  });
});
