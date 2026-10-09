// design-sandbox (tech map S16): execution isolation classification and the
// fail-closed pre-start validation gate. V1 is the pure classifier only
// (design-sandbox §5): no spawn is touched, no container runtime is invoked —
// every input is caller-supplied, so the isolation level and its acceptance
// are fully unit-testable and reproducible.
//
// Principle (design-sandbox §2): the authorization face decides the visible
// face — a connector may touch no file and no network beyond the Realm it was
// granted. Isolation is a registration/start gate, not a runtime patch.

import type { TrustTier } from '../trust/tier.js';

/** The isolation level a local execution body needs (design-sandbox §3.1). */
export type IsolationLevel = 'L-none' | 'L-process' | 'L-process-restricted' | 'L-container' | 'L-remote';

/** The isolation declaration a connector/skill registers (design-sandbox §3.2):
 *  the fs face must be a subset of the authorized Realms, network defaults to
 *  off, resources carry no fabricated defaults, and exec pins command + fixed
 *  args + an env allow-list (no inherited full environment). */
export type IsolationManifest = {
  fs: { read: string[]; write: string[] };
  network: 'off' | 'proxy' | 'direct';
  resources: { cpuShares?: number; memoryMb?: number; maxWallSeconds?: number; maxProcesses?: number };
  exec: { command: string; args: string[]; envAllowList: string[] };
};

/**
 * Determine the isolation level for an execution body (design-sandbox §3.1):
 *
 * - `http` transports are remote by construction — the kernel constrains the
 *   peer over protocol/tier/credentials/data policy, never over host measures;
 * - a `stdio` body declaring `network: 'direct'` requires container isolation
 *   (direct network is only legal under L-container);
 * - tier-3 (signature-verified, the strongest local trust) maps to L-process;
 * - tier-1/tier-2 (shape/roster trust) map to L-process-restricted — the
 *   strictest local profile (realm-bound fs, default-no-network);
 * - tier-0 never reaches here (the gate refuses it); defensively it maps to
 *   the strictest local level so validation still holds it to L-container.
 */
export function classifyIsolation(input: {
  transport: 'stdio' | 'http';
  tier: TrustTier;
  manifest: IsolationManifest;
}): IsolationLevel {
  if (input.transport === 'http') return 'L-remote';
  if (input.manifest.network === 'direct') return 'L-container';
  switch (input.tier) {
    case 'tier-3':
      return 'L-process';
    case 'tier-1':
    case 'tier-2':
      return 'L-process-restricted';
    case 'tier-0':
      return 'L-container';
  }
}

/**
 * Pre-start fail-closed validation (design-sandbox §3.2 / §5 acceptance):
 * returns every reason the declaration cannot be accommodated. An isolation
 * level is never downgraded to let a declaration pass — when L-container is
 * required but no container runtime is available, the registration is refused
 * rather than silently run at L-process. L-none/L-remote bodies need no host
 * measures, so they pass without resource/fs checks (protocol constraints
 * govern the remote face).
 */
export function validateIsolation(input: {
  level: IsolationLevel;
  manifest: IsolationManifest;
  authorizedRealms: string[];
  containerRuntimeAvailable: boolean;
}): { ok: true } | { ok: false; reasons: string[] } {
  const reasons: string[] = [];

  if (input.level === 'L-none' || input.level === 'L-remote') {
    return { ok: true };
  }

  const fsFaces = [...input.manifest.fs.read, ...input.manifest.fs.write];
  for (const path of fsFaces) {
    if (!input.authorizedRealms.includes(path)) {
      reasons.push(`fs face ${path} is outside the authorized Realms`);
    }
  }

  if (input.manifest.network === 'direct' && input.level !== 'L-container') {
    reasons.push('direct network requires container isolation');
  }

  if (input.level === 'L-container' && !input.containerRuntimeAvailable) {
    reasons.push('container runtime unavailable; L-container cannot be satisfied');
  }

  if (!input.manifest.exec.command) {
    reasons.push('exec command is not declared');
  }

  if (input.level !== 'L-container' && isResourcesEmpty(input.manifest.resources)) {
    // No fabricated quota defaults (deferred #9 calibration); a process-level
    // body without a resource declaration cannot be accommodated fail-closed.
    reasons.push('resources are not declared; no default quota is fabricated');
  }

  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

function isResourcesEmpty(r: IsolationManifest['resources']): boolean {
  return r.cpuShares === undefined && r.memoryMb === undefined && r.maxWallSeconds === undefined && r.maxProcesses === undefined;
}

/**
 * S16 V2 (design-sandbox §5): the spawn narrowing a stdio body must run
 * under. The manifest pins command + fixed args + an env allow-list, so the
 * subprocess never inherits the caller's full environment — only the listed
 * variables that actually exist are copied through, and everything else is
 * dropped. `maxWallSeconds` (when declared) becomes the process-level wall
 * clock bound the caller enforces.
 */
export function narrowSpawn(input: {
  manifest: IsolationManifest;
  env: NodeJS.ProcessEnv;
}): {
  command: string;
  args: string[];
  env: Record<string, string>;
  envAllowList: string[];
  maxWallSeconds?: number;
} {
  const env: Record<string, string> = {};
  for (const key of input.manifest.exec.envAllowList) {
    const value = input.env[key];
    if (value !== undefined) env[key] = value;
  }
  return {
    command: input.manifest.exec.command,
    args: input.manifest.exec.args,
    env,
    envAllowList: input.manifest.exec.envAllowList,
    ...(input.manifest.resources.maxWallSeconds !== undefined
      ? { maxWallSeconds: input.manifest.resources.maxWallSeconds }
      : {}),
  };
}
