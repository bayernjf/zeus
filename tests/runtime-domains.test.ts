import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootRuntime, RuntimeBootError, resolveDataDomainConfig } from '../src/state/boot.js';
import { readAuditLog } from '../src/dispatch/audit.js';
import { DomainGrantError } from '../src/dataDomain/authorization.js';
import { resolveDataDomainSource } from '../src/dataDomain/source.js';
import { runtimeStats } from '../src/state/stats.js';

let sandbox: string;

async function dataDomainDir(name: string, files: Record<string, string>): Promise<string> {
  const root = join(sandbox, name);
  await mkdir(root, { recursive: true });
  for (const [file, content] of Object.entries(files)) await writeFile(join(root, file), content);
  return root;
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'zeus-runtime-domains-'));
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe('E3.6 resolveDataDomainConfig (env mounts)', () => {
  it('keeps ZEUS_DATA_DOMAIN_ROOTS as a plain personal list', () => {
    expect(resolveDataDomainConfig({ ZEUS_DATA_DOMAIN_ROOTS: '/data/notes , /data/diary,' }).dataDomainRoots).toEqual(['/data/notes', '/data/diary']);
  });

  it('mounts enterprise dataDomains with their tenant scope', () => {
    const config = resolveDataDomainConfig({
      ZEUS_DATA_DOMAIN_ROOTS: '/data/notes',
      ZEUS_DATA_DOMAIN_ENTERPRISE: '/srv/acme::acme,/srv/acme-eng::acme/eng',
    });
    expect(config.dataDomainRoots).toEqual([
      '/data/notes',
      { root: '/srv/acme', type: 'enterprise', tenant: 'acme' },
      { root: '/srv/acme-eng', type: 'enterprise', tenant: 'acme/eng' },
    ]);
  });

  it('refuses to mount an enterprise dataDomain whose scope is missing or unusable', () => {
    // An unscoped enterprise dataDomain is exactly the silent widening the tenant
    // exists to prevent, so a typo has to stop the boot.
    expect(() => resolveDataDomainConfig({ ZEUS_DATA_DOMAIN_ENTERPRISE: '/srv/acme' })).toThrow(RuntimeBootError);
    expect(() => resolveDataDomainConfig({ ZEUS_DATA_DOMAIN_ENTERPRISE: '/srv/acme' })).toThrow(/<root>::<tenant>/);
    expect(() => resolveDataDomainConfig({ ZEUS_DATA_DOMAIN_ENTERPRISE: '::acme' })).toThrow(/empty root/);
    expect(() => resolveDataDomainConfig({ ZEUS_DATA_DOMAIN_ENTERPRISE: '/srv/acme::a/b/c/d' })).toThrow(/unusable tenant/);
    expect(() => resolveDataDomainConfig({ ZEUS_DATA_DOMAIN_ENTERPRISE: '/srv/acme::' })).toThrow(/unusable tenant/);
  });
});

