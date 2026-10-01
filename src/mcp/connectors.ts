import { validatePermissionClaims } from '../skills/validate-spec.js';
import { SkillValidationError } from '../skills/validate-spec.js';
import { DomainError } from '../util/domain-error.js';
import { assertOutboundUrlAllowed } from '../util/outbound-url.js';
import { McpClient } from './client.js';
import { McpStdioClient } from './stdio-client.js';
import type {
  ConnectorCapabilities,
  ConnectorDeclaration,
  ConnectorRecord,
  PersistedConnectorRecord,
} from './types.js';

export interface ConnectorAuditEntry {
  at: string;
  connectorId: string;
  action: 'declared' | 'connected' | 'revoked' | 'refused' | 'boundary-unmatched';
  detail?: string;
}

export class ConnectorError extends DomainError {}

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
      throw new ConnectorError(`connector ${input.id} already declared`, 'conflict');
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

    // A-12: an http connector's endpoint is caller-supplied and the handshake
    // POSTs to it. Refuse a non-public target here so a declaration can never
    // name the metadata endpoint; the check also runs at connect/call time, so a
    // snapshot restored by importState cannot smuggle one in.
    if (!isStdio) assertOutboundUrlAllowed(normalised.endpoint!);

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
    if (record.status === 'revoked') throw new ConnectorError(`connector ${id} is revoked`, 'conflict');

    let capabilities: ConnectorCapabilities;
    try {
      // A-12: re-check at the outbound moment, not only at declare — a record
      // restored from a hand-edited snapshot never passed declare().
      if (!this.isStdio(record)) assertOutboundUrlAllowed(record.endpoint!);
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

    // A-09 minimum privilege: the declaration may enumerate fewer tools than the
    // server exposes, and only declared ones stay usable. The narrowing runs even
    // when the declaration grants nothing — an empty permission list means no
    // tool, so "declare nothing" cannot widen the boundary to the whole handshake
    // (fail-closed; it used to be skipped, which is what made the bypass work).
    // deferred #30: granted names are upstream strings verbatim, so an upstream
    // rename would silently drop a tool out of the boundary. Announce every
    // granted mcp:<tool> the handshake did not discover rather than hiding it.
    const discovered = new Set(capabilities.tools);
    const unmatched = record.permissions
      .filter(claim => claim.startsWith('mcp:'))
      .map(claim => claim.slice(4))
      .filter(tool => !discovered.has(tool));
    if (unmatched.length > 0) {
      this.log('boundary-unmatched', id, `granted tools not discovered upstream: ${unmatched.join(', ')}`);
    }
    capabilities = narrowCapabilities(record.permissions, capabilities);

    record.status = 'connected';
    record.connectedAt = this.now().toISOString();
    record.capabilities = capabilities;
    this.log('connected', id);
    return structuredClone(record);
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
    if (record.status === 'revoked') throw new ConnectorError(`connector ${id} is revoked`, 'conflict');
    if (record.status !== 'connected' || !record.capabilities) {
      throw new ConnectorError(`connector ${id} is not connected; run the handshake first`);
    }
    // A-09: re-derive the boundary from the declaration on every call instead of
    // trusting the capability list stored at handshake — a snapshot restored by
    // importState (or a widened stored list) is not proof the declaration granted
    // the tool. Both must hold: the declaration granted it and the server
    // advertised it.
    if (!withinDeclaredBoundary(record.permissions, name)) {
      throw new ConnectorError(
        `connector ${id} does not expose tool '${name}': the declaration did not grant it (permissions: ${record.permissions.join(', ') || 'none'})`,
      );
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
    // A-12: the tool call is another outbound POST to the same endpoint.
    assertOutboundUrlAllowed(record.endpoint!);
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

  /**
   * Persistable form: everything but the bearer token. The state file - and so
   * every backup bundle drawn from it - is a plaintext document, which is the
   * wrong side of the credential boundary. The token stays in memory; after a
   * restore the operator re-declares the connector with it.
   */
  exportState(): PersistedConnectorRecord[] {
    return [...this.connectors.values()].map(record => {
      // Omit-by-destructuring: `token` is dropped, `rest` is what persists.
      const { token, ...rest } = record;
      return structuredClone(rest);
    });
  }

  /**
   * A-09: restore records without letting a hand-edited snapshot widen a
   * connector's rights — the capability list is re-narrowed to its declaration
   * on import, exactly as a fresh handshake would have produced it.
   */
  importState(records: PersistedConnectorRecord[]): void {
    this.connectors = new Map(
      records.map(record => {
        const restored = structuredClone(record);
        if (restored.capabilities) {
          restored.capabilities = narrowCapabilities(restored.permissions, restored.capabilities);
        }
        return [restored.id, restored];
      })
    );
  }

  private require(id: string): ConnectorRecord {
    const record = this.connectors.get(id);
    if (!record) throw new ConnectorError(`connector ${id} not found`, 'not-found');
    return record;
  }

  private log(action: ConnectorAuditEntry['action'], id: string, detail?: string): void {
    this.audit({ at: this.now().toISOString(), connectorId: id, action, ...(detail ? { detail } : {}) });
  }
}

/**
 * A-09: a capability is usable only when the declaration granted it. Bounds are
 * `mcp:<name>` for one upstream name and a bare `mcp` for all of them. The same
 * predicate applies to tools, resources and prompts: the bound used to be
 * enforced on tools alone, so a declaration granting `mcp:search` still left the
 * server's whole resource and prompt surface exposed.
 *
 * Anything else — including a record carrying no permissions at all —
 * authorises nothing, so the boundary can never be widened by declaring less.
 */
function withinDeclaredBoundary(permissions: readonly string[], name: string): boolean {
  return permissions.some(claim => claim === `mcp:${name}` || claim === 'mcp');
}

/** A-09: keep only the discovered capabilities the declaration granted. */
function narrowCapabilities(
  permissions: readonly string[],
  capabilities: ConnectorCapabilities,
): ConnectorCapabilities {
  const granted = (names: string[]): string[] => names.filter(name => withinDeclaredBoundary(permissions, name));
  return {
    tools: granted(capabilities.tools),
    resources: granted(capabilities.resources),
    prompts: granted(capabilities.prompts),
  };
}
