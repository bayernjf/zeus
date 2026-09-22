import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FetchLike } from '../src/registry/registry.js';
import { bootKernel } from '../src/state/boot.js';
import type { AgentCard } from '../src/a2a/types.js';

const CARD_URL = 'https://vassal.example/api/a2a/agent-card';

const card: AgentCard = {
  name: 'vassal-1',
  url: 'https://vassal.example',
  skills: [{ id: 'research', name: 'Research', description: 'researches', tags: ['web'] }],
  'x-zeus-fealty': {
    version: '1', swornTo: 'zeus', domain: 'work', dataRealms: ['personal'],
    dataPolicy: 'read-task-scope', reportBack: true, escalationPolicy: 'on-failure',
  },
};

const fetchImpl: FetchLike = async url =>
  url === CARD_URL
    ? new Response(JSON.stringify(card), { status: 200, headers: { 'content-type': 'application/json' } })
    : new Response('nope', { status: 404 });

describe('E2.1 skill registry boot assembly and persistence', () => {
  it('imports card skills when a vassal registers and restores the catalogue after restart', async () => {
    const stateFile = join(tmpdir(), `zeus-skills-${crypto.randomUUID()}.json`);

    const first = await bootKernel({ stateFile, vassalSeeds: [CARD_URL], fetchImpl });
    const imported = first.skillRegistry!.get('research');
    expect(imported).toBeDefined();
    expect(imported!.providedBy).toEqual(['vassal-1']);
    expect(imported!.tags).toEqual(['web']);
    await first.saveState();

    const restarted = await bootKernel({ stateFile, fetchImpl });
    const restored = restarted.skillRegistry!.get('research');
    expect(restored!.providedBy).toEqual(['vassal-1']);
  });

  it('always assembles a skill registry even with no state file', () =>
    bootKernel({}).then(kernel => expect(kernel.skillRegistry).toBeDefined()));
});
