import {
  initModelKit,
  reportUsageInBackground,
  type ModelKit,
  type PingResult,
  type ResolvedModel,
  type TestResult,
} from '@model-hub/model-kit';
import { createLlmBackend, type LlmUsageReport } from './llm.js';
import {
  DecisionBackendFailure,
  type BackendOptions,
  type DecisionBackend,
} from './types.js';

/** The hub attributes usage to the token's project regardless of this body
 *  field; like loom, we report the calling project's slug for readability. */
const HUB_PROJECT_SLUG = 'zeus';

/** L3/L4 test surface exposed to the operator console. */
export type HubTestPort = {
  pingHub(): Promise<PingResult>;
  testConnection(
    alias: string,
    opts?: { deep?: boolean },
  ): Promise<TestResult>;
};

/** A decision backend plus its hub test surface. */
export type HubDecisionWiring = {
  backend: DecisionBackend;
  testPort: HubTestPort;
};

/**
 * Process-wide hub model resolver, published by createHubDecisionBackend
 * when the hub wiring lands. Consumers that are constructed before the
 * decision wiring (the memory embedder) read it lazily instead of threading
 * the kit through boot; one wiring per process is the boot invariant.
 */
let activeResolveModel: ((alias: string) => ResolvedModel | null) | null = null;

export function activeHubModelResolve(alias: string): ResolvedModel | null {
  return activeResolveModel?.(alias) ?? null;
}

/**
 * Hub-backed decision backend. Each primitive (noul/choice/score) resolves
 * its own model by alias via model-kit, so different primitives can use
 * different models and the issued unit prices flow into the LLM config.
 */
export type HubBackendOptions = BackendOptions & {
  hubUrl: string;
  token: string;
  cachePath: string;
  /** Alias overrides; default to the primitive names. */
  aliases?: {
    noul?: string;
    choice?: string;
    score?: string;
  };
  /**
   * TracePort v1 §6 (D-7): usage reports are fire-and-forget — model-kit's
   * postUsage swallows every transport failure, so without this observer they
   * are invisible. Invoked once per failed report (HTTP error or network
   * error); the decision path is never affected.
   */
  onUsageReportFailed?: (reason: string) => void;
};

export async function createHubDecisionBackend(
  options: HubBackendOptions,
): Promise<HubDecisionWiring> {
  const kit: ModelKit = await initModelKit({
    hubUrl: options.hubUrl,
    token: options.token,
    cachePath: options.cachePath,
    ...(options.fetchImpl ? { fetch: options.fetchImpl } : {}),
  });
  const reportFetch = options.fetchImpl ?? fetch;

  // D-7: postUsage swallows all errors (and ignores non-2xx responses), which
  // makes a silently dropping report invisible. When an observer is present,
  // wrap the report transport to surface HTTP and network failures — the
  // rethrow keeps the swallow in place, so the decision path is unchanged.
  const onUsageReportFailed = options.onUsageReportFailed;
  const usageFetch: typeof fetch = onUsageReportFailed
    ? async (input: RequestInfo | URL, init?: RequestInit) => {
        try {
          const response = await reportFetch(input, init);
          if (!response.ok) {
            onUsageReportFailed(`usage report failed: HTTP ${response.status}`);
          }
          return response;
        } catch (error) {
          onUsageReportFailed(error instanceof Error ? error.message : 'usage report network error');
          throw error; // model-kit's postUsage catches this
        }
      }
    : reportFetch;

  // Fire-and-forget usage report after each successful decision call, mirroring
  // model-kit's own chat() reporting for transports that bypass it. postUsage
  // swallows transport failures, so the decision path is never affected.
  function reportUsage(resolved: ResolvedModel, usage: LlmUsageReport): void {
    void reportUsageInBackground(options.hubUrl, options.token, usageFetch, {
      project: HUB_PROJECT_SLUG,
      // D-7: the feature field distinguishes the primitive behind the call.
      feature: `decision:${usage.kind}`,
      billingSource: resolved.source === 'byok' ? 'byok' : 'builtin',
      model: resolved,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      reasoningTokens: usage.reasoningTokens,
      cacheReadTokens: usage.cacheReadTokens,
      httpStatus: 200,
    });
  }

  // Publish the resolver for pre-wiring consumers (memory embedder); an
  // unresolved alias surfaces as null rather than a throw.
  activeResolveModel = alias => {
    try {
      return kit.resolve(alias);
    } catch {
      return null;
    }
  };

  const aliases = {
    noul: options.aliases?.noul ?? 'noul',
    choice: options.aliases?.choice ?? 'choice',
    score: options.aliases?.score ?? 'score',
  };

  function backendFor(alias: string): DecisionBackend | null {
    let resolved: ResolvedModel;
    try {
      resolved = kit.resolve(alias);
    } catch {
      return null;
    }
    return createLlmBackend({
      ...options,
      baseUrl: resolved.baseUrl,
      apiKey: resolved.apiKey,
      model: resolved.model,
      // Some models only accept a specific sampling temperature (e.g. Ark
      // `ark-code-latest` rejects 0 with 400 and requires 1); the hub adapter
      // declares the legal value and we honour it here.
      ...(resolved.adapter !== null &&
      typeof resolved.adapter === 'object' &&
      'temperature' in resolved.adapter
        ? { temperature: Number((resolved.adapter as Record<string, unknown>).temperature) }
        : {}),
      ...(resolved.pricing?.input_usd_per_million !== undefined
        ? { inputUsdPerMillion: resolved.pricing.input_usd_per_million }
        : {}),
      ...(resolved.pricing?.output_usd_per_million !== undefined
        ? { outputUsdPerMillion: resolved.pricing.output_usd_per_million }
        : {}),
      onUsage: (usage) => reportUsage(resolved, usage),
    });
  }

  const noulBackend = backendFor(aliases.noul);
  const choiceBackend = backendFor(aliases.choice);
  const scoreBackend = backendFor(aliases.score);
  const anyBackend = noulBackend ?? choiceBackend ?? scoreBackend;

  // Fail at construction when no model resolved, so the caller falls back to
  // env instead of receiving a backend that only fails on first use.
  if (!anyBackend) {
    throw new DecisionBackendFailure(
      'unavailable',
      'no hub models resolved for noul/choice/score',
    );
  }

  function requireBackend(
    specific: DecisionBackend | null,
    primitive: string,
  ): DecisionBackend {
    const backend = specific ?? anyBackend;
    if (!backend) {
      throw new DecisionBackendFailure(
        'unavailable',
        `no hub model resolved for '${primitive}' and no env fallback`,
      );
    }
    return backend;
  }

  const backend: DecisionBackend = {
    kind: 'hub',
    model: `hub:${aliases.noul}/${aliases.choice}/${aliases.score}`,
    noul: (request) =>
      requireBackend(noulBackend, aliases.noul).noul(request),
    choice: (request) =>
      requireBackend(choiceBackend, aliases.choice).choice(request),
    score: (request) =>
      requireBackend(scoreBackend, aliases.score).score(request),
  };

  const testPort: HubTestPort = {
    pingHub: () => kit.pingHub(),
    testConnection: (alias, opts) =>
      kit.testConnection(alias, {
        ...(opts?.deep !== undefined ? { deep: opts.deep } : {}),
      }),
  };

  return { backend, testPort };
}
