/**
 * G6 (Tier0 gap G6, design-observability §5): read-only MCP tool face over the
 * kernel's memory recall and trace query.
 *
 * Scope — exactly two tools, both read-only by contract:
 *  - `memory.recall`: MemoryPort v1 §7 semantics over MCP. The caller's memory
 *    service token binds one namespace (the same ZEUS_MEMORY_SERVICE_TOKENS
 *    material the HTTP consumer face uses); a claimed namespace that differs
 *    from the bound one is refused through MemoryBoundaryError — the same
 *    refusal class the store raises on every cross-realm read. The driver
 *    token names its namespace explicitly, like the bearer memory face does.
 *  - `traces.query`: a transparent pass-through of the TracePort v1 §5 query
 *    (the same `queryTraceTrees` projection `GET /api/v1/traces` serves, D-4
 *    redaction and bounds included). Driver-token only: a memory consumer's
 *    scope is one namespace of memory, never the observability face.
 *
 * Deliberately NOT here (contract v1 §7): remember/forget. Writes stay on the
 * HTTP consumer face, where the erasure is persisted before the answer
 * (M-12) and every write is audited; a second write surface would double the
 * paths that durability and audit guarantees have to cover.
 *
 * Transport-agnostic like realm/mcp.ts: newline-delimited JSON-RPC semantics,
 * no I/O, no SDK. The HTTP route (POST /api/mcp) resolves the caller's token
 * into an actor and builds one handler per call. Unmounted backing stores fail
 * closed by name — never an empty result a client would read as "nothing
 * exists".
 */
import { MemoryBoundaryError } from '../memory/memory-store.js';
import type { MemoryStore } from '../memory/memory-store.js';
import type { JsonlTraceExporter } from '../observability/exporter.js';
import { queryTraceTrees } from '../observability/trace-query.js';
import { sha256Hex } from '../util/crypto.js';

export const KERNEL_MCP_PROTOCOL_VERSION = '2025-06-18' as const;

// JSON-RPC standard codes + the server-defined application range.
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
/** Permission / realm-boundary refusal (same application range realm/mcp.ts uses). */
const PERMISSION_DENIED = -32004;
/** A tool whose backing store the host did not mount. */
const NOT_MOUNTED = -32005;

export const KERNEL_MCP_ERROR_CODES = {
  METHOD_NOT_FOUND,
  INVALID_PARAMS,
  PERMISSION_DENIED,
  NOT_MOUNTED,
} as const;

/** Who is calling, resolved by the transport from the presented token. */
export type KernelMcpActor =
  | { kind: 'driver' }
  | { kind: 'memory-consumer'; namespace: string };

export type KernelToolsMcpDeps = {
  actor: KernelMcpActor;
  memoryStore?: MemoryStore;
  traceExporter?: JsonlTraceExporter;
  /** Consumer-face audit (content hashes only); wired by the process entry. */
  memoryServiceAudit?: (decision: 'memory-service-call', detail: string) => void;
  /** Sink for fault details the JSON-RPC body must stay generic about. */
  log?: (event: string, msg?: string) => void;
};

type ToolDescriptor = {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
};

/**
 * Both descriptors say "read-only" in so many words: an MCP client choosing a
 * tool from this list should never discover a write capability it was not
 * designed to have.
 */
const TOOLS: readonly ToolDescriptor[] = [
  {
    name: 'memory.recall',
    description:
      'Read-only recall over one realm\'s consolidated memory (MemoryPort v1 §7 semantics). ' +
      'Your memory service token binds exactly one namespace; claiming another is refused. ' +
      'No write surface exists here — remember/forget stay on the HTTP consumer face.',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'Realm to recall from; defaults to your token-bound namespace, and any other value is refused' },
        query: { type: 'string', description: 'Natural-language recall query' },
        k: { type: 'number', description: 'Max hits (positive integer)' },
        kinds: { type: 'string', description: 'Comma-separated kind filter: preference|fact|decision|episodic' },
      },
      required: ['query'],
    },
  },
  {
    name: 'traces.query',
    description:
      'Read-only cross-intent trace query (TracePort v1 §5): settled span trees filtered by agent/time window/cost band/trace id, plus an aggregate summary. ' +
      'Driver token only; payloads are redacted and size-bounded before they leave the process. No export, no mutation.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Vassal seen anywhere in the tree' },
        from: { type: 'string', description: 'ISO timestamp lower bound on the tree start' },
        to: { type: 'string', description: 'ISO timestamp upper bound on the tree start' },
        min_cost_micros: { type: 'number', description: 'Non-negative integer; tree total cost lower bound' },
        max_cost_micros: { type: 'number', description: 'Non-negative integer; tree total cost upper bound' },
        trace_id: { type: 'string', description: 'Exact trace id' },
        limit: { type: 'number', description: 'Max trees (default 50, capped 200)' },
      },
      required: [],
    },
  },
];

