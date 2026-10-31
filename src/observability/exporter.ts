/**
 * S6 V3 (design-observability §5): a JSONL local-file TraceExporter.
 *
 * Data-sovereignty default: local file first, disabled unless a caller
 * explicitly attaches it (boot wires it only when `traceExportFile` is set).
 * Network export exists only as the opt-in OTLP exporter below (G2): an
 * explicitly configured endpoint, never a default — the file layout here
 * remains a stable interchange point for local tooling.
 *
 * Shape mirrors the intent archive (src/state/archive.ts): one record per
 * line, keyed by `traceId` so an interrupted flush followed by a retry cannot
 * double-write, 0700 directory / 0600 file. `readBack` rebuilds the in-memory
 * index, so a restart reads the same exports the previous process left behind.
 */
import { createHash } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { TraceExporter, TraceSpan, TraceTree } from './trace.js';

/** One exported trace tree as persisted on the exporter JSONL. */
export type ExportedTraceRecord = { tree: TraceTree; exportedAt: string };

export class JsonlTraceExporter implements TraceExporter {
  private index = new Map<string, ExportedTraceRecord>();

  constructor(private filePath: string) {}

  /** Rebuild the in-memory index from the export file. Missing file = empty. */
  async loadIndex(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    this.index.clear();
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      const record = JSON.parse(line) as ExportedTraceRecord;
      this.index.set(record.tree.traceId, record);
    }
  }

  /** Append one tree; duplicates by traceId are skipped (keyed append). */
  async export(tree: TraceTree): Promise<void> {
    if (this.index.has(tree.traceId)) return;
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const record: ExportedTraceRecord = { tree, exportedAt: new Date().toISOString() };
    const handle = await open(this.filePath, 'a', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, { encoding: 'utf8' });
      this.index.set(tree.traceId, record);
    } finally {
      await handle.close();
    }
  }

  /** All exported trees, oldest first (stable insertion order of the map). */
  async readBack(): Promise<TraceTree[]> {
    if (this.index.size === 0) await this.loadIndex();
    return [...this.index.values()].map(record => record.tree);
  }
}

// --- G2 (design-observability §5, Tier0 gap G2): OTLP/HTTP JSON export ---
//
// The port comment in trace.ts reserved OTLP "for a future decision under
// explicit authorization" — this is that decision, kept opt-in: the exporter
// exists only when the caller hands one to boot (serve wires it from
// ZEUS_OTLP_ENDPOINT; unset = not constructed, nothing dials out).
//
// Spans map onto the OpenTelemetry GenAI semantic conventions (Development
// state — the mapping layer below is the single adaptation seam and names
// every zeus-specific attribute `zeus.*`). zeus trace/span ids are runIds, not
// W3C 16/8-byte ids, so they map deterministically through SHA-256: same tree
// in, byte-identical OTLP payload out, and the parent/child linkage survives
// the mapping (child hash is computed from the same zeus span id the tree
// carries).
//
// Fail-soft by contract: an export failure degrades observability, it never
// blocks the decision chain (TracePort v1 §6 fire-and-forget semantics). The
// exporter catches its own transport failures and reports them through the
// injected log sink; export() always resolves.

/** OTLP JSON attribute value: exactly one of the proto value fields is set. */
type OtlpAttributeValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean };

type OtlpAttribute = { key: string; value: OtlpAttributeValue };

/** OTel SpanKind on the wire: 1 INTERNAL, 3 CLIENT. */
const SPAN_KIND_INTERNAL = 1;
const SPAN_KIND_CLIENT = 3;

/** OTel StatusCode: 2 = ERROR (1 OK / 0 UNSET are the absence of trouble). */
const STATUS_ERROR = 2;

/**
 * Deterministic W3C-shaped id mapping: zeus ids are runIds (arbitrary
 * strings), OTLP wants 32/16 lowercase hex chars. SHA-256 keeps the mapping
 * total and collision-resistant at single-operator scale (128/64-bit digest
 * prefixes); byte-determinism matters more than uniqueness guarantees here —
 * the same tree always exports the same ids, so a re-export lands on the same
 * spans upstream.
 */
function otlpTraceId(zeusTraceId: string): string {
  return createHash('sha256').update(`trace:${zeusTraceId}`, 'utf8').digest('hex').slice(0, 32);
}

