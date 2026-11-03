/**
 * P2-1（2026-11-02 评审）防漂移：src/ 下禁止新增"裸 fetch 默认"出局面。
 *
 * 背景：2026-09 的 DNS 重绑定守卫只接了 registry/dispatch/mcp 三个面，之后
 * 新增的 6 个出局面（hub-embedder、agent-world、webhook、exporter、judge 及
 * 自查补进的 decision×3、tui）又回到裸 fetch 默认——本测试把"所有出站默认走
 * guardedFetch"钉成机器判据：新增面再写 `?? fetch` / `?? globalThis.fetch` /
 * `= fetch` 默认即判红。逃生通道照旧是 ZEUS_OUTBOUND_ALLOW_HOSTS。
 *
 * 唯一豁免：util/outbound-dns.ts 本身（guardedFetch 的定义处，包装全局 fetch）。
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

function walk(dir: string): string[] {
  // 迭代式遍历（生成器递归在某些 transform 链路上会炸栈，这里不需要递归）
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const entry of readdirSync(cur, { withFileTypes: true })) {
      const full = join(cur, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.endsWith('.ts')) out.push(full);
    }
  }
  return out;
}

// 裸全局 fetch 作为默认值/回退的两种写法。
const BARE_FALLBACK = /\?\?\s*(?:globalThis\.)?fetch\b/;
const BARE_DEFAULT = /=\s*(?:globalThis\.)?fetch\s*[,;)\n]/;

describe('P2-1 outbound guard drift fence', () => {
  it('no src/ module defaults to the bare global fetch', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (relative(SRC, file) === join('util', 'outbound-dns.ts')) continue;
      const text = readFileSync(file, 'utf8');
      if (BARE_FALLBACK.test(text) || BARE_DEFAULT.test(text)) {
        offenders.push(relative(SRC, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('guardedFetch stays the shared default and is exported', async () => {
    const mod = await import('../src/util/outbound-dns.js');
    expect(typeof mod.guardedFetch).toBe('function');
  });
});
