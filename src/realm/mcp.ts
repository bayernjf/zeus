/**
 * Minimal MCP (Model Context Protocol) JSON-RPC surface for a Realm.
 *
 * Scope (P1 scaffold, design-realm.md §6.1):
 *  - resources map to manifest/search/read.
 *  - tools: realm.search / realm.read (read access through the same store) and
 *    realm.write, which is the E3.4 remaining write step. The realmId whitelist
 *    is still the domain boundary for all three.
 *  - realm.write carries no special authority of its own: an ENTERPRISE write is
 *    refused unless the caller presents a signed, unexpired, single-use
 *    DriverWriteGrant for that exact realmId (E3.5), and a personal realm takes
 *    no grant — the same contract every other write path in the kernel obeys.
 *    The grant is verified by the store, never here.
 *  - This is a transport-agnostic, dependency-free message handler: it speaks
 *    newline-delimited JSON-RPC semantics but does no I/O. mcp-stdio.ts wires
 *    it to stdin/stdout. No @modelcontextprotocol/sdk dependency by design;
 *    compatibility with a specific SDK version is to be re-verified when the
 *    real read-realm vassal triggers the formal P1 start.
 *
 * Path non-disclosure invariant (design-realm.md §1.3, types.ts RealmManifest.root):
 *  - connect is NOT exposed over MCP; realms are pre-connected by the host.
 *  - the absolute root is stripped from every manifest before serialization
 *    and never appears in any response; only realmId + root-relative itemIds.
 *  - tools/call follows the same rule: it accepts realmIds the host authorized
 *    and root-relative itemIds, and error messages never carry absolute paths.
 *
 * Kernel read-only face (design P1-1):
 *  - zeus.skills / zeus.plan / zeus.status read kernel-internal registries
 *    through the injected PersonalKernelQueries port. They bypass the realmId
 *    whitelist on purpose - they never touch a connected realm - and their
 *    output is a designed subset that carries no absolute path.
 *  - The port is optional. When the host did not mount it, calling a zeus.*
 *    tool fails closed with a named error instead of returning an empty result
 *    a client would read as "nothing exists".
 *  - This face is read-only by contract: it offers no execute, no write, no
 *    remote call. Execution stays on the signed-ticket + HTTP face.
 */
import type {
  DriverWriteGrant,
  RealmItem,
  RealmManifest,
  RealmStore,
  RealmWriteItem,
  SearchQuery,
} from './types.js';
import {
  InvalidItemIdError,
  RealmNotConnectedError,
  UnauthorizedRealmWriteError,
  UnsupportedQueryError,
  UnsupportedWriteError,
} from './types.js';

export const JSONRPC_VERSION = '2.0' as const;
export const REALM_URI_SCHEME = 'zeus-realm:';

/** Newest first; the server negotiates down to the highest version the client sent. */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
const PREFERRED_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

// JSON-RPC error codes (standard) + server-defined application range (-32000..-32099).
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const REALM_ERROR = -32000;
const REALM_NOT_CONNECTED = -32002;
const INVALID_ITEM = -32003;
/** A write the store refused: read-only realm, or a grant that failed a named check. */
const REALM_UNAUTHORIZED = -32004;

export type JsonRpcId = string | number | null;

export type JsonRpcRequest = {
  jsonrpc: typeof JSONRPC_VERSION;
  id?: JsonRpcId;
  method: string;
  params?: unknown;
};

export type JsonRpcError = { code: number; message: string };

export type JsonRpcResponse = {
  jsonrpc: typeof JSONRPC_VERSION;
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
};

export type McpHandlerDeps = {
  store: RealmStore;
  /** Pre-connected realmIds the host authorizes this server to expose. */
  realmIds: string[];
  serverName?: string;
  serverVersion?: string;
  /**
   * Session-scoped actor (design-realm §6.5, deferred #18 ruling #1): the host
   * explicitly declares who is calling. When the actor also declares realmIds,
   * the effective whitelist is the intersection with deps.realmIds — the actor
   * can only ever narrow, never widen, the host's pre-connected boundary.
   * Absent an actor, the call stays anonymous with the full host whitelist.
   */
  actor?: RealmMcpActor;
  /**
   * Sink for fault details whose JSON-RPC response must stay generic
   * (store errors may carry the realm-local absolute root). Absent = the
   * detail is dropped after the fixed response is produced.
   */
  log?: (event: string, msg?: string, fields?: Record<string, unknown>) => void;
  /**
   * Read-only kernel queries (design P1-1). When absent, the zeus.* tools are
   * advertised by tools/list but fail closed on tools/call - never answered
   * with fabricated empty data.
   */
  kernelQueries?: PersonalKernelQueries;
};

