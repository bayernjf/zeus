/**
 * traceAccountability (design-org §6): map a real FanOutResult onto the
 * establishment, yielding executing agents, their department leads and the
 * deciding driver. Agents with no post are marked unassigned, never dropped.
 */
import type { Department, AccountabilityChain, AccountabilityNode } from './types.js';
import type { FanOutResult } from '../orchestrator/types.js';

type Indexed = { dept: Department; role: 'lead' | 'member'; title?: string };

function indexAgents(departments: Department[]): Map<string, Indexed> {
  const map = new Map<string, Indexed>();
  for (const dept of departments) {
    for (const m of dept.members) {
      if (!map.has(m.agentId)) {
        map.set(m.agentId, { dept, role: m.role, ...(m.title ? { title: m.title } : {}) });
      }
    }
  }
  return map;
}

export function traceAccountability(
  departments: Department[],
  result: FanOutResult,
): AccountabilityChain {
  const index = indexAgents(departments);
  const executing: AccountabilityNode[] = [];
  const unassigned: string[] = [];

  for (const branch of result.branches) {
    const found = index.get(branch.vassal);
    if (!found) {
      unassigned.push(branch.vassal);
      executing.push({
        agentId: branch.vassal,
        role: 'member',
        departmentId: 'unassigned',
        departmentName: 'Unassigned',
      });
      continue;
    }
    executing.push({
      agentId: branch.vassal,
      role: found.role,
      ...(found.title ? { title: found.title } : {}),
      departmentId: found.dept.departmentId,
      departmentName: found.dept.name,
    });
  }

  const executingIds = new Set(executing.map(n => n.agentId));
  const leads: AccountabilityNode[] = [];
  const seenLead = new Set<string>();
  for (const node of executing) {
    if (node.departmentId === 'unassigned') continue;
    const dept = departments.find(d => d.departmentId === node.departmentId);
    const leadId = dept?.lead;
    if (leadId && !executingIds.has(leadId) && !seenLead.has(leadId)) {
      seenLead.add(leadId);
      const leadMember = dept!.members.find(m => m.agentId === leadId);
      leads.push({
        agentId: leadId,
        role: 'lead',
        ...(leadMember?.title ? { title: leadMember.title } : {}),
        departmentId: dept!.departmentId,
        departmentName: dept!.name,
      });
    }
  }

  const chain: AccountabilityChain = {
    intentId: result.intentId,
    skill: result.skill,
    status: result.status,
    executing,
    leads,
    unassigned: [...new Set(unassigned)].sort(),
  };
  if (result.driverResolution) {
    chain.driver = {
      escalationId: result.driverResolution.escalationId,
      stance: result.driverResolution.stance,
      decidedAt: result.driverResolution.decidedAt,
    };
  }
  return chain;
}
