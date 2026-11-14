import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsDataDomainStore } from '../src/dataDomain/store.js';
import { DataDomainError, DataDomainNotConnectedError } from '../src/dataDomain/types.js';

describe('deferred #17 — explicit dataDomain boundary mutations', () => {
  let sandbox: string;
  let dept: string;
  let org: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'zeus-dataDomain-ops-'));
    dept = join(sandbox, 'acme-eng');
    org = join(sandbox, 'acme');
    mkdirSync(dept, { recursive: true });
    mkdirSync(org, { recursive: true });
    writeFileSync(join(dept, 'design.md'), 'department design doc\n');
    writeFileSync(join(org, 'handbook.md'), 'org wide\n');
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  describe('disconnect(dataDomainId)', () => {
    it('removes a mounted dataDomain from connections() so it is no longer persisted', async () => {
      const store = new FsDataDomainStore();
      const { dataDomainId } = await store.connect(dept, 'enterprise', { tenant: 'acme/eng' });
      expect(store.connections().some(c => c.dataDomainId === dataDomainId)).toBe(true);

      await store.disconnect(dataDomainId);
      expect(store.connections().some(c => c.dataDomainId === dataDomainId)).toBe(false);
    });

    it('refuses to disconnect an unknown dataDomain (fail-loud, not silent no-op)', async () => {
      const store = new FsDataDomainStore();
      await expect(store.disconnect('dataDomain-does-not-exist')).rejects.toThrow(DataDomainNotConnectedError);
    });

    it('allows the same root to be reconnected fresh after disconnect (no stale tenant)', async () => {
      const store = new FsDataDomainStore();
      const { dataDomainId } = await store.connect(dept, 'enterprise', { tenant: 'acme/eng' });
      await store.disconnect(dataDomainId);

      // Reconnecting the same directory under a different tenant must now succeed
      // (the teardown cleared the maps the connect guard would otherwise trip on).
      const reconnected = await store.connect(dept, 'enterprise', { tenant: 'acme' });
      expect(reconnected.tenant).toEqual({ org: 'acme' });
      expect(store.connections()).toHaveLength(1);
    });
  });

  describe('retargetTenant(dataDomainId, from, to)', () => {
    it('re-scopes an enterprise dataDomain and reflects it in the manifest + connections()', async () => {
      const store = new FsDataDomainStore();
      const { dataDomainId } = await store.connect(dept, 'enterprise', { tenant: 'acme/eng' });

      await store.retargetTenant(dataDomainId, 'acme/eng', 'acme');

      const manifest = await store.manifest(dataDomainId);
      expect(manifest.tenant).toEqual({ org: 'acme' });
      expect(store.connections().find(c => c.dataDomainId === dataDomainId)?.tenant).toEqual({ org: 'acme' });
    });

    it('compares "from" before writing — a stale/wrong "from" is refused as drift', async () => {
      const store = new FsDataDomainStore();
      const { dataDomainId } = await store.connect(dept, 'enterprise', { tenant: 'acme/eng' });

      await expect(store.retargetTenant(dataDomainId, 'acme', 'acme/mkt')).rejects.toThrow(/tenant drift/);
      // Unchanged after the aborted attempt.
      expect((await store.manifest(dataDomainId)).tenant).toEqual({ org: 'acme', department: 'eng' });
    });

    it('refuses re-scoping a personal dataDomain (no tenant concept to move)', async () => {
      const store = new FsDataDomainStore();
      const { dataDomainId } = await store.connect(org, 'personal');

      await expect(store.retargetTenant(dataDomainId, 'acme', 'acme/eng')).rejects.toThrow(DataDomainError);
    });

    it('requires both a from and a to tenant scope', async () => {
      const store = new FsDataDomainStore();
      const { dataDomainId } = await store.connect(dept, 'enterprise', { tenant: 'acme/eng' });

      await expect(store.retargetTenant(dataDomainId, '', 'acme')).rejects.toThrow();
      await expect(store.retargetTenant(dataDomainId, 'acme/eng', '')).rejects.toThrow();
    });

    it('is case-insensitive on the compare-swap so an operator can copy the stored value verbatim', async () => {
      const store = new FsDataDomainStore();
      const { dataDomainId } = await store.connect(dept, 'enterprise', { tenant: 'ACME/Eng' });

      await expect(store.retargetTenant(dataDomainId, 'acme/eng', 'acme')).resolves.toBeUndefined();
      expect((await store.manifest(dataDomainId)).tenant).toEqual({ org: 'acme' });
    });
  });
});
