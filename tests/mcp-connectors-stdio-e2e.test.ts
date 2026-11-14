import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConnectorRegistry, type ConnectorAuditEntry } from '../src/mcp/connectors.js';
import type { ConnectorDeclaration } from '../src/mcp/types.js';
import { FsDataDomainStore } from '../src/dataDomain/store.js';

/**
 * #70 real-process connector E2E.
 *
 * The stdio transport used to be covered only at the declaration layer
 * (record shape, env redaction) with a spawn-injected seam — no test ever
 * spawned a real MCP subprocess through ConnectorRegistry. These cases run the
 * shipped host `dist/dataDomain/mcp-stdio.js` (build output; CI runs build before
 * test) end to end: declare -> spawn -> initialize handshake -> tools/list ->
 * minimum-privilege narrowing -> tools/call -> revoke, plus the two failure
 * branches (unspawnable command, boundary-unmatched grant).
 */
const STDIO_SERVER = join(process.cwd(), 'dist', 'dataDomain', 'mcp-stdio.js');

function declaration(
  root: string,
  permissions: string[],
  overrides: Partial<ConnectorDeclaration> = {},
): ConnectorDeclaration {
  return {
    id: 'local-dataDomain',
    name: 'Local DataDomain',
    command: process.execPath,
    args: [STDIO_SERVER, root],
    permissions,
    ...overrides,
  };
}

describe('connector real-process stdio E2E (#70)', () => {
  let sandbox: string;
  let root: string;
  let dataDomainId: string;
  let events: ConnectorAuditEntry[];

  beforeEach(async () => {
    if (!existsSync(STDIO_SERVER)) {
      throw new Error(`missing built host ${STDIO_SERVER} — run "npm run build" before the test suite`);
    }
    sandbox = mkdtempSync(join(tmpdir(), 'zeus-connector-e2e-'));
    root = join(sandbox, 'dataDomain');
    mkdirSync(join(root, 'notes'), { recursive: true });
    writeFileSync(join(root, 'notes', 'diary.md'), '# Diary\nhello world secret zeus\n');
    writeFileSync(join(root, 'notes', 'todo.txt'), 'buy milk\n');
    const manifest = await new FsDataDomainStore().connect(root, 'personal', { readOnly: true });
    dataDomainId = manifest.dataDomainId;
    events = [];
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('spawns the shipped stdio server, handshakes and narrows capabilities to the declaration', async () => {
    const registry = new ConnectorRegistry(
      () => new Date(),
      entry => events.push(entry),
    );
    registry.declare(declaration(root, ['mcp:dataDomain.read']));

    const connected = await registry.connect('local-dataDomain');

    expect(connected.status).toBe('connected');
    expect(connected.connectedAt).toBeTruthy();
    // The host advertises dataDomain.search + dataDomain.read; the declaration granted
    // only one, so the handshake must narrow instead of widening.
    expect(connected.capabilities?.tools).toEqual(['dataDomain.read']);
    // Resource/prompt names never match an `mcp:<tool>` grant.
    expect(connected.capabilities?.resources).toEqual([]);
    expect(connected.capabilities?.prompts).toEqual([]);
    expect(events.map(e => e.action)).toContain('declared');
    expect(events.map(e => e.action)).toContain('connected');
  }, 20_000);

  it('calls dataDomain.search and dataDomain.read over real subprocesses and gets file content', async () => {
    const registry = new ConnectorRegistry();
    registry.declare(declaration(root, ['mcp:dataDomain.search', 'mcp:dataDomain.read']));
    await registry.connect('local-dataDomain');

    const searchResult = (await registry.callTool('local-dataDomain', 'dataDomain.search', {
      dataDomainId,
      text: 'secret zeus',
    })) as { content?: Array<{ text: string }> };
    const searchText = searchResult.content?.[0]?.text;
    expect(searchText).toBeTruthy();
    const searchPayload = JSON.parse(searchText as string) as Array<{ itemId?: string; path?: string }>;
    expect(JSON.stringify(searchPayload)).toContain('diary.md');
    expect(JSON.stringify(searchPayload)).not.toContain('todo.txt');

    const readResult = (await registry.callTool('local-dataDomain', 'dataDomain.read', {
      dataDomainId,
      itemId: 'notes/diary.md',
    })) as { content?: Array<{ text: string }> };
    expect(readResult.content?.[0]?.text).toContain('hello world secret zeus');
  }, 20_000);

  it('keeps a tool the declaration did not grant uncallable though the server advertises it', async () => {
    const registry = new ConnectorRegistry();
    registry.declare(declaration(root, ['mcp:dataDomain.read']));
    await registry.connect('local-dataDomain');

    await expect(
      registry.callTool('local-dataDomain', 'dataDomain.search', { dataDomainId, text: 'milk' }),
    ).rejects.toThrowError(/did not grant/);
  }, 20_000);

  it('revokes so every later handshake and tool call is refused', async () => {
    const registry = new ConnectorRegistry();
    registry.declare(declaration(root, ['mcp:dataDomain.read']));
    await registry.connect('local-dataDomain');

    const revoked = registry.revoke('local-dataDomain');
    expect(revoked.status).toBe('revoked');

    await expect(
      registry.callTool('local-dataDomain', 'dataDomain.read', { dataDomainId, itemId: 'notes/diary.md' }),
    ).rejects.toThrowError(/revoked/);
    await expect(registry.connect('local-dataDomain')).rejects.toThrowError(/revoked/);
  }, 20_000);

  it('refuses the handshake when the command cannot spawn, leaves the record declared and audits refused', async () => {
    const registry = new ConnectorRegistry(
      () => new Date(),
      entry => events.push(entry),
    );
    registry.declare(
      declaration(root, ['mcp:dataDomain.read'], {
        id: 'broken',
        command: `zeus-no-such-binary-${Date.now()}`,
        args: [],
      }),
    );

    await expect(registry.connect('broken')).rejects.toThrow();
    expect(registry.get('broken')?.status).toBe('declared');
    expect(events.some(e => e.action === 'refused')).toBe(true);
  }, 20_000);

  it('handshakes when granted a tool the host lacks but logs boundary-unmatched', async () => {
    const registry = new ConnectorRegistry(
      () => new Date(),
      entry => events.push(entry),
    );
    registry.declare(declaration(root, ['mcp:dataDomain.read', 'mcp:does-not-exist']));

    const connected = await registry.connect('local-dataDomain');
    expect(connected.status).toBe('connected');
    expect(connected.capabilities?.tools).toEqual(['dataDomain.read']);
    const unmatched = events.find(e => e.action === 'boundary-unmatched');
    expect(unmatched?.detail).toContain('does-not-exist');
  }, 20_000);
});
