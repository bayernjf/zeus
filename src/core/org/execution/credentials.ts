/**
 * Tier0 M7 (T-M7-01) execution contract — credential references.
 *
 * The executor (and the adapters authored as "task code") never holds a
 * secret value. It is given opaque credential references (credentialRefs) and
 * the framework-invoked ToolInvoker resolves a reference through a
 * SecretBackend at the moment of the call. This keeps long-lived tokens out
 * of task payloads, progress, replays, logs and the executor's reach.
 *
 * T-M7-01 defines the reference and the backend port; concrete backends (local
 * env/file for dev, cloud secret manager for production) are wired in a later
 * slice. The UnconfiguredSecretBackend fails closed so an unconfigured
 * deployment cannot silently execute unauthenticated.
 */

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
