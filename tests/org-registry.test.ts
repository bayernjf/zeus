import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OrgRegistry, OrgError } from '../src/index.js';
import type { FanOutResult, BranchOutcome } from '../src/orchestrator/types.js';
import { bootKernel } from '../src/state/boot.js';

function fanOut(partial: Partial<FanOutResult> & { branches: BranchOutcome[] }): FanOutResult {
  return {
    intentId: 'intent-1',
    runId: 'run-1',
    skill: 'code-review',
    realm: 'personal',
    stream: [],
    positions: [],
    decision: { rule: 'majority', conclusion: null, positions: [], reason: '' },
    conflicts: [],
    status: 'completed',
    createdAt: '2026-09-23T09:00:00.000Z',
    ...partial,
  };
}
function branch(vassal: string): BranchOutcome {
  return { vassal, runId: `run-${vassal}`, ok: true, events: [] };
}

describe('OrgRegistry establishment operations', () => {
  it('creates departments and rejects duplicate ids', () => {
    const org = new OrgRegistry(() => new Date('2026-09-24T00:00:00Z'));
    const dept = org.createDepartment({ name: 'Engineering', mission: 'build' });
    expect(dept.departmentId).toBe('dept:engineering');
    expect(() => org.createDepartment({ name: 'Engineering', mission: 'other' })).toThrow(OrgError);
  });

  it('assigns members, tracks the lead and rejects duplicates', () => {
    const org = new OrgRegistry();
    org.createDepartment({ name: 'Engineering', mission: 'build' });
    org.assignMember('dept:engineering', { agentId: 'agent-b', role: 'lead' });
    org.assignMember('dept:engineering', { agentId: 'agent-a', title: 'Reviewer' });
    expect(org.getDepartment('dept:engineering').lead).toBe('agent-b');
    expect(() => org.assignMember('dept:engineering', { agentId: 'agent-a' })).toThrow(OrgError);
    expect(() => org.getDepartment('dept:nope')).toThrow(OrgError);
  });

  it('changes the lead and removes members', () => {
    const org = new OrgRegistry();
    org.createDepartment({ name: 'Engineering', mission: 'build' });
    org.assignMember('dept:engineering', { agentId: 'agent-b', role: 'lead' });
    org.assignMember('dept:engineering', { agentId: 'agent-a' });
    org.setLead('dept:engineering', 'agent-a');
    expect(org.getDepartment('dept:engineering').lead).toBe('agent-a');
    org.removeMember('dept:engineering', 'agent-b');
    expect(org.getDepartment('dept:engineering').members.map(m => m.agentId)).toEqual(['agent-a']);
  });

  it('projects the chart and renders markdown', () => {
    const org = new OrgRegistry();
    org.createDepartment({ name: 'Eng', mission: 'build' });
    org.assignMember('dept:eng', { agentId: 'agent-a' });
    expect(org.chart()[0]).toMatchObject({ departmentId: 'dept:eng', headcount: 1 });
    expect(org.renderMarkdown()).toContain('## Eng · dept:eng');
    expect(org.listDepartments()).toHaveLength(1);
  });

  it('traces accountability from a fan-out result', () => {
    const org = new OrgRegistry();
    org.createDepartment({ name: 'Engineering', mission: 'build' });
    org.assignMember('dept:engineering', { agentId: 'agent-b', role: 'lead' });
    org.assignMember('dept:engineering', { agentId: 'agent-a' });
    const chain = org.accountability(fanOut({ branches: [branch('agent-a'), branch('agent-c')] }));
    expect(chain.leads.map(n => n.agentId)).toEqual(['agent-b']);
    expect(chain.unassigned).toEqual(['agent-c']);
  });
});

describe('OrgRegistry export/import', () => {
  it('round-trips state and stays independent of the exported array', () => {
    const org = new OrgRegistry();
    org.createDepartment({ name: 'Eng', mission: 'build' });
    const exported = org.exportState();
    const restored = new OrgRegistry();
    restored.importState(exported);
    expect(restored.listDepartments()[0].departmentId).toBe('dept:eng');

    exported[0].name = 'HACKED';
    expect(org.listDepartments()[0].name).toBe('Eng');
  });

  it('rejects malformed state', () => {
    const org = new OrgRegistry();
    expect(() => org.importState([{ format: 'wrong' }] as never)).toThrow(OrgError);
    expect(() => org.importState('nope' as never)).toThrow(OrgError);
  });
});

let dir: string;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('E9.3 org kernel persistence', () => {
  it('restores the department establishment across restart', async () => {
    dir = await mkdtemp(join(tmpdir(), 'zeus-org-'));
    const stateFile = join(dir, 'kernel.json');

    const first = await bootKernel({ stateFile });
    first.orgRegistry!.createDepartment({ name: 'Engineering', mission: 'build' });
    first.orgRegistry!.assignMember('dept:engineering', { agentId: 'agent-b', role: 'lead' });
    first.orgRegistry!.assignMember('dept:engineering', { agentId: 'agent-a', title: 'Reviewer' });
    await first.saveState();

    const second = await bootKernel({ stateFile });
    expect(second.restoredFromSnapshot).toBe(true);
    const dept = second.orgRegistry!.getDepartment('dept:engineering');
    expect(dept.lead).toBe('agent-b');
    expect(dept.members.map(m => m.agentId).sort()).toEqual(['agent-a', 'agent-b']);
    expect(dept.members.find(m => m.agentId === 'agent-a')?.title).toBe('Reviewer');
  });
});
