import { describe, expect, it, vi } from 'vitest';
import { createDeck, type RunnerIo } from '../src/tui/runner.js';
import type { DeckClient, DeckSnapshot } from '../src/tui/client.js';

const baseSnapshot: DeckSnapshot = {
  audit: [],
  domains: {
    realms: [
      { realmId: 'realm-personal-1', type: 'personal', readOnly: false, itemCount: 2, contentDigest: 'sha256:p' },
      { realmId: 'realm-acme-1', type: 'enterprise', tenant: { org: 'acme' }, readOnly: true, itemCount: 4, contentDigest: 'sha256:e' },
    ],
    grants: [
      { grantId: 'grant-1', subject: 'loom', realmId: 'realm-acme-1', access: 'read', grantedBy: 'operator', grantedAt: '', nonce: 'n-1' },
    ],
  },
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
    issueGrant: vi.fn(async () => ({ grantId: 'grant-new' })),
    revokeGrant: vi.fn(async () => undefined),
    recognize: vi.fn(async () => ({ ok: true, skill: 'deployment-health', confidence: 0.5, backend: null, decisionAt: '' })),
  } as unknown as DeckClient;
  const deck = createDeck({ client, io, locale: 'en', color: false });
  return { io, client: client as unknown as { approve: ReturnType<typeof vi.fn>; reject: ReturnType<typeof vi.fn>; resolve: ReturnType<typeof vi.fn>; revoke: ReturnType<typeof vi.fn>; issueGrant: ReturnType<typeof vi.fn>; revokeGrant: ReturnType<typeof vi.fn>; recognize: ReturnType<typeof vi.fn>; snapshot: ReturnType<typeof vi.fn> }, deck, printed };
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

  it('issues a cross-domain grant on an enterprise realm only after y', async () => {
    const { client, deck } = makeHarness(['y']);
    await deck.refresh();
    await deck.handle('g2 loom r');
    expect(client.issueGrant).toHaveBeenCalledWith({
      subject: 'loom',
      realmId: 'realm-acme-1',
      access: 'read',
      grantedBy: 'operator',
    });
  });

  it('does not issue a grant against a personal realm and never calls the API', async () => {
    const { client, deck, printed } = makeHarness(['y']);
    await deck.refresh();
    await deck.handle('g1 loom r');
    expect(client.issueGrant).not.toHaveBeenCalled();
    expect(printed.join('')).toContain('enterprise realms only');
  });

  it('does not issue when the confirm is declined', async () => {
    const { client, deck } = makeHarness(['n']);
    await deck.refresh();
    await deck.handle('g2 loom w alice');
    expect(client.issueGrant).not.toHaveBeenCalled();
  });

  it('revokes a grant by its ledger index only after y', async () => {
    const { client, deck } = makeHarness(['y']);
    await deck.refresh();
    await deck.handle('k1');
    expect(client.revokeGrant).toHaveBeenCalledWith('grant-1');
  });

  it('keeps machine identifiers case-sensitive in grant issuance', async () => {
    const { client, deck } = makeHarness(['y']);
    await deck.refresh();
    await deck.handle('g2 Pr-Helper r Operator-X');
    expect(client.issueGrant).toHaveBeenCalledWith({
      subject: 'Pr-Helper',
      realmId: 'realm-acme-1',
      access: 'read',
      grantedBy: 'Operator-X',
    });
  });
describe('TUI controller intent recognition (E2.6)', () => {
  it('recognizes locally without a confirm gate and prints the plan-only view', async () => {
    const h = makeHarness([]);
    h.client.recognize.mockResolvedValueOnce({ ok: true, skill: 'deployment-health', confidence: 0.5, backend: null, decisionAt: '' });
    await h.deck.handle('i review the pr');
    expect(h.client.recognize).toHaveBeenCalledWith('review the pr', { useModel: false });
    expect(h.printed.join('\n')).toContain('→ skill deployment-health');
    expect(h.printed.join('\n')).toContain('(local rules, zero egress)');
  });

  it('forwards the model opt-in to the backend and prints the model label', async () => {
    const h = makeHarness([]);
    h.client.recognize.mockResolvedValueOnce({ ok: true, skill: 'research', confidence: 0.82, backend: { kind: 'llm', model: 'agnes-2.5-flash' }, decisionAt: '' });
    await h.deck.handle('im research postgres vs sqlite');
    expect(h.client.recognize).toHaveBeenCalledWith('research postgres vs sqlite', { useModel: true });
    expect(h.printed.join('\n')).toContain('(llm agnes-2.5-flash)');
  });

  it('prints the fail-closed reason verbatim, never a guess', async () => {
    const h = makeHarness([]);
    h.client.recognize.mockResolvedValueOnce({ ok: false, reason: 'ambiguous' });
    await h.deck.handle('i 复盘');
    expect(h.printed.join('\n')).toContain('not recognized: ambiguous');
    expect(h.printed.join('\n')).not.toContain('→ skill');
  });

  it('surfaces a client failure without crashing the loop', async () => {
    const h = makeHarness([]);
    h.client.recognize.mockRejectedValueOnce(new Error('boom'));
    await expect(h.deck.handle('i x')).resolves.toBe(true);
    expect(h.printed.join('\n')).toContain('boom');
  });
});

});