describe('E3.6/E6.4 the booted runtime keeps tenants and grants across restart', () => {
  it('restores an enterprise dataDomain WITH its scope, so a restart does not widen it', async () => {
    const eng = await dataDomainDir('eng', { 'design.md': 'compiler design\n' });
    const stateFile = join(sandbox, 'runtime.json');

    const first = await bootRuntime({
      stateFile,
      dataDomainRoots: [{ root: eng, type: 'enterprise', tenant: 'acme/eng' }],
    });
    expect(first.dataDomainStore!.connections()[0]).toMatchObject({ type: 'enterprise', tenant: { org: 'acme', department: 'eng' } });
    await first.saveState();

    // Second boot: no dataDomainRoots at all - the snapshot alone must restore the scope.
    const second = await bootRuntime({ stateFile });
    const restored = second.dataDomainStore!.connections()[0];
    expect(restored).toMatchObject({ type: 'enterprise', tenant: { org: 'acme', department: 'eng' } });

    // The proof it matters: an org-scoped subject still cannot be admitted to it
    // by the restored mount having gone unscoped.
    const decision = second.domainGrants!.exportState();
    expect(decision.grants).toEqual([]);

    const probe = await second.dataDomainStore!.manifest(restored!.dataDomainId);
    expect(probe.tenant).toEqual({ org: 'acme', department: 'eng' });
  });

  it('persists issued grants and keeps a spent nonce spent', async () => {
    const stateFile = join(sandbox, 'runtime.json');
    const eng = await dataDomainDir('eng2', { 'a.md': 'a\n' });
    const first = await bootRuntime({ stateFile, dataDomainRoots: [{ root: eng, type: 'enterprise', tenant: 'acme' }] });
    const dataDomainId = first.dataDomainStore!.connections()[0]!.dataDomainId;
    const issued = first.domainGrants!.issue({ subject: 'jev', dataDomainId, access: 'read', grantedBy: 'operator', nonce: 'nonce-1' });
    await first.saveState();

    const second = await bootRuntime({ stateFile });
    expect(second.domainGrants!.list()).toEqual([issued]);
    expect(() =>
      second.domainGrants!.issue({ subject: 'jev', dataDomainId, access: 'read', grantedBy: 'operator', nonce: 'nonce-1' }),
    ).toThrow(DomainGrantError);

    // Revocation persists too: dropping it on restart would silently re-open a
    // closed boundary.
    second.domainGrants!.revoke(issued.grantId);
    await second.saveState();
    const third = await bootRuntime({ stateFile });
    expect(third.domainGrants!.list()).toEqual([]);
    expect(() => third.domainGrants!.issue({ subject: 'jev', dataDomainId, access: 'read', grantedBy: 'operator', nonce: 'nonce-1' }))
      .toThrow(/already used/);
  });

  it('funnels domain crossings into the same audit file as dispatch decisions', async () => {
    const eng = await dataDomainDir('eng3', { 'a.md': 'a\n' });
    const auditFile = join(sandbox, 'audit.jsonl');
    const runtime = await bootRuntime({ auditFile, dataDomainRoots: [{ root: eng, type: 'enterprise', tenant: 'acme/eng' }] });
    const dataDomainId = runtime.dataDomainStore!.connections()[0]!.dataDomainId;

    // Read the dataDomain as a sibling department would (refused) and as the operator (allowed).
    await expect(
      resolveDataDomainSource({
        store: runtime.dataDomainStore!,
        actor: { kind: 'executor', id: 'loom', tenant: { org: 'acme', department: 'mkt' } },
        source: { dataDomainId },
        grants: runtime.domainGrants!.list(),
        audit: runtime.dataDomainAudit,
      }),
    ).rejects.toThrow(/tenant-out-of-scope/);
    await resolveDataDomainSource({
      store: runtime.dataDomainStore!,
      actor: { kind: 'operator', id: 'operator' },
      source: { dataDomainId },
      grants: runtime.domainGrants!.list(),
      audit: runtime.dataDomainAudit,
    });

    expect(existsSync(auditFile)).toBe(true);
    const refused = readAuditLog(auditFile, { decision: 'domain-refused' });
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ executor: 'loom' });
    expect(refused[0]!.detail).toContain('acme/eng');
    expect(readAuditLog(auditFile, { decision: 'domain-read' })).toHaveLength(1);
    // Issuing a grant is itself an audited act on the same spine.
    runtime.domainGrants!.issue({ subject: 'jev', dataDomainId, access: 'read', grantedBy: 'operator', nonce: 'n' });
    expect(readAuditLog(auditFile, { decision: 'domain-grant-issued' })).toHaveLength(1);
  });

  it('counts enterprise dataDomains and live grants in the inventory face', async () => {
    const scoped = await dataDomainDir('scoped', { 'a.md': 'a\n' });
    const plain = await dataDomainDir('plain', { 'b.md': 'b\n' });
    const runtime = await bootRuntime({
      dataDomainRoots: [
        { root: scoped, type: 'enterprise', tenant: 'acme/eng' },
        { root: plain, type: 'enterprise' },
        await dataDomainDir('personal', { 'c.md': 'c\n' }),
      ],
    });
    expect(runtimeStats(runtime).counts).toMatchObject({
      dataDomains: 3,
      enterpriseDataDomains: 2,
      tenantScopedDataDomains: 1,
      domainGrants: 0,
    });
  });
});
