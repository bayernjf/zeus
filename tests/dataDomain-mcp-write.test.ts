/**
 * E3.4 remaining item (1): the write step over MCP.
 *
 * The MCP face is the only externally drivable write channel, so its boundary is
 * the OperatorWriteGrant (E3.5): an enterprise write is refused unless the caller
 * presents a signed, unexpired, single-use grant bound to that dataDomain. The grant
 * is verified by the store - the same code path the runtime's own writers use -
 * so this suite pins the *channel*, not a second implementation of the check:
 *
 *  - tools/list declares dataDomain.write with the grant in the schema (a capability
 *    nobody can see is a capability nobody can drive)
 *  - every refusal reason the store can produce is surfaced by name, and no
 *    refusal writes anything
 *  - a rejected attempt never burns the nonce, so a legitimate retry still works
 *  - an accepted write is visible to search immediately and reaches the audit
 *    spine with grantedBy, which is what makes it authorizable after the fact
 *  - a personal-dataDomain write needs no grant (same contract as every other write
 *    path) and carries no grantedBy
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsDataDomainStore } from '../src/dataDomain/store.js';
import { createDataDomainMcpHandler, JSON_RPC_CODES, type JsonRpcResponse } from '../src/dataDomain/mcp.js';
import { OperatorGrantLedger, issueOperatorWriteGrant } from '../src/dataDomain/grant.js';
import { Ed25519MemorySigner } from '../src/registry/signing.js';
import type { OperatorWriteGrant } from '../src/dataDomain/types.js';

type Handle = (message: unknown) => Promise<JsonRpcResponse | null>;
type AuditEntry = {
  dataDomainId: string;
  dataDomainType: string;
  itemId: string;
  bytes: number;
  at: string;
  grantedBy?: string;
};

const NOW = new Date('2026-10-14T09:00:00.000Z');
const UNAUTHORIZED = -32004;

function rpc(id: number, method: string, params?: unknown) {
  return { jsonrpc: '2.0' as const, id, method, ...(params ? { params } : {}) };
}

function callWrite(handle: Handle, id: number, args: Record<string, unknown>) {
  return handle(rpc(id, 'tools/call', { name: 'dataDomain.write', arguments: args }));
}

function resultText(res: JsonRpcResponse | null): unknown {
  const content = (res!.result as { content: Array<{ text: string }> }).content;
  return JSON.parse(content[0]!.text);
}

describe('DataDomain MCP write step (E3.4 remaining 1: writes need a OperatorWriteGrant)', () => {
  let sandbox: string;
  let store: FsDataDomainStore;
  let handle: Handle;
  let signer: Ed25519MemorySigner;
  let ledger: OperatorGrantLedger;
  let audit: AuditEntry[];
  let personalId: string;
  let enterpriseId: string;

  beforeEach(async () => {
    sandbox = mkdtempSync(join(tmpdir(), 'zeus-mcp-write-'));
    const personalRoot = join(sandbox, 'personal');
    const enterpriseRoot = join(sandbox, 'enterprise');
    mkdirSync(join(personalRoot, 'notes'), { recursive: true });
    mkdirSync(join(enterpriseRoot, 'notes'), { recursive: true });
    writeFileSync(join(personalRoot, 'notes', 'todo.txt'), 'buy milk\n');

    signer = new Ed25519MemorySigner('zeus-rsk-mcp-write');
    ledger = new OperatorGrantLedger();
    audit = [];
    store = new FsDataDomainStore({
      now: () => NOW,
      operatorGrants: { ledger, verifier: signer.verifier(), acceptedKeyIds: [signer.keyId] },
      audit: (entry: AuditEntry) => audit.push(entry),
    });
    personalId = (await store.connect(personalRoot, 'personal')).dataDomainId;
    enterpriseId = (await store.connect(enterpriseRoot, 'enterprise', { tenant: 'acme/eng' })).dataDomainId;
    handle = createDataDomainMcpHandler({
      store,
      dataDomainIds: [personalId, enterpriseId],
      actor: { name: 'mcp-client' },
    });
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  async function grantFor(dataDomainId: string): Promise<OperatorWriteGrant> {
    return issueOperatorWriteGrant(
      { dataDomainId, grantedBy: 'operator', reason: 'mcp write test', ttlMs: 60_000 },
      { signer, now: () => NOW },
    );
  }

  it('advertises dataDomain.write with the grant in the schema', async () => {
    const res = await handle(rpc(1, 'tools/list'));
    const tools = (
      res!.result as {
        tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown>; required: string[] } }>;
      }
    ).tools;
    const names = tools.map(t => t.name);
    expect(names).toContain('dataDomain.write');
    expect(names).toContain('dataDomain.read');
    expect(names).toContain('dataDomain.search');
    const write = tools.find(t => t.name === 'dataDomain.write')!;
    expect(Object.keys(write.inputSchema.properties).sort()).toEqual(['data', 'dataDomainId', 'grant', 'itemId']);
    expect(write.inputSchema.required.sort()).toEqual(['data', 'dataDomainId']);
  });

  it('refuses an enterprise write with no grant and names the reason', async () => {
    const res = await callWrite(handle, 2, {
      dataDomainId: enterpriseId,
      itemId: 'notes/report.md',
      data: 'quarterly numbers',
    });
    expect(res?.error?.code).toBe(UNAUTHORIZED);
    expect(res!.error!.message).toContain('missing');
    expect(existsSync(join(sandbox, 'enterprise', 'notes', 'report.md'))).toBe(false);
    expect(audit).toEqual([]);
  });

  it('refuses an unsigned or tampered grant', async () => {
    const valid = await grantFor(enterpriseId);
    const tampered = { ...valid, sig: `${valid.sig!.startsWith('a') ? 'b' : 'a'}${valid.sig!.slice(1)}` };
    const unsigned = { ...valid } as Partial<OperatorWriteGrant>;
    delete unsigned.sig;
    delete unsigned.keyId;

    const bad = await callWrite(handle, 3, { dataDomainId: enterpriseId, itemId: 'notes/a.md', data: 'x', grant: tampered });
    expect(bad?.error?.code).toBe(UNAUTHORIZED);
    const none = await callWrite(handle, 4, { dataDomainId: enterpriseId, itemId: 'notes/b.md', data: 'x', grant: unsigned });
    expect(none?.error?.code).toBe(UNAUTHORIZED);
    expect(existsSync(join(sandbox, 'enterprise', 'notes', 'a.md'))).toBe(false);
    expect(existsSync(join(sandbox, 'enterprise', 'notes', 'b.md'))).toBe(false);
  });

  it('refuses a grant bound to another dataDomain and an expired one', async () => {
    const personal = await grantFor(personalId);
    const wrongDataDomain = await callWrite(handle, 5, {
      dataDomainId: enterpriseId,
      itemId: 'notes/c.md',
      data: 'x',
      grant: personal,
    });
    expect(wrongDataDomain?.error?.code).toBe(UNAUTHORIZED);
    expect(wrongDataDomain!.error!.message).toContain('wrong-dataDomain');

    const expired = await issueOperatorWriteGrant(
      { dataDomainId: enterpriseId, grantedBy: 'operator', ttlMs: 1_000 },
      { signer, now: () => new Date(NOW.getTime() - 60_000) },
    );
    const stale = await callWrite(handle, 6, {
      dataDomainId: enterpriseId,
      itemId: 'notes/d.md',
      data: 'x',
      grant: expired,
    });
    expect(stale?.error?.code).toBe(UNAUTHORIZED);
    expect(stale!.error!.message).toContain('expired');
  });

  it('writes with a valid grant, and the content is immediately searchable', async () => {
    const grant = await grantFor(enterpriseId);
    const res = await callWrite(handle, 7, {
      dataDomainId: enterpriseId,
      itemId: 'notes/report.md',
      data: '# Report\n\nzeus quarterly numbers\n',
      grant,
    });
    expect(res?.error).toBeUndefined();
    expect(resultText(res)).toEqual({ itemId: 'notes/report.md' });
    expect(readFileSync(join(sandbox, 'enterprise', 'notes', 'report.md'), 'utf8')).toContain('quarterly numbers');

    const found = await handle(
      rpc(8, 'tools/call', { name: 'dataDomain.search', arguments: { dataDomainId: enterpriseId, text: 'quarterly' } }),
    );
    expect(JSON.stringify(resultText(found))).toContain('notes/report.md');

    // The write is authorizable after the fact: grantedBy rides the audit entry,
    // which is what the runtime turns into a dataDomain-write row on the audit spine.
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ dataDomainId: enterpriseId, itemId: 'notes/report.md', grantedBy: 'operator' });
  });

  it('refuses a replayed grant, and a rejected attempt never burns the nonce', async () => {
    const grant = await grantFor(enterpriseId);
    const first = await callWrite(handle, 9, { dataDomainId: enterpriseId, itemId: 'notes/one.md', data: 'first', grant });
    expect(first?.error).toBeUndefined();

    const replay = await callWrite(handle, 10, { dataDomainId: enterpriseId, itemId: 'notes/two.md', data: 'second', grant });
    expect(replay?.error?.code).toBe(UNAUTHORIZED);
    expect(replay!.error!.message).toContain('replay');
    expect(existsSync(join(sandbox, 'enterprise', 'notes', 'two.md'))).toBe(false);

    // A refused attempt (here: a grant with no issuer) must leave its own nonce
    // unspent, otherwise a bug in the refusal path would strand the operator.
    const retry = await grantFor(enterpriseId);
    const refused = await callWrite(handle, 11, {
      dataDomainId: enterpriseId,
      itemId: 'notes/three.md',
      data: 'x',
      grant: { ...retry, grantedBy: '' },
    });
    expect(refused?.error?.code).toBe(UNAUTHORIZED);
    const accepted = await callWrite(handle, 12, {
      dataDomainId: enterpriseId,
      itemId: 'notes/three.md',
      data: 'third',
      grant: retry,
    });
    expect(accepted?.error).toBeUndefined();
  });

  it('writes into a personal dataDomain without a grant and reports no grant authority', async () => {
    const res = await callWrite(handle, 13, { dataDomainId: personalId, itemId: 'notes/day1.md', data: 'first day' });
    expect(res?.error).toBeUndefined();
    expect(resultText(res)).toEqual({ itemId: 'notes/day1.md' });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.grantedBy).toBeUndefined();
  });

  it('refuses a read-only dataDomain', async () => {
    const readOnlyRoot = join(sandbox, 'frozen');
    mkdirSync(readOnlyRoot, { recursive: true });
    writeFileSync(join(readOnlyRoot, 'notes.txt'), 'fixed\n');
    const frozenId = (await store.connect(readOnlyRoot, 'personal', { readOnly: true })).dataDomainId;
    const scoped = createDataDomainMcpHandler({ store, dataDomainIds: [frozenId] });
    const res = await callWrite(scoped, 14, { dataDomainId: frozenId, itemId: 'notes.txt', data: 'changed' });
    expect(res?.error?.code).toBe(UNAUTHORIZED);
    expect(readFileSync(join(readOnlyRoot, 'notes.txt'), 'utf8')).toBe('fixed\n');
  });

  it('fails loud on an argument the schema never declared, and on a missing payload', async () => {
    const unknown = await callWrite(handle, 15, { dataDomainId: personalId, data: 'x', mode: 'overwrite' });
    expect(unknown?.error?.code).toBe(JSON_RPC_CODES.INVALID_PARAMS);
    expect(unknown!.error!.message).toContain('mode');

    const noData = await callWrite(handle, 16, { dataDomainId: personalId, itemId: 'notes/x.md' });
    expect(noData?.error?.code).toBe(JSON_RPC_CODES.INVALID_PARAMS);
    expect(noData!.error!.message).toContain('data');
  });

  it('refuses a dataDomain the host did not authorize and a path that escapes the root', async () => {
    const outsider = await callWrite(handle, 17, { dataDomainId: 'dataDomain-other', data: 'x' });
    expect(outsider?.error?.code).toBe(JSON_RPC_CODES.DATA_DOMAIN_NOT_CONNECTED);

    const escaping = await callWrite(handle, 18, { dataDomainId: personalId, itemId: '../outside.md', data: 'x' });
    expect(escaping?.error?.code).toBe(JSON_RPC_CODES.INVALID_ITEM);
    expect(existsSync(join(sandbox, 'outside.md'))).toBe(false);
  });

  it('refuses by name when the host store implements no writes at all', async () => {
    // `DataDomainStore.write` is optional on purpose (read-only deployments, P0
    // backends). A tool that cannot work must say so rather than throw undefined.
    const readOnlyStore = {
      manifest: async () => {
        throw new Error('not used by this test');
      },
      search: async () => [],
      read: async () => {
        throw new Error('not used by this test');
      },
    } as unknown as Parameters<typeof createDataDomainMcpHandler>[0]['store'];
    const scoped = createDataDomainMcpHandler({ store: readOnlyStore, dataDomainIds: [personalId] });
    const res = await callWrite(scoped, 19, { dataDomainId: personalId, data: 'x' });
    expect(res?.error?.code).toBe(JSON_RPC_CODES.INVALID_PARAMS);
    expect(res!.error!.message).toContain('does not implement writes');
  });
});
