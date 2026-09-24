/**
 * OrgRegistry (E9.3): stateful holder for the department establishment. It
 * wraps the immutable department primitives and exposes the chart projection,
 * accountability tracing and export/import for kernel persistence. Departments
 * are unique by id; members stay unique within a department (enforced by the
 * primitives).
 */
import type {
  Department,
  CreateDepartmentInput,
  AssignMemberInput,
  AccountabilityChain,
} from './types.js';
import { OrgError } from './types.js';
import { createDepartment, assignMember, removeMember, setLead } from './department.js';
import { buildOrgChart, renderOrgMarkdown, type OrgChartView } from './chart.js';
import { traceAccountability } from './accountability.js';
import type { FanOutResult } from '../orchestrator/types.js';

export class OrgRegistry {
  private departments: Department[] = [];

  constructor(private now: () => Date = () => new Date()) {}

  createDepartment(input: CreateDepartmentInput): Department {
    const dept = createDepartment(input, this.now().toISOString());
    if (this.departments.some(d => d.departmentId === dept.departmentId)) {
      throw new OrgError(`Department ${dept.departmentId} already exists`);
    }
    this.departments.push(dept);
    return dept;
  }

  assignMember(departmentId: string, input: AssignMemberInput): Department {
    const idx = this.indexOf(departmentId);
    const next = assignMember(this.departments[idx], input, this.now().toISOString());
    this.departments[idx] = next;
    return next;
  }

  removeMember(departmentId: string, agentId: string): Department {
    const idx = this.indexOf(departmentId);
    const next = removeMember(this.departments[idx], agentId);
    this.departments[idx] = next;
    return next;
  }

  setLead(departmentId: string, agentId: string): Department {
    const idx = this.indexOf(departmentId);
    const next = setLead(this.departments[idx], agentId);
    this.departments[idx] = next;
    return next;
  }

  getDepartment(departmentId: string): Department {
    return this.departments[this.indexOf(departmentId)];
  }

  listDepartments(): Department[] {
    return [...this.departments];
  }

  chart(): OrgChartView[] {
    return buildOrgChart(this.departments);
  }

  renderMarkdown(): string {
    return renderOrgMarkdown(this.departments);
  }

  accountability(result: FanOutResult): AccountabilityChain {
    return traceAccountability(this.departments, result);
  }

  exportState(): Department[] {
    return this.departments.map(d => structuredClone(d));
  }

  importState(departments: Department[]): void {
    if (!Array.isArray(departments)) throw new OrgError('org state must be an array');
    for (const dept of departments) validateDepartment(dept);
    this.departments = departments.map(d => structuredClone(d));
  }

  private indexOf(departmentId: string): number {
    const idx = this.departments.findIndex(d => d.departmentId === departmentId);
    if (idx === -1) throw new OrgError(`Unknown department ${departmentId}`);
    return idx;
  }
}

function validateDepartment(dept: unknown): asserts dept is Department {
  const d = dept as Partial<Department> | null;
  if (
    !d ||
    d.format !== 'zeus-department' ||
    typeof d.departmentId !== 'string' ||
    !Array.isArray(d.members)
  ) {
    throw new OrgError('invalid department in org state');
  }
}
