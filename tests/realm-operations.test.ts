import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsRealmStore } from '../src/realm/store.js';
import { RealmError, RealmNotConnectedError } from '../src/realm/types.js';

describe('deferred #17 — explicit realm boundary mutations', () => {
  let sandbox: string;
  let dept: string;
  let org: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'zeus-realm-ops-'));
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

  describe('disconnect(realmId)', () => {
    it('removes a mounted realm from connections() so it is no longer persisted', async () => {
      const store = new FsRealmStore();
      const { realmId } = await store.connect(dept, 'enterprise', { tenant: 'acme/eng' });
      expect(store.connections().some(c => c.realmId === realmId)).toBe(true);

      await store.disconnect(realmId);
      expect(store.connections().some(c => c.realmId === realmId)).toBe(false);
    });

    it('refuses to disconnect an unknown realm (fail-loud, not silent no-op)', async () => {
      const store = new FsRealmStore();
      await expect(store.disconnect('realm-does-not-exist')).rejects.toThrow(RealmNotConnectedError);
    });

    it('allows the same root to be reconnected fresh after disconnect (no stale tenant)', async () => {
      const store = new FsRealmStore();
      const { realmId } = await store.connect(dept, 'enterprise', { tenant: 'acme/eng' });
      await store.disconnect(realmId);

      // Reconnecting the same directory under a different tenant must now succeed
      // (the teardown cleared the maps the connect guard would otherwise trip on).
      const reconnected = await store.connect(dept, 'enterprise', { tenant: 'acme' });
      expect(reconnected.tenant).toEqual({ org: 'acme' });
      expect(store.connections()).toHaveLength(1);
    });
  });

  describe('retargetTenant(realmId, from, to)', () => {
    it('re-scopes an enterprise realm and reflects it in the manifest + connections()', async () => {
      const store = new FsRealmStore();
      const { realmId } = await store.connect(dept, 'enterprise', { tenant: 'acme/eng' });

      await store.retargetTenant(realmId, 'acme/eng', 'acme');

      const manifest = await store.manifest(realmId);
      expect(manifest.tenant).toEqual({ org: 'acme' });
      expect(store.connections().find(c => c.realmId === realmId)?.tenant).toEqual({ org: 'acme' });
    });

    it('compares "from" before writing — a stale/wrong "from" is refused as drift', async () => {
      const store = new FsRealmStore();
      const { realmId } = await store.connect(dept, 'enterprise', { tenant: 'acme/eng' });

      await expect(store.retargetTenant(realmId, 'acme', 'acme/mkt')).rejects.toThrow(/tenant drift/);
      // Unchanged after the aborted attempt.
      expect((await store.manifest(realmId)).tenant).toEqual({ org: 'acme', department: 'eng' });
    });

    it('refuses re-scoping a personal realm (no tenant concept to move)', async () => {
      const store = new FsRealmStore();
      const { realmId } = await store.connect(org, 'personal');

      await expect(store.retargetTenant(realmId, 'acme', 'acme/eng')).rejects.toThrow(RealmError);
    });

    it('requires both a from and a to tenant scope', async () => {
      const store = new FsRealmStore();
      const { realmId } = await store.connect(dept, 'enterprise', { tenant: 'acme/eng' });

      await expect(store.retargetTenant(realmId, '', 'acme')).rejects.toThrow();
      await expect(store.retargetTenant(realmId, 'acme/eng', '')).rejects.toThrow();
    });

    it('is case-insensitive on the compare-swap so an operator can copy the stored value verbatim', async () => {
      const store = new FsRealmStore();
      const { realmId } = await store.connect(dept, 'enterprise', { tenant: 'ACME/Eng' });

      await expect(store.retargetTenant(realmId, 'acme/eng', 'acme')).resolves.toBeUndefined();
      expect((await store.manifest(realmId)).tenant).toEqual({ org: 'acme' });
    });
  });
});