/** Session-scoped caller identity (design-realm §6.5). */
export type RealmMcpActor = {
  name: string;
  /** Optional narrowing of the host whitelist for this session. */
  realmIds?: string[];
};

/**
 * Dependency-inverted read-only kernel port for the zeus.* tools. The handler
 * never reaches for a live kernel: the host (mcp-stdio.ts) implements this
 * port over a booted, read-only kernel, so this file stays transport-agnostic
 * and dependency-free. Every method is read-only; the shapes below deliberately
 * omit absolute paths (realms expose realmId/type/readOnly, never root).
 */
export type PersonalKernelQueries = {
  listSkills(filter?: {
    domain?: string;
    tag?: string;
  }): Promise<
    Array<{
      id: string;
      name: string;
      description?: string;
      version: string;
      domain?: string;
      tags: string[];
    }>
  >;
  getSkill(
    id: string,
    version?: string
  ): Promise<
    | {
        id: string;
        name: string;
        description?: string;
        version: string;
        domain?: string;
        tags: string[];
      }
    | undefined
  >;
  plan(input: {
    text: string;
    realm?: 'personal' | 'enterprise';
  }): Promise<{
    ok: boolean;
    chosenBy: string;
    skill?: string;
    confidence?: number;
    candidates: Array<{ skill: string; score: number }>;
    reason?: string;
    detail?: string;
  }>;
  status(): Promise<{
    ts: string;
    realms: Array<{ realmId: string; type: string; readOnly: boolean }>;
    agents: { activeCount: number; names: string[] };
    pendingOversight: number;
    watches: number;
  }>;
};

export function createRealmMcpHandler(deps: McpHandlerDeps): (message: unknown) => Promise<JsonRpcResponse | null> {
  const serverName = deps.serverName ?? 'zeus-realm';
  const serverVersion = deps.serverVersion ?? '0.1.0';
  // §6.5: the actor can only narrow. The effective boundary is the host
  // whitelist intersected with the actor's declared realms (if any).
  const effectiveRealmIds =
    deps.actor?.realmIds && deps.actor.realmIds.length > 0
      ? deps.realmIds.filter(realmId => deps.actor!.realmIds!.includes(realmId))
      : deps.realmIds;

  function ok(id: JsonRpcId, result: unknown): JsonRpcResponse {
    return { jsonrpc: JSONRPC_VERSION, id, result };
  }
  function fail(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
    return { jsonrpc: JSONRPC_VERSION, id, error: { code, message } };
  }

  return async function handle(message: unknown): Promise<JsonRpcResponse | null> {
    if (typeof message !== 'object' || message === null) {
      return fail(null, INVALID_REQUEST, 'invalid request: expected JSON object');
    }
    const req = message as Partial<JsonRpcRequest>;
    if (typeof req.method !== 'string' || req.method.length === 0) {
      return fail(coerceId(req.id) ?? null, INVALID_REQUEST, 'invalid request: missing method');
    }
    // Notifications carry no id and get no response (initialized, cancellations, ...).
    if (req.id === undefined) return null;
    const id = coerceId(req.id) ?? null;

    try {
      switch (req.method) {
        case 'initialize':
          return ok(id, initializeResult(req.params, serverName, serverVersion, deps.actor?.name));
        case 'ping':
          return ok(id, {});
        case 'resources/list':
          return ok(id, { resources: listResources(effectiveRealmIds) });
        case 'resources/templates/list':
          return ok(id, { resourceTemplates: RESOURCE_TEMPLATES });
        case 'resources/read':
          return ok(id, { contents: await readResource(deps.store, effectiveRealmIds, req.params) });
        case 'tools/list':
          return ok(id, { tools: [...REALM_TOOLS, ...KERNEL_TOOLS] });
        case 'tools/call':
          return ok(id, { content: await callTool(deps.store, effectiveRealmIds, deps.kernelQueries, req.params) });
        default:
          return fail(id, METHOD_NOT_FOUND, `method not found: ${req.method}`);
      }
    } catch (error) {
      return mapError(id, error, deps.log);
    }
  };
}

