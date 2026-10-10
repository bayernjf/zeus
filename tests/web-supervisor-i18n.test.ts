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
