import { describe, expect, it } from 'vitest';
import { makeTranslator } from '../src/tui/format.js';
import { makePalette } from '../src/tui/tokens.js';
import { escalationOptions, renderDeck, renderRecognize, skillList } from '../src/tui/render.js';
import type { DeckSnapshot } from '../src/tui/client.js';

const t = makeTranslator('zh-CN');
const palette = makePalette(false);

const snapshot: DeckSnapshot = {
  audit: [
    { ts: '00:00:01', vassal: 'pr-helper', decision: 'dispatched', skill: 'deployment-health' },
    { ts: '00:00:02', vassal: 'loom', decision: 'refused-revoked', skill: 'research' },
  ],
  domains: {
    realms: [
      { realmId: 'notes-personal', type: 'personal', readOnly: false, itemCount: 12, contentDigest: 'sha256:aaa' },
      { realmId: 'acme-eng', type: 'enterprise', tenant: { org: 'acme', department: 'eng' }, readOnly: true, itemCount: 5, contentDigest: 'sha256:bbb' },
    ],
    grants: [
      { grantId: 'g-1', subject: 'loom', realmId: 'acme-eng', access: 'read', grantedBy: 'operator', grantedAt: '2026-09-30T00:00:00.000Z', nonce: 'n1' },
    ],
  },
  contracts: {
    contracts: [
      {
        id: 'dc-aaaaaaaa-1111-2222-3333-444444444444',
        grantedBy: 'operator',
        skill: 'research',
        capabilities: ['execute'],
        limits: { maxChildTickets: 10, maxConcurrent: 2, windowEndsAt: '2026-10-01T00:00:00.000Z' },
        used: { childTickets: 3, inFlight: 1 },
        issuedAt: '2026-09-30T00:00:00.000Z',
      },
      {
        id: 'dc-bbbbbbbb-1111-2222-3333-444444444444',
        grantedBy: 'operator',
        skill: 'review',
        capabilities: ['execute'],
        limits: { maxChildTickets: 4, maxConcurrent: 1, windowEndsAt: '2026-10-01T00:00:00.000Z' },
        used: { childTickets: 4, inFlight: 0 },
        issuedAt: '2026-09-30T00:00:00.000Z',
        revokedAt: '2026-09-30T01:00:00.000Z',
      },
    ],
  },
  watches: { watches: [] },
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
      domains: null,
      contracts: null,
      watches: null,
      roster: { generatedAt: '', entries: [] },
      escalations: [],
      metrics: null,
      state: null,
    };
    const out = renderDeck({ snapshot: empty, t, palette, updatedAt: '00:00:00' });
    expect(out).toContain('在册执行 Agent 为空');
    expect(out).toContain('没有待处理的裁决');
    expect(out).toContain('契约面不可用（该进程未挂载签发注册表）');
    expect(out).not.toContain('并发指标');
  });

  it('derives intent-conflict choices from stances, otherwise from options', () => {
    expect(escalationOptions(snapshot.escalations[1]!)).toEqual(['postgres', 'sqlite']);
    expect(escalationOptions(snapshot.escalations[0]!)).toEqual(['provide params', 'skip']);
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

  it('renders mounted realms, tenant/read-only flags and the grant ledger', () => {
    const out = renderDeck({ snapshot, t, palette, updatedAt: '00:00:00' });
    expect(out).toContain('数据域与跨域授权（域 2 · 授权 1）');
    expect(out).toContain('notes-personal');
    expect(out).toContain('acme-eng');
    expect(out).toContain('租户 acme/eng');
    expect(out).toContain('只读');
    expect(out).toContain('loom → acme-eng（读，operator）');
    expect(out).toContain('#2');
    expect(out).toContain('g<企业域#>');
  });

  it('renders domains unavailable vs empty distinctly', () => {
    const unavailable: DeckSnapshot = { ...snapshot, domains: null };
    expect(renderDeck({ snapshot: unavailable, t, palette, updatedAt: '' })).toContain('数据域面不可用');
    const empty: DeckSnapshot = { ...snapshot, domains: { realms: [], grants: [] } };
    const out = renderDeck({ snapshot: empty, t, palette, updatedAt: '' });
    expect(out).toContain('未挂载数据域');
  });
});