function coerceId(value: unknown): JsonRpcId | undefined {
  if (typeof value === 'string' || typeof value === 'number') return value;
  return undefined;
}

function initializeResult(params: unknown, serverName: string, serverVersion: string, actorName?: string) {
  const requested = (params as { protocolVersion?: string } | undefined)?.protocolVersion;
  const negotiated =
    requested && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
      ? requested
      : PREFERRED_PROTOCOL_VERSION;
  return {
    protocolVersion: negotiated,
    // Realm face: resources plus the tools below. Two of them read; realm.write
    // exists and carries no extra authority — an enterprise write still needs a
    // DriverWriteGrant the store verifies. No prompts.
    capabilities: {
      resources: { listChanged: false, subscribe: false },
      tools: { listChanged: false },
    },
    serverInfo: { name: serverName, version: serverVersion, ...(actorName ? { actor: actorName } : {}) },
  };
}

// --- Tools (Active work 47 §E-4): read-only access through the whitelisted
// realmIds. The whitelist is the domain boundary: a caller cannot point a tool
// at a realm the host did not pre-connect. ---

type ToolDescriptor = {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
};

const REALM_TOOLS: readonly ToolDescriptor[] = [
  {
    name: 'realm.search',
    description: 'Search one connected realm by text; returns root-relative item metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        realmId: { type: 'string', description: 'A realmId the host connected' },
        text: { type: 'string', description: 'Substring filter over item content' },
        since: { type: 'string', description: 'ISO timestamp; only items changed after it' },
        tags: { type: 'string', description: 'Comma-separated tags; NOT supported by the P0 filesystem backend and returns an explicit error' },
        limit: { type: 'number', description: 'Max hits, positive integer' },
      },
      required: ['realmId'],
    },
  },
  {
    name: 'realm.read',
    description: 'Read one item by root-relative itemId from a connected realm.',
    inputSchema: {
      type: 'object',
      properties: {
        realmId: { type: 'string', description: 'A realmId the host connected' },
        itemId: { type: 'string', description: 'Root-relative item path' },
      },
      required: ['realmId', 'itemId'],
    },
  },
  {
    name: 'realm.write',
    description:
      'Write one text item into a connected realm. An ENTERPRISE realm requires a signed, unexpired, single-use DriverWriteGrant for that exact realmId; a personal realm takes no grant. Grants are issued by the driver over POST /api/realm/write-grants.',
    inputSchema: {
      type: 'object',
      properties: {
        realmId: { type: 'string', description: 'A realmId the host connected' },
        data: { type: 'string', description: 'Text written verbatim; JSON-compatible values are serialized' },
        itemId: { type: 'string', description: 'Root-relative POSIX path; omitted lets the store mint one under writes/' },
        grant: { type: 'object', description: 'DriverWriteGrant for an enterprise realm; refused by name when absent, unsigned, expired, replayed or bound to another realm' },
      },
      required: ['realmId', 'data'],
    },
  },
];

