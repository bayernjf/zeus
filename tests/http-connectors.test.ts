import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHttpServer, type DecisionStatus } from '../src/http/server.js';
import { VassalRegistry } from '../src/registry/registry.js';
import { Ed25519MemorySigner } from '../src/registry/signing.js';
import { ConnectorRegistry } from '../src/mcp/connectors.js';

const TOKEN = 'driver-secret';
const AUTH = { authorization: `Bearer ${TOKEN}` };
const CONNECTOR_TOKEN = 'upstream-bearer-secret';

/** Minimal streamable-HTTP MCP endpoint: initialize + the three discovery calls. */
let mcpUrl = '';
const mcpRequests: string[] = [];
let mcpServer: Server;

beforeAll(async () => {
  mcpServer = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => (raw += chunk));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as { method?: string; id?: number };
      if (body.method) mcpRequests.push(body.method);
      const reply = (result: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id ?? null, result }));
      };
      switch (body.method) {
        case 'initialize':
          return reply({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'kb' } });
        case 'tools/list':
          return reply({ tools: [{ name: 'search' }, { name: 'drop-table' }] });
        case 'resources/list':
          return reply({ resources: [{ uri: 'res://a', name: 'docs' }] });
        case 'prompts/list':
          return reply({ prompts: [{ name: 'brief' }] });
        default:
          res.writeHead(202);
          return res.end();
      }
    });
  });
  await new Promise<void>(resolve => mcpServer.listen(0, '127.0.0.1', resolve));
  mcpUrl = `http://127.0.0.1:${(mcpServer.address() as AddressInfo).port}/mcp`;
});

afterAll(() => mcpServer?.close());

async function server(): Promise<{ app: Awaited<ReturnType<typeof createHttpServer>>; connectors: ConnectorRegistry }> {
  const connectors = new ConnectorRegistry(() => new Date('2026-09-25T00:00:00.000Z'));
  const app = await createHttpServer({
    registry: new VassalRegistry(),
    signer: new Ed25519MemorySigner('zeus-rsk-test'),
    internalToken: TOKEN,
    connectorRegistry: connectors,
    decisionStatus: {
      configured: true,
      kind: 'llm',
      model: 'gpt-test',
      arbitration: { enabled: true },
      judge: { enabled: false },
    },
  });
  return { app, connectors };
}

function declarationBody(overrides: Record<string, unknown> = {}) {
  return {
    id: 'knowledge',
    name: 'Knowledge Base',
    endpoint: mcpUrl,
    permissions: ['mcp:search'],
    token: CONNECTOR_TOKEN,
    ...overrides,
  };
}

