/**
 * DNS-rebinding guard for outbound HTTP.
 *
 * `assertOutboundUrlAllowed` (outbound-url.ts) is synchronous and can only see
 * IP literals; a hostname is resolved later, inside the HTTP client. This module
 * makes that resolution a guarded step: the connect lookup resolves the name,
 * runs every returned address through the same special-purpose registry, and
 * hands the connector only an address that passed. The TCP connection is then
 * pinned to that address — the connector does not resolve the name again — so a
 * record pointing at a private address, or changing between resolution and
 * connect, cannot reach a non-public target.
 *
 * Escape-hatch semantics are unchanged: a host in ZEUS_OUTBOUND_ALLOW_HOSTS
 * skips the guard, including whatever its records resolve to.
 */
import { promises as dnsPromises, type LookupAddress } from 'node:dns';
import type { LookupFunction } from 'node:net';
import { Agent, type Dispatcher } from 'undici';
import {
  blockedReason,
  isAllowlisted,
  normaliseHost,
  parseAllowHosts,
} from './outbound-url.js';

export type ResolveAll = (host: string) => Promise<LookupAddress[]>;

const defaultResolveAll: ResolveAll = host => dnsPromises.lookup(host, { all: true });

/**
 * Return the reason a resolved host must be refused, or undefined when every
 * address is reachable. An allowlisted host skips the check.
 */
export function refusedReasonForResolved(
  host: string,
  addresses: readonly LookupAddress[],
  allowHosts: readonly string[],
): string | undefined {
  if (isAllowlisted(host, allowHosts)) return undefined;
  if (addresses.length === 0) return `DNS returned no addresses for ${host}`;
  for (const entry of addresses) {
    const reason = blockedReason(entry.address);
    if (reason) return `${reason} (resolved for ${host})`;
  }
  return undefined;
}

export interface GuardedLookupOptions {
  resolveAll?: ResolveAll;
  allowHosts?: readonly string[];
}

/**
 * Build the connect lookup used by an undici Agent. It resolves the host and —
 * unless the host is allowlisted — returns only the first address that passed
 * the registry, pinning the connection to it. When no address passes (or
 * resolution fails) the connector receives an error and no connection opens.
 */
export function createGuardedLookup(options: GuardedLookupOptions = {}): LookupFunction {
  const resolveAll = options.resolveAll ?? defaultResolveAll;
  const allowHosts = options.allowHosts ?? parseAllowHosts(process.env.ZEUS_OUTBOUND_ALLOW_HOSTS);

  const lookup = (
    hostname: string,
    _lookupOptions: unknown,
    callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
  ): void => {
    const host = normaliseHost(hostname);
    resolveAll(host)
      .then(addresses => {
        const first = addresses[0];
        if (!first) {
          return callback(
            Object.assign(new Error(`no addresses resolved for ${host}`), { code: 'ENOTFOUND' }),
            '',
            0,
          );
        }
        if (isAllowlisted(host, allowHosts)) {
          // Escape hatch: return the resolved result unchanged, no guard.
          return callback(null, first.address, first.family);
        }
        const reason = refusedReasonForResolved(host, addresses, allowHosts);
        if (reason) {
          return callback(
            Object.assign(new Error(`outbound host refused: ${reason}`), {
              code: 'EZEUSOUTBOUND',
            }),
            '',
            0,
          );
        }
        // Every address passed; pin the connection to the first.
        callback(null, first.address, first.family);
      })
      .catch((error: unknown) => {
        callback(error as NodeJS.ErrnoException, '', 0);
      });
  };

  return lookup as LookupFunction;
}

/** Create an undici Agent whose connections go through the guarded lookup. */
export function createOutboundDispatcher(options: GuardedLookupOptions = {}): Dispatcher {
  return new Agent({ connect: { lookup: createGuardedLookup(options) } });
}

let cachedDispatcher: Dispatcher | undefined;

/** Shared Agent (connection pool) for the default outbound fetch faces. */
export function defaultOutboundDispatcher(): Dispatcher {
  if (!cachedDispatcher) cachedDispatcher = createOutboundDispatcher();
  return cachedDispatcher;
}

/** Default outbound fetch: resolve through the guarded lookup, then connect. */
export const guardedFetch: typeof fetch = (input, init) =>
  // The ambient RequestInit is the DOM one (no `dispatcher`); the runtime fetch
  // is undici and honours it. Cast the single extra property through.
  fetch(input, { ...init, dispatcher: defaultOutboundDispatcher() } as RequestInit);
