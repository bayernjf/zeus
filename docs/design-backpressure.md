# 设计稿：执行 Agent 背压分流策略（deferred #9）

- 状态：**设计稿 v0.1（2026-09-27）**，机制已定；实现与阈值调参待触发条件（≥3 个真实执行 Agent 在线压测）到位。
- 关联：deferred #9（背压降级顺序）；E1.5 有界扇出（闸门已落地）；design-fan-out.md §7（明确不做的边界）。
- 本文是策略的单一事实源；handoff 与 PRD 只索引，不复制全文。

## 1. 背景与现状

E1.5 已落地**闸门**（`Orchestrator` 的 `maxConcurrentBranches` + `branchQueueLimit`，`src/orchestrator/orchestrator.ts:101-104` 走 `Semaphore(cap, queueLimit)`）：在途分支超 `cap` 时进入 FIFO 等待，等待线超 `queueLimit` 即拒绝该分支并记录原因 `concurrency limit N reached`，分支不 dispatch（`tests/orchestrator-backpressure.test.ts`）。`ConcurrencyMetrics` 已报告全局 `inFlight` / `maxInFlight` / `queueDepth`（`src/orchestrator/metrics.ts:48-54`）。

闸门解决了"内核不被压垮"，但**没解决"溢出分流给谁"**：
- 选靶只有一次——`lookup.findBySkill(skill)` 给出名单，经 `SkillGovernor.activeProviders` 三态闸门过滤（`src/orchestrator/orchestrator.ts:120-145`）。
- 当某执行 Agent 饱和时，没有机制把它**改投**到同技能的其他可用提供方；超全局 `cap` 直接排队→拒绝，与"具体哪个 Agent 忙"无关。
- 候选也无**可靠度 / 延迟排序**——排在前面的是注册表顺序，不是数据驱动的最优解。

#9 剩下的就是这道策略题：拒绝顺序、按可靠度或延迟重排候选、有界排队 vs 立即降级的取舍。

## 2. 目标与边界

- **目标**：执行 Agent 饱和时，把溢出意图改投到同技能内"当前可用且历史表现最优"的提供方；无可用方时退回已有的"排队→拒绝"闸门，且拒绝原因带审计。
- **本策略不做**（design-fan-out §7 已排除，或超出单实例闭环）：
  - 跨进程 / 跨 Zeus 实例的全局队列协调；
  - 预测式预热 / 容量预分配；
  - 自动改写 Skill 注册（`providedBy`）；
  - 服务端 SSE、进行中硬 abort（E1.4 余下 🚧 项，与本策略正交）。

## 3. 信号盘点

### 3.1 已具备（可直接复用）

| 信号 | 来源 | 用途 |
|---|---|---|
| 历史失败率 `failureRate` | `ConcurrencyMetrics.perVassal[v].failureRate`（metrics.ts:161-174） | 可靠度排序 |
| 历史延迟 `latency.p50Ms / p95Ms` | 同上 `latency`（metrics.ts:29-36） | 延迟排序 |
| 存活探针 `healthCheck(name)` | `registry.healthCheck`（registry.ts:185） | 过滤不可用方 |
| 吊销状态 `VassalStatus` | `registry.ts:12`（active/revoked） | 过滤已吊销方 |
| 候选提供方 `activeProviders(id)` | `SkillGovernor.activeProviders`（skills/registry.ts:289，三态：undefined 未注册 / `[]` 拒派 / `[names]` 活跃） | 取同技能备选集 |
| 显式靶 `request.vassals` | `FanOutRequest.vassals`（types.ts:63） | 硬钉判定（一等旁路） |

### 3.2 缺失（策略启用前必须补的 primitive）

- **per-vassal 实时在途计数**：当前 `metrics.ts:48-54` 只有全局 `inFlight` / `queueDepth`，`perVassal` 只有**历史** `failureRate`/`latency`，没有"此刻该 Agent 在途几条"。无法判定"agent A 是否饱和"。
  - 启用改动：在 `ConcurrencyMetrics`（或独立 `PerVassalLoad`）增 `inFlightByVassal: Map<vassal, number>`，`branchStarted` +1、`branchEnded` −1；饱和判定 `inFlightByVassal[v] >= cap(v)`。
  - `cap(v)` 默认 = `maxConcurrentBranches`；可按 skill 或 vassal 覆盖（超出本稿范围，先留扩展点）。

## 4. 策略

### 4.1 饱和信号（启用 primitive）

- 每个执行 Agent 维护实时在途计数；`cap(v)` 为其并发上界（默认继承全局 `maxConcurrentBranches`）。
- `saturated(v)` ⇔ `inFlightByVassal[v] >= cap(v)`。
- 该计数纯进程内、随内核快照可恢复（与 `ConcurrencyMetrics` 同源，不入决策语义，不影响幂等 / 可恢复）。

### 4.2 分流候选集

给定意图技能 `S`，候选集构造：

```
candidates(S) = activeProviders(S)                    // 同技能注册提供方
  .filter(v => status(v) === 'active')                // 排除 revoked
  .filter(v => healthCheck(v) !== false)              // 排除探针失败（带冷却窗口，避免抖动时全灭）
  .filter(v => !saturated(v))                         // 排除当前饱和
```

`activeProviders` 返回 `undefined`（技能未注册）时，按既有语义走 pass-through，不进入分流逻辑。

### 4.3 候选重排（拒绝顺序的逆向 = 优选顺序）

