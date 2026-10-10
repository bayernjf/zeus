import { describe, expect, it } from 'vitest';
import { bootKernel } from '../src/state/boot.js';
import { PlanFlow, extractPlanDraft, PLANNER_TAG } from '../src/orchestrator/plan-flow.js';
import type { AuditEntry } from '../src/dispatch/dispatcher.js';
import type { AgentCard, Artifact } from '../src/a2a/types.js';

/**
 * S12 V2 (design-planning §5): planning wired into the runtime as a fan-out.
 * V1 shipped the pure scorer; V2 closes the loop — planner skills are found by
 * their `planning` tag, fan-out carries the goal + catalogue snapshot to every
 * planner, the structured DagSpec draft is read from the task data part, and
 * the deterministic select/escalate decision lands on the audit spine while a
 * selected plan is handed to the DAG runner for execution.
 */

const PLANNER_CARD: AgentCard = {
  name: 'alpha',
  url: 'http://127.0.0.1/alpha/api/a2a/tasks',
  version: '0.1.0',
  provider: { organization: 'bayjf', url: 'http://bayjf.test' },
  capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: true },
  defaultInputModes: ['application/json'],
  defaultOutputModes: ['application/json'],
  skills: [
    { id: 'planning', name: 'Planning', description: 'compose a research-and-write plan from a goal', tags: [PLANNER_TAG] },
    { id: 'research', name: 'Research', description: 'search and gather evidence on a topic', tags: [] },
    { id: 'write', name: 'Write', description: 'produce the final document', tags: [] },
  ],
  authentication: { schemes: ['bearer'] },
  preferredTransport: 'JSONRPC',
  'x-zeus-fealty': {
    version: '1', swornTo: 'zeus', domain: 'test-domain',
    dataRealms: ['personal'], dataPolicy: 'read-task-scope',
    reportBack: true, escalationPolicy: 'on-failure',
  },
};

/** Planner returns one structured draft per branch (data part key `plan`). */
function approveFetch(draftFor: (name: string) => unknown): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const name = url.split('/')[3]!;
    if (url.includes('/api/a2a/agent-card')) {
      return new Response(JSON.stringify(cardForName(name)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const draft = draftFor(name);
    const task = {
      kind: 'task',
      id: `${name}-task`,
      contextId: 'ctx',
      status: { state: 'completed' },
      artifacts: [{ artifactId: 'a', name: 'plan', parts: [{ kind: 'data', data: { plan: draft } }] }],
    };
    return new Response(
      `data: ${JSON.stringify({ jsonrpc: '2.0', id: 2, result: task })}\n\n`,
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    );
  }) as typeof fetch;
}

/** A card named after the agent that carries the planning tag, so every seeded
 *  planner registers its own catalogue entry and provider. */
function cardForName(name: string): AgentCard {
  return { ...PLANNER_CARD, name, url: `http://127.0.0.1/${name}/api/a2a/tasks` };
}

const SEED = 'http://127.0.0.1/alpha/api/a2a/agent-card';

/** A valid draft: research then write, both skills in the catalogue. */
function goodDraft() {
  return {
    realm: 'personal',
    nodes: [
      { id: 'n1', skill: 'research' },
      { id: 'n2', skill: 'write', dependsOn: ['n1'] },
    ],
  };
}

