import { describe, it, expect } from 'vitest';
import {
  createDepartment,
  assignMember,
  removeMember,
  setLead,
  slug,
  buildOrgChart,
  renderOrgMarkdown,
  traceAccountability,
  OrgError,
} from '../src/index.js';
import type { Department } from '../src/index.js';
import type { FanOutResult, BranchOutcome } from '../src/orchestrator/types.js';

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

describe('createDepartment / slug', () => {
  it('creates a department with a deterministic id and no members', () => {
    const d = createDepartment({ name: 'Engineering Team', mission: 'build the kernel' });
    expect(d.departmentId).toBe('dept:engineering-team');
    expect(d.members).toEqual([]);
    expect(d.name).toBe('Engineering Team');
  });

  it('requires name and mission', () => {
    expect(() => createDepartment({ name: '', mission: 'm' })).toThrow(OrgError);
    expect(() => createDepartment({ name: 'n', mission: '' })).toThrow(OrgError);
  });

  it('rejects names that produce an empty slug', () => {
    expect(() => slug('---')).toThrow(OrgError);
    expect(slug('QA! Dept')).toBe('qa-dept');
  });

  it('establishes a department whose name has no ASCII slug', async () => {
    const { createDepartment, departmentIdFor } = await import('../src/org/department.js');
    const a = createDepartment({ name: '研发部', mission: '交付' }, '2026-09-25T00:00:00.000Z');
    const b = createDepartment({ name: '研发部', mission: '交付' }, '2026-09-25T00:00:00.000Z');
    const c = createDepartment({ name: '发布工程组', mission: '交付' }, '2026-09-25T00:00:00.000Z');

    expect(a.departmentId).toBe(departmentIdFor('研发部'));
    expect(a.departmentId).toMatch(/^dept:[a-f0-9]{8}$/);
    expect(a.departmentId).toBe(b.departmentId); // stable, so a restart re-derives it
    expect(a.departmentId).not.toBe(c.departmentId);
    expect(a.name).toBe('研发部'); // display name kept verbatim
    // latin names keep the readable slug form
    expect(createDepartment({ name: 'QA Dept', mission: 'm' }, '2026-09-25T00:00:00.000Z').departmentId)
      .toBe('dept:qa-dept');
  });
});

describe('assignMember', () => {
  it('adds a member by default and records title/skills', () => {
    const d = assignMember(createDepartment({ name: 'Eng', mission: 'm' }), {
      agentId: 'agent-a',
      title: 'Reviewer',
      skills: ['code-review'],
    });
    expect(d.members[0]).toMatchObject({ agentId: 'agent-a', role: 'member', title: 'Reviewer' });
    expect(d.members[0].skills).toEqual(['code-review']);
    expect(d.lead).toBeUndefined();
  });

  it('sets the lead when role is lead', () => {
    const d = assignMember(createDepartment({ name: 'Eng', mission: 'm' }), {
      agentId: 'agent-b',
      role: 'lead',
    });
    expect(d.lead).toBe('agent-b');
    expect(d.members[0].role).toBe('lead');
  });

  it('rejects duplicate agents and a second lead', () => {
    let d = assignMember(createDepartment({ name: 'Eng', mission: 'm' }), {
      agentId: 'agent-b',
      role: 'lead',
    });
    expect(() => assignMember(d, { agentId: 'agent-b' })).toThrow(OrgError);
    expect(() => assignMember(d, { agentId: 'agent-c', role: 'lead' })).toThrow(OrgError);
  });

  it('does not mutate the original department', () => {
    const original = createDepartment({ name: 'Eng', mission: 'm' });
    const next = assignMember(original, { agentId: 'agent-a' });
    expect(original.members).toEqual([]);
    expect(next).not.toBe(original);
    expect(next.members).toHaveLength(1);
  });
});