const KERNEL_TOOLS: readonly ToolDescriptor[] = [
  {
    name: 'zeus.skills',
    description:
      'Read the kernel skill catalogue. Without id, list (optionally filtered by domain/tag); with id, fetch one skill. No realmId needed; read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'When present, return exactly this skill (latest version unless version is also given)' },
        version: { type: 'string', description: 'Semver version; only meaningful with id' },
        domain: { type: 'string', description: 'Catalogue filter by capability domain' },
        tag: { type: 'string', description: 'Catalogue filter by tag' },
      },
      required: [],
    },
  },
  {
    name: 'zeus.plan',
    description:
      'Recognize a natural-language instruction against the local skill catalogue (plan-only: returns chosenBy/skill/candidates or a named reason; local ranker, zero outbound; never executes).',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The operator instruction in natural language' },
        realm: { type: 'string', description: "'personal' (default) or 'enterprise'" },
      },
      required: ['text'],
    },
  },
  {
    name: 'zeus.status',
    description:
      'Read-only kernel status: connected realms (realmId/type/readOnly, never absolute paths), active agents, pending oversight count, watches count.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];

async function callTool(
  store: RealmStore,
  realmIds: string[],
  kernelQueries: PersonalKernelQueries | undefined,
  params: unknown
): Promise<Array<{ type: 'text'; text: string }>> {
  const { name, arguments: args } = (params ?? {}) as { name?: unknown; arguments?: Record<string, unknown> };
  if (typeof name !== 'string' || name.length === 0) {
    throw new McpParamError(`unknown tool: ${String(name)}`);
  }
  // The kernel face is its own boundary: it never goes through the realmId
  // whitelist (it does not address a realm at all) and never writes.
  if (name.startsWith('zeus.')) {
    return callKernelTool(kernelQueries, name, args);
  }
  if (!REALM_TOOLS.some(tool => tool.name === name)) {
    throw new McpParamError(`unknown tool: ${name}`);
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new McpParamError('tools/call requires an arguments object');
  }
  const realmId = args.realmId;
  if (typeof realmId !== 'string' || !realmIds.includes(realmId)) {
    throw new RealmNotConnectedMcpError(typeof realmId === 'string' ? realmId : '?');
  }

  if (name === 'realm.search') {
    const query = toolSearchQuery(args);
    const hits = await store.search(realmId, query);
    return [{ type: 'text', text: JSON.stringify(hits) }];
  }

  if (name === 'realm.write') {
    // `RealmStore.write` is optional: a read-only deployment or a P0 backend
    // may not implement it at all. Refuse by name instead of invoking undefined.
    if (typeof store.write !== 'function') {
      throw new McpParamError(
        'realm.write is unavailable: the connected realm store does not implement writes',
      );
    }
    const write = await store.write(realmId, toolWriteItem(args), toolWriteGrant(args));
    return [{ type: 'text', text: JSON.stringify(write) }];
  }

  const itemId = args.itemId;
  if (typeof itemId !== 'string' || itemId.trim() === '') {
    throw new McpParamError('realm.read requires a root-relative itemId string');
  }
  const item: RealmItem = await store.read(realmId, itemId);
  return [{ type: 'text', text: item.content }];
}

// --- Kernel face (design P1-1): zeus.skills / zeus.plan / zeus.status. ---

/** Non-empty kernel-argument string; the schema never declares a free-form blob. */
function asKernelString(value: unknown, key: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new McpParamError(`${key} must be a non-empty string, got: ${String(value)}`);
  }
  return value;
}

async function callKernelTool(
  kernelQueries: PersonalKernelQueries | undefined,
  name: string,
  args: unknown
): Promise<Array<{ type: 'text'; text: string }>> {
  if (!kernelQueries) {
    // Fail closed: the host advertised these tools (tools/list is static) but
    // never mounted the read-only port. Say so by name - an empty catalogue or
    // an empty status would be read as "the kernel has nothing", which is a lie
    // the client would act on.
    throw new KernelNotMountedError(name);
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new McpParamError('tools/call requires an arguments object');
  }
  const kernelArgs = args as Record<string, unknown>;

  if (name === 'zeus.skills') {
    const known = new Set(['id', 'version', 'domain', 'tag']);
    for (const key of Object.keys(kernelArgs)) {
      if (!known.has(key)) {
        throw new McpParamError(`unsupported skills parameter: ${key} (supported: id, version, domain, tag)`);
      }
    }
    const id = kernelArgs.id === undefined ? undefined : asKernelString(kernelArgs.id, 'id');
    const version = kernelArgs.version === undefined ? undefined : asKernelString(kernelArgs.version, 'version');
    const domain = kernelArgs.domain === undefined ? undefined : asKernelString(kernelArgs.domain, 'domain');
    const tag = kernelArgs.tag === undefined ? undefined : asKernelString(kernelArgs.tag, 'tag');
    if (id !== undefined) {
      const skill = await kernelQueries.getSkill(id, version);
      if (!skill) {
        return [
          {
            type: 'text',
            text: JSON.stringify({
              ok: false,
              reason: 'not-found',
              id,
              ...(version !== undefined ? { version } : {}),
            }),
          },
        ];
      }
      return [{ type: 'text', text: JSON.stringify(skill) }];
    }
    const skills = await kernelQueries.listSkills({
      ...(domain !== undefined ? { domain } : {}),
      ...(tag !== undefined ? { tag } : {}),
    });
    return [{ type: 'text', text: JSON.stringify(skills) }];
  }

  if (name === 'zeus.plan') {
    const known = new Set(['text', 'realm']);
    for (const key of Object.keys(kernelArgs)) {
      if (!known.has(key)) {
        throw new McpParamError(`unsupported plan parameter: ${key} (supported: text, realm)`);
      }
    }
    const text = asKernelString(kernelArgs.text, 'text');
    let realm: 'personal' | 'enterprise' | undefined;
    if (kernelArgs.realm !== undefined) {
      if (kernelArgs.realm !== 'personal' && kernelArgs.realm !== 'enterprise') {
        throw new McpParamError(`realm must be 'personal' or 'enterprise', got: ${String(kernelArgs.realm)}`);
      }
      realm = kernelArgs.realm;
    }
    const result = await kernelQueries.plan({ text, ...(realm !== undefined ? { realm } : {}) });
    return [{ type: 'text', text: JSON.stringify(result) }];
  }

  if (name === 'zeus.status') {
    const extra = Object.keys(kernelArgs);
    if (extra.length > 0) {
      throw new McpParamError(`zeus.status takes no arguments (got: ${extra.join(', ')})`);
    }
    const status = await kernelQueries.status();
    return [{ type: 'text', text: JSON.stringify(status) }];
  }

  throw new McpParamError(`unknown tool: ${name}`);
}

