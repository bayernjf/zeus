import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHttpServer } from '../src/http/server.js';
import { ExecutorRegistry, type FetchLike } from '../src/registry/registry.js';
import { Ed25519MemorySigner } from '../src/registry/signing.js';
import { SkillRegistry } from '../src/skills/registry.js';
import type { Orchestrator } from '../src/orchestrator/orchestrator.js';
import type { FanOutRequest } from '../src/orchestrator/types.js';
import type { AgentCard, Handshake } from '../src/a2a/types.js';

/**
 * Z-05: the operator-runnable caller script must work against a real local
 * socket, not only against Fastify's in-process injector. This suite starts a
 * live Zeus HTTP server, writes the caller card to a temp file, and spawns
 * `scripts/acceptance-inbound-a2a.mjs` exactly as an operator would.
 */

const SCRIPT = fileURLToPath(new URL('../scripts/acceptance-inbound-a2a.mjs', import.meta.url));

const VALID_HANDSHAKE: Handshake = {
  version: '1',
  swornTo: 'zeus',
  domain: 'test-domain',
  dataDomains: ['personal'],
  dataPolicy: 'read-task-scope',
  reportBack: true,
  escalationPolicy: 'on-failure',
};

function makeCard(name: string): AgentCard {
  return {
    name,
    url: `https://${name}.example/`,
    skills: [],
    'x-zeus-handshake': VALID_HANDSHAKE,
  };
}

function fetchStub(card: AgentCard): FetchLike {
  return (async () => ({ ok: true, json: async () => card })) as unknown as FetchLike;
}

function makeOrchestrator(): Orchestrator {
  return {
    fanOut: async (request: FanOutRequest) => ({
      intentId: request.intentId ?? 'intent-script-1',
      runId: 'run-script-1',
      skill: request.skill,
      dataDomain: request.dataDomain,
      branches: [],
      stream: [],
      positions: [],
      decision: { rule: 'unanimous', conclusion: 'ok', positions: [], reason: 'stub' },
      conflicts: [],
      status: 'completed',
      createdAt: '2026-11-23T00:00:00.000Z',
    }),
    getIntent: async () => undefined,
  } as unknown as Orchestrator;
}

let app: FastifyInstance | undefined;
let dir: string | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function runScript(args: string[], env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: { ...env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('acceptance-inbound-a2a script timed out'));
    }, 10_000);
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));
    child.on('error', reject);
    child.on('close', status => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

describe('scripts/acceptance-inbound-a2a.mjs', () => {
  it('calls a live Zeus instance with a roster-anchored caller card', async () => {
    const card = makeCard('helper');
    const registry = new ExecutorRegistry(fetchStub(card));
    await registry.register('http://127.0.0.1:9/agent-card');

    const skills = new SkillRegistry();
    skills.register({
      id: 'summarize',
      name: 'summarize',
      description: 'read-only summarization',
      version: '1.0.0',
      tags: ['read-only'],
    });

    app = await createHttpServer({
      registry,
      signer: new Ed25519MemorySigner('zeus-rsk-script'),
      internalToken: 'operator-secret',
      orchestrator: makeOrchestrator(),
      skillRegistry: skills,
      agentCard: makeCard('zeus'),
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind a TCP port');
    const base = `http://127.0.0.1:${address.port}`;

    dir = mkdtempSync(join(tmpdir(), 'zeus-inbound-a2a-'));
    const cardPath = join(dir, 'caller-card.json');
    writeFileSync(cardPath, JSON.stringify(card));

    const result = await runScript([base, 'summarize'], {
      ...process.env,
      BASE_URL: base,
      TOKEN: 'operator-secret',
      CALLER_CARD_FILE: cardPath,
      SKILL: 'summarize',
    });

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Zeus agent card discovered/);
    expect(result.stdout).toMatch(/task accepted/);
    expect(result.stdout).toMatch(/PASS: inbound A2A caller "helper"/);
  });

  it('fails closed when the caller card file is missing', async () => {
    dir = mkdtempSync(join(tmpdir(), 'zeus-inbound-a2a-'));
    const result = await runScript(['http://127.0.0.1:9'], {
      ...process.env,
      BASE_URL: 'http://127.0.0.1:9',
      TOKEN: 'operator-secret',
      CALLER_CARD_FILE: join(dir, 'missing.json'),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/cannot read CALLER_CARD_FILE/);
  });
});
