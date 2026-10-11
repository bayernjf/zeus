import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

/**
 * Contract guard for the supervisor web console's design foundations
 * (docs/design-ui-foundations.md §3/§5/§7):
 *  - every user-facing string lives in the I18N resource tables, keyed by domain;
 *  - zh-CN and en tables carry exactly the same keys, with the same {params};
 *  - every data-i18n / data-i18n-ph reference in the markup resolves;
 *  - no window.confirm remains - destructive/write actions go through the
 *    promise-based confirm dialog that E2E can assert and keyboards can reach;
 *  - the theme toggle and dialog root exist.
 */

const HTML = readFileSync('web/supervisor/index.html', 'utf8');

function loadRes(): Record<string, Record<string, string>> {
  const begin = HTML.indexOf('// I18N-RES-BEGIN');
  const end = HTML.indexOf('// I18N-RES-END');
  expect(begin).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(begin);
  const block = HTML.slice(begin, end);
  const match = block.match(/const RES = (\{[\s\S]*\});/);
  expect(match).toBeTruthy();
  const sandbox: { RES?: Record<string, Record<string, string>> } = {};
  vm.createContext(sandbox);
  vm.runInContext(`RES = ${match![1]!};`, sandbox);
  return sandbox.RES!;
}

const RES = loadRes();
const zh = RES['zh-CN']!;
const en = RES.en!;

describe('web supervisor i18n resources', () => {
  it('has zh-CN and en tables with identical key sets', () => {
    const zhKeys = Object.keys(zh).sort();
    const enKeys = Object.keys(en).sort();
    expect(zhKeys.length).toBeGreaterThan(100);
    expect(enKeys).toEqual(zhKeys);
  });

  it('has no empty values', () => {
    for (const [lang, table] of Object.entries(RES)) {
      for (const [key, value] of Object.entries(table)) {
        expect(typeof value === 'string' && value.trim().length > 0, `${lang}:${key}`).toBe(true);
      }
    }
  });

  it('keeps {param} placeholders in parity per key', () => {
    const paramsOf = (value: string) => (value.match(/\{[^}]+\}/g) || []).sort();
    for (const key of Object.keys(zh)) {
      expect(paramsOf(en[key]!), key).toEqual(paramsOf(zh[key]!));
    }
  });

  it('resolves every data-i18n / data-i18n-ph reference in markup', () => {
    const refs = [...HTML.matchAll(/data-i18n(?:-ph)?="([^"]+)"/g)].map(m => m[1]!);
    expect(refs.length).toBeGreaterThan(50);
    for (const key of refs) {
      expect(Object.hasOwn(zh, key), key).toBe(true);
    }
  });

  it('resolves every translation key the script asks for', () => {
    // Markup references were covered; keys used only from JS were not, so a
    // table header could render its own key name at the operator (col.grantedBy
    // shipped that way). Concatenated keys are excluded: the enum maps below
    // build them at runtime, and each family is pinned by name in its own test.
    const script = HTML.slice(HTML.indexOf('// I18N-RES-END'));
    const refs = [...script.matchAll(/(?:^|[^A-Za-z0-9_.])t\(\s*'([^']+)'\s*[,)]/gm)].map(m => m[1]!);
    expect(refs.length, 'the script no longer asks for keys by literal name - the scan would pass by finding nothing').toBeGreaterThan(200);
    const missing = [...new Set(refs)].filter(key => !Object.hasOwn(zh, key) || !Object.hasOwn(en, key));
    expect(missing, `keys the script asks for that no table defines:\n${missing.join('\n')}`).toEqual([]);
  });

  it('gives every mentorship status a label in both tables', () => {
    // The ledger badge is built as tl('mt.status.' + status, status), so an
    // absent label degrades to the raw API value instead of going red.
    for (const status of ['teaching', 'certified', 'failed', 'dismissed']) {
      for (const table of [zh, en]) {
        expect(Object.hasOwn(table, `mt.status.${status}`), status).toBe(true);
      }
    }
  });

  it('keeps status enums as raw API values with label maps and raw fallback', () => {
    for (const state of ['completed', 'failed', 'canceled', 'running', 'queued', 'dispatched', 'acknowledged', 'timed_out', 'refused']) {
      expect(Object.hasOwn(zh, `task.${state}`), state).toBe(true);
    }
    for (const kind of ['task-input', 'intent-conflict', 'memory-dispute', 'delegation-limit']) {
      expect(Object.hasOwn(zh, `esc.kind.${kind}`), kind).toBe(true);
    }
    for (const status of ['pending', 'approved', 'rejected']) {
      expect(Object.hasOwn(zh, `esc.status.${status}`), status).toBe(true);
    }
    // unknown values fall back to the raw API value
    expect(HTML).toContain('function tl(key, raw)');
  });
});

