// Generate a paste-ready MCP client config (mcpServers.zeus-dataDomain) to stdout.
//
// The absolute path to dist/dataDomain/mcp-stdio.js is derived from this script's
// own location (scripts/../dist/dataDomain/mcp-stdio.js) — never hardcoded.
//
// Roots (authorized read-only dataDomain directories) are the union of:
//   - --roots a,b        (comma-separated CLI flag; flag and value are stripped
//                         from argv so downstream tooling sees a clean argv)
//   - ZEUS_DATA_DOMAIN_ROOTS   (comma-separated env var)
// The union is deduplicated while preserving first-seen order.
//
// stdout always carries pure JSON (2-space indent). If no roots are supplied,
// the JSON is still valid (args = [abs mcp-stdio.js] only) and a "please add a
// root" hint is written to stderr, never to stdout.
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const mcpStdioPath = resolve(scriptDir, '..', 'dist', 'dataDomain', 'mcp-stdio.js');

// --- Parse argv: extract --roots <value> / --roots=<value>, stripping both ---
const cliRoots = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--roots') {
    const value = argv[i + 1] ?? '';
    cliRoots.push(value);
    i++; // consume the value too
  } else if (arg.startsWith('--roots=')) {
    cliRoots.push(arg.slice('--roots='.length));
  }
}

function splitRoots(raw) {
  if (!raw) return [];
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

// Union, CLI flag first then env; dedupe preserving first-seen order.
const envRoots = splitRoots(process.env.ZEUS_DATA_DOMAIN_ROOTS);
const seen = new Set();
const roots = [];
for (const r of [...splitRoots(cliRoots.join(',')), ...envRoots]) {
  if (!seen.has(r)) {
    seen.add(r);
    roots.push(r);
  }
}

const config = {
  mcpServers: {
    'zeus-dataDomain': {
      command: 'node',
      args: [mcpStdioPath, ...roots],
    },
  },
};

process.stdout.write(JSON.stringify(config, null, 2) + '\n');

if (roots.length === 0) {
  console.error(
    '请补 root: 未提供任何个人 DataDomain 目录。用 --roots /path/a,/path/b 或环境变量 ZEUS_DATA_DOMAIN_ROOTS 授权至少一个只读目录后再粘贴。'
  );
  process.exitCode = 0;
}
