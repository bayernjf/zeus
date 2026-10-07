#!/usr/bin/env node
/**
 * #28 「状态列 vs 正文」冲突候选检测器（deferred #28 口径：不入 CI，评审每轮带校准样例跑）。
 *
 * 为什么不做成 CI 断言（deferred #28 两次实测结论）：
 * - 词表版语义判定在真表上的假阳性 2026-09-25 为 5/54、2026-09-27 复量为 2/54，
 *   同一类子句语义（过去时陈述、条件句、已登记的依赖注记）没有被词表收住；
 * - 词表进 CI 的代价是下一批合理措辞会让门禁红，而这条检查的价值恰恰依赖它
 *   不被人为放宽。结构判定（状态列形状）已在 tests/doc-consistency.test.ts 第 5 例，
 *   零假阳性可进 CI；本脚本只做「列与正文是否打脸」的候选扫描，输出由评审人工核对。
 *
 * 校准样例（跑当前真表应归零，或只报出下列已豁免形态）：
 * - E3.4（🚧，正文 "stdio 壳已落地"）＝部分落地，列与正文一致 —— 假阳性（2026-09-27）
 * - E8.3（✅，正文含 "还没有记忆事件生产者"）＝已登记的依赖注记，deferred #27 明文允许
 *   的 ✅ 形态 —— 假阳性（2026-09-27）
 * - E4.8（✅，正文含 "此前写的阻塞原因…是错的"）＝过去时/纠偏陈述 —— 豁免（2026-09-25）
 *
 * 用法：node scripts/check-prd-status-body.mjs [--verbose]
 * 退出码：0 = 无候选命中；1 = 有候选命中（需人工核对，非 CI 失败）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const prdPath = join(__dirname, '..', 'docs', 'prd.md');
const verbose = process.argv.includes('--verbose');

/**
 * 词表严格复刻 deferred #28 两次实测口径（2026-09-25/09-27）：
 * - ✅ 行正文含 未实现/尚未/还没有 → 候选（列说已做、正文说没做）
 * - ⬜/🚧 行正文含 已落地/已交付 → 候选（列说未做、正文说已做）
 * 刻意不含「未做/仍未做/待做」：✅ 行出现这些词几乎总是「已落地 X；子项 Y 仍未做」
 * 式的透明部分完成标注（E1.3/E1.4），不构成列与正文打脸；纳入词表只会复刻
 * v1 的 5/54 假阳性。
 */
/** ✅ 行正文含这些词 → 候选「列说已做、正文说没做」。 */
const DONE_ROW_TODO_WORDS = /未实现|尚未|还没有/;
/** ⬜/🚧 行正文含这些词 → 候选「列说未做、正文说已做」。 */
const TODO_ROW_DONE_WORDS = /已落地|已交付/;
/**
 * 豁免：过去时/纠偏/已登记的依赖注记/条件句/委托注记。粗粒度整行匹配，
 * 命中即打印跳过原因，由评审每轮带校准样例复核 —— 这正是 deferred #28 要求
 * 「不被人为放宽」的折中：放宽动作留给人，机器只负责点名。
 */
const EXEMPT_CLAUSES = [
  { re: /此前/, note: '过去时陈述' },
  { re: /已修|已修复/, note: '修复标记' },
  { re: /已登记/, note: '登记注记' },
  { re: /已更正/, note: '更正注记' },
  { re: /已销项/, note: '销项注记' },
  { re: /deferred #\d+/, note: 'deferred 依赖/委托注记' },
  { re: /触发|触发条件/, note: '触发条件句' },
  { re: /不可用即|不可用则/, note: '条件句' },
  { re: /由评审/, note: '评审委托注记' },
  { re: /剩余归/, note: '剩余归 deferred 注记' },
  { re: /待 /, note: '待触发注记' },
];

const text = readFileSync(prdPath, 'utf8');
const rows = [];
for (const [index, line] of text.split('\n').entries()) {
  const match = line.match(/^\| (E[\d.]+) \| (.+?) \| (P\d) \| (✅|🚧|⬜) \| (.+) \|$/);
  if (match) rows.push({ lineNo: index + 1, id: match[1], title: match[2], pri: match[3], status: match[4], body: match[5] });
}

const hits = [];
let exempted = 0;
for (const row of rows) {
  const pattern = row.status === '✅' || row.status === '🚧' ? DONE_ROW_TODO_WORDS : TODO_ROW_DONE_WORDS;
  if (!pattern.test(row.body)) continue;
  const exemption = EXEMPT_CLAUSES.find(({ re }) => re.test(row.body));
  if (exemption) {
    exempted += 1;
    if (verbose) console.log(`[exempt] ${row.id} (${row.status}) — ${exemption.note}`);
    continue;
  }
  hits.push(row);
}

if (hits.length === 0) {
  console.log(`PRD 状态列 vs 正文：${rows.length} 行需求，${hits.length} 个候选冲突，${exempted} 行命中豁免词（${verbose ? '明细见上' : '加 --verbose 查看'}）。`);
  process.exit(0);
}
console.log(`PRD 状态列 vs 正文：${rows.length} 行需求，${hits.length} 个候选冲突（需人工核对）：`);
for (const row of hits) {
  const word = (row.status === '✅' || row.status === '🚧' ? DONE_ROW_TODO_WORDS : TODO_ROW_DONE_WORDS).exec(row.body)?.[0];
  console.log(`  ${row.lineNo}: ${row.id} [${row.status}] 命中「${word}」：${row.body.slice(0, 120)}…`);
}
process.exit(1);