function otlpSpanId(zeusTraceId: string, zeusSpanId: string): string {
  return createHash('sha256').update(`span:${zeusTraceId}\u0000${zeusSpanId}`, 'utf8').digest('hex').slice(0, 16);
}

/** ISO timestamp → unix nanoseconds string; absent/unparseable → undefined
 *  (the OTLP field is omitted, matching "missing events mean did not happen"). */
function unixNano(iso: string | undefined): string | undefined {
  if (iso === undefined || iso === '') return undefined;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return undefined;
  return String(BigInt(ms) * 1_000_000n);
}

function attr(key: string, value: string | number | boolean | undefined): OtlpAttribute | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return { key, value: { stringValue: value } };
  if (typeof value === 'boolean') return { key, value: { boolValue: value } };
  if (Number.isInteger(value)) return { key, value: { intValue: String(value) } };
  return { key, value: { doubleValue: value } };
}

function attrs(list: Array<OtlpAttrInput>): OtlpAttribute[] {
  return list.flatMap(entry => {
    const attribute = attr(entry[0], entry[1]);
    return attribute ? [attribute] : [];
  });
}
type OtlpAttrInput = [key: string, value: string | number | boolean | undefined];

/** Outcome values that mean the span did not end well (zeus branch outcomes
 *  plus model-call errors). Everything else exports without a status. */
function isErrorSpan(span: TraceSpan): boolean {
  if (span.call?.error !== undefined) return true;
  return span.outcome === 'failed' || span.outcome === 'timeout' || span.outcome === 'canceled';
}

/**
 * Span-name mapping (GenAI semconv shapes, kept literal about what zeus knows):
 *  - intent root / branch / dag-node → agent spans (`execute_task`); the root
 *    carries the intent id as `zeus.intent.id`, branches carry the invoked
 *    vassal as `gen_ai.agent.name` and the skill as `zeus.skill`;
 *  - model → `chat <model>` with gen_ai.system/request.model/usage.* tokens;
 *  - tool → `execute_tool` with `gen_ai.tool.name` (the branch's skill);
 *  - decide / decision-step → zeus decision spans (`zeus.decision_step.name`).
 */
function spanName(span: TraceSpan): string {
  switch (span.kind) {
    case 'model':
      return span.call !== undefined ? `chat ${span.call.model}` : 'chat';
    case 'tool':
      return 'execute_tool';
    case 'decision-step':
      return `decision-step ${span.step?.name ?? 'unknown'}`;
    case 'decide':
      return 'decide';
    default:
      return 'execute_task';
  }
}

function spanAttributes(span: TraceSpan): OtlpAttribute[] {
  const base: OtlpAttrInput[] = [
    ['zeus.span.kind', span.kind],
    ['gen_ai.conversation.id', span.traceId],
    ['zeus.run_id', span.spanId],
    ['zeus.outcome', span.outcome],
    ['zeus.skill', span.skill],
    ['zeus.realm', span.realm],
  ];
  if (span.kind === 'intent') base.push(['zeus.intent.id', span.spanId]);
  if (span.vassal !== undefined) base.push(['gen_ai.agent.name', span.vassal]);
  if (span.summary !== undefined) base.push(['zeus.span.summary', span.summary]);

  const call = span.call;
  if (call !== undefined) {
    base.push(
      ['gen_ai.operation.name', 'chat'],
      ['gen_ai.system', call.backend],
      ['gen_ai.request.model', call.model],
      ['gen_ai.usage.input_tokens', call.tokensIn],
      ['gen_ai.usage.output_tokens', call.tokensOut],
      ['gen_ai.usage.reasoning_tokens', call.reasoningTokens],
      ['gen_ai.usage.cache_read.input_tokens', call.cacheReadTokens],
      ['gen_ai.response.finish_reasons', call.error !== undefined ? 'error' : 'stop'],
      ['zeus.call.kind', call.kind],
      ['zeus.cost_micros', call.costMicros ?? undefined],
      ['zeus.call.latency_ms', call.latencyMs],
      ['zeus.call.error', call.error],
    );
  }
  if (span.kind === 'tool') {
    base.push(['gen_ai.operation.name', 'execute_tool'], ['gen_ai.tool.name', span.skill ?? span.vassal]);
  }
  if (span.step !== undefined) {
    base.push(
      ['zeus.decision_step.name', span.step.name],
      ['zeus.decision_step.vassals', span.step.vassals?.join(',')],
      ['zeus.decision_step.conclusion', span.step.conclusion],
    );
  }
  return attrs(base);
}

