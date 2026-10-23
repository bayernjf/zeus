/**
 * Tier0 M7 (T-M7-01) execution contract — credential references.
 *
 * The executor (and the adapters authored as "task code") never holds a
 * secret value. It is given opaque credential references (credentialRefs) and
 * the framework-invoked ToolInvoker resolves a reference through a
 * SecretBackend at the moment of the call. This keeps long-lived tokens out
 * of task payloads, progress, replays, logs and the executor's reach.
 *
 * T-M7-01 ships the port plus local backends for development/self-hosting
 * (environment variables, an optional gitignored JSON secret file) and a
 * chain that tries them in order. A cloud secret-manager backend (KMS/Vault)
 * is injected by the production assembly; until any backend can resolve a
 * reference the UnconfiguredSecretBackend fails closed, so an unconfigured
 * deployment cannot silently execute unauthenticated.
 */
import { readFileSync } from 'node:fs';

/** Opaque reference to a secret, e.g. "agent-world:service-token" or "commerce:oauth". */
export type CredentialRef = string;

/** A resolved secret handed to the framework-invoked tool, never to task code. */
export interface ResolvedCredential {
  /** The secret material (token / key). Treated as sensitive and redacted. */
  secret: string;
  /** Optional structured metadata (expiry, scopes) — never the secret. */
  metadata?: Record<string, unknown>;
}

/**
 * Backend port for resolving credentials. Implementations own the storage
 * (env, file, KMS/Vault). Resolution is server-side only.
 */
export interface SecretBackend {
  /** True when the backend can resolve the given reference. */
  has(ref: CredentialRef): Promise<boolean>;
  /** Resolve a reference; missing/unconfigured must throw, never return empty. */
  resolve(ref: CredentialRef): Promise<ResolvedCredential>;
}

/** Raised when a credential cannot be resolved — a fail-closed condition. */
export class CredentialError extends Error {
  readonly ref: CredentialRef;
  constructor(ref: CredentialRef, message: string) {
    super(message);
    this.name = 'CredentialError';
    this.ref = ref;
  }
}

/**
 * Default backend: resolves nothing. Used until a real backend is configured
 * so a misconfigured deployment fails closed at the first credential use
 * instead of sending an empty/anonymous credential.
 */
export class UnconfiguredSecretBackend implements SecretBackend {
  async has(): Promise<boolean> {
    return false;
  }

  async resolve(ref: CredentialRef): Promise<ResolvedCredential> {
    throw new CredentialError(
      ref,
      `no SecretBackend configured; cannot resolve credential "${ref}" (fail-closed)`,
    );
  }
}

/** Convert an opaque ref to its default env var name: `a:b-c` → `PREFIX_A_B_C`. */
export function defaultEnvName(ref: CredentialRef, prefix = 'ZEUS_SECRET_'): string {
  const slug = ref
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `${prefix}${slug}`;
}

export interface EnvSecretBackendOptions {
  /** Environment source; defaults to process.env. Injected for tests. */
  vars?: Record<string, string | undefined>;
  /** Explicit ref → env var name overrides; otherwise the default rule applies. */
  map?: Partial<Record<CredentialRef, string>>;
  /** Prefix for default env names. */
  prefix?: string;
}

/**
 * Resolves credentials from environment variables. An empty string is treated
 * as unset so a placeholder can never be sent as a real token.
 */
export class EnvSecretBackend implements SecretBackend {
  private readonly vars: Record<string, string | undefined>;
  private readonly map: Partial<Record<CredentialRef, string>>;
  private readonly prefix: string;

  constructor(opts: EnvSecretBackendOptions = {}) {
    this.vars = opts.vars ?? (typeof process !== 'undefined' ? process.env : {});
    this.map = opts.map ?? {};
    this.prefix = opts.prefix ?? 'ZEUS_SECRET_';
  }

  private envName(ref: CredentialRef): string {
    return this.map[ref] ?? defaultEnvName(ref, this.prefix);
  }

  async has(ref: CredentialRef): Promise<boolean> {
    const value = this.vars[this.envName(ref)];
    return typeof value === 'string' && value.length > 0;
  }

  async resolve(ref: CredentialRef): Promise<ResolvedCredential> {
    const name = this.envName(ref);
    const value = this.vars[name];
    if (typeof value !== 'string' || value.length === 0) {
      throw new CredentialError(
        ref,
        `credential "${ref}" is not set in the environment (${name}) (fail-closed)`,
      );
    }
    return { secret: value };
  }
}

/** On-disk shape of a secret file: ref → secret string or structured entry. */
export type SecretFile = Record<
  string,
  string | { secret: string; metadata?: Record<string, unknown> }
>;

export interface FileSecretBackendOptions {
  /** Absolute path to the gitignored JSON secret file. */
  path: string;
  /** File reader; defaults to synchronous node:fs. Injected for tests. */
  read?: (path: string) => string;
}