describe('web supervisor UX foundations', () => {
  it('has no window.confirm call sites left', () => {
    expect(HTML).not.toContain('window.confirm(');
    expect(HTML.match(/confirmDialog\(/g)!.length).toBeGreaterThan(5);
  });

  it('ships the confirm dialog root and light/dark theme toggle', () => {
    expect(HTML).toContain('id="dlgRoot"');
    expect(HTML).toContain(':root[data-theme="light"]');
    expect(HTML).toContain('id="btnTheme"');
    expect(HTML).toContain('id="btnLang"');
    expect(HTML).toContain('zeus-supervisor-theme');
    expect(HTML).toContain('zeus-supervisor-lang');
  });

  it('keeps no hardcoded CJK strings in the script outside the resource table', () => {
    const scriptRegion = HTML.slice(HTML.indexOf('// I18N-RES-END'));
    const stripComments = (line: string) => line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
    const offenders = scriptRegion
      .split('\n')
      .map(stripComments)
      .filter(line => /[一-鿿]/.test(line))
      // the language toggle label itself is allowed to name the other locale
      .filter(line => !line.includes("btnLang"));
    expect(offenders).toEqual([]);
  });
});

/**
 * design-ui-foundations §7 gates 1/2/3/8: token completeness across themes,
 * no raw values outside token definitions, contrast floor, audit-equivalence
 * of every action the UI can trigger.
 */
const STYLE = HTML.match(/<style>([\s\S]*?)<\/style>/)![1]!;

function themeTokens(selector: string): Record<string, string> {
  const block = STYLE.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([\\s\\S]*?)\\n  \\}`))!;
  expect(block, `${selector} block missing`).toBeTruthy();
  const out: Record<string, string> = {};
  for (const m of block![1]!.matchAll(/(--[\w-]+):\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
}

const DARK = themeTokens(':root');
const LIGHT = themeTokens(':root[data-theme="light"]');

function srgb(channel: number): number {
  return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
}
function luminance(hex: string): number {
  const c = hex.replace('#', '');
  const channels = [0, 2, 4].map(i => srgb(parseInt(c.slice(i, i + 2), 16) / 255));
  const r = channels[0]!;
  const g = channels[1]!;
  const b = channels[2]!;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const sorted = [luminance(a), luminance(b)].sort((x, y) => y - x);
  const hi = sorted[0]!;
  const lo = sorted[1]!;
  return (hi + 0.05) / (lo + 0.05);
}

describe('web supervisor design tokens (§7.1/§7.2/§7.3)', () => {
  it('gives every semantic token a value in both light and dark themes', () => {
    const darkKeys = Object.keys(DARK).sort();
    expect(darkKeys.length).toBeGreaterThan(15);
    expect(Object.keys(LIGHT).sort()).toEqual(darkKeys.filter(k => k !== '--mono' && k !== '--sans'));
    for (const [theme, table] of [['dark', DARK], ['light', LIGHT]] as const) {
      for (const [key, value] of Object.entries(table)) {
        expect(value.length, `${theme}:${key}`).toBeGreaterThan(0);
      }
    }
  });

  it('keeps raw color values out of the stylesheet outside the two token blocks', () => {
    const stripped = STYLE
      .replace(/:root \{[\s\S]*?\n  \}/, '')
      .replace(/:root\[data-theme="light"\] \{[\s\S]*?\n  \}/, '');
    const rawHex = stripped.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
    expect(rawHex).toEqual([]);
    // every color consumption goes through a variable
    const rawColorFns = stripped.match(/(?<![\w-])(rgba?|hsla?)\(/g) || [];
    expect(rawColorFns).toEqual([]);
  });

  it('keeps text and status colors above the contrast floor in both themes', () => {
    for (const [name, t] of [['dark', DARK], ['light', LIGHT]] as const) {
      expect(contrast(t['--text']!, t['--panel']!), `${name} text/panel`).toBeGreaterThanOrEqual(7);
      expect(contrast(t['--text']!, t['--bg']!), `${name} text/bg`).toBeGreaterThanOrEqual(7);
      expect(contrast(t['--text-2']!, t['--panel']!), `${name} text-2/panel`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t['--text-3']!, t['--panel']!), `${name} text-3/panel`).toBeGreaterThanOrEqual(3);
      for (const status of ['--accent', '--ok', '--warn', '--bad', '--btn-danger-text']) {
        expect(contrast(t[status]!, t['--panel']!), `${name} ${status}/panel`).toBeGreaterThanOrEqual(3);
      }
    }
  });
});

describe('web supervisor audit-equivalence (§7.8)', () => {
  it('triggers only actions backed by a real API endpoint', () => {
    const acts = [...HTML.matchAll(/data-act="([^"]+)"/g)]
      .map(m => m[1]!)
      .filter(a => a !== 'yes' && a !== 'no' && !a.includes('${'));
    const known = new Set([
      'approve', 'reject', 'resolve', // POST /api/escalations/:id/{approve,reject,resolve}
      'approve-resume', // POST /api/escalations/:id/approve-resume
      'revoke', // DELETE /api/domains/grants/:id
      'revoke-contract', // DELETE /api/delegation-contracts/:id
      'revoke-watch', // DELETE /api/watches/:id
      'approve-contract', // POST /api/escalations/:id/approve-contract
      'revoke-vassal', // DELETE /api/vassals/:name
      'reinstate-vassal', // POST /api/vassals/:name/reinstate
      'org-set-lead', // POST /api/org/departments/:id/lead
      'cm-waive', // POST /api/org/departments/:id/commissions/:agentId/waive
      'cm-commission', // POST /api/org/departments/:id/commissions/:agentId/commission
      'cm-withdraw', // POST /api/org/departments/:id/commissions/:agentId/withdraw
      'skill-install', // POST /api/skills/:id/install
      'skill-uninstall', // POST /api/skills/:id/uninstall
      'skill-deprecate', // POST /api/skills/:id/deprecate
      'skill-harden', // POST /api/skills/:id/harden
      'mt-lesson', // POST /api/mentorships/:id/lessons
      'mt-assess', // POST /api/mentorships/:id/assess
      'mt-dismiss', // POST /api/mentorships/:id/dismiss
      'connector-connect', // POST /api/connectors/:id/connect
      'connector-revoke', // DELETE /api/connectors/:id
      'connector-call', // POST /api/connectors/:id/tools/:name/call
    ]);
    expect(acts.length).toBeGreaterThan(5);
    for (const act of acts) expect(known.has(act), act).toBe(true);
    // no UI-private action names leaked into the audit path: network access is
    // confined to the three known consumers - api(), apiText() and the SSE stream
    const fetches = HTML.match(/fetch\(/g) || [];
    expect(fetches.length).toBe(3);
  });

  it('gives every button in the markup a handler in the script', () => {
    // A form whose submit button never had a listener is worse than no form: the
    // operator fills it in, clicks, and gets nothing back (#btnGrant shipped that
    // way - the panel header advertised POST /api/domains/grants, the script only
    // ever called DELETE). Buttons driven through the delegated data-act chain are
    // excluded because they carry no id-based listener.
    const cut = HTML.indexOf('<script>');
    const markup = HTML.slice(0, cut);
    const script = HTML.slice(cut);
    const ids = [...markup.matchAll(/<button\b([^>]*)>/gi)]
      .map(m => (/id="([^"]+)"/.exec(m[1]!) || [])[1])
      .filter((id): id is string => !!id);
    expect(ids.length, 'the markup no longer carries id-bearing buttons - the scan would pass by finding nothing').toBeGreaterThan(15);
    const unwired = ids.filter(id => !(script.includes(`$('${id}')`) || script.includes(`getElementById('${id}')`) || script.includes(`"${id}"`) || script.includes(`'${id}'`)));
    expect(unwired, `buttons the page renders but never wires:\n${unwired.join('\n')}`).toEqual([]);
  });
});

/**
 * Copy is an interface too. Two views told the operator "this supervisor is
 * read-only" while the very panel they sit in issues POSTs (skill lifecycle,
 * department creation) - a claim no key/parity check can see, and one that sends
 * an operator to the CLI for a button that is on screen.
 */
describe('supervisor copy describes the actions the page actually has', () => {
  // Every write path the page issues: from its literal api('POST'|'DELETE') calls
  // and from the escalation action map that assembles the path before the call.
  function writePaths(): Set<string> {
    const paths = new Set<string>();
    for (const line of HTML.split('\n')) {
      if (!/api\(['"](POST|DELETE)['"]/.test(line) && !/const path = \{/.test(line)) continue;
      for (const mention of line.matchAll(/'(\/api\/[^']*)/g)) paths.add(mention[1]!.replace(/\/+$/, ''));
    }
    return paths;
  }

  const writes = writePaths();

  it('collects the write set from real call sites (positive control)', () => {
    // Without this the read-only scan below could pass on an empty set.
    expect(writes.size, 'the page appears to issue no writes at all - the scan is broken').toBeGreaterThan(8);
    expect([...writes].some(p => p.startsWith('/api/skills')), 'skill lifecycle is a write').toBe(true);
    expect([...writes].some(p => p.startsWith('/api/org/departments')), 'departments are a write').toBe(true);
    expect(writes.has('/api/connectors'), 'connectors are now drivable from the supervisor').toBe(true);
  });

  it('never calls a view read-only for a path that same view writes', () => {
    const offenders: string[] = [];
    for (const [lang, table] of Object.entries(RES)) {
      for (const [key, value] of Object.entries(table)) {
        if (!/只读|read-only/i.test(value)) continue;
        for (const mention of value.matchAll(/\/api\/[a-z0-9-]+(?:\/[a-z0-9-]+)*/gi)) {
          const named = mention[0]!.replace(/\/+$/, '');
          for (const write of writes) {
            if (write === named || write.startsWith(`${named}/`) || named.startsWith(`${write}/`)) {
              offenders.push(`${lang}:${key} claims ${named} is read-only while the page writes ${write}`);
            }
          }
        }
      }
    }
    expect(offenders, `read-only claims contradicted by the page's own writes:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('keeps the inventory version marker equal to the page marker', () => {
    // The ledger said "方案 A v1.7" for eight page versions because nothing
    // compared it to the string the page prints about itself.
    const pageVersion = HTML.match(/side-foot">v(\d+\.\d+)/);
    expect(pageVersion, 'the page no longer prints its own version - the check would pass by finding nothing').not.toBeNull();
    const inventory = readFileSync('docs/feature-inventory.md', 'utf8');
    const claimed = [...inventory.matchAll(/Web 监督台（方案 A v(\d+\.\d+)）/g)].map(m => m[1]!);
    expect(claimed.length, 'the inventory no longer states the page version in one place').toBe(1);
    expect(claimed[0], `page says v${pageVersion![1]}, inventory says v${claimed[0]}`).toBe(pageVersion![1]!);
  });

  it('keeps the durable-history block wired with an honest unconfigured state', () => {
    // The endpoint is mounted only when the process was given a history file, so
    // the panel has to distinguish "404, nothing configured" from "read failed".
    // Drop either branch and this check goes red; a page that only ever prints the
    // array would show an empty box and read as a broken kernel.
    expect(HTML.includes("id=\"histBody\""), 'the history block markup disappeared').toBe(true);
    expect(HTML.includes("api('GET', '/api/metrics/history')"), 'the page stopped reading the endpoint').toBe(true);
    expect(HTML.includes('error.status === 404'), 'the 404 branch was removed').toBe(true);
    for (const lang of ['zh-CN', 'en'] as const) {
      expect(Object.hasOwn(RES[lang]!, 'hist.unconfigured'), `${lang}: unconfigured copy missing`).toBe(true);
      expect(Object.hasOwn(RES[lang]!, 'hist.failed'), `${lang}: failure copy missing`).toBe(true);
      // The env name is the actionable half of the message - it says what to set.
      expect(RES[lang]!['hist.unconfigured'], `${lang}: the message must name the switch`).toContain('ZEUS_METRICS_HISTORY_FILE');
    }
  });

  it('keeps the skills hint naming operations the panel really offers', () => {
    for (const lang of ['zh-CN', 'en'] as const) {
      const hint = RES[lang]!['catalog.skillsHint']!;
      expect(hint, `${lang}: the skills panel is not read-only`).not.toMatch(/只读|read-only/i);
    }
    // The hint advertises lifecycle work; the handlers it points at must exist.
    for (const verb of ['install', 'uninstall', 'deprecate', 'harden']) {
      expect(HTML.includes(`'skill-${verb}'`), verb).toBe(true);
    }
    expect(RES['zh-CN']!['catalog.skillsHint']).toContain('装卸');
    expect(RES.en!['catalog.skillsHint']!).toMatch(/Install/i);
  });
});