describe('active intents section (S15 V3, design-streaming §3.3)', () => {
  const thinkingSnapshot: DeckSnapshot = {
    ...snapshot,
    active: {
      intents: [
        {
          intentId: 'intent-live',
          skill: 'review',
          status: 'running',
          settledCount: 1,
          totalCount: 2,
          view: {
            order: ['run-1:loom', 'run-1:atlas'],
            branches: {
              'run-1:loom': { runId: 'run-1:loom', vassal: 'loom', started: true, settled: true, outcome: { outcome: 'ok' }, preview: '' },
              'run-1:atlas': { runId: 'run-1:atlas', vassal: 'atlas', started: true, settled: false, lastSeq: 2, preview: 'weighing options' },
            },
            partiallyReady: true,
          },
        },
      ],
    },
  };

  it('renders running state, N/M readiness, thinking frames and a marked preview', () => {
    const out = renderDeck({ snapshot: thinkingSnapshot, t, palette, updatedAt: '' });
    expect(out).toContain('在途意图（1）');
    expect(out).toContain('intent-live');
    expect(out).toContain('运行中');
    expect(out).toContain('1/2 就绪');
    expect(out).toContain('思考中');
    expect(out).toContain('3 帧');
    expect(out).toContain('[预览·非结论] weighing options');
    // the settled branch shows its formal outcome, not a preview
    expect(out).toContain('已完成');
  });

  it('marks a needs-driver intent as awaiting decision', () => {
    const blocked: DeckSnapshot = {
      ...snapshot,
      active: {
        intents: [
          {
            intentId: 'intent-blocked', skill: 'review', status: 'needs-driver', settledCount: 2, totalCount: 2,
            view: {
              order: ['run-1:loom', 'run-1:atlas'],
              branches: {
                'run-1:loom': { runId: 'run-1:loom', vassal: 'loom', started: true, settled: true, outcome: { outcome: 'ok' }, preview: '' },
                'run-1:atlas': { runId: 'run-1:atlas', vassal: 'atlas', started: true, settled: true, outcome: { outcome: 'ok' }, preview: '' },
              },
              partiallyReady: false,
            },
          },
        ],
      },
    };
    const out = renderDeck({ snapshot: blocked, t, palette, updatedAt: '' });
    expect(out).toContain('intent-blocked');
    expect(out).toContain('2/2 就绪');
  });

  it('omits the section when the face is absent or empty', () => {
    expect(renderDeck({ snapshot: { ...snapshot, active: null }, t, palette, updatedAt: '' })).not.toContain('在途意图');
    expect(renderDeck({ snapshot: { ...snapshot, active: { intents: [] } }, t, palette, updatedAt: '' })).not.toContain('在途意图');
  });

  it('localizes the section and preview marker in English', () => {
    const en = makeTranslator('en');
    const out = renderDeck({ snapshot: thinkingSnapshot, t: en, palette, updatedAt: '' });
    expect(out).toContain('In-flight intents (1)');
    expect(out).toContain('running');
    expect(out).toContain('1/2 settled');
    expect(out).toContain('thinking');
    expect(out).toContain('[preview · not a conclusion] weighing options');
  });
});

