import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startExampleAgent, type ExampleAgentHandle } from '../src/a2a/example-agent.js';

/**
 * E4.12: the reference execution agent is what makes the loop demonstrable for a
 * reader who has nothing but a directory. It is a shipped entry, so its contract
 * is pinned here the way any other peer's would be: the card the registry accepts,
 * the two task faces dispatch uses, and the boundaries the module promises.
 */

let handle: ExampleAgentHandle;

beforeAll(async () => {
  handle = await startExampleAgent({ port: 0 });
});

afterAll(async () => {
  await handle.close();
});

async function rpc(method: string, params: unknown, accept?: string) {
  const response = await fetch(`${handle.cardUrl.replace('/agent-card', '/tasks')}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(accept ? { accept } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { status: response.status, type: response.headers.get('content-type') ?? '', text: await response.text() };
}

describe('reference execution agent (E4.12)', () => {
  it('serves a card the registry can validate: fealty complete, one skill declared', async () => {
    const card = await (await fetch(handle.cardUrl)).json();
    expect(card.name).toBe('example-agent');
    expect(card.skills).toEqual([expect.objectContaining({ id: 'research', name: 'Reference Report' })]);
    // Every field the registration boundary requires; a missing one is refused at
    // registration and used to crash at dispatch (Active work 44).
    expect(card['x-zeus-fealty']).toEqual({
      version: '1',
      swornTo: 'zeus',
      domain: 'reference',
      dataRealms: ['personal'],
      dataPolicy: 'read-task-scope',
      reportBack: true,
      escalationPolicy: 'on-failure',
    });
    expect(card.url).toBe(handle.cardUrl.replace('/agent-card', '/tasks'));
  });

  it('answers tasks/send with the report-back contract and no invented answer', async () => {
    const res = await rpc('tasks/send', { message: { parts: [{ kind: 'text', text: 'summarize the note' }] } });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.text);
    expect(body.result.kind).toBe('task');
    expect(body.result.status.state).toBe('completed');
    const artifact = body.result.artifacts[0];
    expect(artifact['x-zeus-report']).toEqual(expect.objectContaining({ summary: expect.any(String), evidence: expect.any(Array) }));
    expect(artifact.parts[0].text).toContain('summarize the note');
    // Restatement, not knowledge: the agent has no basis to conclude anything.
    expect(JSON.stringify(artifact)).not.toContain('stance');
  });

  it('streams a final task snapshot for tasks/sendSubscribe', async () => {
    const res = await rpc('tasks/sendSubscribe', { message: { parts: [{ kind: 'data', data: { prompt: 'check scope' } }] } }, 'text/event-stream');
    expect(res.type).toContain('text/event-stream');
    const frames = res.text.split('\n\n').filter(Boolean).map(frame => JSON.parse(frame.replace(/^data: /, '')));
    expect(frames[0].result.kind).toBe('status-update');
    // Dispatch refuses a stream with no terminal snapshot, so the last frame must
    // carry the task itself.
    expect(frames.at(-1).result.kind).toBe('task');
    expect(frames.at(-1).result.status.state).toBe('completed');
  });

  it('reports a task with no content as a gap instead of inventing one', async () => {
    const res = await rpc('tasks/send', { message: { parts: [] } });
    const artifact = JSON.parse(res.text).result.artifacts[0];
    expect(artifact['x-zeus-report'].followUps.length).toBeGreaterThan(0);
    expect(artifact.parts[0].text).toContain('(empty)');
  });

  it('keeps its two stated boundaries at the module level: no filesystem, no egress', () => {
    const source = readFileSync(join('src', 'a2a', 'example-agent.ts'), 'utf8');
    // The claims are "answers from the task input only" and "no outbound request".
    // Pinning them on the import list is what makes them checkable: adding a
    // realm read or a fetch to this peer would silently break both.
    expect(source).not.toMatch(/from 'node:fs'/);
    expect(source).not.toMatch(/\bfetch\(/);
    expect(source).toMatch(/from 'node:http'/);
  });

  it('counts the tasks it served', async () => {
    const before = handle.requests;
    await rpc('tasks/send', { message: { parts: [{ kind: 'text', text: 'one more' }] } });
    expect(handle.requests).toBe(before + 1);
  });
});
