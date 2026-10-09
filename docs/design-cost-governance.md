# 设计稿：成本治理——token 预算、执行中闸门与异常熔断（tech map S9）

- 状态：**现行 v0.1（2026-10-09）**：设计探索先行，未落码。本文复用 S4 终止守卫的纯函数账本形状，定义 token/时长维度的预算与闸门。
- 演进：v0.1（2026-10-09）首版——现状盘点（决策后端 cost 可信、Agent 自报 cost 只可对账、S4 只有步数维度）+ 双层成本来源 + CostLedger 纯函数草案 + 闸门动作与分期。
- 关联：tech map S9（任务/租户 token 预算、执行中预算闸门、异常熔断；cost 字段已有）；design-supervision.md §7.1（S4 步数预算/熔断，本设计同构）；design-hil.md（预算耗尽的 L1/L2 介入）；design-decision-backend.md（S14，降级到便宜模型的后端路由）；design-observability.md（S6，cost 挂 span）；design-context-engineering.md（S1 V3 上下文预算是**token 空间**预算，本设计是**计费/配额**预算，两者互补不重叠）；`src/decision/types.ts`（内核可信 cost）、`src/a2a/types.ts`（ZeusReport 自报 cost）、`src/orchestrator/termination.ts`（预算纯函数范式）。
- 本文是成本治理的单一事实源；handoff 与 PRD 只索引。

## 1. 背景与现状

| 成本信号 | 现状 | 可信性质 | 位置 |
| --- | --- | --- | --- |
| 决策后端成本 | 每次决策产出 `cost {inputTokens, outputTokens, cents}`，单价表内置，未知则省略 | **内核可计量、可信**（内核自己发起的模型调用） | `src/decision/types.ts`、`llm.ts`、`decision-model.ts` |
| 执行 Agent 自报成本 | ZeusReport 带 `cost {llmTokens, wallSeconds}` | **自报、不可信**：与 caller-asserted 同类，只能展示/对账，不能单独作闸门依据 | `src/a2a/types.ts` |
| 墙钟时长 | 内核时钟计量分支起止、p50 指标 | **可信**（内核时钟） | metrics.ts |
| 步数预算 | 意图级累计分支上限 256、连续失败熔断 8 | 已落地，但是**执行次数**维度，不是 token/费用维度 | termination.ts、S4 |
| 上下文预算 | S1 V3 每分支 token 空间上限 64 条，截断发事件 | 是**装配空间**约束，截断不涉及计费、不跨意图累计 | `src/context/budget.ts` |

**缺口**：

1. **没有计费/配额维度的预算**。一个意图可以无限扇出+resume+DAG 分层，步数预算管"次数"，但单次分支喂给决策模型/外发 Agent 的 token 量没有上限；一个企业租户（realm）一天能烧多少也没有边界。
2. **执行中无闸门**。预算超限时没有动作原语——现状只有"新分支派不出去"（步数预算在派发边界 mayDispatch 判定），缺乏"已在途的分支如何收"（cancel 传播 F3 已具备能力，但没有成本触发器去调它）。
3. **无异常消耗熔断**。失败熔断管连续失败，不管"连续高消耗但都成功"（失控循环、prompt injection 诱导的反复外呼，见 design-guardrails）。
4. **自报成本未对账**。Agent 自报 llmTokens 与内核观测的 wallSeconds/任务规模可能矛盾，现在不标记。

## 2. 目标与边界

**目标**：建立与 S4 同构的**纯函数成本账本**——在派发边界与分支落定两个点记账，给出三类判定（能否再派 / 是否触发在途收敛 / 是否异常熔断），并把判定动作接到既有原语（拒绝派发、cancel 剩余、降级决策后端、升级人工）。预算分两级：**意图级**（一次任务）与**域级**（personal/enterprise realm，配额周期）。

**边界（明确不做）**：

- 不做计费、扣费、账单系统：成本治理是**闸门**不是**收银台**；计费模型属 deferred #4/#8，等首批意向企业用户触发。
- 不对 Agent 自报 cost 做惩罚性动作：自报值只用于展示与"自报矛盾"标记；闸门只对内核可计量值生效（可信边界与 dataPolicy 一致）。
- 不能在分支执行中强行中断外部 Agent 的模型调用（token 一旦发出不可收回）；"执行中闸门"= 不派新分支 + 按策略 cancel 尚未开始/可取消的在途分支。
- 不内置具体价格表与配额数字：阈值经配置注入，默认不启用（与 S4 cap 同策略，不凭空拍数，标定等真实负载，参 deferred #9）。

## 3. 账本与判定设计

### 3.1 可信记账口径

