/**
 * F1.2 workspace isolation tests: a real git worktree is created for a task,
 * settles into archive/discard, disallowed repos fail closed, and tasks
 * without a workspace keep the pre-F1.2 behaviour.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitWorktreeManager } from './git-worktree.js';
import { WorkspaceError } from './manager.js';
import { OrgService, type OrgTaskExecutor } from '../index.js';

const created: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeRepo(): string {
  const dir = tempDir('zeus-ws-repo-');
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  writeFileSync(join(dir, 'README.md'), 'base\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  return dir;
}

function setupService(workspaces?: GitWorktreeManager) {
  let seq = 0;
  const service = new OrgService({
    ...(workspaces ? { workspaces } : {}),
    clock: () => '2026-11-17T00:00:00.000Z',
    newId: prefix => `${prefix}-${++seq}`,
  });
  const org = service.createOrganization({ name: '工作区', scaleTier: 'small' });
  const dept = service.createDepartment({ organizationId: org.id, name: '运营', mission: 'm' });
  const position = service.createPosition({
    organizationId: org.id,
    departmentId: dept.id,
    name: '专员',
    requiredSkills: ['ops'],
    allowedTools: [],
    decisionScope: 'D0',
  });
  service.assignAgent(position.id, { agentId: 'agent-1' });
  return { service, org };
}

const completeExecutor: OrgTaskExecutor = { run: async () => ({ outcome: 'complete' }) };

describe('GitWorktreeManager (F1.2)', () => {
  it('acquires a clean worktree and releases it', () => {
    const repo = makeRepo();
    const root = tempDir('zeus-ws-root-');
    const manager = new GitWorktreeManager({ root, allowedRepos: [repo] });

    const { path } = manager.acquire({ organizationId: 'org-1', taskId: 'task-1', baseRepo: repo });
    expect(existsSync(path)).toBe(true);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: path }).toString().trim()).toBe('');
    expect(execFileSync('git', ['worktree', 'list'], { cwd: repo }).toString()).toContain('task-1');

    manager.release(path);
    expect(existsSync(path)).toBe(false);
  });

  it('archives the worktree into a tarball and removes the directory', () => {
    const repo = makeRepo();
    const root = tempDir('zeus-ws-root-');
    const manager = new GitWorktreeManager({ root, allowedRepos: [repo] });

    const { path } = manager.acquire({ organizationId: 'org-1', taskId: 'task-2', baseRepo: repo });
    writeFileSync(join(path, 'result.txt'), 'artifact\n');
    const artifact = manager.archive(path);

    expect(existsSync(artifact)).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it('fails closed for a repo outside the allow-list', () => {
    const repo = makeRepo();
    const root = tempDir('zeus-ws-root-');
    const manager = new GitWorktreeManager({ root, allowedRepos: [repo] });

    expect(() =>
      manager.acquire({ organizationId: 'org-1', taskId: 'task-3', baseRepo: '/etc' }),
    ).toThrow(WorkspaceError);
  });
});

describe('OrgService workspace wiring (F1.2)', () => {
  it('runs the task inside the worktree and discards it by default', async () => {
    const repo = makeRepo();
    const root = tempDir('zeus-ws-root-');
    const manager = new GitWorktreeManager({ root, allowedRepos: [repo] });
    const { service, org } = setupService(manager);

    const task = service.createTask({
      organizationId: org.id,
      title: '在隔离区跑',
      payload: {},
      requiredSkill: 'ops',
      workspace: { baseRepo: repo, policy: 'discard' },
    });
    const result = await service.dispatch(task.id, completeExecutor);

    expect(result.task.status).toBe('done');
    expect(result.task.workspacePath).toBeDefined();
    expect(existsSync(result.task.workspacePath!)).toBe(false);
  });
  it('keeps a tarball when the policy is archive', async () => {
    const repo = makeRepo();
    const root = tempDir('zeus-ws-root-');
    const manager = new GitWorktreeManager({ root, allowedRepos: [repo] });
    const { service, org } = setupService(manager);

    const task = service.createTask({
      organizationId: org.id,
      title: '归档',
      payload: {},
      requiredSkill: 'ops',
      workspace: { baseRepo: repo, policy: 'archive' },
    });
    const result = await service.dispatch(task.id, completeExecutor);

    expect(result.task.status).toBe('done');
    const artifact = (result.task.result as { workspaceArtifact?: string } | undefined)?.workspaceArtifact;
    expect(artifact).toBeDefined();
    expect(existsSync(artifact!)).toBe(true);
    expect(existsSync(result.task.workspacePath!)).toBe(false);
  });

  it('fails the task as business when the repo is not allow-listed', async () => {
    const repo = makeRepo();
    const root = tempDir('zeus-ws-root-');
    const manager = new GitWorktreeManager({ root, allowedRepos: [repo] });
    const { service, org } = setupService(manager);

    const task = service.createTask({
      organizationId: org.id,
      title: '越界',
      payload: {},
      requiredSkill: 'ops',
      workspace: { baseRepo: '/etc' },
    });
    const result = await service.dispatch(task.id, completeExecutor);

    expect(result.task.status).toBe('failed');
    expect(result.task.failedKind).toBe('business');
    expect(result.task.error).toMatch(/allowed roots/);
  });

  it('runs tasks without a workspace in place (pre-F1.2 behaviour)', async () => {
    const { service, org } = setupService();
    const task = service.createTask({ organizationId: org.id, title: '原地', payload: {}, requiredSkill: 'ops' });
    const result = await service.dispatch(task.id, completeExecutor);

    expect(result.task.status).toBe('done');
    expect(result.task.workspacePath).toBeUndefined();
  });
});
