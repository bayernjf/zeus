import { describe, expect, it } from 'vitest';
import { ZeusClient, ZeusClientError } from '../packages/zeus-client/src/index.js';

/** Unified error contract (Tier0 review 2026-10-30 H2): the server answers
 *  unhandled failures with a minimal RFC 9457 ProblemDetails body, while
 *  business errors keep their §8.1 `{ code, message, retryable }` envelope.
 *  The client must keep a stable machine code and never dump the raw JSON
 *  body into the error message. */
function clientWith(respond: () => Response): ZeusClient {
  return new ZeusClient({
    baseUrl: 'http://127.0.0.1:8790',
    token: 'test-token',
    fetchImpl: async () => respond(),
  });
}

describe('zeus-client error parsing', () => {
  it('maps a ProblemDetails 500 to the stable internal_error code and the generic detail', async () => {
    const client = clientWith(() =>
      new Response(
        JSON.stringify({
          type: 'about:blank',
          title: 'Internal Server Error',
          status: 500,
          detail: 'internal error',
          instance: '/api/v1/decisions',
        }),
        { status: 500, headers: { 'content-type': 'application/json' } },
      ),
    );
    const error = (await client.getDecision('d-1').catch((e: unknown) => e)) as ZeusClientError;
    expect(error).toBeInstanceOf(ZeusClientError);
    expect(error.code).toBe('internal_error');
    expect(error.message).toBe('internal error');
    expect(error.status).toBe(500);
    expect(error.retryable).toBe(true);
  });

  it('keeps parsing the business { code, message, retryable } envelope by its code', async () => {
    const client = clientWith(() =>
      new Response(JSON.stringify({ code: 'not_found', message: 'no such decision', retryable: false }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const error = (await client.getDecision('d-1').catch((e: unknown) => e)) as ZeusClientError;
    expect(error.code).toBe('not_found');
    expect(error.message).toBe('no such decision');
    expect(error.retryable).toBe(false);
  });

  it('falls back to HTTP_<status> for non-JSON bodies', async () => {
    const client = clientWith(() => new Response('<html>bad gateway</html>', { status: 502 }));
    const error = (await client.getDecision('d-1').catch((e: unknown) => e)) as ZeusClientError;
    expect(error.code).toBe('HTTP_502');
    expect(error.retryable).toBe(true);
  });
});