对 `candidates(S)` 按数据驱动评分降序排列，取首位投放：

```
score(v) = w_r * (1 - failureRate(v))  -  w_l * (p50Ms(v) / LATENCY_NORMALIZER)
```

- `failureRate` 取自 `perVassal[v].failureRate`（无历史记 0，视为中性）；
- `p50Ms` 取自 `perVassal[v].latency?.p50Ms`（无历史记 `LATENCY_NORMALIZER`，视为最差）；
- `w_r`、`w_l` 为可调权重，默认 `w_r = 1`、`w_l = 1`；`LATENCY_NORMALIZER` 取观测基线的 p95（先填经验值，压测后校准）；
- 并列时按 `vassal` 名升序，保证确定性（可复现、可审计）。

显式 `request.vassals` 给出的靶**不参与重排**（见 4.4）。

### 4.4 分流策略（policy：有界排队 vs 立即降级）

- **显式靶（`request.vassals` 存在）= 硬钉**：操作者的一等旁路，绝不自动改投。其中任一靶饱和 → 该分支进入既有 FIFO 等待线 → 满则拒绝（沿用现有闸门与原因）。
- **自动选靶（无 `request.vassals`）= 可分流**：
  1. 初选 `names = findBySkill(skill)` → 经 `activeProviders` 三态闸门（既有逻辑，`[]`/无活跃即 refusal）；
  2. 对每个被选靶，若 `saturated(v)`，从 `candidates(skill)` 中按 4.3 评分取**最佳可用备选**改投；
  3. 若 `candidates(skill)` 为空（全饱和 / 全不健康 / 全吊销）→ 退回既有"排队→拒绝"闸门；
  4. 分流在**选靶之后、dispatch 之前**发生，不改写 `intentId` / `runId`，不破坏幂等与重放。

### 4.5 拒绝与审计

- 当 `candidates` 枯竭而分支被拒时，拒绝原因从单纯的 `concurrency limit N reached` 升级为带审计的负载说明，记录**已尝试的备选及其各自状态**（saturated / unhealthy / revoked / none-active），使"为什么这个意图没派出去"在审计脊上可追，而非只报一个全局计数。
- 分流成功（改投）同样记一条事件（如 `branch-diverted`，含 from→to），与既有 `refused-*` 同进审计事件流。

## 5. 与现有闸门的接口

- `Semaphore(cap, queueLimit)` 行为**不变**：它仍是最后一道全局兜底。
- 分流是选靶层的前置优化：能改投就改投，改投不掉进全局闸门；只有真的无候选才落到排队→拒绝。
- 不引入新的并发原语冲突：`inFlightByVassal` 与 `Semaphore` 计数在同一 `branchStarted`/`branchEnded` 生命周期内增减，二者正交（一个按 Agent、一个按全局）。

## 6. 实现拆分（启用代码）

| 块 | 位置 | 说明 |
|---|---|---|
| `PerVassalLoad` 计数 | 扩 `ConcurrencyMetrics` 或新增 | `branchStarted`+1 / `branchEnded`−1；`saturated(v)` 判定 |
| 分流纯函数 `selectTargets` | 新增 `src/orchestrator/diversion.ts` | 输入 `skill / explicitVassals / activeProviders / load / metrics / health`，输出最终靶列表 + 改投/拒绝审计；纯函数、可单测 |
| 选靶处接线 | `orchestrator.ts:120-145` 附近 | 自动选靶分支改调 `selectTargets`；显式靶短路 |
| 拒绝原因升级 | `orchestrator.ts` 拒绝分支 | 带 tried 候选状态 |

`selectTargets` 必须纯函数（不调 LLM、不碰时钟副作用），与 `aggregate` 同级，便于单测与可恢复。

## 7. 验证

- **单测**（`tests/orchestrator-diversion.test.ts`）：
  - 饱和改投：A 饱和 → 改投 B（B 历史更优或仅可用），A 未收到 dispatch；
  - 候选重排：B 失败率低于 A → 同饱和下优先 B；
  - 显式钉不分流：传 `vassals:[A]` 且 A 饱和 → A 仍入队，不投 B；
  - 全饱和回退：candidates 空 → 沿用排队→拒绝，拒绝原因含 tried 状态；
  - 探针失败/吊销过滤：unhealthy / revoked 不进 candidates。
- **压测（触发条件）**：≥3 个真实执行 Agent 在线（mock 不算，mock 的延迟/失败是编的，会把猜测锁成定论），按 `scripts/bench-capacity.mjs` 场景 D 扩成多供应方，校准 `cap(v)` / `queueLimit` / `w_r`、`w_l`、`LATENCY_NORMALIZER`。

## 8. 明确不做（边界）

- 跨 Zeus 实例的队列搬运；
- 预测式扩容 / 预热；
- 改 `providedBy` 或 Skill 注册面；
- 与服务端 SSE、进行中硬 abort 混为一谈（各归 E1.4 余下 🚧）。

## 9. 演进日志

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| v0.1 | 2026-09-27 | 初稿：饱和信号（per-vassal 实时在途计数，待补 primitive）、分流候选集、可靠度/延迟评分重排、显式靶硬钉、全饱和回退拒绝+审计；复用现有 `ConcurrencyMetrics.perVassal` 历史信号与 `SkillGovernor.activeProviders`；实现与阈值调参挂触发条件 ≥3 真实 Agent 压测 |
