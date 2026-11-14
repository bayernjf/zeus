import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsDataDomainStore } from '../src/dataDomain/store.js';
import { DomainGrantRegistry } from '../src/dataDomain/authorization.js';
import { DataDomainSourceError, resolveDataDomainSource, type DataDomainAuditEntry } from '../src/dataDomain/source.js';
import type { DataDomainActor, DataDomainStore } from '../src/dataDomain/types.js';

const NOW = new Date('2026-09-25T00:00:00.000Z');
const now = () => NOW;

const operator: DataDomainActor = { kind: 'operator', id: 'operator' };

describe('E6.4 resolveDataDomainSource (runtime-side retrieval over real directories)', () => {
  let sandbox: string;
  let store: FsDataDomainStore;
  let grants: DomainGrantRegistry;
  let audit: DataDomainAuditEntry[];
  let deptDataDomainId: string;
  let personalDataDomainId: string;
  let readOnlyDataDomainId: string;

  beforeEach(async () => {
    sandbox = mkdtempSync(join(tmpdir(), 'zeus-dataDomain-source-'));
    audit = [];
    store = new FsDataDomainStore();
    grants = new DomainGrantRegistry(now);

    const make = (name: string, files: Record<string, string>) => {
      const root = join(sandbox, name);
      mkdirSync(root, { recursive: true });
      for (const [file, content] of Object.entries(files)) writeFileSync(join(root, file), content);
      return root;
    };

    deptDataDomainId = (await store.connect(
      make('eng', { 'design.md': 'compiler design\n', 'notes.md': 'unrelated\n' }),
      'enterprise',
      { tenant: 'acme/eng' },
    )).dataDomainId;
    await store.connect(
      make('mkt', { 'campaign.md': 'compiler spend on ads\n' }),
      'enterprise',
      { tenant: 'acme/mkt' },
    );
    personalDataDomainId = (await store.connect(
      make('me', { 'diary.md': 'my private compiler diary\n' }),
      'personal',
    )).dataDomainId;
    readOnlyDataDomainId = (await store.connect(
      make('ro', { 'a.md': 'a\n' }),
      'personal',
      { readOnly: true },
    )).dataDomainId;
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  const ask = (input: {
    actor?: DataDomainActor;
    dataDomainId: string;
    text?: string;
    limit?: number;
    access?: 'read' | 'write';
    declaredDataDomain?: 'personal' | 'enterprise';
  }) =>
    resolveDataDomainSource({
      store,
      actor: input.actor ?? operator,
      access: input.access ?? 'read',
      source: { dataDomainId: input.dataDomainId, ...(input.text ? { text: input.text } : {}), ...(input.limit ? { limit: input.limit } : {}) },
      ...(input.declaredDataDomain ? { declaredDataDomain: input.declaredDataDomain } : {}),
      grants: grants.list(),
      audit: entry => audit.push(entry),
      now,
    });

  it('reads the dataDomain by id and reports where the content came from', async () => {
    const resolved = await ask({ dataDomainId: deptDataDomainId, text: 'compiler' });
    expect(resolved.dataDomain).toBe('enterprise');
    expect(resolved.tenant).toEqual({ org: 'acme', department: 'eng' });
    expect(resolved.hits.map(hit => hit.itemId)).toEqual(['design.md']);
    expect(resolved.via).toBe('same-domain');
    expect(audit.map(entry => entry.decision)).toEqual(['domain-read']);
  });

  it('honours the query (text and limit) rather than dumping the corpus', async () => {
    const all = await ask({ dataDomainId: deptDataDomainId });
    expect(all.hits.map(hit => hit.itemId).sort()).toEqual(['design.md', 'notes.md']);
    const capped = await ask({ dataDomainId: deptDataDomainId, limit: 1 });
    expect(capped.hits).toHaveLength(1);
  });

  it('lets an org-scoped subject read down into a department, by hierarchy alone', async () => {
    const resolved = await ask({ actor: { kind: 'executor', id: 'pr-helper', tenant: { org: 'acme' } }, dataDomainId: deptDataDomainId });
    expect(resolved.via).toBe('tenant-hierarchy');
    expect(resolved.hits.length).toBeGreaterThan(0);
  });

  it('refuses a sibling department and leaks no content while doing so', async () => {
    const before = audit.length;
    await expect(
      ask({ actor: { kind: 'executor', id: 'loom', tenant: { org: 'acme', department: 'mkt' } }, dataDomainId: deptDataDomainId, text: 'compiler' }),
    ).rejects.toMatchObject({ decision: { reason: 'tenant-out-of-scope' } });
    const refusal = audit[before];
    expect(refusal?.decision).toBe('domain-refused');
    expect(JSON.stringify(refusal)).not.toMatch(/design\.md|compiler design/);
  });

  it('refuses a personal-side executor until the operator grants it, then admits it by grant id', async () => {
    await expect(ask({ actor: { kind: 'executor', id: 'jev' }, dataDomainId: deptDataDomainId }))
      .rejects.toMatchObject({ decision: { reason: 'no-grant' } });

    const issued = grants.issue({ subject: 'jev', dataDomainId: deptDataDomainId, access: 'read', grantedBy: 'operator', nonce: 'n1' });
    const resolved = await ask({ actor: { kind: 'executor', id: 'jev' }, dataDomainId: deptDataDomainId });
    expect(resolved.via).toBe('grant');
    expect(resolved.grantId).toBe(issued.grantId);

    // Revoking puts the boundary back; nothing about the dataDomain changed.
    grants.revoke(issued.grantId);
    await expect(ask({ actor: { kind: 'executor', id: 'jev' }, dataDomainId: deptDataDomainId }))
      .rejects.toMatchObject({ decision: { reason: 'no-grant' } });
  });

  it('never lets an enterprise subject read the personal domain', async () => {
    await expect(
      ask({ actor: { kind: 'executor', id: 'loom', tenant: { org: 'acme' } }, dataDomainId: personalDataDomainId }),
    ).rejects.toMatchObject({ decision: { reason: 'enterprise-to-personal' } });
  });

  it('refuses when the intent declared a different domain than the dataDomain it points at', async () => {
    // This is the assertion the caller-supplied dataDomainHits path could never make:
    // declared "personal", mined from an enterprise corpus.
    await expect(ask({ dataDomainId: deptDataDomainId, declaredDataDomain: 'personal' }))
      .rejects.toMatchObject({ decision: { reason: 'dataDomain-type-mismatch' } });
    await expect(ask({ dataDomainId: deptDataDomainId, declaredDataDomain: 'enterprise' })).resolves.toMatchObject({ dataDomain: 'enterprise' });
  });

  it('names an unconnected dataDomain instead of returning an empty result', async () => {
    await expect(ask({ dataDomainId: 'dataDomain-does-not-exist' })).rejects.toBeInstanceOf(DataDomainSourceError);
    await expect(ask({ dataDomainId: 'dataDomain-does-not-exist' })).rejects.toMatchObject({ decision: { reason: 'unknown-dataDomain' } });
  });

  it('surfaces a store fault instead of relabelling it as an unconnected dataDomain', async () => {
    const broken = {
      manifest: async () => {
        throw new Error('EIO: manifest unreadable');
      },
      connections: () => [],
    } as unknown as DataDomainStore;
    const faults: DataDomainAuditEntry[] = [];
    await expect(
      resolveDataDomainSource({
        store: broken,
        actor: operator,
        source: { dataDomainId: deptDataDomainId },
        audit: entry => faults.push(entry),
        now,
      }),
    ).rejects.toThrow(/EIO: manifest unreadable/);
    // A store fault is not a boundary refusal, so it must not be audited as one.
    expect(faults).toHaveLength(0);
  });

  it('refuses a write ask against a read-only mount', async () => {
    await expect(ask({ dataDomainId: readOnlyDataDomainId, access: 'write' }))
      .rejects.toMatchObject({ decision: { reason: 'read-only' } });
  });

  it('audits the subject, not the absolute path', async () => {
    await ask({ dataDomainId: deptDataDomainId, text: 'compiler' });
    expect(audit[0]).toMatchObject({ executor: 'operator', dataDomain: 'enterprise' });
    expect(audit[0]!.detail).toContain('acme/eng');
    expect(JSON.stringify(audit)).not.toContain(sandbox);
  });
});
