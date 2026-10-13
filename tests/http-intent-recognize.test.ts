import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHttpServer } from '../src/http/server.js';
import { SkillRegistry } from '../src/skills/registry.js';
import type { ChoiceResult, DecisionBackend, NoulResult, ScoreResult } from '../src/decision/types.js';
import { createScriptedDecisionBackend, type ScriptedOptions } from '../src/testing/decision-backend.js';

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

const defaultChoice: ChoiceResult = { choice: 'research', probabilities: {}, confidence: 0.9, calibrated: false, decisionAt: 'x' };

function mockBackend(overrides: ScriptedOptions = {}): DecisionBackend {
  return createScriptedDecisionBackend({
    kind: 'llm',
    model: 'agnes-2.5-flash',
    noul: { probability: 0.5, confidence: 0.5, calibrated: false, decisionAt: 'x' } satisfies NoulResult,
    score: { score: 50, distribution: {}, confidence: 0.5, calibrated: false, decisionAt: 'x' } satisfies ScoreResult,
    choice: defaultChoice,
    ...overrides,
  });
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
    expect((backend as ReturnType<typeof createScriptedDecisionBackend>).calls.choice).toHaveLength(0);
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
    expect((backend as ReturnType<typeof createScriptedDecisionBackend>).calls.choice).toHaveLength(1);
  });

  it('fails closed (422) on a low-confidence model answer', async () => {
    const backend = mockBackend({
      choice: { choice: 'research', probabilities: {}, confidence: 0.3, calibrated: false, decisionAt: 'x' },
    });
    const a = await server({ skillRegistry: registryWithSkills(), decisionBackend: backend });
    const response = await a.inject({ method: 'POST', url: '/api/intents/recognize', headers: AUTH, payload: { text: 'research agents', useModel: true } });
    expect(response.statusCode).toBe(422);
    expect(response.json().reason).toBe('low-confidence');
  });

  describe('E2.7 declared aliases over the operator face', () => {
    it('registers aliases and resolves a CJK instruction with no model involved', async () => {
      const registry = registryWithSkills();
      const a = await server({ skillRegistry: registry });
      const registered = await a.inject({
        method: 'POST',
        url: '/api/skills',
        headers: AUTH,
        payload: {
          id: 'notes-digest', name: 'Notes Digest', description: 'restates a note', version: '1.0.0',
          tags: [], providedBy: ['alpha'], aliases: ['归纳要点', '总结'],
        },
      });
      expect(registered.statusCode).toBe(201);
      expect(registered.json().aliases).toEqual(['归纳要点', '总结']);

      // No decisionBackend is mounted: the local rules must resolve it, so this
      // path keeps the zero-egress default.
      const resolved = await a.inject({
        method: 'POST',
        url: '/api/intents/recognize',
        headers: AUTH,
        payload: { text: '帮我把这份材料归纳要点' },
      });
      expect(resolved.statusCode).toBe(200);
      expect(resolved.json().intent.skill).toBe('notes-digest');
      expect(resolved.json().backend).toBeNull();
    });

    it('refuses a malformed alias list before it reaches the persisted directory', async () => {
      const registry = registryWithSkills();
      const a = await server({ skillRegistry: registry });
      const bad = await a.inject({
        method: 'POST',
        url: '/api/skills',
        headers: AUTH,
        payload: {
          id: 'broken-aliases', name: 'Broken', description: 'd', version: '1.0.0',
          tags: [], providedBy: ['alpha'], aliases: ['   '],
        },
      });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().message ?? JSON.stringify(bad.json())).toMatch(/alias/i);
      expect(registry.list().some(spec => spec.id === 'broken-aliases')).toBe(false);
    });
  });
});
