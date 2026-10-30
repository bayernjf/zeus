import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Reverse half of the capability <-> drivable-surface audit (#44 follow-up,
 * Active work 223). The Web gate in web-supervisor-i18n.test.ts only proves the
 * forward direction: every data-act the page renders is backed by a real route.
 * It cannot see a write route the HTTP surface exposes that no operator surface
 * can actually drive - the gap shape found in the connector batch (kernel and
 * HTTP both existed, neither TUI nor Web could reach them, while the docs sent
 * operators looking for them). This test collects every write route from
 * server.ts and requires each one to be either:
 *   1. a protocol face (MCP / A2A inbound, driven by remote peers),
 *   2. driven from a shipped operator surface (Web supervisor, TUI, scripts),
 *   3. explicitly registered as HTTP-only with a PRD reference.
 * A new write route that is none of these goes red here instead of silently
 * shipping as an undrivable capability.
 */

const SERVER = readFileSync('src/http/server.ts', 'utf8');
// Only the script half of the page can read or drive a route: every api() call
// site and every delegated action lives there. The markup half names routes in
// `class="hint"` copy ("GET /api/domains"), which the substring match counted
// as a reader - two M7 slice 4 defect injections proved it: renaming the real
// call sites left the gate green because the panel label still named the path.
// Prose is not a reader, exactly as a comment is not (comments were stripped
// for the same reason).
const WEB = readFileSync(join('web', 'supervisor', 'index.html'), 'utf8').replace(/^[\s\S]*?<script>/, '');
const TUI = readdirSync('src/tui')
  .filter(f => f.endsWith('.ts'))
  .map(f => readFileSync(join('src', 'tui', f), 'utf8'))
  .join('\n');
const SCRIPTS = readdirSync('scripts')
  .filter(f => f.endsWith('.mjs'))
  .map(f => readFileSync(join('scripts', f), 'utf8'))
  .join('\n');

const CORPORA: Array<[string, string]> = [
  ['web', WEB],
  ['tui', TUI],
  ['scripts', SCRIPTS],
];

/** Collapse a path's parameter segments and the call sites' interpolations to
 * one placeholder so `/api/x/${id}/y`, `'/api/x/' + id + '/y'` and the route
 * `/api/x/:id/y` all normalize to `/api/x/§/y`. A trailing `+ verb`/`+ kind`
 * (the skill and commission call sites pick the last path segment from the
 * delegated action) collapses as well, producing the call site's shape. */
function normalize(p: string): string {
  return p
    .replace(/\$\{[^}]*\}/g, '§')
    .replace(/['"`]\s*\+\s*[A-Za-z0-9_.$()[\]]+\s*\+\s*['"`]/g, '§')
    .replace(/['"`]\s*\+\s*[A-Za-z0-9_.$()[\]]+(?=\s*[,)])/g, '§')
    .replace(/:[a-zA-Z]+/g, '§');
}

const NORMALIZED = CORPORA.map(([name, text]) => [name, normalize(text)] as const);

/** True when `needle` occurs in `text` as a whole path, never as the prefix of
 *  a longer one. Without this, the read route `/api/memory/retractions` that
 *  the memory view legitimately shows would count as a driver of the write
 *  route `POST /api/memory/retract` (2026-10-14: it did, and the gate went red
 *  on a face that writes nothing). A trailing `?query` or string terminator is
 *  a boundary; a path character is not. */
function hasWholePath(text: string, needle: string): boolean {
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at === -1) return false;
    const after = text[at + needle.length];
    if (after === undefined || !/[a-zA-Z0-9_-]/.test(after)) return true;
    from = at + 1;
  }
}

function drivenIn(path: string): string[] {
  const needle = normalize(path);
  const direct = NORMALIZED.filter(([, text]) => hasWholePath(text, needle)).map(([name]) => name);
  if (direct.length) return direct;
  // Dynamic last segment: the call site ends with a variable (`+ kind`, `+ verb`)
  // and the concrete verbs arrive through data-act delegation. Driven only when
  // the parameterized shape appears AND the route's last segment is a real
  // delegated action verb in the same corpus, never on the shape alone.
  const verb = path.split('/').pop()!;
  const shape = needle.replace(/\/[^/]+$/, '/§');
  // The verb reaches the call site through a delegated action literal such as
  // 'skill-install' / 'cm-waive' (the i18n gate pins those to real endpoints).
  const verbRx = new RegExp(`data-act="[^"]*${verb.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^"]*"|['"\`][a-z]+-${verb.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`);
  return NORMALIZED.filter(([, text]) => {
    if (!hasWholePath(text, shape)) return false;
    return verbRx.test(text);
  }).map(([name]) => name);
}

interface Route {
  method: string;
  path: string;
  key: string;
}

const writeRoutes: Route[] = [...SERVER.matchAll(/app\.(post|delete|patch|put)\('([^']+)'/g)].map(m => ({
  method: m[1]!.toUpperCase(),
  path: m[2]!,
  key: `${m[1]!.toUpperCase()} ${m[2]}`,
}));

