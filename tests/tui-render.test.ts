import { describe, expect, it } from 'vitest';
import { makeTranslator } from '../src/tui/format.js';
import { makePalette } from '../src/tui/tokens.js';
import { escalationOptions, renderDeck, skillList } from '../src/tui/render.js';
import type { DeckSnapshot } from '../src/tui/client.js';

const t = makeTranslator('zh-CN');
const palette = makePalette(false);

const snapshot: DeckSnapshot = {
  audit: [
    { ts: '00:00:01', vassal: 'pr-helper', decision: 'dispatched', skill: 'deployment-health' },
    { ts: '00:00:02', vassal: 'loom', decision: 'refused-revoked', skill: 'research' },
  ],
  roster: {
    generatedAt: '2026-09-30T00:00:00.000Z',
    entries: [
      { name: 'pr-helper', status: 'active', health: 'healthy', skills: [{ id: 'deployment-health' }] },
      { name: 'loom', status: 'revoked', health: 'unknown', skills: [{ id: 'research' }] },
    ],
  },
  escalations: [
    {
      id: 'esc-1',
      kind: 'task-input',
      vassal: 'pr-helper',
      skill: 'deployment-health',
      realm: 'personal',
      reason: 'Missing required parameters: owner, repo',
      status: 'pending',
      options: ['provide params', 'skip'],
      createdAt: '2026-09-30T00:00:00.000Z',
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
      createdAt: '2026-09-30T00:00:00.000Z',
      intentId: 'intent-1',
      stances: [
        { stance: 'postgres', vassals: ['a1'] },
        { stance: 'sqlite', vassals: ['a2'] },
      ],
    },
  ],
  metrics: {
    inFlight: 1,
    maxInFlight: 3,
    queueDepth: 0,
    finished: 5,
    completed: 4,
    failed: 1,
    timedOut: 0,
  },
  state: {
    persistence: { enabled: true, stateFile: '/tmp/k.json', restoredFromSnapshot: true },
    audit: { file: '/tmp/audit.jsonl', failures: 0, degraded: false },
    counts: { vassals: 1, vassalsRevoked: 1, escalations: 2, intents: 3, skills: 4 },
    driverGrants: { authority: 'signed', keyId: 'zeus-rsk-dev' },
  },
};

describe('TUI pure render', () => {
  it('renders roster status labels, escalation kinds and metric counts', () => {
    const out = renderDeck({ snapshot, t, palette, updatedAt: '00:00:00' });
    expect(out).toContain('Zeus 监督台');
    expect(out).toContain('pr-helper');
    expect(out).toContain('deployment-health');
    expect(out).toContain('已吊销');
    expect(out).toContain('待裁决');
    expect(out).toContain('缺参');
    expect(out).toContain('立场冲突');
    expect(out).toContain('在途 1');
    expect(out).toContain('峰值 3');
    expect(out).toContain('esc-1');
    expect(out).toContain('1.postgres');
  });

  it('keeps machine identifiers and enum values untranslated', () => {
    const out = renderDeck({ snapshot, t, palette, updatedAt: '00:00:00' });
    expect(out).toContain('esc-1');
    expect(out).toContain('esc-2');
    expect(out).toContain('pr-helper');
    expect(out).toContain('postgres');
    expect(out).toContain('zeus-rsk-dev');
  });

  it('renders empty-state copy and omits metrics block when null', () => {
    const empty: DeckSnapshot = {
      audit: [],
      roster: { generatedAt: '', entries: [] },
      escalations: [],
      metrics: null,
      state: null,
    };
    const out = renderDeck({ snapshot: empty, t, palette, updatedAt: '00:00:00' });
    expect(out).toContain('在册执行 Agent 为空');
    expect(out).toContain('没有待处理的裁决');
    expect(out).not.toContain('并发指标');
  });

  it('derives intent-conflict choices from stances, otherwise from options', () => {
    expect(escalationOptions(snapshot.escalations[1])).toEqual(['postgres', 'sqlite']);
    expect(escalationOptions(snapshot.escalations[0])).toEqual(['provide params', 'skip']);
    expect(skillList({ skills: [{ id: 'a' }, { name: 'b' }] })).toBe('a,b');
  });

  it('renders the fan-out timeline with localized decision labels and raw context', () => {
    const out = renderDeck({ snapshot, t, palette, updatedAt: '00:00:00' });
    expect(out).toContain('扇出 / 决策时间线（最近 2）');
    expect(out).toContain('已派发');
    expect(out).toContain('已吊销执行 Agent 阻断');
    expect(out).toContain('loom · research');
    expect(out).toContain('pr-helper · deployment-health');
    // The machine enum stays beside the translated label nowhere; here only
    // known labels are rendered without a raw-decision fallback suffix.
    expect(out).not.toContain('(dispatched)');
  });

  it('shows the unknown-decision fallback with the raw enum, never inventing a label', () => {
    const future: DeckSnapshot = {
      ...snapshot,
      audit: [{ ts: '00:00:03', vassal: 'pr-helper', decision: 'quorum-new-thing' }],
    };
    const out = renderDeck({ snapshot: future, t, palette, updatedAt: '00:00:00' });
    expect(out).toContain('未知审计类型 quorum-new-thing');
    expect(out).toContain('(quorum-new-thing)');
  });

  it('renders timeline empty vs unavailable distinctly', () => {
    const emptyAudit: DeckSnapshot = { ...snapshot, audit: [] };
    expect(renderDeck({ snapshot: emptyAudit, t, palette, updatedAt: '' })).toContain('尚无扇出记录');
    const unavailable: DeckSnapshot = { ...snapshot, audit: null };
    expect(renderDeck({ snapshot: unavailable, t, palette, updatedAt: '' })).toContain('审计面不可用');
  });
});
