# 设计稿：Human-in-the-loop 介入时机（tech map S10）

- 状态：**现行 v0.3（2026-10-09）**：设计稿 + **V1/V2 已落码**——V1（Active work 167）`src/oversight/interrupt.ts` 纯函数 `classifyInterruption`/`interruptionReason`（六信号→L0/L1/L2 固定判定链，零 IO 零接线）+ 审计 3 值 `interrupt-level-0/1/2` + TUI token；**V2（2026-10-09）已落码**：升级队列登记 `interruptLevel`（0 自动消解 / 1 异步挂起 / 2 同步阻塞），四类 ingest 默认级别、watch 两处 execute 拒绝路径传级、escalateLimit 回调透传、TUI 级别徽标与中英文案；V3（可选）待分期。
- 演进：v0.1（2026-10-09）设计探索先行（分级判定链 + `classifyInterruption` 接口草案）；v0.2（2026-10-09，Active work 167）V1 落码（`src/oversight/interrupt.ts` + `tests/interrupt-classify.test.ts` 15 例 + 审计/TUI 接线，基线 1379/125 → 1410/126、冒烟 45/45、doc-consistency 18/18）；v0.3（2026-10-09）V2 落码（升级队列/审计/watch/TUI 全链接 interruptLevel，新增 oversight/watch/tui-render 测试 7 例，A 档三批合批收尾基线 1410/126 → 1430/128、冒烟 45/45、doc-consistency 18/18）。
- 关联：tech map S10（何时打断人、何时异步介入，不打断心流）；design-supervision.md（§6 裁决/升级、§7.1 终止与收敛 S4）；design-backpressure.md（分流候选集 selectTargets）；design-external-trust.md（E9.4 信任分级）；`src/oversight/oversight.ts`（升级队列）；`src/delegation/delegation-contract.ts`（父授权契约）。
- 本文是介入时机策略的单一事实源；handoff 与 PRD 只索引，不复制全文。

## 1. 背景与现状

**已有的人工介入点盘点（2026-10-09）**：

| 介入点 | 现状 | 位置 |
| --- | --- | --- |
| 升级队列 | `task-input` / `intent-conflict` 两类升级，操作者 `approve` / `reject` / `resolveDecideConflict` 裁决 | `src/oversight/oversight.ts` |
| watch 评估 | 调用方驱动的一次评估 tick（`POST /api/watch-tick`），条件满足才 fire | `src/watch/`、`scripts/run-watch-tick.mjs` |
| 委托契约授权 | `delegation-limit` 越限时操作者"签新契约并批准"换绑 | `src/delegation/delegation-contract.ts`、H2 `approve-contract` |
| 终止守卫 | 步数预算 256 / 连续失败熔断 8；显式点名与 resume（操作者驱动）不受熔断 | `src/orchestrator/termination.ts`、design-supervision §7.1 |
| 决策回放 | `GET /api/intents/:id/replay` 人读时间线，操作者据此裁决 | `src/http/` H2 |

**缺口**：介入点存在，但没有统一的**时机判定**——"什么信号该打断操作者、什么信号异步挂起、什么信号完全不需要人"。现状是各点自定规则（升级队列只在冲突/补参时触发、watch 只在条件满足时 fire），没有一条贯穿的判定链。结果：要么该打扰时没打扰（intent 卡死而无人知），要么无关紧要的失败也涌进队列（心流被打断）。

## 2. 目标与边界

**目标**：定义一条确定性的**介入分级判定链**——给定意图执行中的任一信号，判定它属于哪个介入级别（不打扰 / 异步介入 / 同步打断），并给出该级别的动作原语。原则：**默认不打断**；只有"进展被卡死且无自动路径"才同步等待操作者；可自动消解的一律走自动链，可挂起的走队列。

**边界（明确不做）**：
- 不做加急通道（短信/电话/推送）：仓库外动作。
- 不改变既有原语的语义（升级队列/契约/watch/守卫照旧），只在其上叠加分级与判定。
- 不做操作者优先级的调度（哪个操作者先处理哪条）：另行议题。

## 3. 介入分级

| 级别 | 含义 | 动作 | 示例 |
| --- | --- | --- | --- |
| **L0 不介入** | 可自动消解或已收敛，操作者零打扰 | 自动链照跑；审计记录即可 | 分支成功；失败后重试/换将/降级成功；冲突被仲裁规则消解 |
| **L1 异步介入** | 进展挂起在队列，操作者**任意时刻**处理，不阻塞其他意图 | 升级队列挂一条带选项的记录（沿用 `{reason, options}` 形状）；处理前意图保持挂起 | intent-conflict 无法自动消解；task-input 缺参待补；delegation-limit 越限待签新契约 |
| **L2 同步打断** | 进展**卡死**：意图无法继续、且无自动路径、且后续动作依赖该意图的结果 | 显式等待操作者裁决（resume / approve）才能继续；裁决前不再派生 | 显式点名分支失败且无其他 provider；自动路径全耗尽的 intent 等待换向指令 |

