// Local acceptance probe for the personal read-only realm stdio MCP host.
// Spawns dist/realm/mcp-stdio.js against a temp realm and runs a real JSON-RPC
// handshake over stdio. Prints a human-readable acceptance table.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'zeus-personal-mcp-'));
mkdirSync(join(root, 'notes'), { recursive: true });
writeFileSync(join(root, 'notes', 'hello.txt'), 'Personal realm marker: recall meeting notes.\n', 'utf8');

const child = spawn('node', ['dist/realm/mcp-stdio.js', root], { stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
const pending = new Map();
function send(method, params) {
  return new Promise((resolve, reject) => {
    const id = send.seq++;
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}
send.seq = 1;
child.stdout.on('data', chunk => {
  buf += chunk.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});
let stderrTail = '';
child.stderr.on('data', c => { stderrTail += c.toString(); });

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail });
}

try {
  const init = await send('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'personal-mcp-probe', version: '1.0' },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  check('initialize -> serverInfo.name=zeus-realm', init.result?.serverInfo?.name === 'zeus-realm', JSON.stringify(init.result?.serverInfo));
  check('initialize -> protocolVersion', /2025-03-26/.test(init.result?.protocolVersion), init.result?.protocolVersion);

  const tools = await send('tools/list', {});
  const names = (tools.result?.tools || []).map(t => t.name);
  check('tools/list contains realm.search/read', names.includes('realm.search') && names.includes('realm.read'), names.join(','));

  const resources = await send('resources/list', {});
  const uris = (resources.result?.resources || []).map(r => r.uri);
  const resList = JSON.stringify((resources.result?.resources || []).map(r => ({ uri: r.uri, name: r.name })));
  check('resources/list exposes manifest (realmId discovery)', /zeus-realm:\/\/[^/]+\/manifest/.test(uris.join(',')), resList.slice(0, 200));

  // realmId is derived from the connected root; read it from stderr connect line.
  const m = stderrTail.match(/connected\s+(\S+)\s+\((\d+)\s+items\)/);
  const realmId = m ? m[1] : null;
  check('realm connected read-only at launch', !!realmId, realmId || stderrTail.trim());

  const search = await send('tools/call', {
    name: 'realm.search',
    arguments: { realmId, text: 'meeting' },
  });
  const searchText = search.result?.content?.[0]?.text || '';
  check('realm.search finds hello.txt', /hello\.txt/.test(searchText), searchText.slice(0, 200));

  const read = await send('tools/call', {
    name: 'realm.read',
    arguments: { realmId, itemId: 'notes/hello.txt' },
  });
  const readText = read.result?.content?.[0]?.text || '';
  check('realm.read returns content', /Personal realm marker/.test(readText), readText.slice(0, 120));

  // Security: stdio host connects read-only; write must be refused.
  const write = await send('tools/call', {
    name: 'realm.write',
    arguments: { realmId, data: 'should not land' },
  });
  const writeBlocked = !!write.error || /read|refus|unavailable|denied|grant/i.test(write.result?.content?.[0]?.text || '');
  check('realm.write refused on read-only stdio host', writeBlocked, JSON.stringify(write.error || write.result?.content?.[0]?.text).slice(0, 160));

  // Security: pointing at a realm the host did not connect is refused.
  const rogue = await send('tools/call', {
    name: 'realm.read',
    arguments: { realmId: 'not-connected', itemId: 'x' },
  });
  check('unknown realm read refused', !!rogue.error, JSON.stringify(rogue.error?.message || rogue).slice(0, 160));
} catch (e) {
  check('probe ran without exception', false, String(e?.message || e));
} finally {
  child.kill('SIGTERM');
}

let pass = 0;
for (const r of results) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `\n        ${r.detail}` : ''}`);
  if (r.pass) pass++;
}
console.log(`\n${pass}/${results.length} checks passed; realm root=${root}`);
process.exit(pass === results.length ? 0 : 1);
