import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootKernel, KernelBootError, resolveRealmConfig } from '../src/state/boot.js';
import { readAuditLog } from '../src/dispatch/audit.js';
import { DomainGrantError } from '../src/realm/authorization.js';
import { resolveRealmSource } from '../src/realm/source.js';
import { kernelStats } from '../src/state/stats.js';

let sandbox: string;

async function realmDir(name: string, files: Record<string, string>): Promise<string> {
  const root = join(sandbox, name);
  await mkdir(root, { recursive: true });
  for (const [file, content] of Object.entries(files)) await writeFile(join(root, file), content);
  return root;
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'zeus-kernel-domains-'));
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe('E3.6 resolveRealmConfig (env mounts)', () => {
  it('keeps ZEUS_REALM_ROOTS as a plain personal list', () => {
    expect(resolveRealmConfig({ ZEUS_REALM_ROOTS: '/data/notes , /data/diary,' }).realmRoots).toEqual(['/data/notes', '/data/diary']);
  });

  it('mounts enterprise realms with their tenant scope', () => {
    const config = resolveRealmConfig({
      ZEUS_REALM_ROOTS: '/data/notes',
      ZEUS_REALM_ENTERPRISE: '/srv/acme::acme,/srv/acme-eng::acme/eng',
    });
    expect(config.realmRoots).toEqual([
      '/data/notes',
      { root: '/srv/acme', type: 'enterprise', tenant: 'acme' },
      { root: '/srv/acme-eng', type: 'enterprise', tenant: 'acme/eng' },
    ]);
  });

  it('refuses to mount an enterprise realm whose scope is missing or unusable', () => {
    // An unscoped enterprise realm is exactly the silent widening the tenant
    // exists to prevent, so a typo has to stop the boot.
    expect(() => resolveRealmConfig({ ZEUS_REALM_ENTERPRISE: '/srv/acme' })).toThrow(KernelBootError);
    expect(() => resolveRealmConfig({ ZEUS_REALM_ENTERPRISE: '/srv/acme' })).toThrow(/<root>::<tenant>/);
    expect(() => resolveRealmConfig({ ZEUS_REALM_ENTERPRISE: '::acme' })).toThrow(/empty root/);
    expect(() => resolveRealmConfig({ ZEUS_REALM_ENTERPRISE: '/srv/acme::a/b/c/d' })).toThrow(/unusable tenant/);
    expect(() => resolveRealmConfig({ ZEUS_REALM_ENTERPRISE: '/srv/acme::' })).toThrow(/unusable tenant/);
  });
});

describe('E3.6/E6.4 the booted kernel keeps tenants and grants across restart', () => {
  it('restores an enterprise realm WITH its scope, so a restart does not widen it', async () => {
    const eng = await realmDir('eng', { 'design.md': 'compiler design\n' });
    const stateFile = join(sandbox, 'kernel.json');

    const first = await bootKernel({
      stateFile,
      realmRoots: [{ root: eng, type: 'enterprise', tenant: 'acme/eng' }],
    });
    expect(first.realmStore!.connections()[0]).toMatchObject({ type: 'enterprise', tenant: { org: 'acme', department: 'eng' } });
    await first.saveState();

    // Second boot: no realmRoots at all - the snapshot alone must restore the scope.
    const second = await bootKernel({ stateFile });
    const restored = second.realmStore!.connections()[0];
    expect(restored).toMatchObject({ type: 'enterprise', tenant: { org: 'acme', department: 'eng' } });

    // The proof it matters: an org-scoped subject still cannot be admitted to it
    // by the restored mount having gone unscoped.
    const decision = second.domainGrants!.exportState();
    expect(decision.grants).toEqual([]);

    const probe = await second.realmStore!.manifest(restored!.realmId);
    expect(probe.tenant).toEqual({ org: 'acme', department: 'eng' });
  });

  it('persists issued grants and keeps a spent nonce spent', async () => {
    const stateFile = join(sandbox, 'kernel.json');
    const eng = await realmDir('eng2', { 'a.md': 'a\n' });
    const first = await bootKernel({ stateFile, realmRoots: [{ root: eng, type: 'enterprise', tenant: 'acme' }] });
    const realmId = first.realmStore!.connections()[0]!.realmId;
    const issued = first.domainGrants!.issue({ subject: 'jev', realmId, access: 'read', grantedBy: 'driver', nonce: 'nonce-1' });
    await first.saveState();

    const second = await bootKernel({ stateFile });
    expect(second.domainGrants!.list()).toEqual([issued]);
    expect(() =>
      second.domainGrants!.issue({ subject: 'jev', realmId, access: 'read', grantedBy: 'driver', nonce: 'nonce-1' }),
    ).toThrow(DomainGrantError);

    // Revocation persists too: dropping it on restart would silently re-open a
    // closed boundary.
    second.domainGrants!.revoke(issued.grantId);
    await second.saveState();
    const third = await bootKernel({ stateFile });
    expect(third.domainGrants!.list()).toEqual([]);
    expect(() => third.domainGrants!.issue({ subject: 'jev', realmId, access: 'read', grantedBy: 'driver', nonce: 'nonce-1' }))
      .toThrow(/already used/);
  });

  it('funnels domain crossings into the same audit file as dispatch decisions', async () => {
    const eng = await realmDir('eng3', { 'a.md': 'a\n' });
    const auditFile = join(sandbox, 'audit.jsonl');
    const kernel = await bootKernel({ auditFile, realmRoots: [{ root: eng, type: 'enterprise', tenant: 'acme/eng' }] });
    const realmId = kernel.realmStore!.connections()[0]!.realmId;

    // Read the realm as a sibling department would (refused) and as the driver (allowed).
    await expect(
      resolveRealmSource({
        store: kernel.realmStore!,
        actor: { kind: 'vassal', id: 'loom', tenant: { org: 'acme', department: 'mkt' } },
        source: { realmId },
        grants: kernel.domainGrants!.list(),
        audit: kernel.realmAudit,
      }),
    ).rejects.toThrow(/tenant-out-of-scope/);
    await resolveRealmSource({
      store: kernel.realmStore!,
      actor: { kind: 'driver', id: 'driver' },
      source: { realmId },
      grants: kernel.domainGrants!.list(),
      audit: kernel.realmAudit,
    });

    expect(existsSync(auditFile)).toBe(true);
    const refused = readAuditLog(auditFile, { decision: 'domain-refused' });
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ vassal: 'loom' });
    expect(refused[0]!.detail).toContain('acme/eng');
    expect(readAuditLog(auditFile, { decision: 'domain-read' })).toHaveLength(1);
    // Issuing a grant is itself an audited act on the same spine.
    kernel.domainGrants!.issue({ subject: 'jev', realmId, access: 'read', grantedBy: 'driver', nonce: 'n' });
    expect(readAuditLog(auditFile, { decision: 'domain-grant-issued' })).toHaveLength(1);
  });

  it('counts enterprise realms and live grants in the inventory face', async () => {
    const scoped = await realmDir('scoped', { 'a.md': 'a\n' });
    const plain = await realmDir('plain', { 'b.md': 'b\n' });
    const kernel = await bootKernel({
      realmRoots: [
        { root: scoped, type: 'enterprise', tenant: 'acme/eng' },
        { root: plain, type: 'enterprise' },
        await realmDir('personal', { 'c.md': 'c\n' }),
      ],
    });
    expect(kernelStats(kernel).counts).toMatchObject({
      realms: 3,
      enterpriseRealms: 2,
      tenantScopedRealms: 1,
      domainGrants: 0,
    });
  });
});
