/**
 * E7 MCP connectors (PRD): external systems connect via Model Context
 * Protocol. A connector declaration binds an endpoint to a minimum-privilege
 * boundary; connection discovers its resources/tools/prompts; disconnect
 * revokes immediately.
 */

export type ConnectorStatus = 'declared' | 'connected' | 'revoked';

export interface ConnectorDeclaration {
  id: string;
  name: string;
  /** MCP streamable-HTTP endpoint. */
  endpoint: string;
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