describe('contracts section (self-host step 5 face)', () => {
  it('renders active and revoked contracts with spend, ceilings and window', () => {
    const out = renderDeck({ snapshot, t, palette, updatedAt: '00:00:00' });
    expect(out).toContain('委托契约（自主执行授权，2）');
    expect(out).toContain('dc-aaaaa');
    expect(out).toContain('research');
    expect(out).toContain('已用 3/10');
    expect(out).toContain('并发 1/2');
    expect(out).toContain('窗口至 2026-10-01 00:00');
    expect(out).toContain('[execute]');
    expect(out).toContain('已撤销');
    expect(out).toContain('生效');
  });

  it('renders empty vs unavailable distinctly, and never invents contracts', () => {
    const empty = renderDeck({ snapshot: { ...snapshot, contracts: { contracts: [] } }, t, palette, updatedAt: 'x' });
    expect(empty).toContain('无委托契约——无人被授权自主执行');
    const unavailable = renderDeck({ snapshot: { ...snapshot, contracts: null }, t, palette, updatedAt: 'x' });
    expect(unavailable).toContain('契约面不可用（该进程未挂载签发注册表）');
  });

  it('flags a delegation-limit escalation with the approve-contract action hint', () => {
    const withLimit: DeckSnapshot = {
      ...snapshot,
      escalations: [
        {
          id: 'esc-dl-1',
          kind: 'delegation-limit',
          vassal: '(watch)',
          skill: 'research',
          realm: 'personal',
          reason: 'execute fire refused (revoked); no outbound dispatch',
          status: 'pending',
          options: [],
          createdAt: '',
        },
      ],
    };
    const out = renderDeck({ snapshot: withLimit, t, palette, updatedAt: 'x' });
    expect(out).toContain('签一份仅 execute 的新契约并换绑本 watch');
  });

  it('flags a revoked roster row with the reinstate form for that position', () => {
    const revoked: DeckSnapshot = {
      ...snapshot,
      roster: {
        generatedAt: '',
        entries: [
          { name: 'keep', status: 'active', health: 'healthy', skills: [{ id: 'research' }] },
          { name: 'gone', status: 'revoked', skills: [{ id: 'research' }] },
        ],
      },
    };
    const out = renderDeck({ snapshot: revoked, t, palette, updatedAt: 'x' });
    // The hint carries the row number an operator has to type - `b<n>` names a position.
    expect(out).toContain('b2');
    expect(out).not.toMatch(/b1/);
  });

  it('flags a task-input escalation with the resume-with-parameters hint', () => {
    const waiting: DeckSnapshot = {
      ...snapshot,
      escalations: [
        {
          id: 'esc-ti-1',
          kind: 'task-input',
          vassal: 'pr-helper',
          skill: 'deployment-health',
          realm: 'personal',
          reason: 'missing owner, repo',
          status: 'pending',
          options: ['provide owner and repo', 'skip'],
          createdAt: '',
        },
      ],
    };
    const out = renderDeck({ snapshot: waiting, t, palette, updatedAt: 'x' });
    expect(out).toContain('用这些参数重派该分支');
  });

  it('S10 V2: shows the interruption level badge and omits it on pre-V2 rows', () => {
    const leveled: DeckSnapshot = {
      ...snapshot,
      escalations: [
        {
          id: 'esc-l1', kind: 'memory-dispute', vassal: '(memory)', skill: '(memory)',
          realm: 'personal', reason: 'dispute', status: 'pending', options: [],
          createdAt: '', interruptLevel: 1,
        },
        {
          id: 'esc-l2', kind: 'task-input', vassal: 'loom', skill: 'deploy',
          realm: 'enterprise', reason: 'blocked', status: 'pending', options: [],
          createdAt: '', interruptLevel: 2,
        },
      ],
    };
    const out = renderDeck({ snapshot: leveled, t, palette, updatedAt: 'x' });
    expect(out).toContain('L1 异步介入');
    expect(out).toContain('L2 同步等待');
    const legacy: DeckSnapshot = {
      ...snapshot,
      escalations: [
        {
          id: 'esc-old', kind: 'memory-dispute', vassal: '(memory)', skill: '(memory)',
          realm: 'personal', reason: 'dispute', status: 'pending', options: [], createdAt: '',
        },
      ],
    };
    expect(renderDeck({ snapshot: legacy, t, palette, updatedAt: 'x' })).not.toContain('L1 异步介入');
  });
});