// Inbound protocol faces: driven by MCP clients and A2A remote agents, not by a
// human operator surface. They must never be under /api/.
const PROTOCOL_FACES = new Set(['POST /mcp', 'POST /.well-known/agent-card.json']);

// Deliberately HTTP-only operator actions: low-frequency, high-blast-radius or
// flow-internal endpoints whose documented operator face IS the bearer API.
// Every entry must cite the PRD line that settled the shape; an endpoint that
// later gains a TUI/Web/script driver must leave this table.
const HTTP_ONLY: Record<string, string> = {
  'POST /api/org/departments/:id/first-task':
    'PRD E9.2 / v0.29: onboarding flow-internal dispatch after the commission gate; driven by the commissioning flow over the bearer API',
  'POST /api/memory/retract':
    'PRD E8.5 / v0.23: memory erasure face, documented as HTTP operator API (read + retract only, no fact write entry)',
  'POST /api/memory/forget-subject':
    'PRD E8.5 / v0.23: right-to-erasure face, documented as HTTP operator API (read + retract only, no fact write entry)',
  'POST /api/diary/generate':
    'PRD E8.3: diary generation over the bearer API; the daily CLI path assembles the kernel in-process',
  'POST /api/skills/team':
    'PRD E2.4 / v0.23: skill-to-team resolution for integrations; ambiguous slots are returned for the caller to resolve',
  'POST /api/realms/:id/disconnect':
    'PRD v0.41: low-frequency realm boundary change, deliberately HTTP operator API; CLI/MCP exposure deferred with item #18',
  'POST /api/realms/:id/retarget-tenant':
    'PRD v0.41: enterprise tenant compare-and-swap, deliberately HTTP operator API; CLI/MCP exposure deferred with item #18',
  'POST /api/realm/write-grants':
    'PRD E3.5 / v0.30: one-shot signed enterprise write-grant minting, an operations action over the bearer API',
  'POST /api/a2a/push-notifications':
    'PRD E4.11 / v0.86: peer callback receiver for push-delivered outbound tasks; the operator face is the peer A2A client sending the callback, not a local driver',
  'POST /api/v1/decisions/:id/approval':
    'Tier0 PRD §6.2 / T-M1-06: approval verdicts over the cross-system decision API; the calling system surfaces the human verdict, zeus only records it',
  'PUT /api/v1/policy':
    'Tier0 PRD §6.2 / T-M1-06: versioned policy administration over the bearer API; low-frequency high-blast-radius config action, no operator deck planned',
  'POST /api/v1/decision-webhooks':
    'Tier0 T-M8: register a decision-event push receiver (HMAC secret); the calling ops console is the consumer of the pushed events, zeus only records subscriptions, no operator deck planned',
  'DELETE /api/v1/decision-webhooks/:id':
    'Tier0 T-M8 / Active work 276: remove a decision-event push subscription; same bearer API face as the register route, no operator deck planned',
  'POST /api/v1/org/policy/thresholds':
    'Tier0 PRD §11 / T-M2-04: per-organization D0-D3 threshold configuration; low-frequency high-blast-radius config action',
  'POST /api/v1/memory/recall':
    'MemoryPort v1 §7 (ruling D-6): cross-agent consumer face behind ZEUS_MEMORY_SERVICE_TOKEN; the calling agent is the driver over the bearer API, namespace is its realm',
  'POST /api/v1/memory/remember':
    'MemoryPort v1 §7 (ruling D-6): cross-agent consumer face behind ZEUS_MEMORY_SERVICE_TOKEN; the calling agent writes its own namespace over the bearer API',
  'POST /api/v1/memory/forget':
    'MemoryPort v1 §7 (ruling D-6): cross-agent erasure face behind ZEUS_MEMORY_SERVICE_TOKEN; requestedBy is pinned to memory-service, the calling agent is the driver',
};

