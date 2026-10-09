import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHttpServer } from '../src/http/server.js';
import { VassalRegistry, type FetchLike } from '../src/registry/registry.js';
import { fealtyOathProblem } from '../src/registry/registry.js';
import { Ed25519MemorySigner } from '../src/registry/signing.js';
import { SkillRegistry } from '../src/skills/registry.js';
import type { Orchestrator } from '../src/orchestrator/orchestrator.js';
import type { FanOutRequest, FanOutResult } from '../src/orchestrator/types.js';
import type { AgentCard, Fealty } from '../src/a2a/types.js';
import type { AuditEntry } from '../src/dispatch/dispatcher.js';

/**
 * S17 V2 (design-agent-testing §5): protocol compatibility matrix, first
 * edition. The kernel's accept/refuse policy is pinned against the version
 * rules of design-vassal-protocol §4.5 — a minimal legal card registers, a
 * card missing optional fields and a card carrying unknown extension fields
 * still register (the design is a superset, not a wall), while an unsupported
 * fealty version and a missing oath are refused at the boundary.
 */

let app: FastifyInstance | undefined;
let auditEntries: AuditEntry[] = [];

afterEach(async () => {
  await app?.close();
  app = undefined;
  auditEntries = [];
});

const TOKEN = { authorization: 'Bearer driver-secret' };

function makeCard(name: string, fealty: Fealty | undefined, extra: Record<string, unknown> = {}): AgentCard {
  return {
    name,
    url: `https://${name}.example/`,
    skills: [],
    ...(fealty ? { 'x-zeus-fealty': fealty } : {}),
    ...extra,
  };
}

const VALID_FEALTY: Fealty = {
  version: '1',
  swornTo: 'zeus',
  domain: 'test-domain',
  dataRealms: ['personal'],
  dataPolicy: 'read-task-scope',
  reportBack: true,
  escalationPolicy: 'on-failure',
};

function makeOrchestrator(): Orchestrator {
  return {
    fanOut: async (request: FanOutRequest): Promise<FanOutResult> => ({
      intentId: request.intentId ?? 'intent-1',
      runId: 'run-1',
      skill: request.skill,
      realm: request.realm,
      branches: [],
      stream: [],
      positions: [],
      decision: { rule: 'unanimous', conclusion: 'ok', positions: [], reason: 'stub' },
      conflicts: [],
      status: 'completed',
      createdAt: new Date().toISOString(),
    }),
  } as Orchestrator;
}

async function makeApp(): Promise<FastifyInstance> {
  const server = await createHttpServer({
    internalToken: 'driver-secret',
    agentCard: makeCard('zeus-self', VALID_FEALTY),
    signer: new Ed25519MemorySigner('zeus-rsk-2026-09'),
    registry: new VassalRegistry(() => Promise.reject(new Error('no fetch needed'))),
    skillRegistry: new SkillRegistry(),
    orchestrator: makeOrchestrator(),
    inboundAudit: (entry: AuditEntry) => auditEntries.push(entry),
    now: () => new Date('2026-10-10T00:00:00Z'),
  });
  return server;
}

describe('S17 V2 protocol compatibility matrix', () => {
  describe('agent-card registration face', () => {
    function localCardFetch(card: unknown): FetchLike {
      return async () => new Response(JSON.stringify(card), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    it('accepts a minimal legal card (name + skills + full oath)', async () => {
      const registry = new VassalRegistry(localCardFetch(makeCard('alpha', VALID_FEALTY)));
      const entry = await registry.register('https://alpha.example/card', { taskUrl: 'https://alpha.example/tasks' });
      expect(entry.card.name).toBe('alpha');
    });

    it('accepts a card that omits optional fields (capabilities/authentication)', async () => {
      // The AgentCard shape in the kernel keeps these optional; a peer that
      // serves the minimum contract is a valid vassal, not a guest.
      const minimal = makeCard('beta', VALID_FEALTY);
      delete (minimal as Partial<AgentCard>).capabilities;
      delete (minimal as Partial<AgentCard>).authentication;
      const registry = new VassalRegistry(localCardFetch(minimal));
      const entry = await registry.register('https://beta.example/card', { taskUrl: 'https://beta.example/tasks' });
      expect(entry.card.name).toBe('beta');
    });

    it('accepts unknown extension fields (superset, not a wall)', async () => {
      const extended = makeCard('gamma', VALID_FEALTY, {
        'x-vendor-extra': { anything: true },
        customField: 'ignored',
      });
      const registry = new VassalRegistry(localCardFetch(extended));
      const entry = await registry.register('https://gamma.example/card', { taskUrl: 'https://gamma.example/tasks' });
      expect(entry.card.name).toBe('gamma');
    });

    it('refuses an unsupported fealty version rather than silently negotiating', async () => {
      const oldCard = makeCard('delta', { ...VALID_FEALTY, version: '0' });
      const registry = new VassalRegistry(localCardFetch(oldCard));
      await expect(registry.register('https://delta.example/card', { taskUrl: 'https://delta.example/tasks' }))
        .rejects.toThrow(/unsupported fealty\.version '0'/);
    });

    it('refuses a card with no fealty oath (a guest is not a vassal)', async () => {
      const guest = makeCard('epsilon', undefined);
      const registry = new VassalRegistry(localCardFetch(guest));
      await expect(registry.register('https://epsilon.example/card', { taskUrl: 'https://epsilon.example/tasks' }))
        .rejects.toThrow(/no vassal fealty on card/);
    });
  });

  describe('fealty oath shape face', () => {
    it('flags each missing oath field dispatch would otherwise read', () => {
      expect(fealtyOathProblem({ ...VALID_FEALTY, dataRealms: undefined as unknown as never[] })).toMatch(/dataRealms/);
      expect(fealtyOathProblem({ ...VALID_FEALTY, dataPolicy: undefined as unknown as never })).toMatch(/dataPolicy/);
      expect(fealtyOathProblem({ ...VALID_FEALTY, escalationPolicy: undefined as unknown as never })).toMatch(/escalationPolicy/);
      expect(fealtyOathProblem(VALID_FEALTY)).toBeNull();
    });
  });

  describe('A2A tasks/send inbound face', () => {
    it('rejects a non-JSON-RPC tasks/send body as invalid_request (400)', async () => {
      app = await makeApp();
      const res = await app.inject({ method: 'POST', url: '/.well-known/agent-card.json', headers: TOKEN, payload: { method: 'other' } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_request');
    });

    it('refuses a caller card with an unsupported fealty version (403 + dual audit)', async () => {
      app = await makeApp();
      const oldCaller = makeCard('caller-old', { ...VALID_FEALTY, version: '0' });
      const res = await app.inject({
        method: 'POST',
        url: '/.well-known/agent-card.json',
        headers: { ...TOKEN, 'x-zeus-caller-card': JSON.stringify(oldCaller) },
        payload: { jsonrpc: '2.0', method: 'tasks/send', id: 1, params: {} },
      });
      expect(res.statusCode).toBe(403);
      expect(auditEntries.filter(e => e.decision === 'inbound-task-refused').length).toBe(1);
      expect(auditEntries.filter(e => e.decision === 'external-agent-refused').length).toBe(1);
    });
  });
});
