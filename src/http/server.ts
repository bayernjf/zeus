import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { VassalRegistry } from '../registry/registry.js';
import { projectInternalRoster, projectPublicRoster, type RosterSnapshot } from '../registry/roster.js';
import { sealSnapshot, type RosterSigner, type SignedRosterSnapshot } from '../registry/signing.js';

/**
 * HTTP H1 service face (docs/design-http-transport.md):
 * a thin Fastify adapter. The ONLY directory allowed to import fastify; handlers
 * do parameter/auth/serialization only — zero business logic, all state lives
 * in the kernel (registry). No Realm routes (Realm is MCP-only, design-realm §6.1).
 */

export const DEFAULT_SEAL_MAX_AGE_SECONDS = 3600;
export const DEFAULT_ATTESTATION_TTL_SECONDS = 24 * 3600;

export type HttpDeps = {
  registry: VassalRegistry;
  signer: RosterSigner;
  /** Bearer token for GET /api/roster. When unset, the internal route is not mounted at all. */
  internalToken?: string;
  now?: () => Date;
  version?: string;
  sealMaxAgeSeconds?: number;
  attestationTtlSeconds?: number;
};

export type StartOptions = {
  host?: string;
  port?: number;
};

export async function createHttpServer(deps: HttpDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const now = deps.now ?? (() => new Date());
  const maxAge = deps.sealMaxAgeSeconds ?? DEFAULT_SEAL_MAX_AGE_SECONDS;
  const attestationTtl = deps.attestationTtlSeconds ?? DEFAULT_ATTESTATION_TTL_SECONDS;

  // Liveness: version + time only, never vassal/Realm information.
  app.get('/healthz', async () => ({
    status: 'ok',
    ...(deps.version ? { version: deps.version } : {}),
    ts: now().toISOString(),
  }));

  // Public immutable signed snapshot (fealty-signing §4); revoked vassals and
  // internal endpoints/probe details are already removed at the projector.
  app.get('/api/roster/public', async (_request, reply) => {
    const at = now();
    const all = deps.registry.listAll();
    const snapshot = projectPublicRoster(all, () => at);
    const sources = all
      .filter(entry => !entry.revoked)
      .map(entry => ({ name: entry.card.name, card: entry.card, cardUrl: entry.cardUrl }));
    const signed: SignedRosterSnapshot = await sealSnapshot(snapshot, deps.signer, {
      now: at,
      maxAgeSeconds: maxAge,
      sources,
      attestationTtlSeconds: attestationTtl,
    });
    reply.header('Cache-Control', `public, max-age=${maxAge}`);
    reply.type('application/json; charset=utf-8');
    return signed;
  });

  // Internal governance view: bearer-protected, unsigned (contains revoked rows
  // and endpoints; the v1 envelope only attests active entries — fealty-signing §4).
  if (deps.internalToken) {
    const expected = deps.internalToken;
    const requireBearer = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const header = request.headers.authorization ?? '';
      const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
      if (!constantTimeEqual(presented, expected)) {
        await reply.code(401).send({ error: 'unauthorized' });
      }
    };
    app.get('/api/roster', { preHandler: requireBearer }, async (): Promise<RosterSnapshot> => {
      return projectInternalRoster(deps.registry.listAll(), now);
    });
  }

  return app;
}

/** Start the long-lived process. Personal edition binds loopback by default
 *  (design-http-transport §2.1); enterprise sits behind a gateway. */
export async function startServer(deps: HttpDeps, options: StartOptions = {}): Promise<FastifyInstance> {
  const app = await createHttpServer(deps);
  await app.listen({ host: options.host ?? '127.0.0.1', port: options.port ?? 0 });
  return app;
}

/** Length-safe constant-time comparison for bearer tokens. */
function constantTimeEqual(presented: string, expected: string): boolean {
  if (!presented) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