describe('S12 V2 plan flow wiring', () => {
  it('extracts the structured draft from a task data part and refuses free text', () => {
    const artifacts: Artifact[] = [
      { artifactId: 'a', name: 'plan', parts: [{ kind: 'data', data: { plan: goodDraft() } }] },
    ];
    const extracted = extractPlanDraft(artifacts);
    expect(extracted?.nodes).toHaveLength(2);
    expect(extracted?.realm).toBe('personal');

    expect(extractPlanDraft([{ artifactId: 'a', name: 'plan', parts: [{ kind: 'text', text: 'I would research first.' }] }])).toBeUndefined();
    expect(extractPlanDraft([{ artifactId: 'a', name: 'plan', parts: [{ kind: 'data', data: { summary: 'no plan key' } }] }])).toBeUndefined();
  });

  it('fans out to the planner, selects the single feasible draft, audits plan-selected and executes the DAG', async () => {
    const audit: AuditEntry[] = [];
    const kernel = await bootKernel({
      fetchImpl: approveFetch(() => goodDraft()),
      vassalSeeds: [SEED],
      dispatchAudit: (entry) => audit.push(entry),
    });
    const flow = new PlanFlow({
      orchestrator: kernel.orchestrator,
      skillRegistry: kernel.skillRegistry!,
      dagRunner: kernel.dagRunner,
      audit: (entry) => audit.push(entry),
    });

    const result = await flow.run({
      goal: { description: 'research the topic then write the document' },
      realm: 'personal',
    });

    expect(result.kind).toBe('selected');
    if (result.kind !== 'selected') return;
    expect(result.planner).toBe('alpha');
    expect(result.dag?.state).toBe('completed');
    expect(audit.some((entry) => entry.decision === 'plan-selected')).toBe(true);
    // The dag nodes ran through the shared orchestrator: two node intents.
    const dag = result.dag!;
    expect(dag.nodes).toHaveLength(2);
    expect(dag.nodes.every((node) => node.state === 'completed')).toBe(true);
  });

  it('escalates a close contest as plan-conflict through the oversight desk', async () => {
    const audit: AuditEntry[] = [];
    const kernel = await bootKernel({
      fetchImpl: approveFetch((name) =>
        name === 'beta'
          ? { realm: 'personal', nodes: [{ id: 'n1', skill: 'research' }, { id: 'n2', skill: 'write', dependsOn: ['n1'] }] }
          : { realm: 'personal', nodes: [{ id: 'n1', skill: 'research' }, { id: 'n2', skill: 'write', dependsOn: ['n1'] }] },
      ),
      // Two planners with identical coverage produce a tie inside the default
      // threshold -> plan-conflict, not a silent selection.
      vassalSeeds: [SEED, 'http://127.0.0.1/beta/api/a2a/agent-card'],
      dispatchAudit: (entry) => audit.push(entry),
    });
    const flow = new PlanFlow({
      orchestrator: kernel.orchestrator,
      skillRegistry: kernel.skillRegistry!,
      oversight: kernel.oversight,
      audit: (entry) => audit.push(entry),
      tieThreshold: 0.5,
    });

    const result = await flow.run({
      goal: { description: 'research the topic then write the document' },
      realm: 'personal',
    });

    expect(result.kind).toBe('conflict');
    if (result.kind !== 'conflict') return;
    expect(result.planners.length).toBeGreaterThan(0);
    expect(result.escalated.kind).toBe('intent-conflict');
    expect(kernel.oversight.list('pending', 'intent-conflict').length).toBeGreaterThan(0);
    expect(audit.some((entry) => entry.decision === 'plan-conflict')).toBe(true);
  });

  it('marks a draft that references an unknown skill as unplannable and escalates', async () => {
    const audit: AuditEntry[] = [];
    const kernel = await bootKernel({
      fetchImpl: approveFetch(() => ({
        realm: 'personal',
        nodes: [{ id: 'n1', skill: 'research' }, { id: 'n2', skill: 'missing-skill', dependsOn: ['n1'] }],
      })),
      vassalSeeds: [SEED],
      dispatchAudit: (entry) => audit.push(entry),
    });
    const flow = new PlanFlow({
      orchestrator: kernel.orchestrator,
      skillRegistry: kernel.skillRegistry!,
      oversight: kernel.oversight,
      audit: (entry) => audit.push(entry),
    });

    const result = await flow.run({
      goal: { description: 'research the topic then write the document' },
      realm: 'personal',
    });

    expect(result.kind).toBe('unplannable');
    if (result.kind !== 'unplannable') return;
    expect(result.reasons.some((reason) => reason.includes('missing-skill'))).toBe(true);
    expect(result.escalated?.kind).toBe('intent-conflict');
    expect(audit.some((entry) => entry.decision === 'plan-rejected-unplannable')).toBe(true);
  });

  it('audits plan-malformed and refuses to run when the draft is not structured', async () => {
    const audit: AuditEntry[] = [];
    const kernel = await bootKernel({
      fetchImpl: approveFetch(() => ({ prose: 'I would start by researching.' })),
      vassalSeeds: [SEED],
      dispatchAudit: (entry) => audit.push(entry),
    });
    const flow = new PlanFlow({
      orchestrator: kernel.orchestrator,
      skillRegistry: kernel.skillRegistry!,
      audit: (entry) => audit.push(entry),
    });

    const result = await flow.run({
      goal: { description: 'research the topic then write the document' },
      realm: 'personal',
    });

    expect(result.kind).toBe('unplannable');
    expect(audit.some((entry) => entry.decision === 'plan-malformed')).toBe(true);
  });

  it('returns the selected plan without executing when confirmation is required', async () => {
    const kernel = await bootKernel({
      fetchImpl: approveFetch(() => goodDraft()),
      vassalSeeds: [SEED],
    });
    const flow = new PlanFlow({
      orchestrator: kernel.orchestrator,
      skillRegistry: kernel.skillRegistry!,
      dagRunner: kernel.dagRunner,
    });

    const result = await flow.run({
      goal: { description: 'research the topic then write the document' },
      realm: 'personal',
      requireConfirmation: true,
    });

    expect(result.kind).toBe('selected');
    if (result.kind !== 'selected') return;
    expect(result.dag).toBeUndefined();
    expect(result.plan.nodes).toHaveLength(2);
  });
});
