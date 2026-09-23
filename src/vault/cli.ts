#!/usr/bin/env node
/**
 * Vault command-line executor (E3.7): draw maps, verify in place, pack full
 * encrypted bundles, and restore across locations.
 *
 * The design (docs/design-vault.md) deliberately keeps scheduling OUT of the
 * kernel: backups are triggered by the user or by an external scheduler
 * (cron/systemd), which invokes this CLI. There is no built-in timer.
 *
 * Commands:
 *   build   --root <dir> --out <map.json>            draw + seal a manifest-only map
 *   backup  --root <dir> --out-dir <dir> [--name s]  pack sealed map + full bundle
 *   check   --map <map.json> [--json]                L0 in-place verification (read-only)
 *   restore --map <map.json> --bundle <bundle.json> --target <dir> [--json]
 *
 * Key material (never a positional argument, absent from process listings):
 *   --key-file <path>      32 raw bytes OR 64 hex chars
 *   --passphrase-env <N>   env var holding the passphrase (default ZEUS_VAULT_PASSPHRASE)
 *
 * Exit codes: 0 ok/recoverable · 1 usage/key/decrypt/io error · 2 drift detected · 3 root unreachable
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RealmType } from '../a2a/types.js';
import { FsRealmStore } from '../realm/store.js';
import { openMap, packFull, restoreFromBundle, sealMap } from './bundle.js';
import type { VaultKey } from './cipher.js';
import { inventoryFromRealm } from './inventory.js';
import { buildVault } from './map.js';
import { restoreDryRun } from './restore.js';
import { VaultDecryptError, VaultError, type RestoreReport, type SealedEnvelope } from './types.js';

export const VAULT_EXIT = { ok: 0, error: 1, drift: 2, unreachable: 3 } as const;

export type VaultCliDeps = {
  env?: Record<string, string | undefined>;
  now?: () => Date;
};

export type VaultCliResult = {
  code: number;
  stdout: string;
  stderr: string;
};

const DEFAULT_PASSPHRASE_ENV = 'ZEUS_VAULT_PASSPHRASE';
const BOOLEAN_FLAGS = new Set(['json']);

class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

type ParsedArgs = {
  command: string;
  flags: Map<string, string>;
};

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  if (!command) throw new CliUsageError('missing command (build | backup | check | restore)');
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith('--')) throw new CliUsageError(`unexpected argument: ${token}`);
    const eq = token.indexOf('=');
    let name: string;
    let inline: string | undefined;
    if (eq >= 0) {
      name = token.slice(2, eq);
      inline = token.slice(eq + 1);
    } else {
      name = token.slice(2);
    }
    if (inline !== undefined) {
      flags.set(name, inline);
    } else if (BOOLEAN_FLAGS.has(name)) {
      flags.set(name, 'true');
    } else {
      const value = rest[++i];
      if (value === undefined || value.startsWith('--')) {
        throw new CliUsageError(`flag --${name} requires a value`);
      }
      flags.set(name, value);
    }
  }
  return { command, flags };
}

function requireFlag(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (!value) throw new CliUsageError(`missing required flag --${name}`);
  return value;
}

async function loadKey(flags: Map<string, string>, env: Record<string, string | undefined>): Promise<VaultKey> {
  const keyFile = flags.get('key-file');
  if (keyFile) {
    const raw = await readFile(keyFile);
    const text = raw.toString('utf8').trim();
    if (/^[0-9a-fA-F]{64}$/.test(text)) return Buffer.from(text, 'hex');
    if (raw.length === 32) return Buffer.from(raw);
    throw new CliUsageError('--key-file must contain 32 raw bytes or 64 hex characters');
  }
  const envName = flags.get('passphrase-env') ?? DEFAULT_PASSPHRASE_ENV;
  const passphrase = env[envName];
  if (!passphrase) {
    throw new CliUsageError(`no vault key provided: set ${envName} or pass --key-file`);
  }
  return passphrase;
}

async function readEnvelope(path: string): Promise<SealedEnvelope> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    throw new VaultError(`cannot read sealed envelope at ${path}: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || typeof (parsed as SealedEnvelope).ciphertext !== 'string') {
    throw new VaultError(`not a sealed envelope: ${path}`);
  }
  return parsed as SealedEnvelope;
}

async function connectInventory(root: string, type: RealmType) {
  const store = new FsRealmStore();
  const manifest = await store.connect(root, type);
  return { store, inventory: inventoryFromRealm(store, manifest.realmId), manifest };
}

function formatReport(report: RestoreReport): string {
  const lines: string[] = [
    `realm:            ${report.realmId}`,
    `root reachable:   ${report.rootReachable}`,
    `digest match:     ${report.contentDigestMatch}`,
    `marks total:      ${report.total}`,
    `ok:               ${report.ok.length}`,
    `changed:          ${report.changed.length}`,
    ...report.changed.map(c => `  - ${c.itemId}`),
    `missing:          ${report.missing.length}`,
    ...report.missing.map(id => `  - ${id}`),
    `unexpected:       ${report.unexpected.length}`,
    ...report.unexpected.map(id => `  - ${id}`),
    `recoverable:      ${report.recoverable}`,
  ];
  if (report.suggestion) lines.push(`suggestion:       ${report.suggestion}`);
  return lines.join('\n');
}

function reportExitCode(report: RestoreReport): number {
  if (!report.rootReachable) return VAULT_EXIT.unreachable;
  if (!report.recoverable || !report.contentDigestMatch || report.unexpected.length > 0) {
    return VAULT_EXIT.drift;
  }
  return VAULT_EXIT.ok;
}

function timestampStem(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-').slice(0, 19) + 'Z';
}

export async function runVaultCli(argv: string[], deps: VaultCliDeps = {}): Promise<VaultCliResult> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  let stdout = '';
  let stderr = '';
  let code: number = VAULT_EXIT.ok;
  try {
    const { command, flags } = parseArgs(argv);
    const realmType = (flags.get('type') as RealmType | undefined) ?? 'personal';
    if (realmType !== 'personal' && realmType !== 'enterprise') {
      throw new CliUsageError(`unsupported --type: ${realmType}`);
    }
    const asJson = flags.has('json');

    if (command === 'build') {
      const root = requireFlag(flags, 'root');
      const out = requireFlag(flags, 'out');
      const key = await loadKey(flags, env);
      const { inventory } = await connectInventory(root, realmType);
      const map = await buildVault(inventory, { now });
      const sealed = sealMap(map, key);
      await mkdir(dirnameOf(out), { recursive: true });
      await writeFile(out, JSON.stringify(sealed, null, 2) + '\n', 'utf8');
      stdout = asJson
        ? JSON.stringify({ ok: true, command, out, realmId: map.realm.realmId, items: map.realm.itemCount })
        : `map sealed (manifest-only): ${out}\nrealm: ${map.realm.realmId}\nitems: ${map.realm.itemCount}`;
    } else if (command === 'backup') {
      const root = requireFlag(flags, 'root');
      const outDir = requireFlag(flags, 'out-dir');
      const key = await loadKey(flags, env);
      const { inventory, manifest } = await connectInventory(root, realmType);
      const packed = await packFull(inventory, key, { now });
      const stem = flags.get('name') ?? `vault-${manifest.realmId.slice(0, 8)}-${timestampStem(now())}`;
      const mapPath = join(outDir, `${stem}.map.json`);
      const bundlePath = join(outDir, `${stem}.bundle.json`);
      await mkdir(outDir, { recursive: true });
      await writeFile(mapPath, JSON.stringify(packed.sealedMap, null, 2) + '\n', 'utf8');
      await writeFile(bundlePath, JSON.stringify(packed.sealedBundle, null, 2) + '\n', 'utf8');
      stdout = asJson
        ? JSON.stringify({ ok: true, command, map: mapPath, bundle: bundlePath, realmId: manifest.realmId, items: packed.map.realm.itemCount })
        : `full backup sealed:\n  map:    ${mapPath}\n  bundle: ${bundlePath}\nrealm: ${manifest.realmId}\nitems: ${packed.map.realm.itemCount}`;
    } else if (command === 'check') {
      const mapPath = requireFlag(flags, 'map');
      const key = await loadKey(flags, env);
      const sealed = await readEnvelope(mapPath);
      const map = openMap(sealed, key);
      const report = await restoreDryRun(map, new FsRealmStore());
      code = reportExitCode(report);
      stdout = asJson ? JSON.stringify({ ok: true, command, report }) : formatReport(report);
    } else if (command === 'restore') {
      const mapPath = requireFlag(flags, 'map');
      const bundlePath = requireFlag(flags, 'bundle');
      const target = requireFlag(flags, 'target');
      const key = await loadKey(flags, env);
      const sealedMap = await readEnvelope(mapPath);
      const sealedBundle = await readEnvelope(bundlePath);
      const map = openMap(sealedMap, key);
      const report = await restoreFromBundle(map, sealedBundle, target, key);
      code = reportExitCode(report);
      stdout = asJson
        ? JSON.stringify({ ok: true, command, target, report })
        : `restored into: ${target}\n${formatReport(report)}`;
    } else {
      throw new CliUsageError(`unknown command: ${command} (expected build | backup | check | restore)`);
    }
  } catch (err) {
    if (err instanceof CliUsageError) {
      code = VAULT_EXIT.error;
      stderr = `usage error: ${err.message}\nRun: vault-cli build|backup|check|restore (see file header for flags)`;
    } else if (err instanceof VaultDecryptError) {
      code = VAULT_EXIT.error;
      stderr = `vault key error: ${err.message}`;
    } else if (err instanceof VaultError) {
      code = VAULT_EXIT.error;
      stderr = `vault error: ${err.message}`;
    } else {
      code = VAULT_EXIT.error;
      stderr = `error: ${(err as Error).message}`;
    }
  }
  return { code, stdout: stdout ? `${stdout}\n` : '', stderr: stderr ? `${stderr}\n` : '' };
}

function dirnameOf(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return idx >= 0 ? path.slice(0, idx) : '.';
}

async function main(): Promise<void> {
  const result = await runVaultCli(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.code);
}

// Only run as a process when invoked directly (not under vitest / imports).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