describe('operator surface coverage (every write route is drivable or explicitly API-only)', () => {
  it('collects the write set from real registration sites (positive control)', () => {
    expect(writeRoutes.length, 'the scan found no write routes - it is broken').toBeGreaterThanOrEqual(45);
    const methods = new Set(writeRoutes.map(r => r.method));
    expect(methods.has('DELETE')).toBe(true);
    // no duplicate registrations
    expect(new Set(writeRoutes.map(r => r.key)).size).toBe(writeRoutes.length);
  });

  it('drives known TUI and Web write routes (normalization positive control)', () => {
    expect(drivenIn('/api/vassals/:name')).toContain('tui'); // d<n> revoke
    expect(drivenIn('/api/skills/:id/install')).toContain('web');
    expect(drivenIn('/api/org/departments/:id/commissions/:agentId/waive')).toContain('web'); // dynamic + verb
    expect(drivenIn('/api/org/departments/:id/members/:agentId')).toContain('web'); // member removal
    expect(drivenIn('/api/connectors/:id/connect')).toContain('tui'); // m<n>
    expect(drivenIn('/api/connectors/:id/connect')).toContain('web');
  });

  it('registers protocol faces outside /api and present in the route table', () => {
    for (const key of PROTOCOL_FACES) {
      const route = writeRoutes.find(r => r.key === key);
      expect(route, `${key} vanished from server.ts - update the protocol face table`).toBeTruthy();
      expect(route!.path.startsWith('/api/'), `${key} looks like an operator route, not a protocol face`).toBe(false);
    }
  });

  it('keeps the HTTP-only table honest: every entry exists and is really undriven', () => {
    for (const key of Object.keys(HTTP_ONLY)) {
      const route = writeRoutes.find(r => r.key === key);
      expect(route, `${key} is registered HTTP-only but no longer exists - remove the stale entry`).toBeTruthy();
      const drivers = drivenIn(route!.path);
      expect(drivers, `${key} now has a ${drivers.join(',')} driver - move it out of the HTTP-only table`).toEqual([]);
    }
  });

  it('leaves no write route without a driver, a protocol face, or a documented API-only registration', () => {
    const missing: string[] = [];
    for (const route of writeRoutes) {
      if (PROTOCOL_FACES.has(route.key)) continue;
      if (Object.hasOwn(HTTP_ONLY, route.key)) continue;
      const drivers = drivenIn(route.path);
      if (drivers.length === 0) {
        missing.push(`${route.key} - add a Web/TUI/script driver or register it in HTTP_ONLY with a PRD reference`);
      }
    }
    expect(missing, `undrivable write routes:\n${missing.join('\n')}`).toEqual([]);
  });
});

/**
 * The read half of the same audit (M7 slice 1c, E6.5). The write half cannot see
 * a capability the kernel computes but nobody can read: `GET /api/cost` would
 * have shipped as an auditable-only fact with no face, which is exactly how the
 * cost gate stayed invisible after it was wired. A GET route must be either a
 * protocol/public face an external party consumes, read by a shipped surface
 * (supervisor, portal, TUI, scripts), or registered as API-only with a reason.
 */
const PORTAL = readFileSync(join('web', 'portal', 'index.html'), 'utf8');
/** Comment lines are prose, not readers: without this the gate would pass on a
 *  doc comment naming a path it never requests. */
function stripCommentLines(text: string): string {
  return text
    .split('\n')
    .filter(line => !/^\s*(\/\/|\*|\/\*|<!--)/.test(line))
    .join('\n');
}
const READ_CORPORA: Array<[string, string]> = [
  ...CORPORA.map(([name, text]) => [name, stripCommentLines(text)] as [string, string]),
  ['portal', stripCommentLines(PORTAL)],
];
const READ_NORMALIZED = READ_CORPORA.map(([name, text]) => [name, normalize(text)] as const);

