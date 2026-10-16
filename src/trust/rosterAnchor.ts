// design-external-trust V3 (PRD E9.4): builds the verified-roster view the
// tier gate consults for tier-3. Zeus is the roster publisher, so the anchor
// is the same signed artifact /api/roster/public serves — freshly sealed and
// verified per request (§4: the tier is decided per request, never cached),
// and the verify half is the same fail-closed chain an external verifier
// (bayjf R2) runs against the published copy.

import type { VassalRegistry } from '../registry/registry.js';
import { projectPublicRoster } from '../registry/roster.js';
import {
  Ed25519Verifier,
  sealSnapshot,
  verifySignedSnapshot,
  type Attestation,
  type RosterSigner,
} from '../registry/signing.js';
import type { RosterAnchor } from './tier.js';

export type RosterAnchorDeps = {
  registry: VassalRegistry;
  signer: RosterSigner;
  now?: () => Date;
  maxAgeSeconds: number;
  attestationTtlSeconds: number;
};

/** Freshly seals the public roster and verifies it back under the signer's
 *  own public key, returning the attestation lookup the tier gate consumes.
 *  Fail-closed: a signer without exportable key material (KMS/HSM), an
 *  unverifiable artifact, or any thrown error yields undefined — callers then
 *  cap at tier-2 and the tier decision itself is never interrupted. */
export async function buildRosterAnchor(deps: RosterAnchorDeps): Promise<RosterAnchor | undefined> {
  const publicKey = deps.signer.publicKey;
  if (!publicKey) return undefined;
  try {
    const at = (deps.now ?? (() => new Date()))();
    const all = deps.registry.listAll();
    const snapshot = projectPublicRoster(all, () => at);
    const sources = all
      .filter(entry => !entry.revoked)
      .map(entry => ({ name: entry.card.name, card: entry.card, cardUrl: entry.cardUrl }));
    const signed = await sealSnapshot(snapshot, deps.signer, {
      now: at,
      maxAgeSeconds: deps.maxAgeSeconds,
      sources,
      attestationTtlSeconds: deps.attestationTtlSeconds,
    });
    const verifier = new Ed25519Verifier([[deps.signer.keyId, publicKey]]);
    const verified = await verifySignedSnapshot(signed, verifier, at);
    if (!verified.ok) return undefined;
    const attestations: Record<string, Attestation> = signed.attestations;
    return { attestationFor: name => attestations[name] };
  } catch {
    return undefined;
  }
}
