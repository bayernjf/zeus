import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHttpServer } from '../src/http/server.js';
import { SkillRegistry } from '../src/skills/registry.js';
import type { DecisionBackend } from '../src/decision/types.js';

const TOKEN = 'driver-secret';
const AUTH = { authorization: `Bearer ${TOKEN}` };

function registryWithSkills() {
  const registry = new SkillRegistry();
  registry.register({
    id: 'code-review', name: 'Code Review', description: 'review a pull request', version: '1.0.0', tags: [],
  });
  registry.register({
    id: 'research', name: 'Deep Research', description: 'multi-source research', version: '1.0.0', tags: [],
  });
  return registry;
}

function mockBackend(overrides: Partial<DecisionBackend> = {}): DecisionBackend {
  return {
    kind: 'llm',
    model: 'agnes-2.5-flash',
    noul: vi.fn(async () => ({ probability: 0.5, confidence: 0.5, calibrated: false, decisionAt: 'x' })),
    score: vi.fn(async () => ({ score: 50, distribution: {}, confidence: 0.5, calibrated: false, decisionAt: 'x' })),
    choice: vi.fn(async () => ({ choice: 'research', probabilities: {}, confidence: 0.9, calibrated: false, decisionAt: 'x' })),
    ...overrides,
  };
}

let app: FastifyInstance | undefined;

afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
});

async function server(deps: Record<string, unknown> = {}) {
  app = await createHttpServer({
    version: '0.0.0-test',
    internalToken: TOKEN,
    signer: undefined,
    ...deps,
  } as never);
  return app;
}

describe('POST /api/intents/recognize', () => {
  it('is bearer-protected like the rest of H2', async () => {
    const a = await server({ skillRegistry: registryWithSkills() });
    const response = await a.inject({ method: 'POST', url: '/api/intents/recognize', payload: { text: 'review the pr' } });
    expect(response.statusCode).toBe(401);
  });

  it('400 on missing or non-string text', async () => {
    const a = await server({ skillRegistry: registryWithSkills() });
    for (const payload of [{}, { text: 42 }, { text: '   ' }]) {
      const response = await a.inject({ method: 'POST', url: '/api/intents/recognize', headers: AUTH, payload });
      expect(response.statusCode).toBe(400);
    }
  });

  it('400 on an invalid realm or useModel', async () => {
    const a = await server({ skillRegistry: registryWithSkills() });
    const bad = await a.inject({ method: 'POST', url: '/api/intents/recognize', headers: AUTH, payload: { text: 'review', realm: 'public' } });
    expect(bad.statusCode).toBe(400);
    const badModel = await a.inject({ method: 'POST', url: '/api/intents/recognize', headers: AUTH, payload: { text: 'review', useModel: 'yes' } });
    expect(badModel.statusCode).toBe(400);
  });

  it('is not mounted when the skill registry is absent (404)', async () => {
    const a = await server({});
    const response = await a.inject({ method: 'POST', url: '/api/intents/recognize', headers: AUTH, payload: { text: 'review' } });
    expect(response.statusCode).toBe(404);
  });

  it('resolves locally by default, without touching any backend', async () => {
    const backend = mockBackend();
    const a = await server({ skillRegistry: registryWithSkills(), decisionBackend: backend });
    const response = await a.inject({ method: 'POST', url: '/api/intents/recognize', headers: AUTH, payload: { text: 'review this pull request' } });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(true);
    expect(body.intent).toEqual({ skill: 'code-review', params: {}, mode: 'plan' });
    expect(body.backend).toBeNull();
    expect((backend.choice as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('fails closed (422) when nothing matches', async () => {
    const a = await server({ skillRegistry: registryWithSkills() });
    const response = await a.inject({ method: 'POST', url: '/api/intents/recognize', headers: AUTH, payload: { text: 'unrelated gibberish topic' } });
    expect(response.statusCode).toBe(422);
    const body = response.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe('no-candidates');
  });

  it('consults the pluggable backend only when useModel is explicitly true', async () => {
    const backend = mockBackend();
    const a = await server({ skillRegistry: registryWithSkills(), decisionBackend: backend });
    const response = await a.inject({ method: 'POST', url: '/api/intents/recognize', headers: AUTH, payload: { text: 'deep research on agents', useModel: true } });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(true);
    expect(body.intent.skill).toBe('research');
    expect(body.backend).toEqual({ kind: 'llm', model: 'agnes-2.5-flash' });
    expect(backend.choice as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
  });

  it('fails closed (422) on a low-confidence model answer', async () => {
    const backend = mockBackend({
      choice: vi.fn(async () => ({ choice: 'research', probabilities: {}, confidence: 0.3, calibrated: false, decisionAt: 'x' })),
    });
    const a = await server({ skillRegistry: registryWithSkills(), decisionBackend: backend });
    const response = await a.inject({ method: 'POST', url: '/api/intents/recognize', headers: AUTH, payload: { text: 'research agents', useModel: true } });
    expect(response.statusCode).toBe(422);
    expect(response.json().reason).toBe('low-confidence');
  });
});
