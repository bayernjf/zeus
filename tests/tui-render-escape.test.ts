import { describe, expect, it } from 'vitest';
import { makeTranslator, safeText } from '../src/tui/format.js';
import { makePalette } from '../src/tui/tokens.js';
import { renderDeck, renderRecognize } from '../src/tui/render.js';
import { createDeck } from '../src/tui/runner.js';
import type { DeckClient, DeckSnapshot } from '../src/tui/client.js';

/**
 * Governance-surface injection: agent-controlled fields (vassal names,
 * escalation reasons, branch previews, connector commands, ...) must never
 * reach the TTY carrying terminal control sequences. SGR/CSI could forge
 * output, CR/LF could rewrite lines, OSC could carry hyperlink/title payloads.
 * The palette's own SGR is added only after the neutralization pass.
 */
const PAYLOAD = 'evil\x1b[31mFORGED\x1b[0m\rOVER\nLINE\t\x07\u009b';
const PAYLOAD_OSC = 'x\x1b]8;;http://forged.example\x07click\x1b]8;;\x1b\\y';

/** Every C0/C1 control byte is illegal in rendered output except LF (\n),
 *  which the deck itself uses to join lines. */
const ILLEGAL_CONTROL = /[\x00-\x09\x0b-\x1f\x7f\x80-\x9f]/;

const poisoned: DeckSnapshot = {
  state: {
    persistence: { enabled: true, stateFile: `/tmp/${PAYLOAD}`, restoredFromSnapshot: true },
    audit: { file: `/tmp/${PAYLOAD_OSC}`, failures: 0, degraded: false },
    driverGrants: { authority: 'signed', keyId: PAYLOAD },
  },
  metrics: null,
  roster: {
    generatedAt: '',
    entries: [
      {
        name: PAYLOAD,
        status: 'active',
        health: `sick${PAYLOAD}`,
        skills: [{ id: PAYLOAD }, { name: PAYLOAD_OSC }],
      },
    ],
  },
  escalations: [
    {
      id: PAYLOAD,
      kind: 'intent-conflict',
      vassal: PAYLOAD,
      skill: PAYLOAD,
      realm: 'personal',
      reason: PAYLOAD_OSC,
      status: 'pending',
      options: [],
      createdAt: '',
      stances: [{ stance: PAYLOAD, vassals: [] }],
    },
  ],
  audit: [
    { ts: `00:00${PAYLOAD}`, vassal: PAYLOAD, decision: `future${PAYLOAD}`, skill: PAYLOAD, state: PAYLOAD_OSC },
  ],
  domains: {
    realms: [
      {
        realmId: PAYLOAD,
        type: 'enterprise',
        tenant: { org: PAYLOAD, department: PAYLOAD_OSC, member: PAYLOAD },
        readOnly: false,
        itemCount: 1,
        contentDigest: PAYLOAD,
      },
    ],
    grants: [
      {
        grantId: PAYLOAD,
        subject: PAYLOAD,
        realmId: PAYLOAD,
        access: 'read',
        grantedBy: PAYLOAD,
        grantedAt: '',
        nonce: 'n',
      },
    ],
  },
  contracts: {
    contracts: [
      {
        id: `\x1b[31m${PAYLOAD}`,
        grantedBy: 'operator',
        skill: PAYLOAD,
        vassal: PAYLOAD,
        capabilities: ['execute', PAYLOAD],
        limits: { maxChildTickets: 4, maxConcurrent: 1, windowEndsAt: '2026-10-01T00:00:00.000Z' },
        used: { childTickets: 1, inFlight: 0 },
        issuedAt: '',
      },
    ],
  },
  watches: {
    watches: [
      {
        id: PAYLOAD,
        owner: 'operator',
        realm: 'personal',
        predicate: { source: PAYLOAD, op: 'change', field: PAYLOAD_OSC },
        intent: { skill: PAYLOAD, subject: 's', mode: 'plan', maxFanOut: 1 },
        intervalSeconds: 60,
        startsAt: '',
        expiresAt: '',
        budget: { fires: 1, executes: 1 },
        used: { fires: 0, executes: 0 },
        enabled: true,
        lastFiredAt: '2026-10-01T00:00:00.000Z',
      },
    ],
  },
  connectors: {
    connectors: [
      {
        id: PAYLOAD,
        name: PAYLOAD,
        status: 'declared',
        command: PAYLOAD,
        args: [PAYLOAD_OSC, 'plain-arg'],
        permissions: [],
        hasToken: false,
      },
      {
        id: 'c2',
        name: PAYLOAD_OSC,
        status: 'connected',
        endpoint: PAYLOAD_OSC,
        permissions: [],
        hasToken: true,
        capabilities: { tools: ['t'], resources: [], prompts: [] },
      },
    ],
  },
  active: {
    intents: [
      {
        intentId: PAYLOAD,
        skill: PAYLOAD,
        status: 'running',
        settledCount: 0,
        totalCount: 1,
        view: {
          order: ['r1'],
          branches: {
            r1: { runId: 'r1', vassal: PAYLOAD, started: true, settled: false, lastSeq: 0, preview: PAYLOAD_OSC },
          },
          partiallyReady: false,
        },
      },
    ],
  },
};

