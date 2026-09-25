import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsRealmStore } from '../src/realm/store.js';
import { DomainGrantRegistry } from '../src/realm/authorization.js';
import { RealmSourceError, resolveRealmSource, type RealmAuditEntry } from '../src/realm/source.js';
import type { RealmActor } from '../src/realm/types.js';

const NOW = new Date('2026-09-25T00:00:00.000Z');
const now = () => NOW;

const driver: RealmActor = { kind: 'driver', id: 'driver' };

describe('E6.4 resolveRealmSource (kernel-side retrieval over real directories)', () => {
  let sandbox: string;
  let store: FsRealmStore;
  let grants: DomainGrantRegistry;
  let audit: RealmAuditEntry[];
  let deptRealmId: string;
  let mktRealmId: string;
  let personalRealmId: string;
  let readOnlyRealmId: string;

  beforeEach(async () => {
    sandbox = mkdtempSync(join(tmpdir(), 'zeus-realm-source-'));
    audit = [];
    store = new FsRealmStore();
    grants = new DomainGrantRegistry(now);

    const make = (name: string, files: Record<string, string>) => {
      const root = join(sandbox, name);
      mkdirSync(root, { recursive: true });
      for (const [file, content] of Object.entries(files)) writeFileSync(join(root, file), content);
      return root;
    };

    deptRealmId = (await store.connect(
      make('eng', { 'design.md': 'compiler design\n', 'notes.md': 'unrelated\n' }),
      'enterprise',
      { tenant: 'acme/eng' },
    )).realmId;
    mktRealmId = (await store.connect(
      make('mkt', { 'campaign.md': 'compiler spend on ads\n' }),
      'enterprise',
      { tenant: 'acme/mkt' },
    )).realmId;
    personalRealmId = (await store.connect(
      make('me', { 'diary.md': 'my private compiler diary\n' }),
      'personal',
    )).realmId;
    readOnlyRealmId = (await store.connect(
      make('ro', { 'a.md': 'a\n' }),
      'personal',
      { readOnly: true },
    )).realmId;
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  const ask = (input: {
    actor?: RealmActor;
    realmId: string;
    text?: string;
    limit?: number;
    access?: 'read' | 'write';
    declaredRealm?: 'personal' | 'enterprise';
  }) =>
    resolveRealmSource({
      store,
      actor: input.actor ?? driver,
      access: input.access ?? 'read',
      source: { realmId: input.realmId, ...(input.text ? { text: input.text } : {}), ...(input.limit ? { limit: input.limit } : {}) },
      ...(input.declaredRealm ? { declaredRealm: input.declaredRealm } : {}),
      grants: grants.list(),
      audit: entry => audit.push(entry),
      now,
    });

  it('reads the realm by id and reports where the content came from', async () => {
    const resolved = await ask({ realmId: deptRealmId, text: 'compiler' });
    expect(resolved.realm).toBe('enterprise');
    expect(resolved.tenant).toEqual({ org: 'acme', department: 'eng' });
    expect(resolved.hits.map(hit => hit.itemId)).toEqual(['design.md']);
    expect(resolved.via).toBe('same-domain');
    expect(audit.map(entry => entry.decision)).toEqual(['domain-read']);
  });

  it('honours the query (text and limit) rather than dumping the corpus', async () => {
    const all = await ask({ realmId: deptRealmId });
    expect(all.hits.map(hit => hit.itemId).sort()).toEqual(['design.md', 'notes.md']);
    const capped = await ask({ realmId: deptRealmId, limit: 1 });
    expect(capped.hits).toHaveLength(1);
  });

  it('lets an org-scoped subject read down into a department, by hierarchy alone', async () => {
    const resolved = await ask({ actor: { kind: 'vassal', id: 'pr-helper', tenant: { org: 'acme' } }, realmId: deptRealmId });
    expect(resolved.via).toBe('tenant-hierarchy');
    expect(resolved.hits.length).toBeGreaterThan(0);
  });

  it('refuses a sibling department and leaks no content while doing so', async () => {
    const before = audit.length;
    await expect(
      ask({ actor: { kind: 'vassal', id: 'loom', tenant: { org: 'acme', department: 'mkt' } }, realmId: deptRealmId, text: 'compiler' }),
    ).rejects.toMatchObject({ decision: { reason: 'tenant-out-of-scope' } });
    const refusal = audit[before];
    expect(refusal?.decision).toBe('domain-refused');
    expect(JSON.stringify(refusal)).not.toMatch(/design\.md|compiler design/);
  });

  it('refuses a personal-side vassal until the driver grants it, then admits it by grant id', async () => {
    await expect(ask({ actor: { kind: 'vassal', id: 'jev' }, realmId: deptRealmId }))
      .rejects.toMatchObject({ decision: { reason: 'no-grant' } });

    const issued = grants.issue({ subject: 'jev', realmId: deptRealmId, access: 'read', grantedBy: 'driver', nonce: 'n1' });
    const resolved = await ask({ actor: { kind: 'vassal', id: 'jev' }, realmId: deptRealmId });
    expect(resolved.via).toBe('grant');
    expect(resolved.grantId).toBe(issued.grantId);

    // Revoking puts the boundary back; nothing about the realm changed.
    grants.revoke(issued.grantId);
    await expect(ask({ actor: { kind: 'vassal', id: 'jev' }, realmId: deptRealmId }))
      .rejects.toMatchObject({ decision: { reason: 'no-grant' } });
  });

  it('never lets an enterprise subject read the personal domain', async () => {
    await expect(
      ask({ actor: { kind: 'vassal', id: 'loom', tenant: { org: 'acme' } }, realmId: personalRealmId }),
    ).rejects.toMatchObject({ decision: { reason: 'enterprise-to-personal' } });
  });

  it('refuses when the intent declared a different domain than the realm it points at', async () => {
    // This is the assertion the caller-supplied realmHits path could never make:
    // declared "personal", mined from an enterprise corpus.
    await expect(ask({ realmId: deptRealmId, declaredRealm: 'personal' }))
      .rejects.toMatchObject({ decision: { reason: 'realm-type-mismatch' } });
    await expect(ask({ realmId: deptRealmId, declaredRealm: 'enterprise' })).resolves.toMatchObject({ realm: 'enterprise' });
  });

  it('names an unconnected realm instead of returning an empty result', async () => {
    await expect(ask({ realmId: 'realm-does-not-exist' })).rejects.toBeInstanceOf(RealmSourceError);
    await expect(ask({ realmId: 'realm-does-not-exist' })).rejects.toMatchObject({ decision: { reason: 'unknown-realm' } });
  });

  it('refuses a write ask against a read-only mount', async () => {
    await expect(ask({ realmId: readOnlyRealmId, access: 'write' }))
      .rejects.toMatchObject({ decision: { reason: 'read-only' } });
  });

  it('audits the subject, not the absolute path', async () => {
    await ask({ realmId: deptRealmId, text: 'compiler' });
    expect(audit[0]).toMatchObject({ vassal: 'driver', realm: 'enterprise' });
    expect(audit[0]!.detail).toContain('acme/eng');
    expect(JSON.stringify(audit)).not.toContain(sandbox);
  });
});