describe('E7 connector HTTP face', () => {
  let connectors: ConnectorRegistry;
  let app: Awaited<ReturnType<typeof createHttpServer>>;
  afterEach(async () => {
    await app?.close();
  });

  it('declares a connector and never echoes its token back', async () => {
    ({ app, connectors } = await server());
    const res = await app.inject({ method: 'POST', url: '/api/connectors', headers: AUTH, payload: declarationBody() });
    expect(res.statusCode).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ id: 'knowledge', status: 'declared', hasToken: true, permissions: ['mcp:search'] });
    expect(res.body).not.toContain(CONNECTOR_TOKEN);

    const list = await app.inject({ method: 'GET', url: '/api/connectors', headers: AUTH });
    expect(list.body).not.toContain(CONNECTOR_TOKEN);
    expect((await list.json()).connectors[0]).toMatchObject({ id: 'knowledge', hasToken: true });

    // the secret is still held where it belongs: in the kernel record
    expect(connectors.get('knowledge')?.token).toBe(CONNECTOR_TOKEN);
  });

  it('connects over the wire and reports only capabilities inside the boundary', async () => {
    ({ app } = await server());
    await app.inject({ method: 'POST', url: '/api/connectors', headers: AUTH, payload: declarationBody() });
    const res = await app.inject({
      method: 'POST', url: '/api/connectors/knowledge/connect', headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const record = await res.json();
    expect(record.status).toBe('connected');
    expect(record.capabilities.tools).toEqual(['search']);
    expect(record.capabilities.resources).toEqual(['docs']);
    expect(record.capabilities.prompts).toEqual(['brief']);
    expect(mcpRequests).toContain('initialize');
    expect(mcpRequests).toContain('tools/list');
  });

  it('keeps every declared tool when the boundary is bare mcp', async () => {
    ({ app } = await server());
    await app.inject({
      method: 'POST', url: '/api/connectors', headers: AUTH,
      payload: declarationBody({ permissions: ['mcp'] }),
    });
    const record = await (await app.inject({
      method: 'POST', url: '/api/connectors/knowledge/connect', headers: AUTH,
    })).json();
    expect(record.capabilities.tools).toEqual(['search', 'drop-table']);
  });

  it('reports a refused handshake as a bad gateway, not a bad request', async () => {
    ({ app } = await server());
    await app.inject({
      method: 'POST', url: '/api/connectors', headers: AUTH,
      payload: declarationBody({ endpoint: 'http://127.0.0.1:1/mcp' }),
    });
    const res = await app.inject({
      method: 'POST', url: '/api/connectors/knowledge/connect', headers: AUTH,
    });
    expect(res.statusCode).toBe(502);
    expect((await res.json()).error).toBe('bad_gateway');
  });

  it('revokes a connector and it leaves the active set', async () => {
    ({ app, connectors } = await server());
    await app.inject({ method: 'POST', url: '/api/connectors', headers: AUTH, payload: declarationBody() });
    const res = await app.inject({ method: 'DELETE', url: '/api/connectors/knowledge', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect((await res.json()).status).toBe('revoked');

    const after = await app.inject({ method: 'GET', url: '/api/connectors?status=revoked', headers: AUTH });
    expect((await after.json()).connectors).toHaveLength(1);
    const connectAgain = await app.inject({
      method: 'POST', url: '/api/connectors/knowledge/connect', headers: AUTH,
    });
    expect(connectAgain.statusCode).toBe(409);
  });

  it('validates the declaration and the route ids', async () => {
    ({ app } = await server());
    const noEndpoint = await app.inject({
      method: 'POST', url: '/api/connectors', headers: AUTH,
      payload: { id: 'x', name: 'X', permissions: ['mcp'] },
    });
    expect(noEndpoint.statusCode).toBe(400);

    const badScope = await app.inject({
      method: 'POST', url: '/api/connectors', headers: AUTH,
      payload: declarationBody({ permissions: ['sudo'] }),
    });
    expect(badScope.statusCode).toBe(400);
    expect((await badScope.json()).detail).toContain('unknown permission scope');

    await app.inject({ method: 'POST', url: '/api/connectors', headers: AUTH, payload: declarationBody() });
    const dup = await app.inject({
      method: 'POST', url: '/api/connectors', headers: AUTH, payload: declarationBody(),
    });
    expect(dup.statusCode).toBe(409);

    const missing = await app.inject({ method: 'GET', url: '/api/connectors/nope', headers: AUTH });
    expect(missing.statusCode).toBe(404);
    const connectMissing = await app.inject({
      method: 'POST', url: '/api/connectors/nope/connect', headers: AUTH,
    });
    expect(connectMissing.statusCode).toBe(404);
    const badStatus = await app.inject({ method: 'GET', url: '/api/connectors?status=paused', headers: AUTH });
    expect(badStatus.statusCode).toBe(400);
  });

  it('requires a bearer token', async () => {
    ({ app } = await server());
    expect((await app.inject({ method: 'GET', url: '/api/connectors' })).statusCode).toBe(401);
  });
});

describe('decision status HTTP face', () => {
  let app: Awaited<ReturnType<typeof createHttpServer>>;
  afterEach(async () => {
    await app?.close();
  });

  it('reports the decision layer the process resolved at boot', async () => {
    ({ app } = await server());
    const res = await app.inject({ method: 'GET', url: '/api/decision', headers: AUTH });
    expect(res.statusCode).toBe(200);
    const status: DecisionStatus = await res.json();
    expect(status).toEqual({
      configured: true,
      kind: 'llm',
      model: 'gpt-test',
      arbitration: { enabled: true },
      judge: { enabled: false },
    });
  });

  it('is not mounted when the process reports nothing', async () => {
    app = await createHttpServer({
      registry: new VassalRegistry(),
      signer: new Ed25519MemorySigner('zeus-rsk-test'),
      internalToken: TOKEN,
    });
    const res = await app.inject({ method: 'GET', url: '/api/decision', headers: AUTH });
    expect(res.statusCode).toBe(404);
  });
});