function readIn(path: string): string[] {
  const needle = normalize(path);
  return READ_NORMALIZED.filter(([, text]) => hasWholePath(text, needle)).map(([name]) => name);
}

const readRoutes: Route[] = [...SERVER.matchAll(/app\.get\(\s*'([^']+)'/g)].map(m => ({
  method: 'GET',
  path: m[1]!,
  key: `GET ${m[1]}`,
}));

/** Faces a remote peer or an offline verifier consumes, not an operator deck. */
const READ_PROTOCOL_FACES = new Set([
  'GET /healthz',
  'GET /api/roster/public',
  'GET /api/roster/keys',
  'GET /api/audit/summary',
  'GET /.well-known/agent-card.json',
  'GET /mcp',
  // Decision API v1 (T-M1-06, design §4.2): machine-to-machine reads for
  // zeus-client (T-M1-07), commerce-os (M3) and loom; no operator deck.
  'GET /api/v1/decisions',
  'GET /api/v1/decisions/:id',
  'GET /api/v1/decisions/:id/replay',
  'GET /api/v1/policy',
  'GET /api/v1/decision-webhooks',
  // Org API v1 (T-M2, design §4.4): machine-to-machine reads for org-os and
  // commerce-os; no operator deck in the self-use slice.
  'GET /api/v1/org/organizations',
  'GET /api/v1/org/organizations/:id',
  'GET /api/v1/org/departments',
  'GET /api/v1/org/positions',
  'GET /api/v1/org/tasks',
  'GET /api/v1/org/tasks/:id',
  // Memory API v1 (MemoryPort v1 §7, ruling D-6): machine-to-machine reads
  // for the cross-agent consumer face behind ZEUS_MEMORY_SERVICE_TOKEN; the
  // calling agent is the reader, namespace is its realm. No operator deck.
  'GET /api/v1/memory/counts',
]);

/** Mounted per boot depending on configuration; reading them is a follow-up,
 *  each registered with why it is not on a face yet.
 *
 *  This table was 10 entries on 2026-10-13 and 6 on 2026-10-14, when supervisor
 *  v1.20 (M7 slice 4 first batch) put readers on the trace tree, the skill
 *  version history, the first-day briefing and the access probe. The remaining
 *  six (the memory face) were closed by v1.21 the same day, so the table is
 *  empty again: every bearer-mounted read route now has a reader on at least
 *  one shipped face, or is a protocol face.
 *
 *  An empty table is not permission to stop checking. The "leaves no read
 *  route without a reader" test below is the invariant; this table is only the
 *  honest escape hatch, and a reason string must cite where a gap is tracked
 *  so the table cannot be used to bury one. If a future batch adds a read
 *  route nobody can drive, it belongs here the day it ships, not later. */
const READ_API_ONLY: Record<string, string> = {
  // TracePort v1 §5 (D-5, W2-4): the cross-intent trace query face ships
  // API-only; the ops-console /app/traces BFF page (W2-5) is its reader.
  'GET /api/v1/traces': 'tracked: PRD F2 / D-5 (TracePort v1 section 5; ops-console reader lands with W2-5)',
};

