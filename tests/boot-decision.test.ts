import { describe, expect, it } from 'vitest';
import { bootKernel, resolveDecisionConfig } from '../src/state/boot.js';
import type { ChoiceResult, DecisionBackend } from '../src/decision/types.js';

// ---------------------------------------------------------------------------
// resolveDecisionConfig: pure env -> backend/judge wiring
// ---------------------------------------------------------------------------

describe('T-C resolveDecisionConfig (process env wiring)', () => {
  it('returns no backend and judge off when no keys are set (rules-only degrade)', () => {
    const cfg = resolveDecisionConfig({});
    expect(cfg.backend).toBeNull();
    expect(cfg.backendKind).toBeNull();
    expect(cfg.judgeEnabled).toBe(false);
  });

  it('builds the dedicated decision model from ZEUS_DECISION_*', () => {
    const cfg = resolveDecisionConfig({
      ZEUS_DECISION_BASE_URL: 'http://jev.test/v1',
      ZEUS_DECISION_API_KEY: 'k',
    });
    expect(cfg.backendKind).toBe('decision-model');
    expect(cfg.backend?.kind).toBe('decision-model');
  });

  it('falls back to a generic LLM when only ZEUS_LLM_* is fully set', () => {
    const cfg = resolveDecisionConfig({
      ZEUS_LLM_BASE_URL: 'http://llm.test/v1',
      ZEUS_LLM_API_KEY: 'k',
      ZEUS_LLM_MODEL: 'gpt-test',
    });
    expect(cfg.backendKind).toBe('llm');
    expect(cfg.backend?.kind).toBe('llm');
  });

  it('needs all three LLM vars; a partial LLM config still yields no backend', () => {
    const cfg = resolveDecisionConfig({ ZEUS_LLM_BASE_URL: 'http://llm.test/v1', ZEUS_LLM_API_KEY: 'k' });
    expect(cfg.backend).toBeNull();
  });

  it('prefers the decision model over the LLM when both are configured', () => {
    const cfg = resolveDecisionConfig({
      ZEUS_DECISION_BASE_URL: 'http://jev.test/v1',
      ZEUS_DECISION_API_KEY: 'k',
      ZEUS_LLM_BASE_URL: 'http://llm.test/v1',
      ZEUS_LLM_API_KEY: 'k',
      ZEUS_LLM_MODEL: 'gpt-test',
    });
    expect(cfg.backendKind).toBe('decision-model');
  });

  it('keeps the judge off when enabled but no backend exists', () => {
    const cfg = resolveDecisionConfig({ ZEUS_JUDGE_ENABLED: 'true' });
    expect(cfg.judgeEnabled).toBe(false);
  });

  it('enables the judge with a backend and parses threshold / uncalibrated flags', () => {
    const cfg = resolveDecisionConfig({
      ZEUS_DECISION_BASE_URL: 'http://jev.test/v1',
      ZEUS_DECISION_API_KEY: 'k',
      ZEUS_JUDGE_ENABLED: '1',
      ZEUS_JUDGE_THRESHOLD: '0.66',
      ZEUS_JUDGE_ALLOW_UNCALIBRATED: 'yes',
    });
    expect(cfg.judgeEnabled).toBe(true);
    expect(cfg.judgeThreshold).toBe(0.66);
    expect(cfg.allowUncalibratedJudge).toBe(true);
  });

  it('ignores a non-numeric threshold', () => {
    const cfg = resolveDecisionConfig({
      ZEUS_DECISION_BASE_URL: 'http://jev.test/v1',
      ZEUS_DECISION_API_KEY: 'k',
      ZEUS_JUDGE_THRESHOLD: 'high',
    });
    expect(cfg.judgeThreshold).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// bootKernel end-to-end: the injected backend must actually reach the
// orchestrator (proved by behaviour, not by poking private fields).
// ---------------------------------------------------------------------------

function cardFor(name: string) {
  return {
    name,
    url: `http://127.0.0.1/${name}/api/a2a/tasks`,
    version: '0.1.0',
    provider: { organization: 'bayjf', url: 'http://bayjf.test' },
    capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: true },
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    skills: [{ id: 'review', name: 'Review', description: '', tags: [] }],
    authentication: { schemes: ['bearer'] },
    preferredTransport: 'JSONRPC',
    'x-zeus-fealty': {
      version: '1', swornTo: 'zeus', domain: 'test-domain',
      dataRealms: ['personal', 'enterprise'], dataPolicy: 'read-task-scope',
      reportBack: true, escalationPolicy: 'auto',
    },
  };
}

// One fetch mock serving N vassals; each vassal always returns a fixed stance
// over a faithful SSE frame sequence (status working -> completed task).
function vassalFetch(stances: Record<string, 'approve' | 'reject'>): typeof fetch {
  return (async (input: any) => {
    const url = String(input);
    const name = url.split('/')[3];
    if (url.includes('/api/a2a/agent-card')) {
      return new Response(JSON.stringify(cardFor(name)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const stance = stances[name];
    const taskId = `${name}-task`;
    const task = {
      kind: 'task',
      id: taskId,
      contextId: 'ctx',
      status: { state: 'completed' },
      artifacts: [{ artifactId: 'a', name: 'verdict', parts: [{ kind: 'data', data: { stance } }] }],
    };
    const frames = [
      `data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { kind: 'status-update', taskId, contextId: 'ctx', status: { state: 'working' }, final: false } })}\n\n`,
      `data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: task })}\n\n`,
    ];
    return new Response(frames.join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }) as typeof fetch;
}

function mockBackend(choice: 'approve' | 'reject', confidence = 0.92): { backend: DecisionBackend; choiceCalls: unknown[] } {
  const choiceCalls: unknown[] = [];
  const result: ChoiceResult = {
    choice,
    probabilities: choice === 'approve' ? { approve: confidence, reject: 1 - confidence } : { approve: 1 - confidence, reject: confidence },
    confidence,
    calibrated: true,
    decisionAt: '2026-09-24T00:00:00.000Z',
  };
  const backend: DecisionBackend = {
    kind: 'decision-model',
    model: 'mock-jev',
    async noul() {
      throw new Error('noul not used in boot wiring');
    },
    async choice(input) {
      choiceCalls.push(input);
      return result;
    },
    async score() {
      throw new Error('score not used in boot wiring');
    },
  };
  return { backend, choiceCalls };
}

const seeds = (names: string[]) => names.map(n => `http://127.0.0.1/${n}/api/a2a/agent-card`);

describe('T-C bootKernel decision backend wiring (end-to-end via SSE vassals)', () => {
  it('consults the injected backend to arbitrate a rule-inconclusive split (arbitration live)', async () => {
    const { backend, choiceCalls } = mockBackend('approve');
    const kernel = await bootKernel({
      fetchImpl: vassalFetch({ loom: 'approve', atlas: 'reject' }),
      vassalSeeds: seeds(['loom', 'atlas']),
      decisionBackend: backend,
    });
    const result = await kernel.orchestrator.fanOut({
      skill: 'review',
      realm: 'personal',
      params: { question: 'ship?' },
    });
    expect(choiceCalls.length).toBeGreaterThan(0);
    expect(result.status).toBe('completed');
    expect(result.decision.conclusion).toBe('approve');
    expect(result.backendArbitration).toMatchObject({ concluded: true, backend: 'decision-model' });
  });

  it('runs the adversarial judge for a rule-decided split when judgeEnabled, escalating on disagreement', async () => {
    const { backend, choiceCalls } = mockBackend('reject', 0.91);
    const kernel = await bootKernel({
      fetchImpl: vassalFetch({ loom: 'approve', craft: 'approve', atlas: 'reject' }),
      vassalSeeds: seeds(['loom', 'craft', 'atlas']),
      decisionBackend: backend,
      judgeEnabled: true,
    });
    const result = await kernel.orchestrator.fanOut({
      skill: 'review',
      realm: 'personal',
      params: { question: 'ship?' },
    });
    expect(choiceCalls.length).toBeGreaterThan(0);
    expect(result.status).toBe('needs-driver');
    expect(result.judgeReview?.agreesWithRule).toBe(false);
    expect(result.conflicts.some(c => c.kind === 'judge-review')).toBe(true);
  });

  it('stays rules-only (no backend call) when no decisionBackend is injected', async () => {
    const { backend, choiceCalls } = mockBackend('approve');
    const kernel = await bootKernel({
      fetchImpl: vassalFetch({ loom: 'approve', atlas: 'reject' }),
      vassalSeeds: seeds(['loom', 'atlas']),
    });
    const result = await kernel.orchestrator.fanOut({
      skill: 'review',
      realm: 'personal',
      params: { question: 'ship?' },
    });
    expect(choiceCalls).toHaveLength(0);
    expect(result.status).toBe('needs-driver'); // split with no arbitration path
    expect(backend).toBeDefined(); // sanity: the unused backend object exists
  });
});