| 账本项 | 来源 | 计入 |
| --- | --- | --- |
| 决策 token | DecisionBackendResult.cost | 实际 input/output tokens 与 cents（可信） |
| 出站载荷规模 | 内核装配的 contextAppendix/skillInputs/realmHits | 内核可估算（~4 chars/token 已有口径，decision/shared.ts），记为出站估算 |
| 墙钟 | metrics 分支起止 | wallSeconds（可信） |
| Agent 自报 | ZeusReport.cost | 进**对账列**不进闸门；与墙钟/规模显著矛盾发 `cost-self-report-mismatch` 审计（只标记） |

### 3.2 三级判定（固定次序）

1. **配额判定（派发边界，admit）**：意图级/域级预算是否还能容纳本次预估（预估=出站载荷估算 + 该技能历史分支 token 中位数，无历史则用配置缺省）。不能 → 拒绝派发（审计 `cost-budget-exceeded`，与 `intent-branch-budget-exceeded` 同脊），并按 §3.3 选动作。
2. **在途收敛（落定/周期 tick）**：已用 + 在途预估 ≥ 软阈值（如预算 80%）→ 不再派新分支；达硬阈值 → cancel 尚未开始的同意图分支（F3 cancel 传播），已开始的等待自然落定。
3. **异常速率熔断**：滑动窗口内 token 速率（tokens/wall-second）超过配置倍数（相对该域历史基线）→ 打开成本熔断，效果同 S4 熔断（自动路径拒绝、显式操作者请求不拦），审计 `cost-rate-circuit-open`，并按 design-hil 升级 L1（异常消耗多半需要人看）。

### 3.3 超限动作（复用既有原语，不新造执行路径）

| 情形 | 动作 |
| --- | --- |
| 决策模型可选强弱（S14） | 后续分支降级到便宜/本地后端（DecisionBackend 路由已有抽象） |
| 无降级可用且未硬超限 | 拒绝新派生 + L1 升级（预算待追加或终止） |
| 硬超限 | cancel 在途 + 意图 settle 为 failed（reason=cost-budget-exceeded） |
| 域级周期配额耗尽 | 该域新意图全部拒绝，直到周期重置；操作者显式请求仍走显式路径（与 S4 一致） |

## 4. 落地接口草案（设计级，未落码）

```ts
// src/orchestrator/cost-ledger.ts（纯函数，与 termination.ts 同形状，零 IO）
export type CostAmount = { tokens: number; cents: number; wallSeconds: number };
export type CostBudget = {
  spent: CostAmount;                         // 已落定累计（只计可信来源）
  inFlightEstimate: CostAmount;             // 在途预估（与 S4 在途计数同思路）
  window: Array<{ at: string; tokens: number }>; // 速率熔断滑动窗
};
export type CostLimit = {
  intentTokenCap?: number;                  // 意图级硬上限
  realmPeriodTokenCap?: number;             // 域级周期配额
  softRatio?: number;                       // 软阈值比例，缺省 0.8
  rateMaxTokensPerSecond?: number;          // 异常速率；基线倍数标定等 #9
};

export function costAdmit(b: CostBudget, limit: CostLimit, estimated: CostAmount): boolean;
export function recordSettled(b: CostBudget, actual: CostAmount): CostBudget;      // 落定入账，移出在途
export function recordAdmitted(b: CostBudget, estimated: CostAmount): CostBudget;  // 占在途预估
export function costSoftReached(b: CostBudget, limit: CostLimit): boolean;
export function costRateCircuitOpen(b: CostBudget, limit: CostLimit, now: string): boolean;
```

- 接线点（V2，设计级）：boot 装配时经配置注入 CostLimit（env 形状沿用 resolveConcurrencyConfig，不合法即 boot 失败，不静默忽略）；fanOutNew 派发边界在 mayDispatch 后串 costAdmit；分支落定（publishBranch/branchEnded 处）recordSettled；watch tick 兼查速率窗。
- 审计新值：`cost-budget-exceeded` / `cost-rate-circuit-open` / `cost-self-report-mismatch` / `cost-backend-degraded` 入 AUDIT_DECISIONS。
- 域级账本随 KernelSnapshot 持久化（周期重置时间戳入快照），意图级账本随意图归档。

## 5. 分期

- **V1（纯函数账本）**：cost-ledger.ts 五函数 + 判定表测试（边界值、软/硬阈值、在途占额、速率窗、自报值不入闸门的不变量）+ 审计值登记；不接线、不定义缺省数字。
- **V2（意图级接线）**：配置注入 + 派发边界/落定记账 + 软阈值停止派生 + 审计 emit；域级账本留 V3。
- **V3（在途收敛 + 降级 + 域级配额）**：硬阈值 cancel 在途、S14 后端降级动作、域级周期配额持久化与重置、自报矛盾标记。
- **V4（标定）**：真实负载下标定软阈值与速率基线（触发条件同 deferred #9：≥3 真实 Agent 压测）；在此之前默认关闭、不拍缺省数。

**验收（V1 实施时）**：每个判定函数边界正反例；"自报 cost 永不进入闸门计算"独立不变量；在途预估落定后正确移出（不双计）；全量与冒烟不回归（V1 零运行时行为变化）。
