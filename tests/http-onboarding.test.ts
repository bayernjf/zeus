import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { bootKernel } from '../src/state/boot.js';
import { createHttpServer } from '../src/http/server.js';
import { Ed25519MemorySigner } from '../src/registry/signing.js';
import { kernelStats } from '../src/state/stats.js';
import type { KernelBoot } from '../src/state/boot.js';

const TOKEN = 'driver-secret';
const AUTH = { authorization: `Bearer ${TOKEN}` };
const NOW = new Date('2026-09-25T10:00:00.000Z');

const CARDS: Record<string, string[]> = {
  'pr-helper': ['release-review'],
  senior: ['release-review'],
  'new-hire': [],
};

function cardFor(name: string) {
  return {
    name,
    url: `http://127.0.0.1/${name}/api/a2a/tasks`,
    version: '0.1.0',
    provider: { organization: 'acme' },
    capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: true },
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    skills: (CARDS[name] ?? []).map(id => ({ id, name: id, description: `${id} work`, tags: [id] })),
    authentication: { schemes: ['bearer'] },
    preferredTransport: 'JSONRPC',
    'x-zeus-fealty': { version: '1', swornTo: 'zeus', domain: 'acme', dataRealms: ['personal', 'enterprise'], dataPolicy: 'read-task-scope', reportBack: true, escalationPolicy: 'auto' },
  };
}

/** Card fetch and A2A dispatch share one transport; the task call answers with a
 *  card body, which the dispatcher records as a failed branch. The branch was
 *  still attempted, and that is what these tests assert. */