function spanEvent(span: TraceSpan): Array<{ timeUnixNano?: string; name: string; attributes?: OtlpAttribute[] }> {
  return span.events.map(event => {
    const at = unixNano(event.at);
    return {
      name: event.kind,
      ...(at !== undefined ? { timeUnixNano: at } : {}),
      ...(event.detail !== undefined ? { attributes: attrs([['zeus.event.detail', event.detail]]) } : {}),
    };
  });
}

export type OtlpTraceExporterOptions = {
  /** OTLP/HTTP JSON endpoint, e.g. http://127.0.0.1:4318/v1/traces. */
  endpoint: string;
  /** Optional static headers (e.g. collector auth). */
  headers?: Record<string, string>;
  /** Resource service.name (default `zeus`). */
  serviceName?: string;
  /** Injectable transport; default globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Fail-soft failure sink (boot wires the operator audit-error channel). */
  log?: (event: string, message?: string) => void;
};

export type OtlpSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano?: string;
  endTimeUnixNano?: string;
  attributes?: OtlpAttribute[];
  events?: Array<{ timeUnixNano?: string; name: string; attributes?: OtlpAttribute[] }>;
  status?: { code: number; message?: string };
};

export type OtlpExportPayload = {
  resourceSpans: Array<{
    resource: { attributes: OtlpAttribute[] };
    scopeSpans: Array<{ scope: { name: string }; spans: OtlpSpan[] }>;
  }>;
};

/**
 * Convert one zeus trace tree into an OTLP/HTTP JSON payload. Exported for
 * tests; the exporter itself is the only production caller.
 */
export function toOtlpPayload(tree: TraceTree, serviceName = 'zeus'): OtlpExportPayload {
  // The projection keeps the intent root separate from tree.spans (its spanId
  // is the intent id, not a branch runId); the OTLP face exports it like any
  // other span so the trace has a root upstream too.
  const spans: OtlpSpan[] = [tree.root, ...tree.spans].map(span => {
    const started = unixNano(span.startedAt);
    const ended = unixNano(span.endedAt);
    const error = errorMessageOf(span);
    return {
      traceId: otlpTraceId(tree.traceId),
      spanId: otlpSpanId(tree.traceId, span.spanId),
      ...(span.parentSpanId !== undefined ? { parentSpanId: otlpSpanId(tree.traceId, span.parentSpanId) } : {}),
      name: spanName(span),
      kind: span.kind === 'model' ? SPAN_KIND_CLIENT : SPAN_KIND_INTERNAL,
      ...(started !== undefined ? { startTimeUnixNano: started } : {}),
      ...(ended !== undefined ? { endTimeUnixNano: ended } : {}),
      attributes: spanAttributes(span),
      ...(span.events.length > 0 ? { events: spanEvent(span) } : {}),
      ...(isErrorSpan(span) ? { status: { code: STATUS_ERROR, ...(error !== undefined ? { message: error } : {}) } } : {}),
    };
  });
  return {
    resourceSpans: [
      {
        resource: {
          attributes: attrs([
            ['service.name', serviceName],
            ['zeus.exporter', 'otlp-json'],
          ]),
        },
        scopeSpans: [{ scope: { name: 'zeus.observability' }, spans }],
      },
    ],
  };
}

/** The refusal reason crosses the wire (clients branch on it); D-4 redaction
 *  already applied upstream, so the call error is the honest status message. */
function errorMessageOf(span: TraceSpan): string | undefined {
  return span.call?.error ?? span.summary;
}

export class OtlpTraceExporter implements TraceExporter {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OtlpTraceExporterOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  /** POST one tree; every failure path resolves (fail-soft, log-only). */
  async export(tree: TraceTree): Promise<void> {
    const payload = toOtlpPayload(tree, this.options.serviceName);
    try {
      const response = await this.fetchImpl(this.options.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.options.headers ?? {}),
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        this.options.log?.('otlp-export-failed', `HTTP ${response.status} from ${this.options.endpoint}`);
        await response.body?.cancel().catch(() => {});
      }
    } catch (error) {
      this.options.log?.('otlp-export-failed', error instanceof Error ? error.message : String(error));
    }
  }
}
