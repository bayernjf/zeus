import { describe, expect, it } from 'vitest';
import { bootKernel } from '../src/state/boot.js';
import { SkillRegistry } from '../src/skills/registry.js';
import type { AgentCard } from '../src/a2a/types.js';

function cardFor(name: string): AgentCard {
  return {
    name,
    url: `http://127.0.0.1/${name}`,
    skills: [{ id: 'research', name: 'Research', description: '', tags: [] }],
    'x-zeus-fealty': {
      version: '1', swornTo: 'zeus', domain: 'test-domain',
      dataRealms: ['personal', 'enterprise'], dataPolicy: 'read-task-scope',
      reportBack: true, escalationPolicy: 'auto',
    },
  };
}

/** Fetch mock serving N vassal cards and recording who gets dispatched. */
function fetchFor(names: string[], calls: string[]): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/a2a/agent-card')) {
      const name = url.split('/')[3];
      return new Response(JSON.stringify(cardFor(name)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const name = url.split('/')[3];
    calls.push(name);
    const task = {
      kind: 'task',
      id: `${name}-task`,
      contextId: 'ctx',
      status: { state: 'completed' },
      artifacts: [{ artifactId: 'a', name: 'verdict', parts: [{ kind: 'data', data: { stance: 'approve' } }] }],
    };
    const frames = [
      `data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { kind: 'status-update', taskId: `${name}-task`, contextId: 'ctx', status: { state: 'working' }, final: false } })}\n\n`,
      `data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: task })}\n\n`,
    ];
    return new Response(frames.join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }) as typeof fetch;
}

const seeds = (names: string[]) => names.map(name => `http://127.0.0.1/${name}/api/a2a/agent-card`);

describe('SkillRegistry.activeProviders (governance read for the dispatch gate)', () => {
  it('returns undefined for an unregistered skill, providers for a registered one, [] after uninstall', () => {
    const registry = new SkillRegistry();
    expect(registry.activeProviders('never-registered')).toBeUndefined();

    registry.register({ id: 'research', name: 'Research', description: '', version: '1.0.0', providedBy: ['vassal-a'], tags: [] });
    expect(registry.activeProviders('research')).toEqual(['vassal-a']);

    registry.uninstall('research');
    expect(registry.activeProviders('research')).toEqual([]);
  });

  it('card catalogue entries make card-advertised vassals active providers', () => {
    const registry = new SkillRegistry();
    registry.registerFromCard(cardFor('vassal-b'));
    expect(registry.activeProviders('research')).toEqual(['vassal-b']);
  });
});

describe('E2.2/E2.3/E2.4 skill governor on the fan-out path (boot, end-to-end)', () => {
  it('auto-selection passes through for a card-advertised skill (catalogue active)', async () => {
    const calls: string[] = [];
    const kernel = await bootKernel({ fetchImpl: fetchFor(['vassal-a'], calls), vassalSeeds: seeds(['vassal-a']) });
    const result = await kernel.orchestrator.fanOut({ skill: 'research', realm: 'personal', params: { q: 1 } });
    expect(result.status).toBe('completed');
    expect(result.refused).toBeUndefined();
    expect(calls).toContain('vassal-a');
  });

  it('uninstalling the skill refuses auto-selection and audits it', async () => {
    const calls: string[] = [];
    const audit: Array<Record<string, unknown>> = [];
    const kernel = await bootKernel({
      fetchImpl: fetchFor(['vassal-a'], calls),
      vassalSeeds: seeds(['vassal-a']),
      dispatchAudit: entry => audit.push({ ...entry }),
    });
    kernel.skillRegistry!.uninstall('research');
    const result = await kernel.orchestrator.fanOut({ skill: 'research', realm: 'personal', params: { q: 1 } });
    expect(result.status).toBe('failed');
    expect(result.refused?.reason).toBe('skill-uninstalled');
    expect(calls).not.toContain('vassal-a');
    expect(audit.some(entry => entry.decision === 'refused-skill-uninstalled' && entry.skill === 'research')).toBe(true);
  });

  it('an explicit spec narrows auto-selection to its providedBy (card claims are not trusted verbatim)', async () => {
    const calls: string[] = [];
    const kernel = await bootKernel({
      fetchImpl: fetchFor(['vassal-a', 'vassal-b'], calls),
      vassalSeeds: seeds(['vassal-a', 'vassal-b']),
    });
    // Both cards advertise research; the explicit spec names only vassal-a.
    kernel.skillRegistry!.register({
      id: 'research', name: 'Research', description: '', version: '2.0.0', providedBy: ['vassal-a'], tags: [],
    });
    const result = await kernel.orchestrator.fanOut({ skill: 'research', realm: 'personal', params: { q: 1 } });
    expect(result.status).toBe('completed');
    expect(result.refused).toBeUndefined();
    expect(calls).toEqual(['vassal-a']);
  });

  it('a skill with a catalogue record but no overlap with card claims refuses', async () => {
    const calls: string[] = [];
    const kernel = await bootKernel({
      fetchImpl: fetchFor(['vassal-a'], calls),
      vassalSeeds: seeds(['vassal-a']),
    });
    // Explicit spec names a provider that is not the registered vassal.
    kernel.skillRegistry!.register({
      id: 'research', name: 'Research', description: '', version: '2.0.0', providedBy: ['some-other-agent'], tags: [],
    });
    const result = await kernel.orchestrator.fanOut({ skill: 'research', realm: 'personal', params: { q: 1 } });
    expect(result.status).toBe('failed');
    expect(result.refused?.reason).toBe('no-active-provider');
    expect(calls).toEqual([]);
  });

  it('an unregistered skill stays a pass-through (no refusal)', async () => {
    const calls: string[] = [];
    const kernel = await bootKernel({ fetchImpl: fetchFor(['vassal-a'], calls), vassalSeeds: seeds(['vassal-a']) });
    const result = await kernel.orchestrator.fanOut({ skill: 'research', realm: 'personal', params: { q: 1 } });
    expect(result.status).toBe('completed');
    expect(result.refused).toBeUndefined();
  });

  it('driver-named explicit vassals bypass the governor (deliberate override)', async () => {
    const calls: string[] = [];
    const kernel = await bootKernel({ fetchImpl: fetchFor(['vassal-a'], calls), vassalSeeds: seeds(['vassal-a']) });
    kernel.skillRegistry!.uninstall('research');
    const result = await kernel.orchestrator.fanOut({
      skill: 'research', realm: 'personal', params: { q: 1 }, vassals: ['vassal-a'],
    });
    expect(result.status).toBe('completed');
    expect(result.refused).toBeUndefined();
    expect(calls).toContain('vassal-a');
  });
});