describe('connectors section (E7 MCP face)', () => {
  it('renders declared/connected/revoked connectors with transport, caps and token', () => {
    const withConn: DeckSnapshot = {
      ...snapshot,
      connectors: {
        connectors: [
          { id: 'c1', name: 'GitHub', status: 'declared', permissions: ['repo:read'], hasToken: false },
          {
            id: 'c2', name: 'Slack', status: 'connected', endpoint: 'https://slack', permissions: ['chat:write'], hasToken: true,
            capabilities: { tools: ['post'], resources: [], prompts: [] },
          },
        ],
      },
    };
    const out = renderDeck({ snapshot: withConn, t, palette, updatedAt: 'x' });
    expect(out).toContain('连接器（MCP，2）');
    expect(out).toContain('GitHub');
    expect(out).toContain('Slack');
    expect(out).toContain('已声明');
    expect(out).toContain('已连接');
    expect(out).toContain('http: https://slack');
    expect(out).toContain('1 工具 / 0 资源 / 0 提示');
    expect(out).toContain('有凭据');
    expect(out).toContain('m<连接器#>');
    expect(out).toContain('mx<#>');
    expect(out).toContain('mt<#>');
  });

  it('renders stdio transport and no-caps (un-handshaked) distinctly', () => {
    const withConn: DeckSnapshot = {
      ...snapshot,
      connectors: {
        connectors: [
          {
            id: 'c3', name: 'local', status: 'declared', command: 'mcp-server', args: ['--foo'], permissions: [], hasToken: false,
          },
        ],
      },
    };
    const out = renderDeck({ snapshot: withConn, t, palette, updatedAt: 'x' });
    expect(out).toContain('stdio: mcp-server --foo');
    expect(out).toContain('未握手');
  });

  it('renders empty vs unavailable distinctly, and never invents a connector', () => {
    const empty = renderDeck({ snapshot: { ...snapshot, connectors: { connectors: [] } }, t, palette, updatedAt: 'x' });
    expect(empty).toContain('无连接器——没有声明任何外部系统');
    const unavailable = renderDeck({ snapshot: { ...snapshot, connectors: null }, t, palette, updatedAt: 'x' });
    expect(unavailable).toContain('连接器面不可用（该进程未装配连接器注册中心）');
  });
});

describe('renderRecognize (E2.6 operator intent)', () => {
  it('renders a local-rule hit with plan-only notice and zero-egress backend', () => {
    const out = renderRecognize({
      result: { ok: true, skill: 'deployment-health', confidence: 0.5, backend: null, decisionAt: '' },
      t,
      palette,
    });
    expect(out).toContain('意图识别');
    expect(out).toContain('技能 deployment-health');
    expect(out).toContain('0.5');
    expect(out).toContain('本地规则，零出域');
    expect(out).toContain('plan-only');
  });

  it('renders a model-backed hit with the backend label', () => {
    const out = renderRecognize({
      result: { ok: true, skill: 'research', confidence: 0.82, backend: { kind: 'llm', model: 'agnes-2.5-flash' }, decisionAt: '' },
      t,
      palette,
    });
    expect(out).toContain('llm agnes-2.5-flash');
  });

  it('renders a fail-closed miss with the named reason, never a guess', () => {
    const out = renderRecognize({
      result: { ok: false, reason: 'ambiguous', detail: '规则并列：deployment-health / research' },
      t,
      palette,
    });
    expect(out).toContain('未识别：ambiguous');
    expect(out).toContain('规则并列');
    expect(out).not.toContain('→ 技能');
  });

  it('omits detail when the miss carries none', () => {
    const out = renderRecognize({ result: { ok: false, reason: 'no-candidates' }, t, palette });
    expect(out).toContain('未识别：no-candidates');
    expect(out).not.toContain('undefined');
  });
});