/**
 * The assessment dialog parses the operator's own text into the boolean the
 * mentorship ledger stores, and `passed: false` is an outcome that can fail a
 * candidate. So a verdict the parser does not recognise has to be refused
 * outright: the earlier `MT_PASS.test(v)` inline would have coerced an
 * unrecognised word (a Chinese 通过 while the token set is ASCII) to a silent
 * "failed", writing a verdict the operator never gave. The dialog copy is the
 * only place that tells the operator which tokens are accepted, so both
 * locales are pinned to the same vocabulary the parser actually uses.
 */
describe('mentorship assessment parsing', () => {
  type Checks = { checks: Array<{ criterion: string; passed: boolean; score: number }>; bad: string | null };
  const begin = HTML.indexOf('  const MT_PASS');
  const end = HTML.indexOf('\n  async function loadCommissions');
  expect(begin, 'the verdict token set moved - the extraction would pass by taking no source').toBeGreaterThan(-1);
  expect(end, 'the parser region no longer ends before loadCommissions').toBeGreaterThan(begin);
  const sandbox: Record<string, unknown> = {};
  vm.createContext(sandbox);
  vm.runInContext(
    `${HTML.slice(begin, end)}\nthis.parseMentorChecks = parseMentorChecks;`,
    sandbox,
  );
  const parse = sandbox.parseMentorChecks as (raw: string) => Checks;

  it('reads each accepted verdict token as the boolean it says', () => {
    for (const word of ['pass', 'passed', 'yes', 'y', 'true', 'PASS']) {
      expect(parse(`c | ${word} | 0.9`).checks[0]!.passed, word).toBe(true);
    }
    for (const word of ['fail', 'failed', 'no', 'n', 'false', 'FAIL']) {
      expect(parse(`c | ${word} | 0.9`).checks[0]!.passed, word).toBe(false);
    }
  });

  it('refuses a verdict outside the token set instead of calling it a failure', () => {
    const line = '能独立复现派发 | 通过 | 0.9';
    const out = parse(line);
    expect(out.checks, 'an unrecognised verdict must not reach the ledger').toEqual([]);
    expect(out.bad, 'the refused line must be shown to the operator').toBe(line);
  });

  it('refuses a malformed line before anything is submitted', () => {
    for (const line of ['criterion only', 'c | pass', 'c | pass | 2', 'c | pass | -1', 'c | pass | abc', ' | pass | 0.5']) {
      const out = parse(`${line}\nc2 | pass | 0.5`);
      expect(out.bad, line).toBe(line);
      expect(out.checks.length, `${line} blocks the whole submission`).toBe(0);
    }
    expect(parse('').checks).toEqual([]);
    expect(parse('').bad, 'blank input is nothing to refuse').toBeNull();
  });

  it('advertises in both locales the verdict tokens the parser accepts', () => {
    for (const lang of ['zh-CN', 'en'] as const) {
      const body = RES[lang]!['mt.assessBody']!;
      expect(body, `${lang}: the dialog must name the pass token`).toContain('pass');
      expect(body, `${lang}: the dialog must name the fail token`).toContain('fail');
      expect(Object.hasOwn(RES[lang]!, 'mt.checkBad'), `${lang}: refusal copy missing`).toBe(true);
      expect(RES[lang]!['mt.checkBad']!, `${lang}: the refusal must show the offending line`).toContain('{line}');
    }
  });
});
