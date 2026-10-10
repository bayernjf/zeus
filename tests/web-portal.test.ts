import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

/**
 * Contract guard for the public roster portal (docs/design-ui.md scheme C,
 * docs/design-ui-foundations.md §3/§5/§7):
 *  - zh-CN and en resource tables carry exactly the same keys with the same
 *    {params}, and every data-i18n reference in markup resolves;
 *  - design tokens are complete across dark/light themes, with no raw hex
 *    colors outside the token definitions;
 *  - the page is read-only and audience-public: it may only call the two
 *    unauthenticated endpoints, must never attach an Authorization header,
 *    and must never issue a write method.
 */

const HTML = readFileSync('web/portal/index.html', 'utf8');

function loadRes(): Record<string, Record<string, string>> {
  const begin = HTML.indexOf('// I18N-RES-BEGIN');
  const end = HTML.indexOf('// I18N-RES-END');
  expect(begin).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(begin);
  const match = HTML.slice(begin, end).match(/const RES = (\{[\s\S]*\});/);
  expect(match).toBeTruthy();
  const sandbox: { RES?: Record<string, Record<string, string>> } = {};
  vm.createContext(sandbox);
  vm.runInContext(`RES = ${match![1]!};`, sandbox);
  return sandbox.RES!;
}

const RES = loadRes();
const zh = RES['zh-CN']!;
const en = RES.en!;

describe('web portal i18n resources', () => {
  it('has zh-CN and en tables with identical key sets', () => {
    const zhKeys = Object.keys(zh).sort();
    expect(zhKeys.length).toBeGreaterThan(20);
    expect(Object.keys(en).sort()).toEqual(zhKeys);
  });

  it('has no empty values and keeps {param} parity per key', () => {
    const paramsOf = (value: string) => (value.match(/\{[^}]+\}/g) || []).sort();
    for (const key of Object.keys(zh)) {
      expect(zh[key]!.trim().length, key).toBeGreaterThan(0);
      expect(en[key]!.trim().length, key).toBeGreaterThan(0);
      expect(paramsOf(en[key]!), key).toEqual(paramsOf(zh[key]!));
    }
  });

  it('resolves every data-i18n / data-i18n-ph reference in markup', () => {
    const refs = [...HTML.matchAll(/data-i18n(?:-ph)?="([^"]+)"/g)].map(m => m[1]!);
    expect(refs.length).toBeGreaterThan(10);
    for (const key of refs) {
      expect(Object.hasOwn(zh, key), key).toBe(true);
    }
  });

  it('keeps no hardcoded CJK strings in the script outside the resource table', () => {
    const scriptRegion = HTML.slice(HTML.indexOf('// I18N-RES-END'));
    const offenders = scriptRegion
      .split('\n')
      .map(line => line.replace(/\/\/.*$/, ''))
      .filter(line => /[一-鿿]/.test(line))
      .filter(line => !line.includes('btnLang'));
    expect(offenders).toEqual([]);
  });
});

const STYLE = HTML.match(/<style>([\s\S]*?)<\/style>/)![1]!;

function themeTokens(selector: string): Record<string, string> {
  const block = STYLE.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([\\s\\S]*?)\\n  \\}`))!;
  expect(block, `${selector} block missing`).toBeTruthy();
  const out: Record<string, string> = {};
  for (const m of block![1]!.matchAll(/(--[\w-]+):\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
}

describe('web portal design tokens', () => {
  it('keeps dark/light theme token sets identical', () => {
    const dark = themeTokens(':root');
    const light = themeTokens(':root[data-theme="light"]');
    // font stacks are theme-invariant and defined only once in :root
    expect(Object.keys(light).sort()).toEqual(
      Object.keys(dark).filter(k => k !== '--mono' && k !== '--sans').sort()
    );
  });

  it('uses no raw hex colors outside the token definitions', () => {
    const tokenBlock = /:root(?:\[data-theme="light"])? \{[\s\S]*?\n  \}/g;
    const withoutTokens = STYLE.replace(tokenBlock, '');
    expect(withoutTokens.match(/#[0-9a-fA-F]{3,8}\b/)).toBeNull();
  });

  it('ships the theme and language toggles with persisted preferences', () => {
    expect(HTML).toContain(':root[data-theme="light"]');
    expect(HTML).toContain('id="btnTheme"');
    expect(HTML).toContain('id="btnLang"');
    expect(HTML).toContain('zeus-portal-theme');
    expect(HTML).toContain('zeus-portal-lang');
  });
});

describe('web portal read-only public surface', () => {
  it('calls only the three unauthenticated public endpoints', () => {
    const fetches = [...HTML.matchAll(/fetch\(([^)]*)\)/g)].map(m => m[1]!);
    expect(fetches.length).toBe(3);
    expect(HTML).toContain('"/api/roster/public"');
    expect(HTML).toContain('"/api/roster/keys"');
    expect(HTML).toContain('"/api/audit/summary"');
  });

  it('never attaches credentials or write methods', () => {
    expect(HTML).not.toContain('Authorization');
    expect(HTML).not.toContain('Bearer');
    expect(HTML).not.toMatch(/method:\s*['"](?:POST|PUT|PATCH|DELETE)/i);
    expect(HTML).not.toContain('/api/intents');
    expect(HTML).not.toContain('/api/grants');
  });
});
