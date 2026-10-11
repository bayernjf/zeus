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
const WEB = readFileSync(join('web', 'supervisor', 'index.html'), 'utf8');
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

function drivenIn(path: string): string[] {
  const needle = normalize(path);
  const direct = NORMALIZED.filter(([, text]) => text.includes(needle)).map(([name]) => name);
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
    if (!text.includes(shape)) return false;
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
