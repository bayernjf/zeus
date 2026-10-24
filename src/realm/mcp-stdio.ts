#!/usr/bin/env node
/**
 * stdio MCP host for read-only personal Realms (P1 scaffold).
 *
 * Usage:
 *   node dist/realm/mcp-stdio.js <root-dir> [<root-dir> ...]
 *   ZEUS_REALM_ROOTS=/path/a,/path/b node dist/realm/mcp-stdio.js
 *
 * Security model:
 *  - Roots are authorized at launch (argv/env) and pre-connected read-only by
 *    the booted kernel. There is deliberately NO MCP method to connect an
 *    arbitrary path - the protocol can never point the scanner at a directory
 *    the host did not grant.
 *  - The kernel boots in-memory by default (zero side effects): no state file
 *    is written unless ZEUS_STATE_FILE is explicitly set, and no decision
 *    backend is mounted - zeus.plan runs the local ranker only.
 *  - The face is read-only: realm.search/realm.read plus the kernel face
 *    zeus.skills/zeus.plan/zeus.status. realm.write is refused on a read-only
 *    mount; execute stays on the signed-ticket + HTTP face, never here.
 *  - stdout carries only newline-delimited JSON-RPC; all diagnostics go to stderr.
 */
import { createInterface } from 'node:readline';
import { bootKernel } from '../state/boot.js';
import { createPersonalKernelQueries } from './kernel-queries.js';
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

  // In-memory unless the host explicitly asks for a state file; either way the
  // mounts are personal + readOnly, and no decision backend is wired.
  const stateFile = process.env.ZEUS_STATE_FILE?.trim() || undefined;
  const kernel = await bootKernel({
    realmRoots: roots.map(root => ({ root, type: 'personal' as const, readOnly: true })),
    ...(stateFile ? { stateFile } : {}),
  });

  const store = kernel.realmStore;
  if (!store) {
    process.stderr.write('[zeus-realm-mcp] fatal: kernel booted without a realm store\n');
    process.exit(1);
  }

  const realmIds: string[] = [];
  for (const connection of store.connections()) {
    realmIds.push(connection.realmId);
    const manifest = await store.manifest(connection.realmId);
    process.stderr.write(
      `[zeus-realm-mcp] connected ${connection.realmId} (${manifest.itemCount} items) type=${connection.type} readOnly=${connection.readOnly}\n`
    );
  }

  const handle = createRealmMcpHandler({
    store,
    realmIds,
    kernelQueries: createPersonalKernelQueries(kernel),
  });
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

  // No state file means no lock was acquired (releaseLock is a no-op then);
  // when the host did set one, release it on signal so we never leave a lock.
  const shutdown = async () => {
    await kernel.releaseLock().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => {
    void shutdown();
  });
  process.on('SIGINT', () => {
    void shutdown();
  });
}

function writeResponse(response: JsonRpcResponse): void {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

function collectRoots(): string[] {
  const fromArgv = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
  // Comma-separated, exactly like the kernel reads the same variable. A colon
  // list would shred a Windows drive path (C:\Users\...) into two bogus roots,
  // and as long as the two doors disagree about one variable, a host can end up
  // serving a different set of directories than the kernel was pointed at.
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