**判定次序（固定，不并行）**：`可自动消解？→ L0`；`卡死（无自动路径且依赖它）？→ L2`；`否则挂起 → L1`。

## 4. 判定链设计

输入信号与既有原语一一对应，产出级别：

| 输入信号 | 现有原语 | 判定 | 级别 |
| --- | --- | --- | --- |
| 分支失败 | 失败分类（`branch.ok === false`） | 幂等且未超重试上限 → 自动重试；非幂等或重试耗尽 → 进入下一步 | L0 → 下查 |
| 重试/换将/降级链 | design-supervision §6.1 固定次序 | 链上任一步成功 → 收敛；链耗尽 → 下查 | L0 → 下查 |
| 高利害标记 | 无（需新增信号，见 §5） | 高利害且自动链将执行 → 跳过自动链直接挂起 | L1 |
| 连续失败熔断 | S4 熔断计数 | 熔断打开且非显式点名 → 拒绝派生；显式点名失败 → 下查 | L0（拒绝+审计）→ 下查 |
| 显式点名分支失败 | resume / 点名路径 | 无替代 provider 且意图依赖其结果 → 等待操作者 | **L2** |
| intent-conflict | 升级队列 `intent-conflict` | 仲裁规则可消解 → 自动；否则挂起带 stances 选项 | L0 / **L1** |
| task-input 缺参 | 升级队列 `task-input` | 无法从技能 inputs 声明补全（S1 V2 unavailable）→ 挂起待补 | **L1** |
| delegation-limit 越限 | `approve-contract` | 无覆盖契约 → 挂起"签新契约并批准"动作 | **L1** |
| watch 条件满足 | 评估 tick | fire 后按上述链继续 | 依链 |

**不打断心流的两条硬规则**：
1. **L2 只给"卡死"**：意图仍有自动路径（哪怕慢）就不进 L2；L2 判定依赖"无替代 provider"与"后续依赖它"两个条件同时成立。
2. **L1 不阻塞全局**：升级队列挂起不占用并发槽、不阻塞其他意图派发；操作者处理是异步的，处理前意图保持挂起而非回滚。

## 5. 落地接口草案（设计级，未落码）

```ts
// src/oversight/interrupt.ts（纯函数，零内核状态）
type InterruptLevel = 0 | 1 | 2; // L0 不介入 / L1 异步介入 / L2 同步打断
type InterruptSignal =
  | { kind: 'branch-failed'; idempotent: boolean; retriesLeft: number; highStakes: boolean }
  | { kind: 'circuit-open'; explicitlyNamed: boolean }
  | { kind: 'intent-conflict'; autoResolvable: boolean }
  | { kind: 'task-input-missing'; field: string }
  | { kind: 'delegation-limit-hit'; coveredByContract: boolean }
  | { kind: 'explicit-branch-failed'; hasFallbackProvider: boolean; downstreamDependsOnIt: boolean };

function classifyInterruption(sig: InterruptSignal): InterruptLevel { /* 判定链表驱动 */ }
```

- 审计标注：新 decision 值 `interrupt-level-0|1|2` 进 `AUDIT_DECISIONS`（实施时定措辞），与既有 `inbound-task-*` / `branch-*` 同脊。
- `highStakes` 信号来源（设计级）：委托契约 capability 边界（execute）与数据域跨域授权（DomainGrant）覆盖的动作默认为高利害；具体清单实施时定。

## 6. 分期

- **V1（纯函数判定链）**：`classifyInterruption` + 判定表测试（正/反例各信号） + 审计标注；不接任何既有原语。**✅ 已落地（2026-10-09，Active work 167）**。
- **V2（接升级队列）**：oversight 升级队列登记 `interrupt-level` 字段，L1/L2 的记录带级别可见；watch 评估 tick 输出级别。**✅ 已落地（2026-10-09）**——升级队列四类 ingest 默认级别（task-input/intent-conflict=1、memory-dispute 经常量缺省 1、ingestDelegationLimit 入参可选）、audit() 仅 escalated 写级别、watch 两处 execute 拒绝路径传级、escalateLimit 回调与 boot 透传、TUI 徽标/文案。
- **V3（可选）**：L2 等待的操作者裁决动作标准化（resume 带级别提示）。

**验收（V1 实施时）**：每条信号至少一正一反例；L2 仅"卡死"双条件同时成立时产生；全量与冒烟不回归（本设计不新增运行时行为，V1 只是纯函数 + 测试）。
