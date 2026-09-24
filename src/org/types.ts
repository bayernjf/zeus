/**
 * Org (E9.3): virtual department establishment and result accountability.
 * Departments hold a single lead and uniquely-identified members; an
 * accountability chain traces each task result to executing agents, their
 * department leads and the deciding driver.
 */

export type OrgRole = 'lead' | 'member';

export interface OrgMember {
  agentId: string;
  role: OrgRole;
  title?: string;
  skills?: string[];
  joinedAt: string;
}

export interface Department {
  format: 'zeus-department';
  version: 1;
  departmentId: string;
  name: string;
  mission: string;
  lead?: string;
  members: OrgMember[];
  createdAt: string;
}

export interface AccountabilityNode {
  agentId: string;
  role: OrgRole;
  title?: string;
  departmentId: string;
  departmentName: string;
}

export interface AccountabilityChain {
  intentId: string;
  skill: string;
  status: string;
  executing: AccountabilityNode[];
  leads: AccountabilityNode[];
  unassigned: string[];
  driver?: { escalationId: string; stance: string; decidedAt: string };
}

export interface CreateDepartmentInput {
  name: string;
  mission: string;
}

export interface AssignMemberInput {
  agentId: string;
  role?: OrgRole;
  title?: string;
  skills?: string[];
}

export class OrgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrgError';
  }
}