describe('removeMember / setLead', () => {
  it('removes a member and clears the lead when the lead is removed', () => {
    let d = assignMember(createDepartment({ name: 'Eng', mission: 'm' }), {
      agentId: 'agent-b',
      role: 'lead',
    });
    d = removeMember(d, 'agent-b');
    expect(d.members).toEqual([]);
    expect(d.lead).toBeUndefined();
    expect(() => removeMember(d, 'ghost')).toThrow(OrgError);
  });

  it('promotes a member to lead and demotes the previous lead', () => {
    let d = createDepartment({ name: 'Eng', mission: 'm' });
    d = assignMember(d, { agentId: 'agent-b', role: 'lead' });
    d = assignMember(d, { agentId: 'agent-a' });
    const changed = setLead(d, 'agent-a');
    expect(changed.lead).toBe('agent-a');
    expect(changed.members.find(m => m.agentId === 'agent-a')?.role).toBe('lead');
    expect(changed.members.find(m => m.agentId === 'agent-b')?.role).toBe('member');
    expect(() => setLead(d, 'ghost')).toThrow(OrgError);
  });
});

describe('org chart', () => {
  it('projects a sorted chart with headcount', () => {
    let d = createDepartment({ name: 'Eng', mission: 'build' });
    d = assignMember(d, { agentId: 'agent-b', role: 'lead' });
    d = assignMember(d, { agentId: 'agent-a', title: 'Reviewer' });
    const chart = buildOrgChart([d]);
    expect(chart[0]).toMatchObject({
      departmentId: 'dept:eng',
      lead: 'agent-b',
      headcount: 2,
    });
    expect(chart[0].members.map(m => m.agentId)).toEqual(['agent-a', 'agent-b']);
  });

  it('renders a markdown establishment', () => {
    let d = createDepartment({ name: 'Eng', mission: 'build' });
    d = assignMember(d, { agentId: 'agent-b', role: 'lead' });
    d = assignMember(d, { agentId: 'agent-a', title: 'Reviewer', skills: ['code-review'] });
    const md = renderOrgMarkdown([d]);
    expect(md).toContain('## Eng · dept:eng');
    expect(md).toContain('Mission: build');
    expect(md).toContain('**Lead:** agent-b');
    expect(md).toContain('agent-a — Reviewer (code-review)');
  });
});

describe('traceAccountability', () => {
  function engineering(): Department {
    let d = createDepartment({ name: 'Engineering', mission: 'build' });
    d = assignMember(d, { agentId: 'agent-b', role: 'lead' });
    d = assignMember(d, { agentId: 'agent-a', title: 'Reviewer' });
    return d;
  }

  it('traces executing agents, department leads and unassigned agents', () => {
    const chain = traceAccountability([engineering()], fanOut({ branches: [branch('agent-a'), branch('agent-c')] }));
    expect(chain.executing.map(n => n.agentId)).toEqual(['agent-a', 'agent-c']);
    expect(chain.executing[0]).toMatchObject({
      role: 'member',
      departmentId: 'dept:engineering',
      title: 'Reviewer',
    });
    expect(chain.executing[1]).toMatchObject({ departmentId: 'unassigned' });
    expect(chain.unassigned).toEqual(['agent-c']);
    expect(chain.leads.map(n => n.agentId)).toEqual(['agent-b']);
  });

  it('does not list a lead again when the lead is the executor', () => {
    const chain = traceAccountability([engineering()], fanOut({ branches: [branch('agent-b')] }));
    expect(chain.executing[0].role).toBe('lead');
    expect(chain.leads).toEqual([]);
  });

  it('deduplicates leads across multiple departments', () => {
    let qa = createDepartment({ name: 'QA', mission: 'verify' });
    qa = assignMember(qa, { agentId: 'agent-d', role: 'lead' });
    qa = assignMember(qa, { agentId: 'agent-e' });
    const chain = traceAccountability(
      [engineering(), qa],
      fanOut({ branches: [branch('agent-a'), branch('agent-e')] }),
    );
    expect(chain.leads.map(n => n.agentId).sort()).toEqual(['agent-b', 'agent-d']);
  });

  it('surfaces the deciding driver from a driver resolution', () => {
    const chain = traceAccountability(
      [engineering()],
      fanOut({
        branches: [branch('agent-a')],
        driverResolution: {
          escalationId: 'esc-1',
          stance: 'approve',
          decidedAt: '2026-09-23T12:00:00.000Z',
        },
      }),
    );
    expect(chain.driver).toEqual({
      escalationId: 'esc-1',
      stance: 'approve',
      decidedAt: '2026-09-23T12:00:00.000Z',
    });
  });
});
