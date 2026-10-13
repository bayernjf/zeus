/**
 * E3.4 remaining item (1): the write step over MCP.
 *
 * The MCP face is the only externally drivable write channel, so its boundary is
 * the DriverWriteGrant (E3.5): an enterprise write is refused unless the caller
 * presents a signed, unexpired, single-use grant bound to that realm. The grant
 * is verified by the store - the same code path the kernel's own writers use -
 * so this suite pins the *channel*, not a second implementation of the check:
 *
 *  - tools/list declares realm.write with the grant in the schema (a capability
 *    nobody can see is a capability nobody can drive)
 *  - every refusal reason the store can produce is surfaced by name, and no
 *    refusal writes anything
 *  - a rejected attempt never burns the nonce, so a legitimate retry still works
 *  - an accepted write is visible to search immediately and reaches the audit
 *    spine with grantedBy, which is what makes it authorizable after the fact
 *  - a personal-realm write needs no grant (same contract as every other write
 *    path) and carries no grantedBy
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsRealmStore } from '../src/realm/store.js';
import { createRealmMcpHandler, JSON_RPC_CODES, type JsonRpcResponse } from '../src/realm/mcp.js';
import { DriverGrantLedger, issueDriverWriteGrant } from '../src/realm/grant.js';
import { Ed25519MemorySigner } from '../src/registry/signing.js';
import type { DriverWriteGrant } from '../src/realm/types.js';

type Handle = (message: unknown) => Promise<JsonRpcResponse | null>;
type AuditEntry = {
  realmId: string;
  realmType: string;
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
  return handle(rpc(id, 'tools/call', { name: 'realm.write', arguments: args }));
}

function resultText(res: JsonRpcResponse | null): unknown {
  const content = (res!.result as { content: Array<{ text: string }> }).content;
  return JSON.parse(content[0]!.text);
}

describe('Realm MCP write step (E3.4 remaining 1: writes need a DriverWriteGrant)', () => {
  let sandbox: string;
  let store: FsRealmStore;
  let handle: Handle;
  let signer: Ed25519MemorySigner;
  let ledger: DriverGrantLedger;
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
    ledger = new DriverGrantLedger();
    audit = [];
    store = new FsRealmStore({
      now: () => NOW,
      driverGrants: { ledger, verifier: signer.verifier(), acceptedKeyIds: [signer.keyId] },
      audit: (entry: AuditEntry) => audit.push(entry),
    });
    personalId = (await store.connect(personalRoot, 'personal')).realmId;
    enterpriseId = (await store.connect(enterpriseRoot, 'enterprise', { tenant: 'acme/eng' })).realmId;
    handle = createRealmMcpHandler({
      store,
      realmIds: [personalId, enterpriseId],
      actor: { name: 'mcp-client' },
    });
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  async function grantFor(realmId: string): Promise<DriverWriteGrant> {
    return issueDriverWriteGrant(
      { realmId, grantedBy: 'driver', reason: 'mcp write test', ttlMs: 60_000 },
      { signer, now: () => NOW },
    );
  }

  it('advertises realm.write with the grant in the schema', async () => {
    const res = await handle(rpc(1, 'tools/list'));
    const tools = (
      res!.result as {
        tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown>; required: string[] } }>;
      }
    ).tools;
    const names = tools.map(t => t.name);
    expect(names).toContain('realm.write');
    expect(names).toContain('realm.read');
    expect(names).toContain('realm.search');
    const write = tools.find(t => t.name === 'realm.write')!;
    expect(Object.keys(write.inputSchema.properties).sort()).toEqual(['data', 'grant', 'itemId', 'realmId']);
    expect(write.inputSchema.required.sort()).toEqual(['data', 'realmId']);
  });

  it('refuses an enterprise write with no grant and names the reason', async () => {
    const res = await callWrite(handle, 2, {
      realmId: enterpriseId,
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
    const unsigned = { ...valid } as Partial<DriverWriteGrant>;
    delete unsigned.sig;
    delete unsigned.keyId;

    const bad = await callWrite(handle, 3, { realmId: enterpriseId, itemId: 'notes/a.md', data: 'x', grant: tampered });
    expect(bad?.error?.code).toBe(UNAUTHORIZED);
    const none = await callWrite(handle, 4, { realmId: enterpriseId, itemId: 'notes/b.md', data: 'x', grant: unsigned });
    expect(none?.error?.code).toBe(UNAUTHORIZED);
    expect(existsSync(join(sandbox, 'enterprise', 'notes', 'a.md'))).toBe(false);
    expect(existsSync(join(sandbox, 'enterprise', 'notes', 'b.md'))).toBe(false);
  });

  it('refuses a grant bound to another realm and an expired one', async () => {
    const personal = await grantFor(personalId);
    const wrongRealm = await callWrite(handle, 5, {
      realmId: enterpriseId,
      itemId: 'notes/c.md',
      data: 'x',
      grant: personal,
    });
    expect(wrongRealm?.error?.code).toBe(UNAUTHORIZED);
    expect(wrongRealm!.error!.message).toContain('wrong-realm');

    const expired = await issueDriverWriteGrant(
      { realmId: enterpriseId, grantedBy: 'driver', ttlMs: 1_000 },
      { signer, now: () => new Date(NOW.getTime() - 60_000) },
    );
    const stale = await callWrite(handle, 6, {
      realmId: enterpriseId,
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
      realmId: enterpriseId,
      itemId: 'notes/report.md',
      data: '# Report\n\nzeus quarterly numbers\n',
      grant,
    });
    expect(res?.error).toBeUndefined();
    expect(resultText(res)).toEqual({ itemId: 'notes/report.md' });
    expect(readFileSync(join(sandbox, 'enterprise', 'notes', 'report.md'), 'utf8')).toContain('quarterly numbers');

    const found = await handle(
      rpc(8, 'tools/call', { name: 'realm.search', arguments: { realmId: enterpriseId, text: 'quarterly' } }),
    );
    expect(JSON.stringify(resultText(found))).toContain('notes/report.md');

    // The write is authorizable after the fact: grantedBy rides the audit entry,
    // which is what the kernel turns into a realm-write row on the audit spine.
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ realmId: enterpriseId, itemId: 'notes/report.md', grantedBy: 'driver' });
  });

  it('refuses a replayed grant, and a rejected attempt never burns the nonce', async () => {
    const grant = await grantFor(enterpriseId);
    const first = await callWrite(handle, 9, { realmId: enterpriseId, itemId: 'notes/one.md', data: 'first', grant });
    expect(first?.error).toBeUndefined();

    const replay = await callWrite(handle, 10, { realmId: enterpriseId, itemId: 'notes/two.md', data: 'second', grant });
    expect(replay?.error?.code).toBe(UNAUTHORIZED);
    expect(replay!.error!.message).toContain('replay');
    expect(existsSync(join(sandbox, 'enterprise', 'notes', 'two.md'))).toBe(false);

    // A refused attempt (here: a grant with no issuer) must leave its own nonce
    // unspent, otherwise a bug in the refusal path would strand the operator.
    const retry = await grantFor(enterpriseId);
    const refused = await callWrite(handle, 11, {
      realmId: enterpriseId,
      itemId: 'notes/three.md',
      data: 'x',
      grant: { ...retry, grantedBy: '' },
    });
    expect(refused?.error?.code).toBe(UNAUTHORIZED);
    const accepted = await callWrite(handle, 12, {
      realmId: enterpriseId,
      itemId: 'notes/three.md',
      data: 'third',
      grant: retry,
    });
    expect(accepted?.error).toBeUndefined();
  });

  it('writes into a personal realm without a grant and reports no grant authority', async () => {
    const res = await callWrite(handle, 13, { realmId: personalId, itemId: 'notes/day1.md', data: 'first day' });
    expect(res?.error).toBeUndefined();
    expect(resultText(res)).toEqual({ itemId: 'notes/day1.md' });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.grantedBy).toBeUndefined();
  });

  it('refuses a read-only realm', async () => {
    const readOnlyRoot = join(sandbox, 'frozen');
    mkdirSync(readOnlyRoot, { recursive: true });
    writeFileSync(join(readOnlyRoot, 'notes.txt'), 'fixed\n');
    const frozenId = (await store.connect(readOnlyRoot, 'personal', { readOnly: true })).realmId;
    const scoped = createRealmMcpHandler({ store, realmIds: [frozenId] });
    const res = await callWrite(scoped, 14, { realmId: frozenId, itemId: 'notes.txt', data: 'changed' });
    expect(res?.error?.code).toBe(UNAUTHORIZED);
    expect(readFileSync(join(readOnlyRoot, 'notes.txt'), 'utf8')).toBe('fixed\n');
  });

  it('fails loud on an argument the schema never declared, and on a missing payload', async () => {
    const unknown = await callWrite(handle, 15, { realmId: personalId, data: 'x', mode: 'overwrite' });
    expect(unknown?.error?.code).toBe(JSON_RPC_CODES.INVALID_PARAMS);
    expect(unknown!.error!.message).toContain('mode');

    const noData = await callWrite(handle, 16, { realmId: personalId, itemId: 'notes/x.md' });
    expect(noData?.error?.code).toBe(JSON_RPC_CODES.INVALID_PARAMS);
    expect(noData!.error!.message).toContain('data');
  });

  it('refuses a realm the host did not authorize and a path that escapes the root', async () => {
    const outsider = await callWrite(handle, 17, { realmId: 'realm-other', data: 'x' });
    expect(outsider?.error?.code).toBe(JSON_RPC_CODES.REALM_NOT_CONNECTED);

    const escaping = await callWrite(handle, 18, { realmId: personalId, itemId: '../outside.md', data: 'x' });
    expect(escaping?.error?.code).toBe(JSON_RPC_CODES.INVALID_ITEM);
    expect(existsSync(join(sandbox, 'outside.md'))).toBe(false);
  });

  it('refuses by name when the host store implements no writes at all', async () => {
    // `RealmStore.write` is optional on purpose (read-only deployments, P0
    // backends). A tool that cannot work must say so rather than throw undefined.
    const readOnlyStore = {
      manifest: async () => {
        throw new Error('not used by this test');
      },
      search: async () => [],
      read: async () => {
        throw new Error('not used by this test');
      },
    } as unknown as Parameters<typeof createRealmMcpHandler>[0]['store'];
    const scoped = createRealmMcpHandler({ store: readOnlyStore, realmIds: [personalId] });
    const res = await callWrite(scoped, 19, { realmId: personalId, data: 'x' });
    expect(res?.error?.code).toBe(JSON_RPC_CODES.INVALID_PARAMS);
    expect(res!.error!.message).toContain('does not implement writes');
  });
});
