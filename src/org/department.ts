/**
 * Department establishment primitives (design-org §4). Immutable: each
 * operation returns a new Department. A department has exactly one lead and
 * members are unique by agentId.
 */
import type {
  Department,
  OrgMember,
  CreateDepartmentInput,
  AssignMemberInput,
} from './types.js';
import { OrgError } from './types.js';
import { sha256Hex } from '../util/crypto.js';

/** ASCII slug form: non [a-z0-9] runs fold to a single dash. */
function asciiSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Strict slug for callers that need a readable one; empty is a defect here. */
export function slug(name: string): string {
  const s = asciiSlug(name);
  if (!s) throw new OrgError('Department name yields no valid slug');
  return s;
}

/**
 * Stable, URL-safe department id. The ASCII slug is preferred because it reads
 * well in a path, but a name in any non-Latin script - the normal case for this
 * product - produces no slug at all, and refusing to establish a department
 * because its name is Chinese is not a rule anyone asked for. Those names fall
 * back to a short digest; the display name is stored verbatim either way.
 */
export function departmentIdFor(name: string): string {
  const s = asciiSlug(name);
  return `dept:${s || sha256Hex(name).slice(0, 8)}`;
}

export function createDepartment(
  input: CreateDepartmentInput,
  now: string = new Date().toISOString(),
): Department {
  const name = input.name?.trim();
  const mission = input.mission?.trim();
  if (!name) throw new OrgError('Department name is required');
  if (!mission) throw new OrgError('Department mission is required');
  return {
    format: 'zeus-department',
    version: 1,
    departmentId: departmentIdFor(name),
    name,
    mission,
    members: [],
    createdAt: now,
  };
}

export function assignMember(
  dept: Department,
  input: AssignMemberInput,
  now: string = new Date().toISOString(),
): Department {
  const agentId = input.agentId?.trim();
  if (!agentId) throw new OrgError('agentId is required');
  if (dept.members.some(m => m.agentId === agentId)) {
    throw new OrgError(`Agent ${agentId} is already in the department`);
  }
  const role = input.role ?? 'member';
  if (role === 'lead' && dept.lead) throw new OrgError('Department already has a lead');

  const member: OrgMember = { agentId, role, joinedAt: now };
  if (input.title?.trim()) member.title = input.title.trim();
  if (input.skills) member.skills = [...input.skills];

  const next: Department = { ...dept, members: [...dept.members, member] };
  if (role === 'lead') next.lead = agentId;
  return next;
}

export function removeMember(dept: Department, agentId: string): Department {
  if (!dept.members.some(m => m.agentId === agentId)) {
    throw new OrgError(`Agent ${agentId} is not in the department`);
  }
  const next: Department = { ...dept, members: dept.members.filter(m => m.agentId !== agentId) };
  if (dept.lead === agentId) next.lead = undefined;
  return next;
}

/** Promote an existing member to lead; the previous lead becomes a member. */
export function setLead(dept: Department, agentId: string): Department {
  if (!dept.members.some(m => m.agentId === agentId)) {
    throw new OrgError(`Agent ${agentId} is not in the department`);
  }
  const members = dept.members.map(m => {
    if (m.agentId === agentId) return { ...m, role: 'lead' as const };
    if (m.role === 'lead') return { ...m, role: 'member' as const };
    return m;
  });
  return { ...dept, members, lead: agentId };
}
