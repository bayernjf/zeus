import { describe, expect, it } from 'vitest';
import type { LookupAddress } from 'node:dns';
import type { LookupFunction } from 'node:net';
import { createServer } from 'node:http';
import {
  createGuardedLookup,
  createOutboundDispatcher,
  refusedReasonForResolved,
  type ResolveAll,
} from '../src/util/outbound-dns.js';

function addr(address: string): LookupAddress {
  return { address, family: address.includes(':') ? 6 : 4 };
}

function resolverFor(addresses: LookupAddress[]): ResolveAll {
  return async () => addresses;
}

function runLookup(
  lookup: LookupFunction,
  host: string,
): Promise<{ address: string; family: number }> {
  return new Promise((resolve, reject) => {
    lookup(host, {}, (err, address, family) => {
      if (err) return reject(err);
      const resolved = typeof address === 'string' ? address : (address[0]?.address ?? '');
      resolve({ address: resolved, family: family ?? 0 });
    });
  });
}

describe('refusedReasonForResolved', () => {
  it('reports no reason when every address is public', () => {
    expect(
      refusedReasonForResolved('example.com', [addr('93.184.216.34')], []),
    ).toBeUndefined();
  });

  it('refuses an empty result set', () => {
    expect(refusedReasonForResolved('example.com', [], [])).toMatch(/no addresses/);
  });

  it('refuses when any resolved address is private', () => {
    const reason = refusedReasonForResolved(
      'example.com',
      [addr('93.184.216.34'), addr('10.0.0.1')],
      [],
    );
    expect(reason).toContain('RFC1918');
  });

  it('skips the check for an allowlisted host', () => {
    expect(
      refusedReasonForResolved(
        'internal.example',
        [addr('10.0.0.1')],
        ['internal.example'],
      ),
    ).toBeUndefined();
  });
});

describe('createGuardedLookup', () => {
  it('pins a public IPv4 address', async () => {
    const lookup = createGuardedLookup({
      resolveAll: resolverFor([addr('93.184.216.34')]),
    });
    await expect(runLookup(lookup, 'example.com')).resolves.toEqual({
      address: '93.184.216.34',
      family: 4,
    });
  });

  it('refuses a host that resolves to a private network', async () => {
    const lookup = createGuardedLookup({
      resolveAll: resolverFor([addr('10.1.2.3')]),
    });
    await expect(runLookup(lookup, 'evil.example')).rejects.toThrow(/RFC1918/);
  });

  it('refuses a host that resolves to the cloud metadata address', async () => {
    const lookup = createGuardedLookup({
      resolveAll: resolverFor([addr('169.254.169.254')]),
    });
    await expect(runLookup(lookup, 'evil.example')).rejects.toThrow(/link-local/);
  });

  it('refuses a mixed result that contains a private address (fail-closed)', async () => {
    const lookup = createGuardedLookup({
      resolveAll: resolverFor([addr('93.184.216.34'), addr('10.0.0.1')]),
    });
    await expect(runLookup(lookup, 'evil.example')).rejects.toThrow(/RFC1918/);
  });

  it('refuses an IPv6 unique-local address', async () => {
    const lookup = createGuardedLookup({
      resolveAll: resolverFor([addr('fd00::1')]),
    });
    await expect(runLookup(lookup, 'evil.example')).rejects.toThrow(/unique-local/);
  });

  it('pins a public IPv6 address', async () => {
    const lookup = createGuardedLookup({
      resolveAll: resolverFor([addr('2606:4700::4700')]),
    });
    await expect(runLookup(lookup, 'example.com')).resolves.toEqual({
      address: '2606:4700::4700',
      family: 6,
    });
  });

  it('keeps loopback reachable (local-first)', async () => {
    const lookup = createGuardedLookup({
      resolveAll: resolverFor([addr('127.0.0.1')]),
    });
    await expect(runLookup(lookup, 'localhost')).resolves.toEqual({
      address: '127.0.0.1',
      family: 4,
    });
  });

  it('returns an escape-hatch host unchanged even when it resolves private', async () => {
    const lookup = createGuardedLookup({
      resolveAll: resolverFor([addr('10.5.6.7')]),
      allowHosts: ['internal.example'],
    });
    await expect(runLookup(lookup, 'internal.example')).resolves.toEqual({
      address: '10.5.6.7',
      family: 4,
    });
  });

  it('refuses when resolution returns no addresses', async () => {
    const lookup = createGuardedLookup({ resolveAll: resolverFor([]) });
    await expect(runLookup(lookup, 'empty.example')).rejects.toThrow(/no addresses/);
  });

  it('propagates a resolver failure', async () => {
    const lookup = createGuardedLookup({
      resolveAll: async () => {
        throw new Error('dns unavailable');
      },
    });
    await expect(runLookup(lookup, 'example.com')).rejects.toThrow('dns unavailable');
  });
});

describe('guarded dispatcher (loopback integration)', () => {
  it('still reaches a loopback service through the guarded lookup', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
        dispatcher: createOutboundDispatcher(),
      } as RequestInit);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('ok');
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
