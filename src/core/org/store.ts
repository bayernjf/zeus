/**
 * In-memory org v1 store (M2 slice). Same durability stance as the M1 decision
 * stores: process memory, snapshot/restore through export/import; durable
 * persistence is a later deployment slice (design §5.1).
 */
import type {
  Organization,
  Department,
  Position,
  OrgTask,
} from './types.js';

export interface OrgSnapshot {
  organizations: Organization[];
  departments: Department[];
  positions: Position[];
  tasks: OrgTask[];
}

/**
 * Org store port. MemoryOrgStore is the volatile implementation (test/demo);
 * the durable SQLite implementation (T-M6-01) satisfies the same contract.
 */
export interface OrgStore {
  putOrganization(org: Organization): void;
  getOrganization(id: string): Organization | undefined;
  listOrganizations(): Organization[];

  putDepartment(dept: Department): void;
  getDepartment(id: string): Department | undefined;
  listDepartments(organizationId?: string): Department[];

  putPosition(pos: Position): void;
  getPosition(id: string): Position | undefined;
  listPositions(organizationId?: string): Position[];

  putTask(task: OrgTask): void;
  getTask(id: string): OrgTask | undefined;
  listTasks(organizationId?: string): OrgTask[];

  exportSnapshot(): OrgSnapshot;
  importSnapshot(snapshot: OrgSnapshot): void;
}

export class MemoryOrgStore implements OrgStore {
  private organizations = new Map<string, Organization>();
  private departments = new Map<string, Department>();
  private positions = new Map<string, Position>();
  private tasks = new Map<string, OrgTask>();

  // Organizations
  putOrganization(org: Organization): void {
    this.organizations.set(org.id, structuredClone(org));
  }
  getOrganization(id: string): Organization | undefined {
    const v = this.organizations.get(id);
    return v ? structuredClone(v) : undefined;
  }
  listOrganizations(): Organization[] {
    return [...this.organizations.values()].map(v => structuredClone(v));
  }

  // Departments
  putDepartment(dept: Department): void {
    this.departments.set(dept.id, structuredClone(dept));
  }
  getDepartment(id: string): Department | undefined {
    const v = this.departments.get(id);
    return v ? structuredClone(v) : undefined;
  }
  listDepartments(organizationId?: string): Department[] {
    return [...this.departments.values()]
      .filter(d => organizationId === undefined || d.organizationId === organizationId)
      .map(v => structuredClone(v));
  }

  // Positions
  putPosition(pos: Position): void {
    this.positions.set(pos.id, structuredClone(pos));
  }
  getPosition(id: string): Position | undefined {
    const v = this.positions.get(id);
    return v ? structuredClone(v) : undefined;
  }
  listPositions(organizationId?: string): Position[] {
    return [...this.positions.values()]
      .filter(p => organizationId === undefined || p.organizationId === organizationId)
      .map(v => structuredClone(v));
  }

  // Tasks
  putTask(task: OrgTask): void {
    this.tasks.set(task.id, structuredClone(task));
  }
  getTask(id: string): OrgTask | undefined {
    const v = this.tasks.get(id);
    return v ? structuredClone(v) : undefined;
  }
  listTasks(organizationId?: string): OrgTask[] {
    return [...this.tasks.values()]
      .filter(t => organizationId === undefined || t.organizationId === organizationId)
      .map(v => structuredClone(v));
  }

  exportSnapshot(): OrgSnapshot {
    return {
      organizations: this.listOrganizations(),
      departments: this.listDepartments(),
      positions: this.listPositions(),
      tasks: this.listTasks(),
    };
  }

  importSnapshot(snapshot: OrgSnapshot): void {
    for (const [coll, key] of [
      ['organizations', 'id'],
      ['departments', 'id'],
      ['positions', 'id'],
      ['tasks', 'id'],
    ] as const) {
      const arr = snapshot[coll];
      if (!Array.isArray(arr)) throw new Error(`org snapshot.${coll} must be an array`);
      for (const item of arr) {
        if (!item || typeof (item as unknown as Record<string, unknown>)[key] !== 'string') {
          throw new Error(`org snapshot.${coll} contains entries without ${key}`);
        }
      }
    }
    this.organizations = new Map(snapshot.organizations.map(o => [o.id, structuredClone(o)]));
    this.departments = new Map(snapshot.departments.map(d => [d.id, structuredClone(d)]));
    this.positions = new Map(snapshot.positions.map(p => [p.id, structuredClone(p)]));
    this.tasks = new Map(snapshot.tasks.map(t => [t.id, structuredClone(t)]));
  }
}
