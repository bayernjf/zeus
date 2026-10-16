import { describe, expect, it } from 'vitest';
import { VassalRegistry, type FetchLike } from '../src/registry/registry.js';
import { Ed25519MemorySigner, type RosterSigner } from '../src/registry/signing.js';
import { buildRosterAnchor } from '../src/trust/rosterAnchor.js';
import type { AgentCard, Fealty } from '../src/a2a/types.js';

const VALID_FEALTY: Fealty = {
  version: '1',
  swornTo: 'zeus',
  domain: 'test-domain',
  dataRealms: ['personal'],
  dataPolicy: 'read-task-scope',
  reportBack: true,
  escalationPolicy: 'on-failure',
};

function makeCard(name: string): AgentCard {
  return { name, url: `https://${name}.example/`, skills: [], 'x-zeus-fealty': VALID_FEALTY };
}

function fetchStub(card: AgentCard): FetchLike {
  return (async () => ({ ok: true, json: async () => card })) as unknown as FetchLike;
}

describe('buildRosterAnchor (design-external-trust §4, V3)', () => {
  it('returns undefined when the signer cannot export its public key (KMS backend)', async () => {
    const kmsLike: RosterSigner = { keyId: 'kms-key', sign: async () => 'unreachable' };
    const anchor = await buildRosterAnchor({
      registry: new VassalRegistry(),
      signer: kmsLike,
      maxAgeSeconds: 3600,
      attestationTtlSeconds: 3600,
    });
    expect(anchor).toBeUndefined();
  });

  it('anchors registered active vassals and no one else', async () => {
    const registry = new VassalRegistry(fetchStub(makeCard('helper')));
    await registry.register('http://127.0.0.1:9/agent-card');
    const anchor = await buildRosterAnchor({
      registry,
      signer: new Ed25519MemorySigner('test-rsk'),
      maxAgeSeconds: 3600,
      attestationTtlSeconds: 3600,
    });
    expect(anchor).toBeDefined();
    expect(anchor?.attestationFor('helper')).toBeDefined();
    expect(anchor?.attestationFor('stranger')).toBeUndefined();
  });

  it('drops the attestation once the vassal is revoked (revoked rows leave the public roster)', async () => {
    const registry = new VassalRegistry(fetchStub(makeCard('helper')));
    await registry.register('http://127.0.0.1:9/agent-card');
    expect(registry.revoke('helper')).toBe(true);
    const anchor = await buildRosterAnchor({
      registry,
      signer: new Ed25519MemorySigner('test-rsk'),
      maxAgeSeconds: 3600,
      attestationTtlSeconds: 3600,
    });
    expect(anchor?.attestationFor('helper')).toBeUndefined();
  });

  it('fails closed at lookup, not at build, for an empty registry', async () => {
    const anchor = await buildRosterAnchor({
      registry: new VassalRegistry(),
      signer: new Ed25519MemorySigner('test-rsk'),
      maxAgeSeconds: 3600,
      attestationTtlSeconds: 3600,
    });
    expect(anchor?.attestationFor('anyone')).toBeUndefined();
  });

  it('returns undefined instead of throwing when sealing blows up (fail-closed)', async () => {
    const registry = new VassalRegistry(fetchStub(makeCard('helper')));
    await registry.register('http://127.0.0.1:9/agent-card');
    const anchor = await buildRosterAnchor({
      registry,
      signer: new Ed25519MemorySigner('test-rsk'),
      maxAgeSeconds: 0,
      attestationTtlSeconds: 3600,
    });
    expect(anchor).toBeUndefined();
  });
});