const routingFetch = (async (input: string | URL | Request) => {
  const url = String(typeof input === 'string' || input instanceof URL ? input : (input as Request).url);
  const name = new URL(url).pathname.split('/').filter(Boolean)[0] ?? '';
  return new Response(JSON.stringify(cardFor(name)), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}) as unknown as typeof fetch;

type Face = {
  app: FastifyInstance;
  kernel: KernelBoot;
  sandbox: string;
  deptId: string;
  realmId: string;
  auditFile: string;
  close: () => Promise<void>;
};

let face: Face;

async function bootFace(): Promise<Face> {
  const sandbox = await mkdtemp(join(tmpdir(), 'zeus-http-onboarding-'));
  const realmRoot = join(sandbox, 'eng');
  await mkdir(realmRoot, { recursive: true });
  await writeFile(join(realmRoot, 'charter.md'), 'how we ship the compiler safely\n');
  const auditFile = join(sandbox, 'audit.jsonl');
  const stateFile = join(sandbox, 'kernel.json');

  const kernel = await bootKernel({
    fetchImpl: routingFetch,
    now: () => NOW,
    auditFile,
    stateFile,
    realmRoots: [{ root: realmRoot, type: 'enterprise', tenant: 'acme/eng' }],
  });
  const realmId = kernel.realmStore!.connections()[0]!.realmId;
  const dept = kernel.orgRegistry!.createDepartment({ name: 'Engineering', mission: 'ship the compiler safely' });
  kernel.orgRegistry!.assignMember(dept.departmentId, { agentId: 'pr-helper', role: 'lead', title: 'EM', skills: ['release-review'] });
  kernel.orgRegistry!.assignMember(dept.departmentId, { agentId: 'new-hire', role: 'member', title: 'Junior reviewer' });

  const app = await createHttpServer({
    registry: kernel.registry,
    signer: new Ed25519MemorySigner('zeus-rsk-test'),
    internalToken: TOKEN,
    now: () => NOW,
    orchestrator: kernel.orchestrator,
    oversight: kernel.oversight,
    metrics: kernel.metrics,
    skillRegistry: kernel.skillRegistry,
    mentorshipLedger: kernel.mentorshipLedger,
    orgRegistry: kernel.orgRegistry,
    memoryStore: kernel.memoryStore,
    realmStore: kernel.realmStore,
    domainGrants: kernel.domainGrants,
    realmAudit: kernel.realmAudit,
    commissions: kernel.commissionLedger,
    auditFile,
    kernelStats: () => kernelStats(kernel),
  });

  return {
    app,
    kernel,
    sandbox,
    deptId: dept.departmentId,
    realmId,
    auditFile,
    close: async () => {
      await app.close();
    },
  };
}

beforeEach(async () => {
  face = await bootFace();
});

afterEach(async () => {
  await face.close();
  await rm(face.sandbox, { recursive: true, force: true });
});

async function openSeat(over: Record<string, unknown> = {}) {
  return face.app.inject({
    method: 'POST',
    url: `/api/org/departments/${face.deptId}/commissions`,
    headers: AUTH,
    payload: { agentId: 'new-hire', realmId: face.realmId, openedBy: 'driver', ...over },
  });
}

/** Walk the whole chain over HTTP, ending in a sign-off. */
async function commissionThroughHttp() {
  await face.app.inject({
    method: 'POST',
    url: '/api/vassals',
    headers: AUTH,
    payload: { cardUrl: 'http://127.0.0.1/new-hire/api/a2a/card' },
  });
  // Opening is idempotent for the caller of this helper: a seat already on
  // file answers 409, which is not a failure on the way to a sign-off.
  expect([201, 409]).toContain((await openSeat()).statusCode);
  const waived = await face.app.inject({
    method: 'POST',
    url: `/api/org/departments/${face.deptId}/commissions/new-hire/waive`,
    headers: AUTH,
    payload: { reason: 'supervised internship', by: 'driver' },
  });
  expect(waived.statusCode).toBe(200);
  return face.app.inject({
    method: 'POST',
    url: `/api/org/departments/${face.deptId}/commissions/new-hire/commission`,
    headers: AUTH,
    payload: { by: 'driver', note: 'day one' },
  });
}

describe('HTTP E9.2 - the commission face', () => {
  it('lists commissions with a live verdict for each', async () => {
    const empty = await face.app.inject({ method: 'GET', url: `/api/org/departments/${face.deptId}/commissions`, headers: AUTH });
    expect(empty.json()).toEqual({ commissions: [] });

    await openSeat();
    const listed = await face.app.inject({ method: 'GET', url: `/api/org/departments/${face.deptId}/commissions`, headers: AUTH });
    const rows = listed.json().commissions as Array<{ agentId: string; verdict: { stage: string; blockedOn: string } }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agentId: 'new-hire', verdict: { blockedOn: 'account' } });

    const unknown = await face.app.inject({ method: 'GET', url: '/api/org/departments/dept:nope/commissions', headers: AUTH });
    expect(unknown.statusCode).toBe(404);
  });

  it('refuses the shapes that cannot name a seat', async () => {
    expect((await openSeat({ agentId: undefined })).statusCode).toBe(400);
    expect((await openSeat({ openedBy: undefined })).statusCode).toBe(400);
    expect((await openSeat({ realmId: 'realm-missing' })).statusCode).toBe(404);
    expect((await openSeat({ requiredSkills: 'release-review' })).statusCode).toBe(400);
    expect((await openSeat({ tenant: 42 })).statusCode).toBe(400);
    expect((await openSeat({ agentId: 'nobody' })).statusCode).toBe(400);
  });

  it('answers a gate refusal with the blocked stage, not just a message', async () => {
    expect((await openSeat()).statusCode).toBe(201);
    const refused = await face.app.inject({
      method: 'POST',
      url: `/api/org/departments/${face.deptId}/commissions/new-hire/commission`,
      headers: AUTH,
      payload: { by: 'driver' },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'commission_gate', blockedOn: 'account' });
    expect(refused.json().reason).toMatch(/no vassal named new-hire/);

    // A refusal is part of the trail, not just a response code.
    const refusedEntry = await face.app.inject({ method: 'GET', url: '/api/audit?decision=commission-refused', headers: AUTH });
    expect((refusedEntry.json().entries as unknown[]).length).toBe(1);

    // 404 for a seat that has no file at all, 400 for a waiver that waists nothing
    const missing = await face.app.inject({
      method: 'POST',
      url: `/api/org/departments/${face.deptId}/commissions/ghost/commission`,
      headers: AUTH,
      payload: { by: 'driver' },
    });
    expect(missing.statusCode).toBe(404);
    const badPath = await face.app.inject({
      method: 'GET',
      url: `/api/org/departments/${face.deptId}/briefing/a%2Fb`,
      headers: AUTH,
    });
    expect([400, 404]).toContain(badPath.statusCode);
  });

  it('walks account -> authorization -> mentorship -> sign-off and reports it in the audit trail', async () => {
    const commissioned = await commissionThroughHttp();
    expect(commissioned.statusCode).toBe(200);
    expect(commissioned.json()).toMatchObject({ commissioned: { by: 'driver' } });

    expect(existsSync(face.auditFile)).toBe(true);
    const granted = await face.app.inject({
      method: 'GET',
      url: '/api/audit?decision=commission-granted',
      headers: AUTH,
    });
    const entries = granted.json().entries as Array<{ vassal: string; detail: string }>;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ vassal: 'new-hire' });
    expect(entries[0].detail).toContain('acme/eng');

    const waivedEntry = await face.app.inject({ method: 'GET', url: '/api/audit?decision=commission-waived', headers: AUTH });
    const waivers = waivedEntry.json().entries as Array<{ detail: string }>;
    expect(waivers).toHaveLength(1);
    expect(waivers[0].detail).toContain('supervised internship');

    const state = await face.app.inject({ method: 'GET', url: '/api/state', headers: AUTH });
    expect(state.json().counts).toMatchObject({ commissions: 1, commissioned: 1 });
  });

  it('carries a seat through a restart with its sign-off intact', async () => {
    await commissionThroughHttp();
    await face.kernel.saveState();
    const before = face.kernel.commissionLedger!.exportState();

    const second = await bootKernel({
      fetchImpl: routingFetch,
      now: () => NOW,
      stateFile: join(face.sandbox, 'kernel.json'),
    });
    expect(second.commissionLedger!.exportState()).toEqual(before);
    expect(() => second.commissionLedger!.assertCommissioned(before[0]!.id)).not.toThrow();
  });
});

