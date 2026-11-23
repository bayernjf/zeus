import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHttpServer } from '../src/http/server.js';
import {
  ExecutorRegistry,
  type FetchLike,
} from '../src/registry/registry.js';
import {
  Ed25519MemorySigner,
  type RosterSigner,
} from '../src/registry/signing.js';
import { SkillRegistry } from '../src/skills/registry.js';
import type { Orchestrator } from '../src/orchestrator/orchestrator.js';
import type { FanOutRequest, FanOutResult } from '../src/orchestrator/types.js';
import type { AgentCard, Handshake } from '../src/a2a/types.js';
import type { AuditEntry } from '../src/dispatch/dispatcher.js';

/**
 * Z-05: a real local/内网 upstream A2A caller.
 *
 * The existing `http-inbound-a2a.test.ts` uses Fastify `inject()`, which proves
 * the route contract but never opens a socket. The missing evidence for Z-05 is
 * exactly the transport boundary: a local caller process/agent sends a real
 * HTTP `tasks/send` and the Rust/RPC face still lands on the intent surface with
 * the right roster-derived tier. This suite binds the server on 127.0.0.1:0 and
 * calls it with the global `fetch`, so the caller is an actual HTTP peer.
 *
 * Scope is deliberately the local/intranet caller; public A2A remains out of
 * scope (docs/review-2026-11-23-original-gap.md Z-05).
 */

let app: FastifyInstance | undefined;
let auditEntries: AuditEntry[] = [];
let lastFanOutRequest: FanOutRequest | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  auditEntries = [];
  lastFanOutRequest = undefined;
});

const VALID_HANDSHAKE: Handshake = {
  version: '1',
  swornTo: 'zeus',
  domain: 'test-domain',
  dataDomains: ['personal'],
  dataPolicy: 'read-task-scope',
  reportBack: true,
  escalationPolicy: 'on-failure',
};

function makeCard(name: string, description?: string): AgentCard {
  return {
    name,
    url: `https://${name}.example/`,
    ...(description ? { description } : {}),
    skills: [],
    'x-zeus-handshake': VALID_HANDSHAKE,
  };
}

function fetchStub(card: AgentCard): FetchLike {
  return (async () => ({ ok: true, json: async () => card })) as unknown as FetchLike;
}

function makeOrchestrator(): Orchestrator {
  return {
    fanOut: async (request: FanOutRequest): Promise<FanOutResult> => {
      lastFanOutRequest = request;
      return {
        intentId: request.intentId ?? 'intent-live-1',
        runId: 'run-live-1',
        skill: request.skill,
        dataDomain: request.dataDomain,
        branches: [],
        stream: [],
        positions: [],
        decision: { rule: 'unanimous', conclusion: 'ok', positions: [], reason: 'stub' },
        conflicts: [],
        status: 'completed',
        createdAt: '2026-11-23T00:00:00.000Z',
      };
    },
    getIntent: async () => undefined,
  } as unknown as Orchestrator;
}

function makeSkillRegistry(): SkillRegistry {
  const skills = new SkillRegistry();
  skills.register({
    id: 'summarize',
    name: 'summarize',
    description: 'read-only summarization',
    version: '1.0.0',
    tags: ['read-only'],
  });
  return skills;
}

async function listen(signer: RosterSigner = new Ed25519MemorySigner('zeus-rsk-live')): Promise<string> {
  app = await createHttpServer({
    registry: await makeRegistry(),
    signer,
    internalToken: 'operator-secret',
    orchestrator: makeOrchestrator(),
    skillRegistry: makeSkillRegistry(),
    agentCard: makeCard('zeus'),
    inboundAudit: entry => auditEntries.push(entry),
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind a TCP port');
  return `http://127.0.0.1:${address.port}`;
}

async function makeRegistry(): Promise<ExecutorRegistry> {
  const registry = new ExecutorRegistry(fetchStub(makeCard('helper')));
  await registry.register('http://127.0.0.1:9/agent-card');
  return registry;
}

type SendOptions = {
  card?: AgentCard;
  skill?: string;
  taskId?: string;
};

async function send(base: string, options: SendOptions = {}) {
  const headers: Record<string, string> = {
    Authorization: 'Bearer operator-secret',
    'Content-Type': 'application/json',
  };
  if (options.card) headers['x-zeus-caller-card'] = JSON.stringify(options.card);
  return fetch(`${base}/.well-known/agent-card.json`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tasks/send',
      params: {
        taskId: options.taskId ?? 'caller-task-live',
        message: 'summarize the diary',
        skills: [options.skill ?? 'summarize'],
      },
    }),
  });
}

