# Z-04 长会话 compaction/writeback 验收

状态：**已完成（2026-11-24，20+ 轮分支）**。判据来自
[review-2026-11-23-original-gap.md](review-2026-11-23-original-gap.md) Z-04：
用真实长会话（≥ 一周 / ≥ 20 轮）跑 compaction + writeback，验证事实不丢、
旧事实可追溯、写回不污染决策，证据落库。

本文记录的是**真实 CLI 进程 × 24 轮**的本地验收，不把它说成一周自然使用。

## 1. 口径：这里的 “compaction” 是什么

Zeus 没有独立的摘要式（summarization）compaction 模块或 CLI。Z-04 可验收的
现有机制是两条：

1. **记忆整理（consolidation）**：`src/memory/consolidate.ts` 把 claim 事件收敛为
   fact，保留 provenance，并对重复/冲突做判定；
2. **上下文装配与水位（context watermark）**：`src/context/assemble.ts` +
   `src/core/orchestrator/context-watermark.ts` 记录每 run 装配/裁剪/超预算的读数。

因此本验收证明的是**记忆 consolidation + decision writeback + context watermark 在跨进程长会话中的耐久性**，不声称已经实现摘要式上下文压缩。

## 2. 验收方式

脚本：`scripts/acceptance-long-session.mjs`（`npm run acceptance:long-session`）。

- 24 次**独立** `node dist/daily/cli.js` 进程，共用同一个 runtime state 文件与同一个
  dataDomain root；
- 每轮一个真实 Tier 0 项目问题（Zeus Z-04/Z-07、Atlas T5/T6/T7、Loom L-01/L-03/L-04、
  Agent Ops F6/F7、BayJF、commerce-os、growth-os、code-audit、pr-helper、job-agent、
  Argus、Tier0 台账等），不是随机填充；
- 每轮 params 带不同 `subject`（`project:<slug>:round-NN`）、固定
  `predicate: deployment-health`，使 24 条事实可区分、可查询；
- 对端是本机确定性 A2A reference peer（skill `deployment-health`，恒返回
  `stance: healthy`），零文件系统、零出网、零模型；
- `ZEUS_AUDIT_FILE` / `ZEUS_AUDIT_MAX_BYTES=0` / `ZEUS_MEMORY_EMBEDDING=off`；
- 结束后读 audit JSONL 与 state memory，重建 `MemoryStore`，用第一轮 subject
  直接 recall 验证旧事实可检索；
- 证据落 `outputs/z04-long-session/`：`01-summary.md`、`evidence.json`、
  `session.jsonl`、`audit.jsonl`、`memory.json`。

复现：

```bash
npm run build
npm run acceptance:long-session   # 可用 Z04_ROUNDS 调整，必须 >= 20，默认 24
```

## 3. 实测读数（2026-11-24）

`evidence.json` 的 `ok: true`，关键计数：

| 项 | 读数 |
| --- | --- |
| rounds | 24/24 |
| unique intent ids / run ids | 24 / 24 |
| context watermark rows | 24 |
| assembled max | 20 |
| trimmed / over budget | 0 / 0 |
| decision events | 24 |
| claim events | 48 |
| active facts | 25（24 条 topic fact + 1 条 settled decision fact） |
| settled decision facts | 1，provenance 24 |
| disputed facts | 0 |
| writeback skipped / consolidation failed | 0 / 0 |
| missing expected subjects | 0 |
| old fact traceable / recallable | true / true |
| writeback did not pollute decisions | true（唯一结论 `healthy`） |
| capObserved | true（assembled 达到 20 entry 上限） |

水位说明：recall 的 `limit` 也是 20，所以本轮观察到的是“达到上限后不再增长”，
没有产生 `context-trimmed` 或 `context-budget-exceeded` 事件；这不是裁剪路径的
负向验收。

第一轮可追溯样例：

- intent `intent-ba4d5af0-3841-4d56-8818-896c1948ca9e`
- run `zeus-run-8652d044-ea55-4ca8-8a9c-34108606e6f5`
- fact `62fac7e58e3ccb37eed33b53`，provenance 指向该 run 的 claim 事件
- recall 第一位命中该 fact（score 0.7767）

## 4. 验收逼出并修复的两个真实缺陷

### 4.1 一次性进程丢写回

`consolidateFinishedMemory` 原本是 fire-and-forget 的 async IIFE；`daily` 在
`fanOut` 返回后立刻 `writeRecord` + `saveState` + 退出，consolidation 可能还没
完成就丢。结果是命令报成功，但记忆没有落盘。

修复（`src/state/boot.ts`）：

- 新增 `memoryWorkTail`，把 consolidation 串行链起来；
- `persistLiveState` 采集快照前循环 drain `memoryWorkTail`，确保 decision
  writeback / consolidation 先落盘，再 `collectRuntimeState`；
- 失败仍 fail-soft，并写 `memory-consolidation-failed` 审计，不静默。

回归测试：`tests/daily-entry.test.ts`
`durably writes the settled conclusion back before the one-shot run returns`。

### 4.2 重复同结论被整理成假冲突

24 轮跑完后，所有 `settled-decision` facts 都是 `status: disputed`。原因：
decision memory 的 `object` 里包含每轮唯一的 `intentId`，consolidation 按
subject/predicate/object 比较，24 次 `healthy` 被当成 24 个不同答案。

修复（`src/state/boot.ts`）：

- `object` 改为稳定的 `{ conclusion, conflicts }`；
- `intentId` 移到事件顶层 `refs: [intentId, runId]`，保留可追溯性但不制造假分歧。

回归测试：`tests/daily-entry.test.ts`
`consolidates repeated settled decisions instead of inventing disputes`；同批把
`tests/runtime-memory-p1.test.ts` 的旧契约断言改为“object 无 intentId、refs 保留
intentId”。

## 5. 边界

- 24 轮是判据的“≥ 20 轮”分支，**不是一周 wall-clock 自然使用**；
- 对端是本地确定性替身，只证明记忆/上下文路径，不证明答案质量；
- 未声称摘要式 compaction；`assembled=20` 是当前 recall 上限，裁剪/预算路径
  在本轮没有触发；
- 证据中的 project subject 是合成事实，用于验收记忆机制，不代表这些项目的
  真实部署健康结论。