describe('HTTP E9.1 - the briefing face', () => {
  it('returns the assembled seat context over HTTP, with no path disclosure', async () => {
    await commissionThroughHttp();
    const res = await face.app.inject({
      method: 'GET',
      url: `/api/org/departments/${face.deptId}/briefing/new-hire`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).seat).toMatchObject({
      departmentName: 'Engineering',
      mission: 'ship the compiler safely',
      role: 'member',
      title: 'Junior reviewer',
    });
    const parsed = JSON.parse(res.body) as {
      chain: { lead?: string };
      boundaries: Record<string, unknown>;
      culture: { totalFacts: number };
      digest: string;
    };
    expect(parsed.chain.lead).toBe('pr-helper');
    expect(parsed.boundaries).toMatchObject({ realmType: 'enterprise', canRead: true, writeNeedsGrant: true });
    expect(parsed.culture.totalFacts).toBe(0);
    expect(parsed.digest).toMatch(/^[0-9a-f]{64}$/);
    // design-realm invariant 3: the absolute root never leaves the process.
    expect(res.body).not.toContain(face.sandbox);
  });
});

describe('HTTP E9.2 - the first task', () => {
  it('refers the task to the commissioned agent, carrying the briefing digest', async () => {
    await commissionThroughHttp();
    const res = await face.app.inject({
      method: 'POST',
      url: `/api/org/departments/${face.deptId}/first-task`,
      headers: AUTH,
      payload: { agentId: 'new-hire', skill: 'release-review', params: { target: 'v1.2' } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      intentId: string;
      realm: string;
      realmId: string;
      branches: Array<{ vassal: string }>;
      briefing: { digest: string; gaps: string[] };
    };
    expect(body.realm).toBe('enterprise');
    expect(body.realmId).toBe(face.realmId);
    expect(body.branches.map(branch => branch.vassal)).toEqual(['new-hire']);
    expect(body.briefing.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(body.intentId).toBeTruthy();
  });

  it('refuses before the sign-off, and again after a withdrawal', async () => {
    const beforeAny = await face.app.inject({
      method: 'POST',
      url: `/api/org/departments/${face.deptId}/first-task`,
      headers: AUTH,
      payload: { agentId: 'new-hire', skill: 'release-review' },
    });
    expect(beforeAny.statusCode).toBe(404);

    await openSeat();
    const notCommissioned = await face.app.inject({
      method: 'POST',
      url: `/api/org/departments/${face.deptId}/first-task`,
      headers: AUTH,
      payload: { agentId: 'new-hire', skill: 'release-review' },
    });
    expect(notCommissioned.statusCode).toBe(409);
    expect(notCommissioned.json()).toMatchObject({ error: 'commission_gate', blockedOn: 'account' });

    await commissionThroughHttp();
    const withdrawn = await face.app.inject({
      method: 'POST',
      url: `/api/org/departments/${face.deptId}/commissions/new-hire/withdraw`,
      headers: AUTH,
      payload: { by: 'driver', reason: 'reorg' },
    });
    expect(withdrawn.statusCode).toBe(200);

    const afterWithdraw = await face.app.inject({
      method: 'POST',
      url: `/api/org/departments/${face.deptId}/first-task`,
      headers: AUTH,
      payload: { agentId: 'new-hire', skill: 'release-review' },
    });
    expect(afterWithdraw.statusCode).toBe(409);
    expect(afterWithdraw.json().reason).toMatch(/withdrawn/);
  });

  it('validates the request before it touches the gate', async () => {
    await commissionThroughHttp();
    const post = (payload: Record<string, unknown>) =>
      face.app.inject({ method: 'POST', url: `/api/org/departments/${face.deptId}/first-task`, headers: AUTH, payload });
    expect((await post({ skill: 'release-review' })).statusCode).toBe(400);
    expect((await post({ agentId: 'new-hire' })).statusCode).toBe(400);
    expect((await post({ agentId: 'new-hire', skill: 'release-review', params: 'nope' })).statusCode).toBe(400);
    expect((await post({ agentId: 'ghost', skill: 'release-review' })).statusCode).toBe(404);
  });
});