/**
 * E3.4 remaining item (1): the write step. Same fail-loud contract as the search
 * arguments (deferred #31): an argument the schema never declared is rejected by
 * name rather than ignored.
 */
function toolWriteItem(args: Record<string, unknown>): RealmWriteItem {
  const known = new Set(['realmId', 'data', 'itemId', 'grant']);
  for (const name of Object.keys(args)) {
    if (!known.has(name)) {
      throw new McpParamError(`unsupported write parameter: ${name} (supported: data, itemId, grant)`);
    }
  }
  if (!('data' in args)) {
    throw new McpParamError('realm.write requires a data payload');
  }
  const item: RealmWriteItem = { data: args.data as unknown };
  if (args.itemId !== undefined) {
    if (typeof args.itemId !== 'string' || args.itemId.trim() === '') {
      throw new McpParamError(`itemId must be a non-empty root-relative string, got: ${String(args.itemId)}`);
    }
    item.itemId = args.itemId;
  }
  return item;
}

/**
 * The grant is handed to the store untouched on purpose: shape, realm binding,
 * signature, expiry and single-use are verified by `verifyDriverWriteGrant`,
 * which every write path shares. A second verification here would be a second
 * answer to the same question, and the day they disagree one of them is wrong.
 */
function toolWriteGrant(args: Record<string, unknown>): DriverWriteGrant | undefined {
  if (args.grant === undefined) return undefined;
  const grant = args.grant;
  if (typeof grant !== 'object' || grant === null || Array.isArray(grant)) {
    throw new McpParamError('grant must be a DriverWriteGrant object when present');
  }
  return grant as DriverWriteGrant;
}

function toolSearchQuery(args: Record<string, unknown>): SearchQuery {
  const query: SearchQuery = {};
  // Same fail-loud contract as the resource URI (deferred #31): an argument the
  // schema never declared is rejected, and tags is forwarded so the P0 backend
  // returns its explicit "unsupported" error instead of unfiltered hits.
  const known = new Set(['realmId', 'text', 'since', 'limit', 'tags']);
  for (const name of Object.keys(args)) {
    if (!known.has(name)) {
      throw new McpParamError(`unsupported search parameter: ${name} (supported: text, since, limit, tags)`);
    }
  }
  if (typeof args.text === 'string' && args.text.trim()) query.text = args.text;
  if (typeof args.since === 'string' && args.since.trim()) query.since = args.since;
  if (args.tags !== undefined) {
    if (typeof args.tags !== 'string' || !args.tags.trim()) {
      throw new McpParamError(`tags must be a non-empty comma-separated string, got: ${String(args.tags)}`);
    }
    query.tags = args.tags.split(',').map(tag => tag.trim()).filter(Boolean);
  }
  if (args.limit !== undefined) {
    if (typeof args.limit !== 'number' || !Number.isFinite(args.limit) || args.limit < 1) {
      throw new McpParamError(`limit must be a positive number, got: ${String(args.limit)}`);
    }
    query.limit = Math.floor(args.limit);
  }
  return query;
}

