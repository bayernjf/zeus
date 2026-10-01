import { afterEach, describe, expect, it } from 'vitest';
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createHttpServer } from '../src/http/server.js';
import { VassalRegistry } from '../src/registry/registry.js';
import { Ed25519MemorySigner, Ed25519Verifier, verifySignedSnapshot } from '../src/registry/signing.js';
import type { RosterSigner } from '../src/index.js';

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

type MountOptions = { internalToken?: string; rosterKey?: { keyId: string; source: 'configured' | 'ephemeral' } };

async function mount(signer: RosterSigner, options: string | MountOptions = {}): Promise<FastifyInstance> {
  // A bare string is still accepted because most cases here only care about the token.
  const { internalToken, rosterKey }: MountOptions = typeof options === 'string' ? { internalToken: options } : options;
  app = await createHttpServer({
    registry: new VassalRegistry(),
    signer,
    ...(internalToken ? { internalToken } : {}),
    ...(rosterKey ? { rosterKey } : {}),
  });
  return app;
}

type KeyDocument = {
  issuer: string;
  keySource?: 'configured' | 'ephemeral';
  survivesRestart?: boolean;
  keys: Array<{
    kid: string;
    kty: string;
    crv: string;
    x: string;
    alg: string;
    use: string;
    spkiPem: string;
    jwkThumbprint: string;
    spkiSha256: string;
  }>;
  trust: string;
};

async function keys(instance: FastifyInstance): Promise<{ status: number; body: KeyDocument }> {
  const res = await instance.inject({ method: 'GET', url: '/api/roster/keys' });
  return { status: res.statusCode, body: res.json() as unknown as KeyDocument };
}

describe('root public key publication (design-fealty-signing §5.1)', () => {
  it('answers on the public face with a JWKS-shaped descriptor', async () => {
    const { status, body } = await keys(await mount(new Ed25519MemorySigner('zeus-rsk-2026-09'), 'driver-secret'));
    // No authorization header was sent: the key that verifies a public roster
    // cannot itself sit behind the driver token, or a third party could not use it.
    expect(status).toBe(200);
    expect(body.issuer).toBe('zeus');
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).toMatchObject({
      kid: 'zeus-rsk-2026-09',
      kty: 'OKP',
      crv: 'Ed25519',
      alg: 'Ed25519',
      use: 'sig',
    });
    expect(body.trust).toMatch(/out of band/);
  });

  it('publishes the key that actually seals /api/roster/public', async () => {
    const signer = new Ed25519MemorySigner('zeus-rsk-binding');
    const instance = await mount(signer);
    const { body } = await keys(instance);
    const envelope = await instance.inject({ method: 'GET', url: '/api/roster/public' });

    // The claim under test is "what this endpoint publishes is the signing key",
    // so the check is the one a verifier performs: load the published PEM and
    // verify the published roster with it.
    const verifier = new Ed25519Verifier([[body.keys[0].kid, createPublicKey(body.keys[0].spkiPem)]]);
    const result = await verifySignedSnapshot(envelope.json(), verifier);
    expect(result.ok).toBe(true);
  });

  it('rejects a roster re-sealed by a different key, using only the published key', async () => {
    const instance = await mount(new Ed25519MemorySigner('zeus-rsk-2026-09'));
    const { body } = await keys(instance);
    const impostor = new Ed25519MemorySigner('zeus-rsk-2026-09');
    const envelope = (await instance.inject({ method: 'GET', url: '/api/roster/public' })).json() as {
      seal: { sig: string };
    };
    const resealed = { ...envelope, seal: { ...envelope.seal, sig: await impostor.sign('{}') } };
    const verifier = new Ed25519Verifier([[body.keys[0].kid, createPublicKey(body.keys[0].spkiPem)]]);
    const result = await verifySignedSnapshot(resealed, verifier);
    expect(result.ok).toBe(false);
    // §8.1-6: the point is that a *foreign key* is caught, so the rejection must
    // name the signature and not stop earlier at the digest or the TTL gate.
    if (result.ok) throw new Error('expected the re-sealed roster to be rejected');
    expect(result.reason).toMatch(/seal signature verification failed/);
  });

  it('reports the JWK coordinate and both fingerprints consistently across encodings', async () => {
    const signer = new Ed25519MemorySigner('zeus-rsk-encodings');
    const { body } = await keys(await mount(signer));
    const key = body.keys[0];
    const fromPem = createPublicKey(key.spkiPem);

    expect(fromPem.export({ format: 'jwk' }).x).toBe(key.x);
    // Recomputed here rather than called through the library: a fingerprint that
    // is derived the same way the code derives it can never disagree with it.
    expect(key.jwkThumbprint).toBe(
      createHash('sha256')
        .update(`{"crv":"Ed25519","kty":"OKP","x":${JSON.stringify(key.x)}}`, 'utf8')
        .digest('base64url')
    );
    expect(key.spkiSha256).toBe(
      (createHash('sha256').update(fromPem.export({ type: 'spki', format: 'der' })).digest('hex').match(/.{2}/g) ?? [])
        .join(':')
    );
    expect(key.spkiSha256).toMatch(/^([0-9a-f]{2}:){31}[0-9a-f]{2}$/);
  });

  it('fails loudly when the signing backend exports no public half', async () => {
    const opaque: RosterSigner = { keyId: 'zeus-rsk-kms', sign: async () => 'never-signed-in-this-test' };
    const res = await (await mount(opaque)).inject({ method: 'GET', url: '/api/roster/keys' });
    // 500, not 501: the endpoint is implemented and was asked a valid question;
    // 501 would tell the client "not implemented" and hide a broken deployment
    // behind a version-shaped excuse.
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: 'key-material-unavailable' });
    // An empty keys[] would read as "nothing to pin" to a verifier that ignores
    // the status code; the field must be absent, not vacuous.
    expect((res.json() as { keys?: unknown }).keys).toBeUndefined();
  });

  it('states whether the sealing key survives a restart, and stays silent when it cannot know', async () => {
    const configured = await keys(await mount(new Ed25519MemorySigner('zeus-rsk-2026-09'), { rosterKey: { keyId: 'zeus-rsk-2026-09', source: 'configured' } }));
    expect(configured.body.keySource).toBe('configured');
    expect(configured.body.survivesRestart).toBe(true);

    const ephemeral = await keys(await mount(new Ed25519MemorySigner('zeus-rsk-dev'), { rosterKey: { keyId: 'zeus-rsk-dev', source: 'ephemeral' } }));
    expect(ephemeral.body.keySource).toBe('ephemeral');
    expect(ephemeral.body.survivesRestart).toBe(false);

    // An embedding process that built its own signer is not reporting a source it
    // did not determine: the field is absent, not defaulted to something reassuring.
    const unknown = await keys(await mount(new Ed25519MemorySigner('zeus-rsk-custom')));
    expect(unknown.status).toBe(200);
    expect(unknown.body.keySource).toBeUndefined();
    expect(unknown.body.survivesRestart).toBeUndefined();
  });

  it('refuses to publish a non-Ed25519 root key', async () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const offSpec: RosterSigner = {
      keyId: 'zeus-rsk-rsa',
      publicKey: rsa.publicKey,
      sign: async () => 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    };
    const res = await (await mount(offSpec)).inject({ method: 'GET', url: '/api/roster/keys' });
    expect(res.statusCode).toBe(500);
    expect((res.json() as { detail: string }).detail).toMatch(/Ed25519/);
  });

  it('stays mounted when no internal token is configured', async () => {
    const { status } = await keys(await mount(new Ed25519MemorySigner('zeus-rsk-no-token')));
    expect(status).toBe(200);
  });
});
