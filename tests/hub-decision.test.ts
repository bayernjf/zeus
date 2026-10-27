import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { resolveDecisionConfigWithHub } from '../src/state/boot.js';
import {
  createHubDecisionBackend,
  type HubTestPort,
} from '../src/decision/hub-backend.js';
import { createHttpServer } from '../src/http/server.js';
import { VassalRegistry } from '../src/registry/registry.js';
import { Ed25519MemorySigner } from '../src/registry/signing.js';
import type { CatalogResponse, ProjectedModel } from '@model-hub/model-kit';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zeus-hub-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function projected(
  alias: string,
  model: string,
  baseUrl: string,
): ProjectedModel {
  return {
    assignment_id: `asn_${alias}`,
    alias,
    role: 'primary',
    modalities: ['text'],
    model,
    litellm_id: null,
    display_name: model,
    protocol: 'openai-compatible',
    base_url: baseUrl,
    api_key: `key-${alias}`,
    endpoints: { chat: '/chat/completions' },
    adapter: null,
    context_window: 1000,
    supports_json: true,
    supports_stream: true,
    daily_budget_micros: null,
    pricing: {
      input_usd_per_million: 1,
      output_usd_per_million: 2,
    },
  };
}

const catalog: CatalogResponse = {
  project: 'zeus',
  revision: 3,
  fetched_at: '2026-10-28T00:00:00Z',
  models: [
    projected('noul', 'model-noul', 'https://noul.test/v1'),
    projected('choice', 'model-choice', 'https://choice.test/v1'),
    projected('score', 'model-score', 'https://score.test/v1'),
  ],
};

// Record which model each provider call used.
function routingFetch(calls: Array<{ model: string }>): typeof fetch {
  const answerFor = (model: string) => {
    if (model === 'model-noul') {
      return { probability: 0.7, confidence: 0.8 };
    }
    if (model === 'model-choice') {
      return { choice: 'x', probabilities: { x: 1 }, confidence: 0.9 };
    }
    return { score: 50, distribution: {}, confidence: 0.9 };
  };

  return (async (input, init) => {
    const url = String(input);
    if (url.includes('/pub/v1/models')) {
      return new Response(JSON.stringify(catalog), { status: 200 });
    }
    const body = JSON.parse((init?.body as string) ?? '{}') as {
      model: string;
    };
    calls.push({ model: body.model });
    return new Response(
      JSON.stringify({
        choices: [
          { message: { content: JSON.stringify(answerFor(body.model)) } },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
}

describe('createHubDecisionBackend', () => {
  it('routes each primitive to its alias model', async () => {
    const calls: Array<{ model: string }> = [];
    const fetchImpl = routingFetch(calls);
    const { backend } = await createHubDecisionBackend({
      hubUrl: 'https://hub.local',
      token: 'tok',
      cachePath: join(dir, 'cache.json'),
      fetchImpl,
    });

    await backend.noul({
      state: {},
      instructions: '',
      runId: 'r1',
      realm: 'personal',
      question: 'q',
    });
    await backend.choice({
      state: {},
      instructions: '',
      runId: 'r2',
      realm: 'personal',
      question: 'q',
      options: ['x'],
    });
    await backend.score({
      state: {},
      instructions: '',
      runId: 'r3',
      realm: 'personal',
      question: 'q',
      levels: ['low'],
    });

    expect(calls.map((c) => c.model)).toEqual([
      'model-noul',
      'model-choice',
      'model-score',
    ]);
  });
});

describe('resolveDecisionConfigWithHub', () => {
  it('uses the hub backend when configured', async () => {
    const cfg = await resolveDecisionConfigWithHub(
      {
        MODEL_HUB_URL: 'https://hub.local',
        MODEL_HUB_TOKEN: 'tok',
        MODEL_HUB_CACHE_PATH: join(dir, 'cache.json'),
      },
      {
        fetchImpl: (async () =>
          new Response(JSON.stringify(catalog), { status: 200 })) as typeof fetch,
      },
    );
    expect(cfg.backendKind).toBe('hub');
    expect(cfg.backend).not.toBeNull();
  });

  it('falls back to env when the hub is unreachable', async () => {
    const cfg = await resolveDecisionConfigWithHub(
      {
        MODEL_HUB_URL: 'https://hub.local',
        MODEL_HUB_TOKEN: 'tok',
        MODEL_HUB_CACHE_PATH: join(dir, 'cache.json'),
        ZEUS_LLM_BASE_URL: 'http://llm.test/v1',
        ZEUS_LLM_API_KEY: 'k',
        ZEUS_LLM_MODEL: 'gpt-test',
      },
      {
        fetchImpl: (async () => {
          throw new Error('hub down');
        }) as typeof fetch,
      },
    );
    expect(cfg.backendKind).toBe('llm');
  });

  it('honors the kill switch and skips the hub', async () => {
    const cfg = await resolveDecisionConfigWithHub({
      MODEL_HUB_URL: 'https://hub.local',
      MODEL_HUB_TOKEN: 'tok',
      MODEL_HUB_CACHE_PATH: join(dir, 'cache.json'),
      MODEL_HUB_DISABLED: '1',
      ZEUS_LLM_BASE_URL: 'http://llm.test/v1',
      ZEUS_LLM_API_KEY: 'k',
      ZEUS_LLM_MODEL: 'gpt-test',
    });
    expect(cfg.backendKind).toBe('llm');
  });

  it('boots rules-only when neither hub nor env is configured', async () => {
    const cfg = await resolveDecisionConfigWithHub({});
    expect(cfg.backend).toBeNull();
    expect(cfg.backendKind).toBeNull();
  });
});

describe('hub L3/L4 test endpoints', () => {
  const TOKEN = 'driver-secret';
  const AUTH = { authorization: `Bearer ${TOKEN}` };

  const hubTest: HubTestPort = {
    pingHub: async () => ({ ok: true, latency_ms: 10, revision: 3 }),
    testConnection: async (alias) => ({
      ok: true,
      latency_ms: 20,
      scope: `L4:${alias}`,
    }),
  };

  async function serverWith(testPort?: HubTestPort): Promise<FastifyInstance> {
    return createHttpServer({
      registry: new VassalRegistry(),
      signer: new Ed25519MemorySigner('zeus-rsk-test'),
      internalToken: TOKEN,
      ...(testPort ? { hubTest: testPort } : {}),
    });
  }

  it('returns the L3 ping result', async () => {
    const app = await serverWith(hubTest);
    const res = await app.inject({ method: 'GET', url: '/api/decision/ping', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, revision: 3 });
  });

  it('requires an alias for the L4 test', async () => {
    const app = await serverWith(hubTest);
    const res = await app.inject({ method: 'POST', url: '/api/decision/test', payload: {}, headers: AUTH });
    expect(res.statusCode).toBe(400);
  });

  it('runs the L4 test for a given alias', async () => {
    const app = await serverWith(hubTest);
    const res = await app.inject({
      method: 'POST',
      url: '/api/decision/test',
      payload: { alias: 'noul' },
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, scope: 'L4:noul' });
  });

  it('does not mount the test endpoints without a hub', async () => {
    const app = await serverWith();
    const res = await app.inject({ method: 'GET', url: '/api/decision/ping', headers: AUTH });
    expect(res.statusCode).toBe(404);
  });

  it('requires a bearer token', async () => {
    const app = await serverWith(hubTest);
    const res = await app.inject({ method: 'GET', url: '/api/decision/ping' });
    expect(res.statusCode).toBe(401);
  });
});
