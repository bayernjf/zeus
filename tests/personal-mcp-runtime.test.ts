import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bootRuntime } from '../src/state/boot.js';
import { createPersonalRuntimeQueries } from '../src/dataDomain/runtime-queries.js';
import {
  createDataDomainMcpHandler,
  JSON_RPC_CODES,
  type JsonRpcResponse,
  type PersonalRuntimeQueries,
} from '../src/dataDomain/mcp.js';
import type { DataDomainStore } from '../src/dataDomain/types.js';

function rpc(id: number, method: string, params?: unknown) {
  return { jsonrpc: '2.0' as const, id, method, ...(params ? { params } : {}) };
}

/**
 * Recording dataDomain stub: any dataDomain-side touch fails the test. The zeus.* face
 * must never address a connected dataDomain - asserting against a throwing store
 * proves the runtime tools bypass the dataDomain boundary by construction.
 */
function recordingStore(): { store: DataDomainStore; touched: string[] } {
  const touched: string[] = [];
  const boom = (op: string): (() => Promise<never>) => {
    return () => {
      touched.push(op);
      return Promise.reject(new Error(`dataDomain store op '${op}' must not be reached`));
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

/** Recorded fake runtime port: every call lands in `calls` for assertions. */
function fakeRuntimeQueries(): { queries: PersonalRuntimeQueries; calls: string[] } {
  const calls: string[] = [];
  const queries: PersonalRuntimeQueries = {
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
    async plan({ text, dataDomain }) {
      calls.push(`plan(${text},${dataDomain ?? 'personal'})`);
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
        dataDomains: [{ dataDomainId: 'dataDomain-abc', type: 'personal', readOnly: true }],
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

describe('zeus.* runtime tools over the personal MCP face (fake port, hermetic)', () => {
  it('tools/list advertises the dataDomain tools plus the three read-only runtime tools', async () => {
    const { store } = recordingStore();
    const { queries } = fakeRuntimeQueries();
    const handle = createDataDomainMcpHandler({ store, dataDomainIds: [], runtimeQueries: queries });
    const res = await handle(rpc(1, 'tools/list'));
    const names = (res!.result as { tools: Array<{ name: string }> }).tools.map(t => t.name).sort();
    expect(names).toEqual(['dataDomain.read', 'dataDomain.search', 'dataDomain.write', 'zeus.plan', 'zeus.skills', 'zeus.status']);
    const plan = (res!.result as { tools: Array<{ name: string; inputSchema: { required: string[] } }> }).tools.find(t => t.name === 'zeus.plan')!;
    expect(plan.inputSchema.required).toEqual(['text']);
    const skills = (res!.result as { tools: Array<{ name: string; inputSchema: { required: string[] } }> }).tools.find(t => t.name === 'zeus.skills')!;
    expect(skills.inputSchema.required).toEqual([]);
  });

  it('zeus.skills lists the catalogue, fetches by id, and reports unknown ids as not-found JSON', async () => {
    const { store, touched } = recordingStore();
    const { queries, calls } = fakeRuntimeQueries();
    const handle = createDataDomainMcpHandler({ store, dataDomainIds: [], runtimeQueries: queries });

    const list = await handle(rpc(1, 'tools/call', { name: 'zeus.skills', arguments: {} }));
    const arr = JSON.parse(contentOf(list)) as Array<{ id: string; version: string; tags: string[] }>;
    expect(arr.map(s => s.id).sort()).toEqual(['code-review', 'diary']);
    expect(arr[0]!.version).toBeTruthy();
    expect(arr[0]!.tags).toBeInstanceOf(Array);
    expect(touched).toEqual([]); // dataDomain store untouched

    const one = await handle(rpc(2, 'tools/call', { name: 'zeus.skills', arguments: { id: 'code-review', version: '1.2.0' } }));
    expect(JSON.parse(contentOf(one))).toMatchObject({ id: 'code-review', version: '1.2.0' });

    const missing = await handle(rpc(3, 'tools/call', { name: 'zeus.skills', arguments: { id: 'ghost' } }));
    expect(JSON.parse(contentOf(missing))).toEqual({ ok: false, reason: 'not-found', id: 'ghost' });

    // dataDomainId is neither required nor consulted on the runtime face.
    expect(calls).toContain('listSkills({})');
    expect(calls).toContain('getSkill(code-review,1.2.0)');
    expect(touched).toEqual([]);
  });

  it('zeus.plan returns a structured verdict and never touches the dataDomain store (no write path)', async () => {
    const { store, touched } = recordingStore();
    const { queries } = fakeRuntimeQueries();
    const handle = createDataDomainMcpHandler({ store, dataDomainIds: [], runtimeQueries: queries });

    const plan = await handle(rpc(1, 'tools/call', { name: 'zeus.plan', arguments: { text: 'review the diff', dataDomain: 'personal' } }));
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

  it('zeus.status projects dataDomains without the absolute root and reports counts', async () => {
    const { store } = recordingStore();
    const { queries } = fakeRuntimeQueries();
    const handle = createDataDomainMcpHandler({ store, dataDomainIds: [], runtimeQueries: queries });

    const res = await handle(rpc(1, 'tools/call', { name: 'zeus.status', arguments: {} }));
    expect(res?.error).toBeUndefined();
    const text = contentOf(res);
    expect(text).not.toMatch(/root/);
    expect(text).not.toMatch(/\/(Users|srv|tmp|home)\//);
    const status = JSON.parse(text) as {
      ts: string;
      dataDomains: Array<{ dataDomainId: string; type: string; readOnly: boolean }>;
      agents: { activeCount: number; names: string[] };
      pendingOversight: number;
      watches: number;
    };
    expect(status.dataDomains).toEqual([{ dataDomainId: 'dataDomain-abc', type: 'personal', readOnly: true }]);
    expect(status.agents).toEqual({ activeCount: 1, names: ['loom'] });
    expect(status.pendingOversight).toBe(2);
    expect(status.watches).toBe(3);
    expect(status.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('fail-closed: without a mounted runtime port the zeus.* tools answer with a named error, never empty success', async () => {
    const { store, touched } = recordingStore();
    const handle = createDataDomainMcpHandler({ store, dataDomainIds: [] }); // no runtimeQueries
    let seq = 0;
    for (const name of ['zeus.skills', 'zeus.plan', 'zeus.status']) {
      seq += 1;
      const res = await handle(rpc(seq, 'tools/call', {
        name,
        ...(name === 'zeus.plan' ? { arguments: { text: 'x' } } : {}),
      }));
      expect(res?.error).toBeDefined();
      expect(res!.error!.code).toBe(JSON_RPC_CODES.INVALID_PARAMS);
      expect(res!.error!.message).toContain('unavailable: runtime queries not mounted');
    }
    // And nothing was fabricated: the dataDomain store was never touched either.
    expect(touched).toEqual([]);
  });

  it('zeus.* needs no dataDomainId, while dataDomain.* tools stay under the host whitelist', async () => {
    const { store } = recordingStore();
    const { queries } = fakeRuntimeQueries();
    const handle = createDataDomainMcpHandler({ store, dataDomainIds: [], runtimeQueries: queries });

    // Runtime face works with an empty whitelist (no dataDomainId anywhere).
    const skills = await handle(rpc(1, 'tools/call', { name: 'zeus.skills', arguments: {} }));
    expect(skills?.error).toBeUndefined();

    // DataDomain face is still gated: even with the runtime port mounted, an unknown
    // dataDomainId is refused by the whitelist.
    const rogue = await handle(rpc(2, 'tools/call', { name: 'dataDomain.search', arguments: { dataDomainId: 'not-connected', text: 'x' } }));
    expect(rogue!.error!.code).toBe(JSON_RPC_CODES.DATA_DOMAIN_NOT_CONNECTED);
  });

  it('validates zeus.* arguments fail loud (missing text, bad dataDomain, stray params)', async () => {
    const { store } = recordingStore();
    const { queries } = fakeRuntimeQueries();
    const handle = createDataDomainMcpHandler({ store, dataDomainIds: [], runtimeQueries: queries });

    const noText = await handle(rpc(1, 'tools/call', { name: 'zeus.plan', arguments: {} }));
    expect(noText!.error!.code).toBe(JSON_RPC_CODES.INVALID_PARAMS);

    const badDataDomain = await handle(rpc(2, 'tools/call', { name: 'zeus.plan', arguments: { text: 'x', dataDomain: 'mystery' } }));
    expect(badDataDomain!.error!.code).toBe(JSON_RPC_CODES.INVALID_PARAMS);

    const planJunk = await handle(rpc(3, 'tools/call', { name: 'zeus.plan', arguments: { text: 'x', bogus: 1 } }));
    expect(planJunk!.error!.message).toMatch(/unsupported plan parameter: bogus/);

    const statusJunk = await handle(rpc(4, 'tools/call', { name: 'zeus.status', arguments: { watch: 1 } }));
    expect(statusJunk!.error!.code).toBe(JSON_RPC_CODES.INVALID_PARAMS);

    const skillsJunk = await handle(rpc(5, 'tools/call', { name: 'zeus.skills', arguments: { filter: 1 } }));
    expect(skillsJunk!.error!.message).toMatch(/unsupported skills parameter: filter/);

    const unknownRuntime = await handle(rpc(6, 'tools/call', { name: 'zeus.purge', arguments: {} }));
    expect(unknownRuntime!.error!.code).toBe(JSON_RPC_CODES.INVALID_PARAMS);
    expect(unknownRuntime!.error!.message).toMatch(/unknown tool/);
  });
});

describe('real booted runtime through the personal stdio face (integration)', () => {
  let sandbox: string;
  afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

  it('zeus.status / zeus.skills / zeus.plan answer over a read-only personal mount; dataDomain.write stays refused', async () => {
    sandbox = mkdtempSync(join(tmpdir(), 'zeus-personal-mcp-runtime-'));
    const root = join(sandbox, 'dataDomain');
    mkdirSync(join(root, 'notes'), { recursive: true });
    writeFileSync(join(root, 'notes', 'hello.txt'), 'Personal dataDomain marker: recall meeting notes.\n');

    // In-memory runtime (no state file): zero side effects, read-only mount.
    const runtime = await bootRuntime({
      dataDomainRoots: [{ root, type: 'personal' as const, readOnly: true }],
    });
    try {
      runtime.skillRegistry!.register({
        id: 'code-review',
        name: 'Code Review',
        description: 'Review a unified diff',
        version: '1.0.0',
        tags: ['review'],
      });

      const store = runtime.dataDomainStore!;
      const dataDomainIds = store.connections().map(c => c.dataDomainId);
      expect(dataDomainIds).toHaveLength(1);
      const handle = createDataDomainMcpHandler({
        store,
        dataDomainIds,
        runtimeQueries: createPersonalRuntimeQueries(runtime),
      });

      const status = await handle(rpc(1, 'tools/call', { name: 'zeus.status', arguments: {} }));
      expect(status?.error).toBeUndefined();
      const statusText = contentOf(status);
      expect(statusText).not.toContain(root);
      expect(JSON.parse(statusText)).toMatchObject({
        dataDomains: [{ dataDomainId: dataDomainIds[0], type: 'personal', readOnly: true }],
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

      // The probe's 8th security check: a read-only mount refuses dataDomain.write.
      const write = await handle(rpc(6, 'tools/call', { name: 'dataDomain.write', arguments: { dataDomainId: dataDomainIds[0], data: 'should not land' } }));
      expect(write!.error!.code).toBe(JSON_RPC_CODES.DATA_DOMAIN_UNAUTHORIZED);
      expect(write!.error!.message).toContain('dataDomain-read-only');
    } finally {
      await runtime.releaseLock();
    }
  });
});