// --- URI scheme: zeus-realm://<realmId>/(manifest|search|item) ---

export function manifestUri(realmId: string): string {
  return `${REALM_URI_SCHEME}//${realmId}/manifest`;
}
export function searchUri(realmId: string): string {
  return `${REALM_URI_SCHEME}//${realmId}/search`;
}

type ResourceDescriptor = { uri: string; name: string; mimeType?: string };
type ResourceTemplateDescriptor = { name: string; uriTemplate: string; mimeType?: string };

function listResources(realmIds: string[]): ResourceDescriptor[] {
  return realmIds.flatMap(realmId => [
    { uri: manifestUri(realmId), name: `Realm manifest (${realmId})`, mimeType: 'application/json' },
    { uri: searchUri(realmId), name: `Realm search (${realmId})`, mimeType: 'application/json' },
  ]);
}

const RESOURCE_TEMPLATES: ResourceTemplateDescriptor[] = [
  { name: 'Realm manifest', uriTemplate: 'zeus-realm://{realmId}/manifest', mimeType: 'application/json' },
  {
    name: 'Search realm items',
    uriTemplate: 'zeus-realm://{realmId}/search?text={text}&since={since}&limit={limit}&tags={tags}',
    mimeType: 'application/json',
  },
  { name: 'Read one realm item', uriTemplate: 'zeus-realm://{realmId}/item?path={path}', mimeType: 'text/plain' },
];

type ParsedRealmUri = { realmId: string; kind: 'manifest' | 'search' | 'item'; url: URL };

