// Local acceptance probe for the personal read-only dataDomain stdio MCP host.
// Spawns dist/dataDomain/mcp-stdio.js against a temp dataDomain and runs a real JSON-RPC
// handshake over stdio. Prints a human-readable acceptance table.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'zeus-personal-mcp-'));
mkdirSync(join(root, 'notes'), { recursive: true });
writeFileSync(join(root, 'notes', 'hello.txt'), 'Personal dataDomain marker: recall meeting notes.\n', 'utf8');

const child = spawn('node', ['dist/dataDomain/mcp-stdio.js', root], { stdio: ['pipe', 'pipe', 'pipe'] });
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
  check('initialize -> serverInfo.name=zeus-dataDomain', init.result?.serverInfo?.name === 'zeus-dataDomain', JSON.stringify(init.result?.serverInfo));
  check('initialize -> protocolVersion', /2025-03-26/.test(init.result?.protocolVersion), init.result?.protocolVersion);

  const tools = await send('tools/list', {});
  const names = (tools.result?.tools || []).map(t => t.name);
  check('tools/list contains dataDomain.search/read', names.includes('dataDomain.search') && names.includes('dataDomain.read'), names.join(','));
  check(
    'tools/list exposes the read-only runtime face (zeus.skills/plan/status)',
    ['zeus.skills', 'zeus.plan', 'zeus.status'].every(n => names.includes(n)),
    names.join(',')
  );

  const resources = await send('resources/list', {});
  const uris = (resources.result?.resources || []).map(r => r.uri);
  const resList = JSON.stringify((resources.result?.resources || []).map(r => ({ uri: r.uri, name: r.name })));
  check('resources/list exposes manifest (dataDomainId discovery)', /zeus-dataDomain:\/\/[^/]+\/manifest/.test(uris.join(',')), resList.slice(0, 200));

  // dataDomainId is derived from the connected root; read it from stderr connect line.
  const m = stderrTail.match(/connected\s+(\S+)\s+\((\d+)\s+items\)/);
  const dataDomainId = m ? m[1] : null;
  check('dataDomain connected read-only at launch', !!dataDomainId, dataDomainId || stderrTail.trim());

  const search = await send('tools/call', {
    name: 'dataDomain.search',
    arguments: { dataDomainId, text: 'meeting' },
  });
  const searchText = search.result?.content?.[0]?.text || '';
  check('dataDomain.search finds hello.txt', /hello\.txt/.test(searchText), searchText.slice(0, 200));

  const read = await send('tools/call', {
    name: 'dataDomain.read',
    arguments: { dataDomainId, itemId: 'notes/hello.txt' },
  });
  const readText = read.result?.content?.[0]?.text || '';
  check('dataDomain.read returns content', /Personal dataDomain marker/.test(readText), readText.slice(0, 120));

  // Security: stdio host connects read-only; write must be refused.
  const write = await send('tools/call', {
    name: 'dataDomain.write',
    arguments: { dataDomainId, data: 'should not land' },
  });
  const writeBlocked = !!write.error || /read|refus|unavailable|denied|grant/i.test(write.result?.content?.[0]?.text || '');
  check('dataDomain.write refused on read-only stdio host', writeBlocked, JSON.stringify(write.error || write.result?.content?.[0]?.text).slice(0, 160));

  // Security: pointing at a dataDomain the host did not connect is refused.
  const rogue = await send('tools/call', {
    name: 'dataDomain.read',
    arguments: { dataDomainId: 'not-connected', itemId: 'x' },
  });
  check('unknown dataDomain read refused', !!rogue.error, JSON.stringify(rogue.error?.message || rogue).slice(0, 160));

  // --- Read-only runtime face (design P1-1): zeus.skills / zeus.plan / zeus.status.

  const status = await send('tools/call', { name: 'zeus.status', arguments: {} });
  const statusText = status.result?.content?.[0]?.text || '';
  let statusJson = null;
  try { statusJson = JSON.parse(statusText); } catch { /* handled below */ }
  check(
    'zeus.status returns dataDomains (dataDomainId/type/readOnly) and counts, never the absolute root',
    !!statusJson &&
      Array.isArray(statusJson.dataDomains) &&
      statusJson.dataDomains.some(r => r.dataDomainId === dataDomainId && r.type === 'personal' && r.readOnly === true) &&
      typeof statusJson.agents?.activeCount === 'number' &&
      typeof statusJson.pendingOversight === 'number' &&
      typeof statusJson.watches === 'number' &&
      !statusText.includes(root) &&
      !/"root"\s*:/.test(statusText),
    statusText.slice(0, 220)
  );

  const skills = await send('tools/call', { name: 'zeus.skills', arguments: {} });
  const skillsText = skills.result?.content?.[0]?.text || '';
  let skillsArr = null;
  try { skillsArr = JSON.parse(skillsText); } catch { /* handled below */ }
  check('zeus.skills returns the catalogue as an array', Array.isArray(skillsArr), skillsText.slice(0, 200));

  const plan = await send('tools/call', { name: 'zeus.plan', arguments: { text: 'review the meeting notes' } });
  const planText = plan.result?.content?.[0]?.text || '';
  let planJson = null;
  try { planJson = JSON.parse(planText); } catch { /* handled below */ }
  check(
    'zeus.plan returns a structured verdict (ok/chosenBy/candidates; local ranker, zero outbound)',
    !!planJson &&
      typeof planJson.ok === 'boolean' &&
      typeof planJson.chosenBy === 'string' &&
      Array.isArray(planJson.candidates) &&
      (planJson.ok ? typeof planJson.skill === 'string' : typeof planJson.reason === 'string'),
    planText.slice(0, 220)
  );
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
console.log(`\n${pass}/${results.length} checks passed; dataDomain root=${root}`);
process.exit(pass === results.length ? 0 : 1);
