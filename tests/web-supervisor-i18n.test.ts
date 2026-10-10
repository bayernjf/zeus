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
    ]);
    expect(acts.length).toBeGreaterThan(5);
    for (const act of acts) expect(known.has(act), act).toBe(true);
    // no UI-private action names leaked into the audit path: network access is
    // confined to the three known consumers - api(), apiText() and the SSE stream
    const fetches = HTML.match(/fetch\(/g) || [];
    expect(fetches.length).toBe(3);
  });
});
