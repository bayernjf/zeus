import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../scripts/acceptance-standard-a2a.mjs', import.meta.url));

function startServer(handler: (req: any, body: any, res: any) => void): Promise<{ server: Server; url: string }> {
  return new Promise(resolve => {
    const server = createServer((req, res) => {
      if (req.method === 'POST') {
        let raw = '';
        req.on('data', chunk => (raw += chunk));
        req.on('end', () => handler(req, JSON.parse(raw || '{}'), res));
      } else {
        handler(req, null, res);
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function json(res: any, status: number, payload: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

// Async spawn: spawnSync would block the event loop and deadlock the in-process mock server.
function runScript(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: { ...env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('acceptance script timed out'));
    }, 10000);
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));
    child.on('error', reject);
    child.on('close', status => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

// Minimal faithful pr-helper shape (api/_lib/agent-card.ts + api/_lib/a2a/rpc.ts):
// card carries x-zeus-fealty (the script must not need it), tasks/send accepts a
// text part whose first token is the skill id, and tasks include a history array.
function healthyHandler(req: any, body: any, res: any) {
  if (req.url === '/api/a2a/agent-card') {
    return json(res, 200, {
      name: 'pr-helper',
      url: 'http://127.0.0.1/api/a2a/tasks',
      version: '0.1.0',
      provider: { organization: 'bayjf', url: 'https://github.com/jiangfeng' },
      capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: true },
      defaultInputModes: ['application/json'],
      defaultOutputModes: ['application/json'],
      skills: [
        { id: 'deployment-health', name: 'Track deployments and run health checks', description: '', tags: ['health'] },
      ],
      authentication: { schemes: ['bearer'] },
      preferredTransport: 'JSONRPC',
      'x-zeus-fealty': { version: '1', swornTo: 'zeus', domain: 'pr-release-control' },
    });
  }
  if (req.url === '/api/a2a/tasks') {
    const skill = body?.params?.message?.parts?.[0]?.text?.trim().split(/\s+/)[0];
    if (skill !== 'deployment-health') {
      return json(res, 200, { jsonrpc: '2.0', id: body.id, error: { code: -32602, message: 'unknown skill' } });
    }
    return json(res, 200, {
      jsonrpc: '2.0',
      id: body.id,
      result: {
        kind: 'task',
        id: 'task-mock-1',
        contextId: 'ctx-mock-1',
        history: [],
        status: { state: 'completed' },
        artifacts: [],
      },
    });
  }
  json(res, 404, { message: 'not found' });
}

function brokenHandler(_req: any, _body: any, res: any) {
  json(res, 500, { message: 'boom' });
}

// These tests spawn a real node subprocess; under full parallel load cold start
// can exceed vitest's default 5s timeout. Give headroom above the script's own 10s guard.
describe('acceptance #6 standards-only client script', { timeout: 20000 }, () => {
  let healthy: { server: Server; url: string };
  let broken: { server: Server; url: string };

  beforeAll(async () => {
    healthy = await startServer(healthyHandler);
    broken = await startServer(brokenHandler);
  });

  afterAll(() => {
    healthy.server.close();
    broken.server.close();
  });

  it('exits 0 and passes against a standard A2A endpoint without touching x-zeus-*', async () => {
    const run = await runScript([healthy.url]);
    expect(run.status, `stderr: ${run.stderr}\nstdout: ${run.stdout}`).toBe(0);
    expect(run.stdout).toContain('agent card discovered: "pr-helper"');
    expect(run.stdout).toContain('state=completed');
    expect(run.stdout).toContain('PASS: acceptance #6');
  });

  it('exits 1 with diagnostics when the card endpoint is down', async () => {
    const run = await runScript([broken.url]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('[FAIL]');
  });

  it('exits 1 when BASE_URL is not provided', async () => {
    const run = await runScript([], { PATH: process.env.PATH, HOME: process.env.HOME });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('BASE_URL is required');
  });
});
