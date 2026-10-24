import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bootKernel } from '../src/state/boot.js';
import { createPersonalKernelQueries } from '../src/realm/kernel-queries.js';
import {
  createRealmMcpHandler,
  JSON_RPC_CODES,
  type JsonRpcResponse,
  type PersonalKernelQueries,
} from '../src/realm/mcp.js';
import type { RealmStore } from '../src/realm/types.js';

function rpc(id: number, method: string, params?: unknown) {
  return { jsonrpc: '2.0' as const, id, method, ...(params ? { params } : {}) };
}

/**
 * Recording realm stub: any realm-side touch fails the test. The zeus.* face
 * must never address a connected realm - asserting against a throwing store
 * proves the kernel tools bypass the realm boundary by construction.
 */
function recordingStore(): { store: RealmStore; touched: string[] } {
  const touched: string[] = [];
  const boom = (op: string): (() => Promise<never>) => {
    return () => {
      touched.push(op);
      return Promise.reject(new Error(`realm store op '${op}' must not be reached`));
    };
  };
  return {
    touched,
    store: {
      connect: boom('connect'),
      manifest: boom('manifest'),
      search: boom('search'),
      read: boom('read'),
      connections: () => [],
      disconnect: boom('disconnect'),
      retargetTenant: boom('retargetTenant'),
      entries: boom('entries'),
    },
  };
}

/** Recorded fake kernel port: every call lands in `calls` for assertions. */
function fakeKernelQueries(): { queries: PersonalKernelQueries; calls: string[] } {
  const calls: string[] = [];
  const queries: PersonalKernelQueries = {
    async listSkills(filter) {
      calls.push(`listSkills(${JSON.stringify(filter ?? {})})`);
      return [
        { id: 'code-review', name: 'Code Review', description: 'Review a diff', version: '1.2.0', domain: 'code', tags: ['review'] },
        { id: 'diary', name: 'Diary', description: 'Append a diary entry', version: '0.9.0', tags: ['personal'] },
      ];
    },
    async getSkill(id, version) {
      calls.push(`getSkill(${id},${String(version)})`);
      if (id === 'code-review') {
        return { id: 'code-review', name: 'Code Review', description: 'Review a diff', version: version ?? '1.2.0', domain: 'code', tags: ['review'] };
      }
      return undefined;
    },
    async plan({ text, realm }) {
      calls.push(`plan(${text},${realm ?? 'personal'})`);
      return {
        ok: true,
        chosenBy: 'local-ranker',
        skill: 'code-review',
        confidence: 0.5,
        candidates: [
          { skill: 'code-review', score: 3 },
          { skill: 'diary', score: 1 },
        ],
      };
    },
    async status() {
      calls.push('status()');
      return {
        ts: '2026-10-25T00:00:00.000Z',
        realms: [{ realmId: 'realm-abc', type: 'personal', readOnly: true }],
        agents: { activeCount: 1, names: ['loom'] },
        pendingOversight: 2,
        watches: 3,
      };
    },
  };
  return { queries, calls };
}

function contentOf(res: JsonRpcResponse | null): string {
  return (res!.result as { content: Array<{ type: 'text'; text: string }> }).content[0]!.text;
}

