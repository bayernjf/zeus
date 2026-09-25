import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TenantError, formatTenant, parseTenant, tenantReaches } from '../src/realm/tenant.js';
import { FsRealmStore } from '../src/realm/store.js';
import { RealmError } from '../src/realm/types.js';

const t = (path: string) => parseTenant(path);

describe('E3.6 tenant scopes: parse and format', () => {
  it('parses one, two and three levels, keeping the names verbatim', () => {
    expect(t('acme')).toEqual({ org: 'acme' });
    expect(t('acme/eng')).toEqual({ org: 'acme', department: 'eng' });
    expect(t('acme/eng/zhang')).toEqual({ org: 'acme', department: 'eng', member: 'zhang' });
    expect(formatTenant(t(' ACME / Eng '))).toBe('ACME/Eng');
  });

  it('accepts non-ASCII names (the primary language of this product is not ASCII)', () => {
    expect(formatTenant(t('研发部/编译器组'))).toBe('研发部/编译器组');
  });

  it('refuses shapes that would make the hierarchy ambiguous', () => {
    expect(() => t('')).toThrow(TenantError);
    expect(() => t('acme/')).toThrow(/empty segment/);
    expect(() => t('acme//eng')).toThrow(/empty segment/);
    expect(() => t('acme/eng/zhang/fourth')).toThrow(/1-3 segments/);
    expect(() => t('../etc')).toThrow(/path marker/);
    expect(() => t('acme/.')).toThrow(/path marker/);
  });
});

describe('E3.6 tenant hierarchy rule (tenantReaches)', () => {
  it('lets a broader scope reach inward', () => {
    expect(tenantReaches(t('acme'), t('acme'))).toBe(true);
    expect(tenantReaches(t('acme'), t('acme/eng'))).toBe(true);
    expect(tenantReaches(t('acme/eng'), t('acme/eng/zhang'))).toBe(true);
  });

  it('refuses looking up and looking sideways', () => {
    expect(tenantReaches(t('acme/eng'), t('acme'))).toBe(false);
    expect(tenantReaches(t('acme/eng/zhang'), t('acme/eng'))).toBe(false);
    expect(tenantReaches(t('acme/eng'), t('acme/mkt'))).toBe(false);
    expect(tenantReaches(t('other'), t('acme/eng'))).toBe(false);
  });

  it('folds case so one org typed two ways is still one tenant', () => {
    expect(tenantReaches(t('ACME/ENG'), t('acme/eng'))).toBe(true);
  });
});

describe('E3.6 connect records the tenant and refuses to mis-label a domain', () => {
  let sandbox: string;
  let org: string;
  let dept: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'zeus-realm-tenant-'));
    org = join(sandbox, 'acme');
    dept = join(sandbox, 'acme-eng');
    mkdirSync(org, { recursive: true });
    mkdirSync(dept, { recursive: true });
    writeFileSync(join(org, 'handbook.md'), 'org wide\n');
    writeFileSync(join(dept, 'design.md'), 'department design doc\n');
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('stores the tenant on the manifest and on the connection', async () => {
    const store = new FsRealmStore();
    const manifest = await store.connect(dept, 'enterprise', { tenant: 'acme/eng' });
    expect(manifest.tenant).toEqual({ org: 'acme', department: 'eng' });
    expect(store.connections()[0]?.tenant).toEqual({ org: 'acme', department: 'eng' });
  });

  it('refuses a tenant on a personal realm instead of ignoring it', async () => {
    const store = new FsRealmStore();
    await expect(store.connect(org, 'personal', { tenant: 'acme' })).rejects.toThrow(RealmError);
    await expect(store.connect(org, 'personal', { tenant: 'acme' })).rejects.toThrow(/belongs to an enterprise realm/);
  });

  it('refuses a reconnect that would silently re-scope a mounted realm', async () => {
    const store = new FsRealmStore();
    await store.connect(dept, 'enterprise', { tenant: 'acme/eng' });
    await expect(store.connect(dept, 'enterprise', { tenant: 'acme' })).rejects.toThrow(/would change its tenant scope/);
    // Reconnecting with the SAME tenant stays harmless (boot restores then seeds).
    await expect(store.connect(dept, 'enterprise', { tenant: 'acme/eng' })).resolves.toMatchObject({
      tenant: { org: 'acme', department: 'eng' },
    });
  });

  it('leaves an enterprise realm unscoped when no tenant is given, and says so', async () => {
    const store = new FsRealmStore();
    const manifest = await store.connect(org, 'enterprise');
    expect(manifest.tenant).toBeUndefined();
    expect(store.connections()[0]?.tenant).toBeUndefined();
  });
});
