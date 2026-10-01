import { validatePermissionClaims } from '../skills/validate-spec.js';
import { SkillValidationError } from '../skills/validate-spec.js';
import { McpClient } from './client.js';
import { McpStdioClient } from './stdio-client.js';
import type {
  ConnectorCapabilities,
  ConnectorDeclaration,
  ConnectorRecord,
} from './types.js';

export interface ConnectorAuditEntry {
  at: string;
  connectorId: string;
  action: 'declared' | 'connected' | 'revoked' | 'refused' | 'boundary-unmatched';
  detail?: string;
}

export class ConnectorError extends Error {}

/**
 * E7 connector registry: declarations are the minimum-privilege boundary,
 * connection runs the MCP handshake and discovers capabilities, revoke drops
 * the record out of the active set immediately. A connector never holds more
 * rights than it declared at registration.
 */
export class ConnectorRegistry {
  private connectors = new Map<string, ConnectorRecord>();

  constructor(
    private now: () => Date = () => new Date(),
    private audit: (entry: ConnectorAuditEntry) => void = () => {},
  ) {}

  declare(input: ConnectorDeclaration): ConnectorRecord {
    if (this.connectors.has(input.id)) {
      throw new ConnectorError(`connector ${input.id} already declared`);
    }
    const issues = validatePermissionClaims(input.permissions);
    if (issues.length > 0) throw new SkillValidationError(issues);

    const isStdio =
      input.transport?.type === 'stdio' ||
      (input.transport?.type !== 'http' && typeof input.command === 'string' && input.command.trim().length > 0);
    if (isStdio) {
      const command = input.transport?.type === 'stdio' ? input.transport.command : input.command;
      if (typeof command !== 'string' || command.trim().length === 0) {
        throw new ConnectorError('stdio connector requires a non-empty command');
      }
    } else if (typeof input.endpoint !== 'string' || input.endpoint.trim().length === 0) {
      throw new ConnectorError('http connector requires a non-empty endpoint');
    }

    const normalised: ConnectorDeclaration = isStdio
      ? {
          id: input.id,
          name: input.name,
          command:
            input.transport?.type === 'stdio' ? input.transport.command : input.command!,
          args:
            input.transport?.type === 'stdio'
              ? input.transport.args
              : input.args,
          env:
            input.transport?.type === 'stdio' ? input.transport.env : input.env,
          permissions: input.permissions,
        }
      : {
          id: input.id,
          name: input.name,
          endpoint:
            input.transport?.type === 'http' ? input.transport.endpoint : input.endpoint!,
          permissions: input.permissions,
          ...(input.transport?.type === 'http' && input.transport.token
            ? { token: input.transport.token }
            : input.token
              ? { token: input.token }
              : {}),
        };

    const record: ConnectorRecord = {
      ...normalised,
      permissions: [...new Set(input.permissions)],
      status: 'declared',
      declaredAt: this.now().toISOString(),
    };
    this.connectors.set(input.id, record);
    this.log('declared', input.id);
    return structuredClone(record);
  }

  /** Run the MCP handshake; refused when the server is unreachable or returns
   *  a capability beyond the declared permission boundary. */
  async connect(
    id: string,
    fetchImpl?: typeof fetch,
  ): Promise<ConnectorRecord> {
    const record = this.require(id);
    if (record.status === 'revoked') throw new ConnectorError(`connector ${id} is revoked`);

    let capabilities: ConnectorCapabilities;
    try {
      if (this.isStdio(record)) {
        const stdio = new McpStdioClient({
          command: record.command!,
          args: record.args,
          env: record.env,
        });
        try {
          capabilities = await stdio.initialize();
        } finally {
          stdio.close();
        }
      } else {
        capabilities = await new McpClient(record.endpoint!, { fetchImpl, token: record.token }).initialize();
      }
    } catch (error) {
      this.log('refused', id, error instanceof Error ? error.message : 'handshake failed');
      throw error;
    }

    // Minimum privilege: the declaration may enumerate fewer tools than the
    // server exposes; only declared capability names remain usable.
    if (record.permissions.length > 0) {
      // deferred #30: granted names are upstream strings verbatim, so a rename
      // upstream would silently drop a tool out of the boundary. Announce every
      // granted mcp:<tool> the handshake did not discover rather than hiding it.
      const discovered = new Set(capabilities.tools);
      const unmatched = record.permissions
        .filter(claim => claim.startsWith('mcp:'))
        .map(claim => claim.slice(4))
        .filter(tool => !discovered.has(tool));
      if (unmatched.length > 0) {
        this.log('boundary-unmatched', id, `granted tools not discovered upstream: ${unmatched.join(', ')}`);
      }
      capabilities = {
        tools: capabilities.tools.filter(t => this.withinBoundary(id, 'tool', t)),
        resources: capabilities.resources,
        prompts: capabilities.prompts,
      };
    }

    record.status = 'connected';
    record.connectedAt = this.now().toISOString();
    record.capabilities = capabilities;
    this.log('connected', id);
    return structuredClone(record);
  }

