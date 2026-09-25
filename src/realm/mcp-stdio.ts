#!/usr/bin/env node
/**
 * stdio MCP host for read-only personal Realms (P1 scaffold).
 *
 * Usage:
 *   node dist/realm/mcp-stdio.js <root-dir> [<root-dir> ...]
 *   ZEUS_REALM_ROOTS=/path/a,/path/b node dist/realm/mcp-stdio.js
 *
 * Security model:
 *  - Roots are authorized at launch (argv/env) and pre-connected read-only.
 *    There is deliberately NO MCP method to connect an arbitrary path — the
 *    protocol can never point the scanner at a directory the host did not grant.
 *  - stdout carries only newline-delimited JSON-RPC; all diagnostics go to stderr.
 */
import { createInterface } from 'node:readline';
import { FsRealmStore } from './store.js';
import {
  createRealmMcpHandler,
  JSON_RPC_CODES,
  JSONRPC_VERSION,
  type JsonRpcResponse,
} from './mcp.js';

async function main(): Promise<void> {
  const roots = collectRoots();
  if (roots.length === 0) {
    process.stderr.write('usage: mcp-stdio <root-dir>... (or set ZEUS_REALM_ROOTS)\n');
    process.exit(1);
  }

  const store = new FsRealmStore();
  const realmIds: string[] = [];
  for (const root of roots) {
    try {
      const manifest = await store.connect(root, 'personal', { readOnly: true });
      realmIds.push(manifest.realmId);
      process.stderr.write(
        `[zeus-realm-mcp] connected ${manifest.realmId} (${manifest.itemCount} items) from ${root}\n`
      );
    } catch (error) {
      process.stderr.write(
        `[zeus-realm-mcp] connect failed for ${root}: ${error instanceof Error ? error.message : String(error)}\n`
      );
      process.exit(1);
    }
  }

  const handle = createRealmMcpHandler({ store, realmIds });
  const rl = createInterface({ input: process.stdin });

  // Serialize request handling so responses cannot overtake each other.
  let chain: Promise<void> = Promise.resolve();
  rl.on('line', line => {
    if (!line.trim()) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      writeResponse({
        jsonrpc: JSONRPC_VERSION,
        id: null,
        error: { code: JSON_RPC_CODES.PARSE_ERROR, message: 'parse error' },
      });
      return;
    }
    chain = chain
      .then(async () => {
        const response = await handle(message);
        if (response) writeResponse(response);
      })
      .catch(error => {
        const id =
          message && typeof message === 'object' && 'id' in message
            ? ((message as { id?: string | number }).id ?? null)
            : null;
        writeResponse({
          jsonrpc: JSONRPC_VERSION,
          id: typeof id === 'string' || typeof id === 'number' ? id : null,
          error: { code: JSON_RPC_CODES.INTERNAL_ERROR, message: 'internal error' },
        });
        process.stderr.write(
          `[zeus-realm-mcp] handler error: ${error instanceof Error ? error.message : String(error)}\n`
        );
      });
  });
}

function writeResponse(response: JsonRpcResponse): void {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

function collectRoots(): string[] {
  const fromArgv = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
  // Comma-separated, exactly like the kernel reads the same variable. A colon
  // list would shred a Windows drive path (C:\Users\...) into two bogus roots,
  // and two doors disagreeing about one env var is how a host ends up serving
  // a directory nobody meant to authorize.
  const fromEnv = (process.env.ZEUS_REALM_ROOTS ?? '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  return [...new Set([...fromArgv, ...fromEnv])];
}

main().catch(error => {
  process.stderr.write(`[zeus-realm-mcp] fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