/**
 * Resolves credentials from a local JSON file. The file is lazily read once;
 * a missing or unreadable file (and any missing reference) fails closed.
 */
export class FileSecretBackend implements SecretBackend {
  private readonly path: string;
  private readonly readImpl: (path: string) => string;
  private loaded: SecretFile | undefined;

  constructor(opts: FileSecretBackendOptions) {
    this.path = opts.path;
    this.readImpl = opts.read ?? ((p) => readFileSync(p, 'utf8'));
  }

  private load(): SecretFile {
    if (this.loaded) return this.loaded;
    try {
      this.loaded = JSON.parse(this.readImpl(this.path)) as SecretFile;
    } catch {
      // Missing/malformed file: resolve nothing rather than crash the process.
      this.loaded = {};
    }
    return this.loaded;
  }

  private entry(ref: CredentialRef): SecretFile[string] | undefined {
    return this.load()[ref];
  }

  /** Normalize a raw entry to a ResolvedCredential, or undefined when absent/empty. */
  private normalize(entry: SecretFile[string] | undefined): ResolvedCredential | undefined {
    if (typeof entry === 'string') return entry.length > 0 ? { secret: entry } : undefined;
    if (entry && typeof entry === 'object' && typeof entry.secret === 'string' && entry.secret.length > 0) {
      return { secret: entry.secret, ...(entry.metadata ? { metadata: entry.metadata } : {}) };
    }
    return undefined;
  }

  async has(ref: CredentialRef): Promise<boolean> {
    return this.normalize(this.entry(ref)) !== undefined;
  }

  async resolve(ref: CredentialRef): Promise<ResolvedCredential> {
    const resolved = this.normalize(this.entry(ref));
    if (resolved) return resolved;
    throw new CredentialError(
      ref,
      `credential "${ref}" is not present in the local secret file ${this.path} (fail-closed)`,
    );
  }
}

/**
 * Tries backends in order and resolves from the first that `has` the ref.
 * If none can resolve it, the chain fails closed.
 */
export class ChainedSecretBackend implements SecretBackend {
  constructor(private readonly backends: readonly SecretBackend[]) {}

  async has(ref: CredentialRef): Promise<boolean> {
    for (const backend of this.backends) {
      if (await backend.has(ref)) return true;
    }
    return false;
  }

  async resolve(ref: CredentialRef): Promise<ResolvedCredential> {
    for (const backend of this.backends) {
      if (await backend.has(ref)) return backend.resolve(ref);
    }
    throw new CredentialError(
      ref,
      `credential "${ref}" could not be resolved by any configured backend (fail-closed)`,
    );
  }
}

export interface LocalSecretBackendOptions {
  vars?: Record<string, string | undefined>;
  envMap?: Partial<Record<CredentialRef, string>>;
  /** Explicit path to the secret file. */
  secretFile?: string;
  /** Env var that names the secret file; defaults to ZEUS_SECRET_FILE. */
  secretFileEnv?: string;
  readFile?: (path: string) => string;
}

/**
 * Standard local/self-host assembly: environment first, then an optional
 * secret file (env vars take precedence). No file and no env secret simply
 * yields the env backend; a cloud assembly replaces this with its own backend.
 */
export function createLocalSecretBackend(opts: LocalSecretBackendOptions = {}): SecretBackend {
  const vars = opts.vars ?? (typeof process !== 'undefined' ? process.env : {});
  const fileEnv = opts.secretFileEnv ?? 'ZEUS_SECRET_FILE';
  const secretFile = opts.secretFile ?? vars[fileEnv];
  const backends: SecretBackend[] = [
    new EnvSecretBackend({ vars, ...(opts.envMap ? { map: opts.envMap } : {}) }),
  ];
  if (secretFile) {
    backends.push(new FileSecretBackend({
      path: secretFile,
      ...(opts.readFile ? { read: opts.readFile } : {}),
    }));
  }
  return backends.length === 1 ? backends[0]! : new ChainedSecretBackend(backends);
}

/**
 * Least-privilege resolution used by a framework-invoked ToolInvoker:
 * the executor can only obtain a reference that was granted to this run, and
 * the configured backend must actually resolve it. Any other case throws a
 * CredentialError (fail-closed; the runner settles it as a non-retried
 * business failure rather than ever calling a channel anonymously).
 */
export async function resolveGrantedCredential(
  backend: SecretBackend,
  granted: readonly CredentialRef[],
  ref: CredentialRef,
): Promise<ResolvedCredential> {
  if (!granted.includes(ref)) {
    throw new CredentialError(
      ref,
      `credential "${ref}" is not granted to this run (least-privilege fail-closed)`,
    );
  }
  if (!(await backend.has(ref))) {
    throw new CredentialError(
      ref,
      `credential "${ref}" is not available from the configured backend (fail-closed)`,
    );
  }
  return backend.resolve(ref);
}