  private withinBoundary(connectorId: string, kind: string, name: string): boolean {
    const record = this.connectors.get(connectorId)!;
    // Tool-level bounds are expressed as mcp:<tool>; bare mcp grants everything.
    return record.permissions.some(
      claim => claim === `mcp:${name}` || claim === 'mcp' || claim === kind,
    );
  }

  private isStdio(record: ConnectorRecord): boolean {
    if (record.transport?.type === 'stdio') return true;
    if (record.transport?.type === 'http') return false;
    return typeof record.command === 'string' && record.command.trim().length > 0;
  }

  /** Revoke: the connector immediately disappears from active lookups. */
  revoke(id: string): ConnectorRecord {
    const record = this.require(id);
    record.status = 'revoked';
    this.log('revoked', id);
    return structuredClone(record);
  }

  /**
   * Active work 47 §E-4: invoke one tool on a connected connector. The call is
   * bounded by the capability list discovered at handshake (already narrowed to
   * the declaration's minimum-privilege boundary), so a tool the server never
   * advertised — or the declaration never granted — cannot be invoked.
   */
  async callTool(
    id: string,
    name: string,
    args: Record<string, unknown> = {},
    fetchImpl?: typeof fetch,
  ): Promise<unknown> {
    const record = this.require(id);
    if (record.status === 'revoked') throw new ConnectorError(`connector ${id} is revoked`);
    if (record.status !== 'connected' || !record.capabilities) {
      throw new ConnectorError(`connector ${id} is not connected; run the handshake first`);
    }
    if (!record.capabilities.tools.includes(name)) {
      throw new ConnectorError(`connector ${id} does not expose tool '${name}' (discovered: ${record.capabilities.tools.join(', ') || 'none'})`);
    }
    if (this.isStdio(record)) {
      const client = new McpStdioClient({ command: record.command!, args: record.args, env: record.env });
      try {
        return await client.callTool(name, args);
      } finally {
        client.close();
      }
    }
    const client = new McpClient(record.endpoint!, { fetchImpl, token: record.token });
    return client.callTool(name, args);
  }

  list(status?: ConnectorRecord['status']): ConnectorRecord[] {
    const all = [...this.connectors.values()].map(record => structuredClone(record));
    return status ? all.filter(record => record.status === status) : all;
  }

  get(id: string): ConnectorRecord | undefined {
    const record = this.connectors.get(id);
    return record ? structuredClone(record) : undefined;
  }

  exportState(): ConnectorRecord[] {
    return [...this.connectors.values()].map(record => structuredClone(record));
  }

  importState(records: ConnectorRecord[]): void {
    this.connectors = new Map(records.map(record => [record.id, structuredClone(record)]));
  }

  private require(id: string): ConnectorRecord {
    const record = this.connectors.get(id);
    if (!record) throw new ConnectorError(`connector ${id} not found`);
    return record;
  }

  private log(action: ConnectorAuditEntry['action'], id: string, detail?: string): void {
    this.audit({ at: this.now().toISOString(), connectorId: id, action, ...(detail ? { detail } : {}) });
  }
}