describe('operator surface coverage - read routes', () => {
  it('collects the read set from real registration sites (positive control)', () => {
    expect(readRoutes.length, 'the scan found no GET routes - it is broken').toBeGreaterThanOrEqual(30);
    expect(readRoutes.some(r => r.key === 'GET /api/cost'), 'GET /api/cost is not in the route table').toBe(true);
    expect(new Set(readRoutes.map(r => r.key)).size).toBe(readRoutes.length);
  });

  it('sees a route that is genuinely read (normalization positive control)', () => {
    expect(readIn('/api/cost')).toEqual(expect.arrayContaining(['tui', 'web']));
    expect(readIn('/api/roster/public')).toContain('portal');
    expect(readIn('/api/state')).toContain('tui');
    // M7 slice 4 first batch (2026-10-14, supervisor v1.20): the four read
    // routes that left READ_API_ONLY must be seen on a real face, or their
    // removal from the table would be the only thing keeping the gate green.
    expect(readIn('/api/intents/:id/trace'), 'trace tree lost its reader').toContain('web');
    expect(readIn('/api/skills/:id/versions'), 'skill versions lost their reader').toContain('web');
    expect(readIn('/api/org/departments/:id/briefing/:agentId'), 'briefing lost its reader').toContain('web');
    expect(readIn('/api/domains/access'), 'access probe lost its reader').toContain('web');
    // M7 slice 4 second batch (2026-10-14, supervisor v1.21): the memory face.
    // The six endpoints that emptied READ_API_ONLY must stay read on a real
    // face - an empty table is not permission to stop checking.
    expect(readIn('/api/memory/events'), 'memory events lost their reader').toContain('web');
    expect(readIn('/api/memory/facts'), 'memory facts lost their reader').toContain('web');
    expect(readIn('/api/memory/replay'), 'memory replay lost its reader').toContain('web');
    expect(readIn('/api/memory/recall'), 'memory recall lost its reader').toContain('web');
    expect(readIn('/api/memory/retractions'), 'memory retractions lost their reader').toContain('web');
    expect(readIn('/api/memory/integrity'), 'memory integrity lost its reader').toContain('web');
  });

  it('keeps the read-only tables honest: entries exist and are really unread', () => {
    for (const [key, reason] of Object.entries(READ_API_ONLY)) {
      const route = readRoutes.find(r => r.key === key);
      expect(route, `${key} is registered read-only but no longer exists - remove the stale entry`).toBeTruthy();
      expect(readIn(route!.path), `${key} now has a reader - move it out of the read-only table`).toEqual([]);
      // A registration without a tracked place to come back to is how a gap
      // becomes permanent.
      expect(reason, `${key} is registered with no tracking reference`).toMatch(/tracked: .*(Active work|deferred|PRD)/);
    }
    // The table is empty as of 2026-10-14 (v1.21). Pin the closure of the ten
    // routes it once held: re-registering one of them without a reader is
    // exactly the "bury the gap" failure the table exists to prevent, and the
    // loop above is vacuous while the table is empty.
    const CLOSED_2026_10_14 = [
      'GET /api/intents/:id/trace',
      'GET /api/org/departments/:id/briefing/:agentId',
      'GET /api/memory/events',
      'GET /api/memory/facts',
      'GET /api/memory/replay',
      'GET /api/memory/recall',
      'GET /api/memory/retractions',
      'GET /api/memory/integrity',
      'GET /api/skills/:id/versions',
      'GET /api/domains/access',
    ];
    for (const key of CLOSED_2026_10_14) {
      expect(Object.hasOwn(READ_API_ONLY, key), `${key} is registered read-only again - if it truly lost its reader, fix the reader, do not bury the gap`).toBe(false);
    }
    for (const key of READ_PROTOCOL_FACES) {
      expect(readRoutes.find(r => r.key === key), `${key} vanished - update the read protocol face table`).toBeTruthy();
    }
  });

  it('caps the registered read gaps so a new one cannot be added without a decision', () => {
    // 2026-10-13 baseline: ten routes the kernel computes that no face reads.
    // 2026-10-14: four closed by supervisor v1.20 (M7 slice 4 first batch),
    // the memory six closed by v1.21 (second batch) - the table is empty.
    // Raising this number is the moment a new unread capability is being
    // shipped, and an entry without a tracked destination is a buried one.
    expect(Object.keys(READ_API_ONLY).length, 'read-gap table grew past the tracked baseline').toBeLessThanOrEqual(10);
  });

  it('leaves no read route without a reader, a protocol face, or a documented API-only registration', () => {
    const unread: string[] = [];
    for (const route of readRoutes) {
      if (READ_PROTOCOL_FACES.has(route.key)) continue;
      if (Object.hasOwn(READ_API_ONLY, route.key)) continue;
      if (readIn(route.path).length === 0) {
        unread.push(`${route.key} - read it on a surface or register it in READ_API_ONLY with a reason`);
      }
    }
    expect(unread, `unread read routes (the kernel computes them, no operator can see them):\n${unread.join('\n')}`).toEqual([]);
  });
});
