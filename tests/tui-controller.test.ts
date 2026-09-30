import { describe, expect, it, vi } from 'vitest';
import { createDeck, type RunnerIo } from '../src/tui/runner.js';
import type { DeckClient, DeckSnapshot } from '../src/tui/client.js';

const baseSnapshot: DeckSnapshot = {
  audit: [],
  domains: null,
  roster: {
    generatedAt: '',
    entries: [
      { name: 'pr-helper', status: 'active', health: 'healthy', skills: [{ id: 'deployment-health' }] },
      { name: 'loom', status: 'active', health: 'healthy', skills: [{ id: 'research' }] },
    ],
  },
  escalations: [
    {
      id: 'esc-1',
      kind: 'task-input',
      vassal: 'pr-helper',
      skill: 'deployment-health',
      realm: 'personal',
      reason: 'missing owner, repo',
      status: 'pending',
      options: ['go', 'skip'],
      createdAt: '',
    },
    {
      id: 'esc-2',
      kind: 'intent-conflict',
      vassal: '(intent)',
      skill: 'pick-db',
      realm: 'personal',
      reason: 'split',
      status: 'pending',
      options: [],
      createdAt: '',
      stances: [
        { stance: 'postgres', vassals: ['a'] },
        { stance: 'sqlite', vassals: ['b'] },
      ],
    },
  ],
  metrics: null,
  state: null,
};

function makeHarness(answers: string[]) {
  const printed: string[] = [];
  let snapshotCalls = 0;
  const io: RunnerIo = {
    print: text => printed.push(text),
    question: vi.fn(async () => answers.shift() ?? 'n'),
    now: () => new Date('2026-09-30T00:00:00.000Z'),
  };
  const client = {
    snapshot: vi.fn(async () => {
      snapshotCalls += 1;
      return baseSnapshot;
    }),
    approve: vi.fn(async () => undefined),
    reject: vi.fn(async () => undefined),
    resolve: vi.fn(async () => undefined),
    revoke: vi.fn(async () => undefined),
  } as unknown as DeckClient;
  const deck = createDeck({ client, io, locale: 'en', color: false });
  return { io, client: client as unknown as { approve: ReturnType<typeof vi.fn>; reject: ReturnType<typeof vi.fn>; resolve: ReturnType<typeof vi.fn>; revoke: ReturnType<typeof vi.fn>; snapshot: ReturnType<typeof vi.fn> }, deck, printed };
}

describe('TUI controller writes go through the API with a confirm gate', () => {
  it('renders on refresh without prompting', async () => {
    const { io, deck, printed } = makeHarness([]);
    await deck.refresh();
    expect(io.question).not.toHaveBeenCalled();
    expect(printed.join('')).toContain('Zeus supervision deck');
  });

  it('approves escalation #1 only after y and re-renders', async () => {
    const { client, deck } = makeHarness(['y']);
    await deck.refresh();
    const keepGoing = await deck.handle('a1');
    expect(keepGoing).toBe(true);
    expect(client.approve).toHaveBeenCalledWith('esc-1');
    expect(client.reject).not.toHaveBeenCalled();
  });

  it('does not write when the confirm is declined', async () => {
    const { client, deck } = makeHarness(['n']);
    await deck.refresh();
    await deck.handle('x1');
    expect(client.reject).not.toHaveBeenCalled();
  });

  it('resolves an intent-conflict by stance text, not index', async () => {
    const { client, deck } = makeHarness(['y']);
    await deck.refresh();
    await deck.handle('s2.1');
    expect(client.resolve).toHaveBeenCalledWith('esc-2', 'postgres');
  });

  it('revokes the roster entry by name after confirm', async () => {
    const { client, deck } = makeHarness(['y']);
    await deck.refresh();
    await deck.handle('d1');
    expect(client.revoke).toHaveBeenCalledWith('pr-helper');
  });

  it('quits on q and prints help for an unknown command', async () => {
    const h = makeHarness([]);
    await h.deck.refresh();
    expect(await h.deck.handle('q')).toBe(false);
    expect(await h.deck.handle('zzz')).toBe(true);
    expect(h.printed.join('')).toContain('approve');
  });
});
