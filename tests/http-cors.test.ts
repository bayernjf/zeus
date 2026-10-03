import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHttpServer } from '../src/http/server.js';
import { VassalRegistry } from '../src/registry/registry.js';
import { Ed25519MemorySigner } from '../src/registry/signing.js';

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function mount(corsOrigins?: string[]): Promise<FastifyInstance> {
  app = await createHttpServer({
    registry: new VassalRegistry(),
    signer: new Ed25519MemorySigner('zeus-rsk-2026-09'),
    internalToken: 'driver-secret',
    ...(corsOrigins ? { corsOrigins } : {}),
  });
  return app;
}

describe('optional CORS allow-list (deferred #34 方案 A, ZEUS_CORS_ORIGINS)', () => {
  it('emits no CORS headers when no allow-list is configured (default behaviour unchanged)', async () => {
    const res = await (await mount()).inject({
      method: 'GET',
      url: '/api/state',
      headers: { origin: 'http://localhost:5173' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(String(res.headers.vary ?? '')).not.toContain('Origin');
  });

  it('echoes an exact allow-listed origin and marks Vary', async () => {
    const res = await (await mount(['http://localhost:5173'])).inject({
      method: 'GET',
      url: '/api/state',
      headers: { origin: 'http://localhost:5173' },
    });
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(res.headers.vary).toContain('Origin');
  });

  it('leaves non-allow-listed origins untouched', async () => {
    const res = await (await mount(['http://localhost:5173'])).inject({
      method: 'GET',
      url: '/api/state',
      headers: { origin: 'https://evil.example' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers an allow-listed OPTIONS preflight with 204 and the permitted surface', async () => {
    const res = await (await mount(['http://localhost:5173'])).inject({
      method: 'OPTIONS',
      url: '/api/intents',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, content-type',
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(res.headers['access-control-allow-methods']).toContain('POST');
    expect(res.headers['access-control-allow-headers']).toContain('Authorization');
  });
});
