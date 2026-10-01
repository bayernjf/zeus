import { describe, expect, it } from 'vitest';
import { en, messages, zhCN, type MessageKey } from '../src/tui/messages.js';
import { format, makeTranslator, resolveLocale, statusLabel } from '../src/tui/format.js';

/** Extract {placeholders} from an ICU-ish template (TUI subset). */
function placeholders(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
}

describe('TUI i18n contract (design-ui-foundations §5)', () => {
  const keys = Object.keys(zhCN) as MessageKey[];

  it('zh-CN and en expose the identical key set', () => {
    expect(Object.keys(en).sort()).toEqual(keys.slice().sort());
  });

  it('every value is a non-empty string', () => {
    for (const key of keys) {
      expect(typeof zhCN[key]).toBe('string');
      expect(zhCN[key].length).toBeGreaterThan(0);
      expect(typeof en[key]).toBe('string');
      expect(en[key].length).toBeGreaterThan(0);
    }
  });

  it('each locale uses the same placeholder set per key', () => {
    for (const key of keys) {
      expect(placeholders(en[key]), key).toEqual(placeholders(zhCN[key]));
    }
  });

  it('interpolates params and leaves a missing param as its literal placeholder', () => {
    expect(format('hi {name}', { name: 'zeus' })).toBe('hi zeus');
    expect(format('hi {name}')).toBe('hi {name}');
  });

  it('renders a key absent from both tables as the key itself', () => {
    const enT = makeTranslator('en');
    const zhT = makeTranslator('zh-CN');
    expect(enT('not.a.real.key' as MessageKey)).toBe('not.a.real.key');
    expect(zhT('not.a.real.key' as MessageKey)).toBe('not.a.real.key');
  });

  it('translates and resolves locales by BCP 47 prefix', () => {
    const zh = makeTranslator('zh-CN');
    const enT = makeTranslator('en');
    expect(zh('intent.status.needs-driver')).toBe('待裁决');
    expect(enT('intent.status.needs-driver')).toBe('needs driver');
    expect(resolveLocale('en_US.UTF-8')).toBe('en');
    expect(resolveLocale('zh_CN.UTF-8')).toBe('zh-CN');
    expect(resolveLocale(undefined)).toBe('zh-CN');
  });

  it('maps a known status to a label and keeps an unknown status raw', () => {
    const enT = makeTranslator('en');
    expect(statusLabel(enT, 'completed')).toBe('completed');
    expect(statusLabel(enT, 'totally-new')).toBe('unknown status totally-new');
  });

  it('registers exactly the two v1 locales', () => {
    expect(Object.keys(messages).sort()).toEqual(['en', 'zh-CN']);
  });
});