describe('Z-05 live inbound A2A caller', () => {
  it('accepts a registered caller card on tier-3 over a real socket', async () => {
    const base = await listen();
    const res = await send(base, { card: makeCard('helper') });
    expect(res.status).toBe(200);
    const task = (await res.json()) as { kind?: string; id?: string };
    expect(task.kind).toBe('task');
    expect(task.id).toBe('caller-task-live');

    expect(
      auditEntries.some(
        entry =>
          entry.decision === 'external-agent-admitted' &&
          entry.executor === 'helper' &&
          entry.tier === 'tier-3',
      ),
    ).toBe(true);
    expect(
      auditEntries.some(
        entry =>
          entry.decision === 'inbound-task-accepted' &&
          entry.executor === 'helper' &&
          entry.taskId === 'caller-task-live',
      ),
    ).toBe(true);
    // Roster-anchored names survive into memory/dispatch, not `unverified:`.
    expect(lastFanOutRequest?.params.a2aCaller).toBe('helper');
  });

  it('admits an unknown but handshake-shaped caller on tier-1 with an untrusted name', async () => {
    const base = await listen();
    const res = await send(base, { card: makeCard('rogue') });
    expect(res.status).toBe(200);
    expect(
      auditEntries.some(
        entry =>
          entry.decision === 'external-agent-admitted' &&
          entry.executor === 'unverified:rogue' &&
          entry.tier === 'tier-1',
      ),
    ).toBe(true);
    // tier-1 is pinned to plan mode and a read-only skill; the name is not an identity.
    expect(lastFanOutRequest?.mode).toBe('plan');
    expect(lastFanOutRequest?.params.a2aCaller).toBe('unverified:rogue');
  });

  it('falls back to tier-2 when the registered card content does not match the roster anchor', async () => {
    const base = await listen();
    const res = await send(base, { card: makeCard('helper', 'not the anchored card') });
    expect(res.status).toBe(200);
    expect(
      auditEntries.some(
        entry =>
          entry.decision === 'external-agent-admitted' &&
          entry.executor === 'helper' &&
          entry.tier === 'tier-2',
      ),
    ).toBe(true);
    expect(lastFanOutRequest?.params.a2aCaller).toBe('helper');
  });

  it('never grants tier-3 when the signer cannot export a public key (fail-closed)', async () => {
    const kmsLike: RosterSigner = {
      keyId: 'kms-key',
      sign: async () => 'unreachable',
    };
    const base = await listen(kmsLike);
    const res = await send(base, { card: makeCard('helper') });
    expect(res.status).toBe(200);
    // Registered name survives at tier-2; the exact card is NOT anchored.
    expect(
      auditEntries.some(
        entry =>
          entry.decision === 'external-agent-admitted' &&
          entry.executor === 'helper' &&
          entry.tier === 'tier-2',
      ),
    ).toBe(true);
    expect(auditEntries.some(entry => entry.tier === 'tier-3')).toBe(false);
  });

  it('refuses a malformed caller handshake before dispatch over a real socket', async () => {
    const base = await listen();
    const bad: AgentCard = {
      ...makeCard('rogue'),
      'x-zeus-handshake': { ...VALID_HANDSHAKE, swornTo: 'other' },
    };
    const res = await send(base, { card: bad });
    expect(res.status).toBe(403);
    expect(
      auditEntries.some(
        entry =>
          entry.decision === 'external-agent-refused' &&
          entry.executor === 'rogue' &&
          entry.tier === 'tier-0',
      ),
    ).toBe(true);
    expect(
      auditEntries.some(
        entry =>
          entry.decision === 'inbound-task-refused' &&
          entry.executor === 'rogue',
      ),
    ).toBe(true);
    expect(lastFanOutRequest).toBeUndefined();
  });
});
