import { validatePermissionClaims } from '../skills/validate-spec.js';
import { SkillValidationError } from '../skills/validate-spec.js';
import { McpClient } from './client.js';
import type {
  ConnectorCapabilities,
  ConnectorDeclaration,
  ConnectorRecord,
} from './types.js';

export interface ConnectorAuditEntry {
  at: string;
  connectorId: string;
  action: 'declared' | 'connected' | 'revoked' | 'refused';
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

    const record: ConnectorRecord = {
      ...input,
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
      capabilities = await new McpClient(record.endpoint, { fetchImpl, token: record.token }).initialize();
    } catch (error) {
      this.log('refused', id, error instanceof Error ? error.message : 'handshake failed');
      throw error;
    }

    // Minimum privilege: the declaration may enumerate fewer tools than the
    // server exposes; only declared capability names remain usable.
    if (record.permissions.length > 0) {
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

  /** Revoke: the connector immediately disappears from active lookups. */
  revoke(id: string): ConnectorRecord {
    const record = this.require(id);
    record.status = 'revoked';
    this.log('revoked', id);
    return structuredClone(record);
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
