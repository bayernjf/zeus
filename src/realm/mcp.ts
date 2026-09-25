/**
 * Minimal MCP (Model Context Protocol) JSON-RPC surface for a read-only Realm.
 *
 * Scope (P1 scaffold, design-realm.md §6.1):
 *  - resources map to manifest/search/read.
 *  - tools (Active work 47 §E-4): realm.search / realm.read — read-only access
 *    through the same store, with the realmId whitelist as the domain boundary.
 *    No write tool exists (P0 is read-only).
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
 */
import type { RealmItem, RealmManifest, RealmStore, SearchQuery } from './types.js';
import { InvalidItemIdError, RealmNotConnectedError, UnsupportedQueryError } from './types.js';

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
};

export function createRealmMcpHandler(deps: McpHandlerDeps): (message: unknown) => Promise<JsonRpcResponse | null> {
  const serverName = deps.serverName ?? 'zeus-realm';
  const serverVersion = deps.serverVersion ?? '0.1.0';

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
          return ok(id, initializeResult(req.params, serverName, serverVersion));
        case 'ping':
          return ok(id, {});
        case 'resources/list':
          return ok(id, { resources: listResources(deps.realmIds) });
        case 'resources/templates/list':
          return ok(id, { resourceTemplates: RESOURCE_TEMPLATES });
        case 'resources/read':
          return ok(id, { contents: await readResource(deps.store, deps.realmIds, req.params) });
        case 'tools/list':
          return ok(id, { tools: REALM_TOOLS });
        case 'tools/call':
          return ok(id, { content: await callTool(deps.store, deps.realmIds, req.params) });
        default:
          return fail(id, METHOD_NOT_FOUND, `method not found: ${req.method}`);
      }
    } catch (error) {
      return mapError(id, error);
    }
  };
}

function coerceId(value: unknown): JsonRpcId | undefined {
  if (typeof value === 'string' || typeof value === 'number') return value;
  return undefined;
}

function initializeResult(params: unknown, serverName: string, serverVersion: string) {
  const requested = (params as { protocolVersion?: string } | undefined)?.protocolVersion;
  const negotiated =
    requested && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
      ? requested
      : PREFERRED_PROTOCOL_VERSION;
  return {
    protocolVersion: negotiated,
    // Read-only realm: resources plus the two read-only tools below; no write
    // tool, no prompts.
    capabilities: {
      resources: { listChanged: false, subscribe: false },
      tools: { listChanged: false },
    },
    serverInfo: { name: serverName, version: serverVersion },
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
];

async function callTool(store: RealmStore, realmIds: string[], params: unknown): Promise<Array<{ type: 'text'; text: string }>> {
  const { name, arguments: args } = (params ?? {}) as { name?: unknown; arguments?: Record<string, unknown> };
  if (typeof name !== 'string' || !REALM_TOOLS.some(tool => tool.name === name)) {
    throw new McpParamError(`unknown tool: ${String(name)}`);
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

  const itemId = args.itemId;
  if (typeof itemId !== 'string' || itemId.trim() === '') {
    throw new McpParamError('realm.read requires a root-relative itemId string');
  }
  const item: RealmItem = await store.read(realmId, itemId);
  return [{ type: 'text', text: item.content }];
}

function toolSearchQuery(args: Record<string, unknown>): SearchQuery {
  const query: SearchQuery = {};
  if (typeof args.text === 'string' && args.text.trim()) query.text = args.text;
  if (typeof args.since === 'string' && args.since.trim()) query.since = args.since;
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
    uriTemplate: 'zeus-realm://{realmId}/search?text={text}&since={since}&limit={limit}',
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

function mapError(id: JsonRpcId, error: unknown): JsonRpcResponse {
  if (error instanceof McpParamError || error instanceof UnsupportedQueryError) {
    return errorResponse(id, INVALID_PARAMS, (error as Error).message);
  }
  if (error instanceof RealmNotConnectedError || error instanceof RealmNotConnectedMcpError) {
    return errorResponse(id, REALM_NOT_CONNECTED, (error as Error).message);
  }
  if (error instanceof InvalidItemIdError) {
    // InvalidItemIdError messages carry only the root-relative itemId, never the root.
    return errorResponse(id, INVALID_ITEM, error.message);
  }
  return errorResponse(id, REALM_ERROR, error instanceof Error ? error.message : 'realm error');
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
} as const;