function parseRealmUri(rawUri: unknown, realmIds: string[]): ParsedRealmUri {
  if (typeof rawUri !== 'string' || rawUri.length === 0) {
    throw new McpParamError('resources/read requires a string uri');
  }
  let url: URL;
  try {
    url = new URL(rawUri);
  } catch {
    throw new McpParamError(`malformed uri: ${rawUri}`);
  }
  if (url.protocol !== REALM_URI_SCHEME) {
    throw new McpParamError(`unsupported uri scheme (expected ${REALM_URI_SCHEME}//): ${rawUri}`);
  }
  const realmId = url.hostname;
  if (!realmIds.includes(realmId)) {
    throw new RealmNotConnectedMcpError(realmId);
  }
  const kind = url.pathname.replace(/^\//, '') as ParsedRealmUri['kind'];
  if (kind !== 'manifest' && kind !== 'search' && kind !== 'item') {
    throw new McpParamError(`unknown realm resource: ${url.pathname}`);
  }
  return { realmId, kind, url };
}

async function readResource(store: RealmStore, realmIds: string[], params: unknown): Promise<unknown[]> {
  const uri = (params as { uri?: unknown } | undefined)?.uri;
  const parsed = parseRealmUri(uri, realmIds);

  if (parsed.kind === 'manifest') {
    const manifest = await store.manifest(parsed.realmId);
    return [
      {
        uri: parsed.url.href,
        mimeType: 'application/json',
        text: JSON.stringify(publicManifest(manifest)),
      },
    ];
  }

  if (parsed.kind === 'search') {
    const query = parseSearchQuery(parsed.url);
    const hits = await store.search(parsed.realmId, query);
    return [{ uri: parsed.url.href, mimeType: 'application/json', text: JSON.stringify(hits) }];
  }

  const itemId = parsed.url.searchParams.get('path');
  if (!itemId) throw new McpParamError('item resource requires a root-relative path query parameter');
  const item: RealmItem = await store.read(parsed.realmId, itemId);
  return [{ uri: parsed.url.href, mimeType: 'text/plain', text: item.content }];
}

function parseSearchQuery(url: URL): SearchQuery {
  const query: SearchQuery = {};
  const text = url.searchParams.get('text');
  if (text !== null && text.trim()) query.text = text;
  const since = url.searchParams.get('since');
  if (since !== null && since.trim()) query.since = since;
  const limitRaw = url.searchParams.get('limit');
  if (limitRaw !== null && limitRaw.trim()) {
    const limit = Number(limitRaw);
    if (!Number.isFinite(limit) || limit < 1) {
      throw new McpParamError(`limit must be a positive integer, got: ${limitRaw}`);
    }
    query.limit = Math.floor(limit);
  }
  const tagsRaw = url.searchParams.get('tags');
  if (tagsRaw !== null && tagsRaw.trim()) {
    // Forwarded rather than dropped: the P0 filesystem backend rejects tag search
    // explicitly (UnsupportedQueryError -> -32602), so a client asking for it
    // sees the refusal instead of silently receiving unfiltered hits (deferred #31).
    query.tags = tagsRaw.split(',').map(tag => tag.trim()).filter(Boolean);
  }
  // Fail loud on parameters the resource template never declared: a dropped name
  // would otherwise read as "filter applied" while returning the full result set.
  const known = new Set(['text', 'since', 'limit', 'tags']);
  for (const name of url.searchParams.keys()) {
    if (!known.has(name)) {
      throw new McpParamError(`unsupported search parameter: ${name} (supported: text, since, limit, tags)`);
    }
  }
  return query;
}

/** Strip the in-process-only absolute root before any client serialization. */
export function publicManifest(manifest: RealmManifest): Omit<RealmManifest, 'root'> {
  const { root: _root, ...publicPart } = manifest;
  return publicPart;
}

class McpParamError extends Error {}
class RealmNotConnectedMcpError extends Error {
  constructor(readonly realmId: string) {
    super(`realm not connected: ${realmId}`);
    this.name = 'RealmNotConnectedMcpError';
  }
}
/** A zeus.* tool was called but the host did not mount the read-only kernel port. */
class KernelNotMountedError extends Error {
  constructor(readonly tool: string) {
    super(`${tool} unavailable: kernel queries not mounted`);
    this.name = 'KernelNotMountedError';
  }
}

function mapError(
  id: JsonRpcId,
  error: unknown,
  log?: (event: string, msg?: string, fields?: Record<string, unknown>) => void,
): JsonRpcResponse {
  if (
    error instanceof McpParamError ||
    error instanceof UnsupportedQueryError ||
    error instanceof KernelNotMountedError
  ) {
    return errorResponse(id, INVALID_PARAMS, (error as Error).message);
  }
  if (error instanceof RealmNotConnectedError || error instanceof RealmNotConnectedMcpError) {
    return errorResponse(id, REALM_NOT_CONNECTED, (error as Error).message);
  }
  if (error instanceof InvalidItemIdError) {
    // InvalidItemIdError messages carry only the root-relative itemId, never the root.
    return errorResponse(id, INVALID_ITEM, error.message);
  }
  if (error instanceof UnauthorizedRealmWriteError) {
    // The refusal REASON crosses the boundary, not the prose: a client branches
    // on "grant-expired" vs "grant-bad-signature", and neither message carries a
    // path. The store is the only place that decides this, so the name is read
    // off the error rather than re-derived here.
    return errorResponse(id, REALM_UNAUTHORIZED, `write refused: ${error.reason}`);
  }
  if (error instanceof UnsupportedWriteError) {
    // Same contract as the P0 tag refusal on the read path (deferred #31): the
    // backend states what it cannot do instead of silently accepting less.
    return errorResponse(id, INVALID_PARAMS, error.message);
  }
  // Anything else is a store/transport fault: its message may carry the
  // realm-local absolute root (EACCES, ENOSPC, ...), which must never cross the
  // JSON-RPC boundary. Answer with the fixed code+message instead; the raw
  // detail goes only to the host-supplied log sink, if any.
  log?.('realm-mcp-error', error instanceof Error ? error.message : String(error));
  return errorResponse(id, REALM_ERROR, 'realm error');
}

function errorResponse(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: JSONRPC_VERSION, id, error: { code, message } };
}

export const JSON_RPC_CODES = {
  PARSE_ERROR,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  INVALID_PARAMS,
  INTERNAL_ERROR,
  REALM_ERROR,
  REALM_NOT_CONNECTED,
  INVALID_ITEM,
  REALM_UNAUTHORIZED,
} as const;