describe('safeText terminal neutralization', () => {
  it('strips complete CSI/SGR and cursor sequences', () => {
    expect(safeText('\x1b[31mred\x1b[0m')).toBe('red');
    expect(safeText('a\x1b[2J\x1b[Hb')).toBe('ab');
    expect(safeText('x\x1b[?25hy')).toBe('xy');
  });

  it('strips OSC strings including hyperlinks terminated by BEL or ST', () => {
    expect(safeText('\x1b]8;;http://x\x07label\x1b]8;;\x1b\\')).toBe('label');
    expect(safeText('\x1b]0;title\x07rest')).toBe('rest');
  });

  it('replaces residual C0/C1 control bytes with a visible marker, keeping printable text', () => {
    expect(safeText('a\rb\nc\td\x07e')).toBe('a\uFFFDb\uFFFDc\uFFFDd\uFFFDe');
    expect(safeText('x\u009by')).toBe('x\uFFFDy');
    expect(safeText('lone\x1b')).toBe('lone\uFFFD');
    expect(safeText('del\x7f')).toBe('del\uFFFD');
  });

  it('keeps CJK text, box-drawing characters and punctuation untouched', () => {
    expect(safeText('监督台 ─└… · [execute] #1')).toBe('监督台 ─└… · [execute] #1');
  });
});

describe('translator interpolation boundary', () => {
  it('neutralizes control sequences arriving through message params, never the catalogue', () => {
    const t = makeTranslator('zh-CN');
    const out = t('state.persistence.on', { file: `/tmp/${PAYLOAD}` });
    expect(out).not.toMatch(ILLEGAL_CONTROL);
    expect(out).toContain('/tmp/evilFORGED');
  });
});

describe('renderDeck output neutralization', () => {
  const t = makeTranslator('zh-CN');

  it('emits no control bytes from any dynamic field when color is off', () => {
    const out = renderDeck({ snapshot: poisoned, t, palette: makePalette(false), updatedAt: '00:00:00' });
    expect(out).not.toMatch(ILLEGAL_CONTROL);
    // OSC string bodies disappear with the sequence; the forged URL must not
    // survive into visible output either.
    expect(out).not.toContain('forged.example');
    // Printable payload content stays visible (silent hiding would itself be a
    // forgery), while its SGR styling is gone.
    expect(out).toContain('evilFORGED');
    // Legitimate tabular characters used by the deck itself survive.
    expect(out).toContain('─');
  });

  it('keeps palette SGR working while stripping injected SGR when color is on', () => {
    const out = renderDeck({ snapshot: poisoned, t, palette: makePalette(true), updatedAt: '00:00:00' });
    expect(out).toMatch(/\x1b\[/); // the palette's own wrap is intact
    expect(out).not.toContain('\x1b[31mFORGED');
    expect(out).not.toContain('FORGED\x1b[0m');
    expect(out).not.toContain('\r');
    expect(out).not.toContain('\u009b');
  });
});

describe('renderRecognize output neutralization', () => {
  const t = makeTranslator('zh-CN');
  const palette = makePalette(false);

  it('neutralizes a fail-closed reason and detail even though they render verbatim', () => {
    const out = renderRecognize({ result: { ok: false, reason: PAYLOAD, detail: PAYLOAD_OSC }, t, palette });
    expect(out).not.toMatch(ILLEGAL_CONTROL);
    expect(out).not.toContain('forged.example');
  });

  it('neutralizes a hit skill name and model backend label', () => {
    const out = renderRecognize({
      result: { ok: true, skill: PAYLOAD, confidence: 0.9, backend: { kind: 'llm', model: PAYLOAD }, decisionAt: '' },
      t,
      palette,
    });
    expect(out).not.toMatch(ILLEGAL_CONTROL);
  });
});

describe('controller confirm prompts', () => {
  it('neutralizes snapshot-derived ids in readline prompts (runner t() path)', async () => {
    const prompts: string[] = [];
    const io = {
      question: async (prompt: string) => {
        prompts.push(prompt);
        return 'n';
      },
      print: () => {},
      now: () => new Date(0),
    };
    const client = { snapshot: async () => poisoned } as unknown as DeckClient;
    const deck = createDeck({ client, io, color: false });
    await deck.refresh();
    const keepGoing = await deck.handle('a1');
    expect(keepGoing).toBe(true);
    expect(prompts.length).toBe(1);
    expect(prompts[0]).not.toMatch(ILLEGAL_CONTROL);
    expect(prompts[0]).toContain('evilFORGED');
  });
});
