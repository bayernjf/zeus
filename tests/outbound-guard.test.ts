import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { assertOutboundUrlAllowed, OutboundUrlError } from '../src/util/outbound-url.js';
import { VassalRegistry } from '../src/registry/registry.js';
import { ConnectorRegistry } from '../src/mcp/connectors.js';
import { createHttpServer } from '../src/http/server.js';
import { Ed25519MemorySigner } from '../src/registry/signing.js';

const AUTH = { authorization: 'Bearer driver-secret' };
const NO_ALLOW: readonly string[] = [];

describe('A-12 outbound URL guard', () => {
  describe('refuses a target that is not globally reachable', () => {
    const blocked: Array<[string, string]> = [
      ['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
      ['RFC1918 10/8', 'http://10.0.0.1/card.json'],
      ['RFC1918 172.16/12', 'http://172.16.0.1/'],
      ['RFC1918 192.168/16', 'http://192.168.1.1/'],
      ['CGNAT 100.64/10', 'http://100.64.0.1/'],
      ['this-network 0/8', 'http://0.0.0.0/'],
      ['benchmark 198.18/15', 'http://198.18.0.1/'],
      ['multicast 224/4', 'http://224.0.0.1/'],
      ['reserved 240/4', 'http://240.0.0.1/'],
      ['IPv6 unique-local', 'http://[fd00::1]/'],
      ['IPv6 link-local', 'http://[fe80::1]/'],
      ['IPv6 multicast', 'http://[ff02::1]/'],
      ['IPv6 unspecified', 'http://[::]/'],
      ['IPv4-mapped private', 'http://[::ffff:10.0.0.1]/'],
      ['IPv4-compatible private', 'http://[::10.0.0.1]/'],
    ];
    it.each(blocked)('refuses %s (%s)', (_label, url) => {
      expect(() => assertOutboundUrlAllowed(url, NO_ALLOW)).toThrow(OutboundUrlError);
    });
  });

  describe('allows targets the local-first kernel must still reach', () => {
    const allowed: Array<[string, string]> = [
      ['loopback IPv4', 'http://127.0.0.1:8787/api/a2a/card.json'],
      ['loopback IPv6', 'http://[::1]:8787/api/a2a/card.json'],
      ['a hostname', 'https://loom.example/api/a2a/agent-card'],
      ['a globally reachable address', 'https://93.184.216.34/card.json'],
    ];
    it.each(allowed)('allows %s (%s)', (_label, url) => {
      expect(() => assertOutboundUrlAllowed(url, NO_ALLOW)).not.toThrow();
    });
  });

  it('refuses a URL that is not http(s), and one that is not absolute', () => {
    expect(() => assertOutboundUrlAllowed('file:///etc/passwd', NO_ALLOW)).toThrow(OutboundUrlError);
    expect(() => assertOutboundUrlAllowed('ftp://loom.example/card', NO_ALLOW)).toThrow(OutboundUrlError);
    expect(() => assertOutboundUrlAllowed('/card.json', NO_ALLOW)).toThrow(OutboundUrlError);
  });

  it('lets an operator re-open a private host through the allowlist', () => {
    expect(() => assertOutboundUrlAllowed('http://10.0.0.5/card.json', ['10.0.0.5'])).not.toThrow();
    // only the named host is re-opened, not the whole block
    expect(() => assertOutboundUrlAllowed('http://10.0.0.6/card.json', ['10.0.0.5'])).toThrow(OutboundUrlError);
  });

  it('reads the allowlist from ZEUS_OUTBOUND_ALLOW_HOSTS', () => {
    const previous = process.env.ZEUS_OUTBOUND_ALLOW_HOSTS;
    process.env.ZEUS_OUTBOUND_ALLOW_HOSTS = '169.254.169.254';
    try {
      expect(() => assertOutboundUrlAllowed('http://169.254.169.254/latest/meta-data/')).not.toThrow();
    } finally {
      if (previous === undefined) delete process.env.ZEUS_OUTBOUND_ALLOW_HOSTS;
      else process.env.ZEUS_OUTBOUND_ALLOW_HOSTS = previous;
    }
  });
});

const card = {
  name: 'loom',
  url: 'https://loom.example/api/a2a/tasks',
  version: '0.1.0',
  provider: { organization: 'acme' },
  capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: true },
  defaultInputModes: ['application/json'],
  defaultOutputModes: ['application/json'],
  skills: [],
  authentication: { schemes: ['bearer'] },
  preferredTransport: 'JSONRPC',
  'x-zeus-fealty': {
    version: '1',
    swornTo: 'zeus',
    domain: 'acme',
    dataRealms: ['personal'],
    dataPolicy: 'none',
    reportBack: true,
    escalationPolicy: 'auto',
  },
};

const cardFetch = (async () =>
  new Response(JSON.stringify(card), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

describe('A-12 the guard covers every outbound face', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('refuses a private agent-card URL at the registry boundary', async () => {
    const registry = new VassalRegistry();
    await expect(registry.register('http://169.254.169.254/agent-card')).rejects.toThrow(OutboundUrlError);
  });

  it('refuses a taskUrl override that points at a private host', async () => {
    const registry = new VassalRegistry(cardFetch);
    await expect(
      registry.register('https://loom.example/card.json', { taskUrl: 'http://10.0.0.5/api/a2a/tasks' }),
    ).rejects.toThrow(OutboundUrlError);
  });

  it('refuses a private MCP endpoint at declare time', () => {
    const connectors = new ConnectorRegistry();
    expect(() =>
      connectors.declare({ id: 'meta', name: 'Metadata', endpoint: 'http://192.168.0.10/mcp', permissions: ['mcp'] }),
    ).toThrow(OutboundUrlError);
  });

  it('refuses a private MCP endpoint restored from a snapshot', async () => {
    const connectors = new ConnectorRegistry();
    connectors.importState([
      {
        id: 'meta',
        name: 'Metadata',
        endpoint: 'http://169.254.169.254/mcp',
        permissions: ['mcp'],
        status: 'declared',
        declaredAt: '2026-09-25T00:00:00.000Z',
      },
    ]);
    await expect(connectors.connect('meta')).rejects.toThrow(OutboundUrlError);
  });

  it('answers POST /api/vassals with 400 for a private cardUrl', async () => {
    ({ app } = await face());
    const res = await app.inject({
      method: 'POST',
      url: '/api/vassals',
      headers: AUTH,
      payload: { cardUrl: 'http://169.254.169.254/agent-card' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('non-public');
  });

  it('answers POST /api/connectors with 400 for a private endpoint', async () => {
    ({ app } = await face());
    const res = await app.inject({
      method: 'POST',
      url: '/api/connectors',
      headers: AUTH,
      payload: { id: 'meta', name: 'Metadata', endpoint: 'http://169.254.169.254/mcp', permissions: ['mcp'] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('non-public');
  });
});

async function face(): Promise<{ app: FastifyInstance }> {
  const app = await createHttpServer({
    registry: new VassalRegistry(),
    signer: new Ed25519MemorySigner('zeus-rsk-test'),
    internalToken: 'driver-secret',
    connectorRegistry: new ConnectorRegistry(() => new Date('2026-09-25T00:00:00.000Z')),
    decisionStatus: {
      configured: true,
      kind: 'llm',
      model: 'gpt-test',
      arbitration: { enabled: true },
      judge: { enabled: false },
    },
  });
  return { app };
}
