/**
 * E7 MCP connectors (PRD): external systems connect via Model Context
 * Protocol. A connector declaration binds an endpoint to a minimum-privilege
 * boundary; connection discovers its resources/tools/prompts; disconnect
 * revokes immediately.
 */

export type ConnectorStatus = 'declared' | 'connected' | 'revoked';

/**
 * Outbound connectors support two MCP transports:
 * - http:  a streamable-HTTP endpoint URL (default, backwards compatible)
 * - stdio: a local subprocess speaking newline-delimited JSON-RPC on its
 *          stdio. Local-first MCP servers (e.g. work-learn's stdio server,
 *          Zeus's own realm mcp-stdio) have no HTTP face.
 */
export type ConnectorTransport =
  | { type?: 'http'; endpoint: string; token?: string }
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> };

export interface ConnectorDeclaration {
  id: string;
  name: string;
  /** MCP streamable-HTTP endpoint (http transport). */
  endpoint?: string;
  /** Explicit transport; inferred from `command` when omitted. */
  transport?: ConnectorTransport;
  /** stdio transport: executable to spawn. */
  command?: string;
  args?: string[];
  /** Extra environment variables for the spawned process (merged over process.env). */
  env?: Record<string, string>;
  /** Minimum rights the connector may exercise; closed Skill vocabulary. */
  permissions: string[];
  /** Optional bearer token presented to the connected system. */
  token?: string;
}

export interface ConnectorCapabilities {
  tools: string[];
  resources: string[];
  prompts: string[];
}

export interface ConnectorRecord extends ConnectorDeclaration {
  status: ConnectorStatus;
  declaredAt: string;
  connectedAt?: string;
  capabilities?: ConnectorCapabilities;
}

export interface McpClientDeps {
  fetchImpl?: typeof fetch;
  token?: string;
}