describe('zeus.* kernel tools over the personal MCP face (fake port, hermetic)', () => {
  it('tools/list advertises the realm tools plus the three read-only kernel tools', async () => {
    const { store } = recordingStore();
    const { queries } = fakeKernelQueries();
    const handle = createRealmMcpHandler({ store, realmIds: [], kernelQueries: queries });
    const res = await handle(rpc(1, 'tools/list'));
    const names = (res!.result as { tools: Array<{ name: string }> }).tools.map(t => t.name).sort();
    expect(names).toEqual(['realm.read', 'realm.search', 'realm.write', 'zeus.plan', 'zeus.skills', 'zeus.status']);
    const plan = (res!.result as { tools: Array<{ name: string; inputSchema: { required: string[] } }> }).tools.find(t => t.name === 'zeus.plan')!;
    expect(plan.inputSchema.required).toEqual(['text']);
    const skills = (res!.result as { tools: Array<{ name: string; inputSchema: { required: string[] } }> }).tools.find(t => t.name === 'zeus.skills')!;
    expect(skills.inputSchema.required).toEqual([]);
  });

  it('zeus.skills lists the catalogue, fetches by id, and reports unknown ids as not-found JSON', async () => {
    const { store, touched } = recordingStore();
    const { queries, calls } = fakeKernelQueries();
    const handle = createRealmMcpHandler({ store, realmIds: [], kernelQueries: queries });

    const list = await handle(rpc(1, 'tools/call', { name: 'zeus.skills', arguments: {} }));
    const arr = JSON.parse(contentOf(list)) as Array<{ id: string; version: string; tags: string[] }>;
    expect(arr.map(s => s.id).sort()).toEqual(['code-review', 'diary']);
    expect(arr[0]!.version).toBeTruthy();
    expect(arr[0]!.tags).toBeInstanceOf(Array);
    expect(touched).toEqual([]); // realm store untouched

    const one = await handle(rpc(2, 'tools/call', { name: 'zeus.skills', arguments: { id: 'code-review', version: '1.2.0' } }));
    expect(JSON.parse(contentOf(one))).toMatchObject({ id: 'code-review', version: '1.2.0' });

    const missing = await handle(rpc(3, 'tools/call', { name: 'zeus.skills', arguments: { id: 'ghost' } }));
    expect(JSON.parse(contentOf(missing))).toEqual({ ok: false, reason: 'not-found', id: 'ghost' });

    // realmId is neither required nor consulted on the kernel face.
    expect(calls).toContain('listSkills({})');
    expect(calls).toContain('getSkill(code-review,1.2.0)');
    expect(touched).toEqual([]);
  });

  it('zeus.plan returns a structured verdict and never touches the realm store (no write path)', async () => {
    const { store, touched } = recordingStore();
    const { queries } = fakeKernelQueries();
    const handle = createRealmMcpHandler({ store, realmIds: [], kernelQueries: queries });

    const plan = await handle(rpc(1, 'tools/call', { name: 'zeus.plan', arguments: { text: 'review the diff', realm: 'personal' } }));
    expect(plan?.error).toBeUndefined();
    const verdict = JSON.parse(contentOf(plan)) as {
      ok: boolean; chosenBy: string; skill?: string; confidence?: number; candidates: Array<{ skill: string; score: number }>;
    };
    expect(verdict.ok).toBe(true);
    expect(verdict.chosenBy).toBe('local-ranker');
    expect(verdict.skill).toBe('code-review');
    expect(verdict.confidence).toBe(0.5);
    expect(verdict.candidates.map(c => c.skill)).toContain('code-review');
    // The recording store's write/read/search are all throwing: zero touches proves
    // the plan path originates no execute and no write through this face.
    expect(touched).toEqual([]);
  });

  it('zeus.status projects realms without the absolute root and reports counts', async () => {
    const { store } = recordingStore();
    const { queries } = fakeKernelQueries();
    const handle = createRealmMcpHandler({ store, realmIds: [], kernelQueries: queries });

    const res = await handle(rpc(1, 'tools/call', { name: 'zeus.status', arguments: {} }));
    expect(res?.error).toBeUndefined();
    const text = contentOf(res);
    expect(text).not.toMatch(/root/);
    expect(text).not.toMatch(/\/(Users|srv|tmp|home)\//);
    const status = JSON.parse(text) as {
      ts: string;
      realms: Array<{ realmId: string; type: string; readOnly: boolean }>;
      agents: { activeCount: number; names: string[] };
      pendingOversight: number;
      watches: number;
    };
    expect(status.realms).toEqual([{ realmId: 'realm-abc', type: 'personal', readOnly: true }]);
    expect(status.agents).toEqual({ activeCount: 1, names: ['loom'] });
    expect(status.pendingOversight).toBe(2);
    expect(status.watches).toBe(3);
    expect(status.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('fail-closed: without a mounted kernel port the zeus.* tools answer with a named error, never empty success', async () => {
    const { store, touched } = recordingStore();
    const handle = createRealmMcpHandler({ store, realmIds: [] }); // no kernelQueries
    let seq = 0;
    for (const name of ['zeus.skills', 'zeus.plan', 'zeus.status']) {
      seq += 1;
      const res = await handle(rpc(seq, 'tools/call', {
        name,
        ...(name === 'zeus.plan' ? { arguments: { text: 'x' } } : {}),
      }));
      expect(res?.error).toBeDefined();
      expect(res!.error!.code).toBe(JSON_RPC_CODES.INVALID_PARAMS);
      expect(res!.error!.message).toContain('unavailable: kernel queries not mounted');
    }
    // And nothing was fabricated: the realm store was never touched either.
    expect(touched).toEqual([]);
  });

  it('zeus.* needs no realmId, while realm.* tools stay under the host whitelist', async () => {
    const { store } = recordingStore();
    const { queries } = fakeKernelQueries();
    const handle = createRealmMcpHandler({ store, realmIds: [], kernelQueries: queries });

    // Kernel face works with an empty whitelist (no realmId anywhere).
    const skills = await handle(rpc(1, 'tools/call', { name: 'zeus.skills', arguments: {} }));
    expect(skills?.error).toBeUndefined();

    // Realm face is still gated: even with the kernel port mounted, an unknown
    // realmId is refused by the whitelist.
    const rogue = await handle(rpc(2, 'tools/call', { name: 'realm.search', arguments: { realmId: 'not-connected', text: 'x' } }));
    expect(rogue!.error!.code).toBe(JSON_RPC_CODES.REALM_NOT_CONNECTED);
  });

  it('validates zeus.* arguments fail loud (missing text, bad realm, stray params)', async () => {
    const { store } = recordingStore();
    const { queries } = fakeKernelQueries();
    const handle = createRealmMcpHandler({ store, realmIds: [], kernelQueries: queries });

    const noText = await handle(rpc(1, 'tools/call', { name: 'zeus.plan', arguments: {} }));
    expect(noText!.error!.code).toBe(JSON_RPC_CODES.INVALID_PARAMS);

    const badRealm = await handle(rpc(2, 'tools/call', { name: 'zeus.plan', arguments: { text: 'x', realm: 'mystery' } }));
    expect(badRealm!.error!.code).toBe(JSON_RPC_CODES.INVALID_PARAMS);

    const planJunk = await handle(rpc(3, 'tools/call', { name: 'zeus.plan', arguments: { text: 'x', bogus: 1 } }));
    expect(planJunk!.error!.message).toMatch(/unsupported plan parameter: bogus/);

    const statusJunk = await handle(rpc(4, 'tools/call', { name: 'zeus.status', arguments: { watch: 1 } }));
    expect(statusJunk!.error!.code).toBe(JSON_RPC_CODES.INVALID_PARAMS);

    const skillsJunk = await handle(rpc(5, 'tools/call', { name: 'zeus.skills', arguments: { filter: 1 } }));
    expect(skillsJunk!.error!.message).toMatch(/unsupported skills parameter: filter/);

    const unknownKernel = await handle(rpc(6, 'tools/call', { name: 'zeus.purge', arguments: {} }));
    expect(unknownKernel!.error!.code).toBe(JSON_RPC_CODES.INVALID_PARAMS);
    expect(unknownKernel!.error!.message).toMatch(/unknown tool/);
  });
});

describe('real booted kernel through the personal stdio face (integration)', () => {
  let sandbox: string;
  afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

  it('zeus.status / zeus.skills / zeus.plan answer over a read-only personal mount; realm.write stays refused', async () => {
    sandbox = mkdtempSync(join(tmpdir(), 'zeus-personal-mcp-kernel-'));
    const root = join(sandbox, 'realm');
    mkdirSync(join(root, 'notes'), { recursive: true });
    writeFileSync(join(root, 'notes', 'hello.txt'), 'Personal realm marker: recall meeting notes.\n');

    // In-memory kernel (no state file): zero side effects, read-only mount.
    const kernel = await bootKernel({
      realmRoots: [{ root, type: 'personal' as const, readOnly: true }],
    });
    try {
      kernel.skillRegistry!.register({
        id: 'code-review',
        name: 'Code Review',
        description: 'Review a unified diff',
        version: '1.0.0',
        tags: ['review'],
      });

      const store = kernel.realmStore!;
      const realmIds = store.connections().map(c => c.realmId);
      expect(realmIds).toHaveLength(1);
      const handle = createRealmMcpHandler({
        store,
        realmIds,
        kernelQueries: createPersonalKernelQueries(kernel),
      });

      const status = await handle(rpc(1, 'tools/call', { name: 'zeus.status', arguments: {} }));
      expect(status?.error).toBeUndefined();
      const statusText = contentOf(status);
      expect(statusText).not.toContain(root);
      expect(JSON.parse(statusText)).toMatchObject({
        realms: [{ realmId: realmIds[0], type: 'personal', readOnly: true }],
        pendingOversight: 0,
        watches: 0,
      });

      const skills = await handle(rpc(2, 'tools/call', { name: 'zeus.skills', arguments: {} }));
      const arr = JSON.parse(contentOf(skills)) as Array<{ id: string }>;
      expect(arr.map(s => s.id)).toContain('code-review');

      const byId = await handle(rpc(3, 'tools/call', { name: 'zeus.skills', arguments: { id: 'code-review' } }));
      expect(JSON.parse(contentOf(byId))).toMatchObject({ id: 'code-review', version: '1.0.0' });

      const plan = await handle(rpc(4, 'tools/call', { name: 'zeus.plan', arguments: { text: 'review the diff' } }));
      expect(plan?.error).toBeUndefined();
      expect(JSON.parse(contentOf(plan))).toMatchObject({ ok: true, skill: 'code-review', chosenBy: 'local-ranker' });

      // Empty catalogue would fail closed with a named reason, never a crash.
      const planEmpty = await handle(rpc(5, 'tools/call', { name: 'zeus.plan', arguments: { text: '' } }));
      // Empty text is rejected by the schema layer before the port is consulted.
      expect(planEmpty!.error!.code).toBe(JSON_RPC_CODES.INVALID_PARAMS);

      // The probe's 8th security check: a read-only mount refuses realm.write.
      const write = await handle(rpc(6, 'tools/call', { name: 'realm.write', arguments: { realmId: realmIds[0], data: 'should not land' } }));
      expect(write!.error!.code).toBe(JSON_RPC_CODES.REALM_UNAUTHORIZED);
      expect(write!.error!.message).toContain('realm-read-only');
    } finally {
      await kernel.releaseLock();
    }
  });
});