/** JSON-RPC ids are strings or numbers; anything else is treated as null. */
function coerceId(value: unknown): string | number | null {
  return typeof value === 'string' || typeof value === 'number' ? value : null;
}

class McpParamError extends Error {}class ToolNotMountedError extends Error {
  constructor(readonly tool: string) {
    super(`${tool} unavailable: the backing store is not mounted on this server`);
    this.name = 'ToolNotMountedError';
  }
}
class PermissionDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermissionDeniedError';
  }
}

export type JsonRpcResponse = { jsonrpc: '2.0'; id: string | number | null; result?: unknown; error?: { code: number; message: string } };

/**
 * Build one request-scoped handler. `undefined` result = notification (no
 * response body), mirroring the realm face's transport contract.
 */
export function createKernelToolsMcpHandler(deps: KernelToolsMcpDeps): (message: unknown) => Promise<JsonRpcResponse | null> {
  const ok = (id: string | number | null, result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id, result });
  const fail = (id: string | number | null, code: number, message: string): JsonRpcResponse => ({ jsonrpc: '2.0', id, error: { code, message } });

  return async function handle(message: unknown): Promise<JsonRpcResponse | null> {
    if (typeof message !== 'object' || message === null) return fail(null, INVALID_PARAMS, 'invalid request: expected JSON object');
    const req = message as { id?: unknown; method?: unknown; params?: unknown };
    if (typeof req.method !== 'string' || req.method.length === 0) {
      return fail(coerceId(req.id), INVALID_PARAMS, 'invalid request: missing method');
    }
    if (req.id === undefined) return null; // notification: no response
    const id = coerceId(req.id);

    try {
      switch (req.method) {
        case 'initialize':
          return ok(id, {
            protocolVersion: KERNEL_MCP_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'zeus-kernel', version: '0.1.0' },
          });
        case 'ping':
          return ok(id, {});
        case 'tools/list':
          return ok(id, { tools: TOOLS });
        case 'tools/call':
          return ok(id, { content: await callTool(deps, req.params) });
        default:
          return fail(id, METHOD_NOT_FOUND, `method not found: ${req.method}`);
      }
    } catch (error) {
      if (error instanceof McpParamError) return fail(id, INVALID_PARAMS, error.message);
      if (error instanceof MemoryBoundaryError) {
        // The boundary refusal reason is the message: "realm X cannot read
        // memory of realm Y" — no namespace contents, no paths, safe to serve.
        return fail(id, PERMISSION_DENIED, error.message);
      }
      if (error instanceof PermissionDeniedError) return fail(id, PERMISSION_DENIED, error.message);
      if (error instanceof ToolNotMountedError) return fail(id, NOT_MOUNTED, error.message);
      deps.log?.('kernel-mcp-error', error instanceof Error ? error.message : String(error));
      return fail(id, -32603, 'kernel tool error');
    }
  };
}

async function callTool(deps: KernelToolsMcpDeps, params: unknown): Promise<Array<{ type: 'text'; text: string }>> {
  const { name, arguments: args } = (params ?? {}) as { name?: unknown; arguments?: unknown };
  if (typeof name !== 'string' || name.length === 0) throw new McpParamError('tools/call requires a tool name');
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new McpParamError('tools/call requires an arguments object');
  }
  if (name === 'memory.recall') {
    return [{ type: 'text', text: JSON.stringify(await memoryRecall(deps, args as Record<string, unknown>)) }];
  }
  if (name === 'traces.query') {
    return [{ type: 'text', text: JSON.stringify(await tracesQuery(deps, args as Record<string, unknown>)) }];
  }
  throw new McpParamError(`unknown tool: ${name}`);
}

// --- memory.recall (read-only; namespace-bound) ---

/** Same hit projection the HTTP consumer face serves (contract v1 §7). */
function recallHits(hits: Awaited<ReturnType<MemoryStore['searchRecall']>>) {
  return hits.map(hit => ({
    factId: hit.fact.factId,
    kind: hit.fact.kind ?? 'fact',
    subject: hit.fact.subject,
    predicate: hit.fact.predicate,
    object: hit.fact.object,
    confidence: hit.fact.confidence,
    score: Number(hit.score.toFixed(4)),
    provenance: hit.fact.provenance,
  }));
}

async function memoryRecall(
  deps: KernelToolsMcpDeps,
  args: Record<string, unknown>,
): Promise<{ hits: ReturnType<typeof recallHits> }> {
  if (deps.memoryStore === undefined) throw new ToolNotMountedError('memory.recall');
  for (const key of Object.keys(args)) {
    if (!['namespace', 'query', 'k', 'kinds'].includes(key)) {
      throw new McpParamError(`unsupported recall parameter: ${key} (supported: namespace, query, k, kinds)`);
    }
  }
  const query = args.query;
  if (typeof query !== 'string' || query.trim() === '') {
    throw new McpParamError('query must be a non-empty string');
  }
  let k: number | undefined;
  if (args.k !== undefined) {
    if (typeof args.k !== 'number' || !Number.isInteger(args.k) || args.k < 1) {
      throw new McpParamError('k must be a positive integer');
    }
    k = args.k;
  }
  let kinds: string[] | undefined;
  if (args.kinds !== undefined) {
    if (typeof args.kinds !== 'string' || args.kinds.trim() === '') {
      throw new McpParamError('kinds must be a non-empty comma-separated string');
    }
    kinds = args.kinds.split(',').map(kind => kind.trim()).filter(Boolean);
  }

  // The namespace argument can only ever name the caller's own namespace:
  // a memory consumer's token binds one, and the driver names one explicitly
  // (no implicit default — the internal bearer face requires realmId too).
  // Claiming another namespace is the same cross-realm read the store refuses
  // everywhere else, so the refusal reuses MemoryBoundaryError itself.
  const requested = args.namespace === undefined ? undefined : String(args.namespace);
  if (requested !== undefined && requested.trim() === '') {
    throw new McpParamError('namespace must be a non-empty string when present');
  }
  let namespace: string;
  if (deps.actor.kind === 'driver') {
    if (requested === undefined) throw new McpParamError('namespace is required');
    namespace = requested;
  } else {
    if (requested !== undefined && requested !== deps.actor.namespace) {
      throw new MemoryBoundaryError(`realm ${deps.actor.namespace} cannot read memory of realm ${requested}`);
    }
    namespace = deps.actor.namespace;
  }

  const hits = await deps.memoryStore.searchRecall(namespace, namespace, query, k !== undefined ? { limit: k } : undefined);
  const filtered = kinds !== undefined ? hits.filter(hit => kinds.includes(hit.fact.kind ?? 'fact')) : hits;
  deps.memoryServiceAudit?.(
    'memory-service-call',
    `namespace=${namespace} action=recall channel=mcp actor=${deps.actor.kind} queryHash=${sha256Hex(query).slice(0, 16)} hits=${filtered.length}`,
  );
  return { hits: recallHits(filtered) };
}

// --- traces.query (driver-only; pass-through of the W2-4 query face) ---

const MAX_QUERY_LIMIT = 200;

async function tracesQuery(
  deps: KernelToolsMcpDeps,
  args: Record<string, unknown>,
): Promise<Awaited<ReturnType<typeof queryTraceTrees>>> {
  // Authorization first: an unauthorized caller must not learn whether the
  // exporter is mounted (mount state is configuration, the refusal is policy).
  if (deps.actor.kind !== 'driver') {
    // A memory consumer's scope is one namespace of memory — traces are the
    // driver's observability face and carry no namespace binding at all.
    throw new PermissionDeniedError('traces.query requires the driver token');
  }
  if (deps.traceExporter === undefined) throw new ToolNotMountedError('traces.query');
  for (const key of Object.keys(args)) {
    if (!['agent', 'from', 'to', 'min_cost_micros', 'max_cost_micros', 'trace_id', 'limit'].includes(key)) {
      throw new McpParamError(`unsupported trace query parameter: ${key}`);
    }
  }
  const str = (key: string): string | undefined => {
    const value = args[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.trim() === '') throw new McpParamError(`${key} must be a non-empty string when present`);
    return value;
  };
  const from = str('from');
  const to = str('to');
  if (from !== undefined && Number.isNaN(Date.parse(from))) throw new McpParamError('from must be an ISO timestamp');
  if (to !== undefined && Number.isNaN(Date.parse(to))) throw new McpParamError('to must be an ISO timestamp');
  const micros = (key: string): number | undefined => {
    const value = args[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new McpParamError(`${key} must be a non-negative integer`);
    }
    return value;
  };
  const minCostMicros = micros('min_cost_micros');
  const maxCostMicros = micros('max_cost_micros');
  let limit: number | undefined;
  if (args.limit !== undefined) {
    if (typeof args.limit !== 'number' || !Number.isInteger(args.limit) || args.limit < 1) {
      throw new McpParamError('limit must be a positive integer');
    }
    limit = args.limit;
  }
  // Same projection the HTTP face serves: filter + D-4 sanitize + summary.
  const agent = str('agent');
  const traceId = str('trace_id');
  const filter: Parameters<typeof queryTraceTrees>[1] = {
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    ...(minCostMicros !== undefined ? { minCostMicros } : {}),
    ...(maxCostMicros !== undefined ? { maxCostMicros } : {}),
    ...(agent !== undefined ? { agent } : {}),
    ...(traceId !== undefined ? { traceId } : {}),
    ...(limit !== undefined ? { limit: Math.min(limit, MAX_QUERY_LIMIT) } : {}),
  };
  return queryTraceTrees(await deps.traceExporter.readBack(), filter);
}
