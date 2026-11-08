# 背压阈值建议卡（启用时取值依据，不是默认值）

- 状态：**建议卡 v0.1（2026-11-08）**。数据源为 [capacity-baseline.md](capacity-baseline.md) §11（2026-11-08 mock 标定）与 [design-backpressure.md](design-backpressure.md)（分流语义）。**本卡不修改任何代码默认值**：`maxConcurrentBranches` / `branchQueueLimit` / `maxConcurrentPerVassal` 在 `src/state/boot.ts`、`Semaphore` 与 compose 中仍全部未设。
- 适用：准备**显式启用**背压的人。启用方式是 env：`ZEUS_MAX_CONCURRENT_BRANCHES`、`ZEUS_BRANCH_QUEUE_LIMIT`、`ZEUS_MAX_CONCURRENT_PER_VASSAL`（`resolveConcurrencyConfig` 只读显式 env）。
- 一句话结论：cap 对齐下游真实并发槽位数；queueLimit 按尾延迟预算取 `1×cap` 起步、最多 `2×cap`；`maxConcurrentPerVassal` **本卡给不出数字，待真机标定**。

## 1. 推荐值总表

| 配置 | 推荐取值 | 依据数据 | 确定性 |
|---|---|---|---|
| `maxConcurrentBranches` | `≈ 下游执行 Agent 的并行槽位数 N`（部署时已知）；未知时按 `目标峰值 QPS × 最慢分支占用` 反推。**不要显著低于 N** | §11.3 场景 E：cap=32（mock 槽位 64 的一半）时 128 分支单意图 p95 从 68.1ms 升至 224.4ms，墙钟 68.6→225.1ms | 规则明确；具体 N 必须由部署现场给出，mock 的 64 不可搬运 |
| `branchQueueLimit` | 起始 `1×cap`；可接受两个执行周期则 `2×cap`；**不要 `Infinity`** | §11.3 场景 F（cap=16）：`1×cap` 等待 p95 63ms、`4×cap` 226ms、无限制 390ms；拒绝率 75%→37.5%→0 | 公式可算；系数需按真实单分支占用复核 |
| `maxConcurrentPerVassal` | **待真机标定，不给数字**。公式 `cap(v) ≈ 可接受单 Agent 排队延迟 / 单 Agent 服务时间`，且必须 `< maxConcurrentBranches` | mock farm 无状态、无"越忙越慢"曲线；本卡不把内核开销冒充 Agent 容量 | 未标定；触发条件见 §4 |

## 2. 逐条依据

### 2.1 `maxConcurrentBranches`

场景 E 是 32 意图 × 4 分支 = 128 分支，mock farm 64 槽、单分支 think 50ms（Apple M4 / 10 CPU / darwin arm64 / Node v22.23.4，同机单跑一轮）：

| cap | 墙钟 ms | 分支/秒 | 单意图 p50 / p95 ms | max in-flight |
|---|---|---|---|---|
| 无限制 | 68.6 | 1865.1 | 66.1 / 68.1 | 128 |
| 32 | 225.1 | 568.7 | 115.3 / 224.4 | 32 |
| 16 | 451.5 | 283.5 | 232.9 / 450.6 | 16 |
| 8 | 853.4 | 150.0 | 430.7 / 852.2 | 8 |

读法：**拐点是下游槽位数（本次 mock 为 64），不是突发规模 128**。cap ≥ 槽位数时 128 分支分两波完成，墙钟约 70ms；cap 一旦低于槽位数就退化，但**先体现在尾延迟**（`单意图 p95 ≈ 墙钟 ≈ ceil(128/cap) × 单分支占用`），不是先掉吞吐。所以：

- 推荐 `cap ≈ N`，N = 真机最慢执行 Agent 的并发能力（不是 mock 的 64）。
- 若只按 QPS 反推，用 `目标峰值 QPS × 最慢分支占用`，并向上取整到不小于 N。
- 反例：把 cap 设成 N 的一半，128 分支的 p95 立刻从 68.1ms 变成 224.4ms（约 3.3×），而吞吐只从 1865 降到 569 分支/秒——**省下的不是容量，是延迟**。

### 2.2 `branchQueueLimit`

场景 F 固定 cap=16，对 128 分支扫等待线：

| queueLimit | 完成 / 拒绝 | 墙钟 ms | 单意图 p95 ms | 队列等待 p50 / p95 ms | 采样峰值队列 |
|---|---|---|---|---|---|
| 0 | 16 / 112 | 60.2 | 59.8 | 3 / 4 | 0 |
| 8 | 24 / 104 | 110.9 | 110.2 | 3 / 58 | 8 |
| 16 | 32 / 96 | 119.4 | 118.9 | 4 / 63 | 16 |
| 32 | 48 / 80 | 172.9 | 172.3 | 59 / 120 | 32 |
| 64 | 80 / 48 | 280.6 | 279.6 | 114 / 226 | 64 |
| 无限制 | 128 / 0 | 447.5 | 446.6 | 179 / 390 | 112 |

**公式与取值**：等待随 `(cap + queue) / cap` 线性增长，等价于

```text
queueLimit ≈ cap × (可接受尾延迟 / 单分支占用 − 1)
```

- 目标"排队不超过一个执行周期"：`queueLimit = 1×cap`。cap=16 时实测等待 p95 63ms，约为单分支占用 50ms 的 1.3×（公式给 50ms，实测有 13ms 余量，取值时按实测上浮）。
- 能接受两个周期：`queueLimit = 2×cap`，对应等待 p95 约 120ms 一档。
- **不要 `Infinity`**：8× 突发下等待 p95 从 60ms 档拉到 390ms，尾延迟换来的是零拒绝，不是容量。
- **拒绝率是设计行为，不是故障**：`1×cap` 在 8× 突发下仍拒绝 96/128（75%）。如果业务不能接受这个拒绝率，正确动作是**提高 cap 或在上游限流/削峰**，不是继续加 queueLimit——把队列拉长只是把拒绝换成更长的等待。
- 公式是近似值：cap=16、queue=64 时公式给 150ms，实测 p95 226ms。启用后以 `queueWait` 实测为准复核一次，不要只信公式。

### 2.3 `maxConcurrentPerVassal`

**不给数字，理由是测不出来**：mock farm 是无状态并发处理器，不存在单个 Agent "越忙越慢"的饱和曲线；在 mock 上量到的 per-vassal 数字只是内核调度开销，不是 Agent 容量。写一个 mock 数字会被误读成真机容量，本卡不这么做。

可执行的部分是公式与约束：

```text
cap(v) ≈ 可接受单 Agent 排队延迟 / 单 Agent 服务时间
```

- `cap(v)` **必须小于全局 `maxConcurrentBranches`**。若两者相等，单 Agent 饱和即意味着全局槽满，没有空闲备选可投，分流永不触发（`design-backpressure.md` §3.2 的设计修正）。
- 未设 `maxConcurrentPerVassal` 时行为与全局闸门一致，`diverted` 恒为 0；启用后才应观察改投频率。
- 数值：**待真机标定**。方法见 §4.2。

## 3. 启用后的观测口径

只看四个指标，不看感觉：

- `refused`：等待线满导致的拒绝数。突发下应与 `cap + queueLimit` 的溢出量吻合。
- `queueWait`（p50/p95/max）：排队等闸的时间，必须与执行耗时分开看。
- `queuedPeak`：突发提交峰值，用来看突发规模是否超出标定假设，不等于等待线长度。
- `diverted`：per-vassal 改投次数；未启用 `cap(v)` 时恒 0 是预期，不是缺陷。
- `historyWindow.trimmedQueueWaits`：若快照窗口被裁剪，百分位已被低估；出现非零就该重跑或调窗口，而不是照读 p95。

## 4. 什么条件下必须重新标定

### 4.1 通用触发条件

出现任一条，本卡的取值即失效，必须重跑同一脚本重标：

1. **执行 Agent 数量或并发能力变化**：增减 Agent、换模型、换工具链、调整单 Agent 并发上限。
2. **单分支服务时间变化超过约 20%**：`bench:gate` 的 ±15% 告警可作前哨；跨过即重标 cap 与 queueLimit。
3. **突发形状变化**：扇出宽度或并发意图数显著超出本次 32×4（128 分支）/ 8× 突发的假设。
4. **尾延迟目标变化**：SLO 从"一个执行周期"放宽或收紧，queueLimit 随之改。
5. **启用或关闭 per-vassal 分流**：`cap(v)` 上线后有效全局需求改变，需连同全局 cap 一起复核。
6. **运行时/硬件变化**：Node 版本、CPU 核数、同机共跑负载变化。容量基线是负载敏感的，绝对值只作比值参考。
7. **观测异常**：`queueWait` p95 超预算、`refused` 明显高于预期、`trimmedQueueWaits` 非零。

### 4.2 `maxConcurrentPerVassal` 的专门前提：≥3 个真实执行 Agent

`design-backpressure.md` 把阈值调参的触发条件写成"≥3 个真实执行 Agent 在线压测"，本卡沿用，不降低门槛。原因不是玄学：

- 只有 1 个 Agent：饱和后无备选，只能验证"排队→拒绝"，验证不了改投。
- 只有 2 个：只能验证一次改投（A 饱和 → B），B 也饱和后立即回退全局闸门，看不到"多轮改投 + 改投目标饱和"的稳定态。
- **≥3 个同技能真实 Agent**：才能在同一轮里同时观察"饱和 → 改投 → 新目标也饱和 → 拒绝并附 tried 状态"的完整链路，并让 `diverted` 有统计意义。

测法（真机，不是 mock）：

1. 至少 3 个同技能执行 Agent 注册在线，记录各自的单 Agent 服务时间 p50/p95（先空载测）。
2. 用 `scripts/bench-capacity.mjs` 的真实 taskUrl 版本（替换 mock farm），按场景 F 的突发形状施压：固定全局 cap=场景 E 标出的 N，扫 `cap(v)` 的若干档。
3. 每档记录：per-Agent 在途峰值、`diverted`、`refused`、`queueWait` p50/p95、单意图 p95。
4. 找 `queueWait` 开始超线性增长的拐点，取拐点前的最大 `cap(v)`；再用公式 `T_budget / T_service` 交叉校验。
5. 若 `diverted` 长期为 0 而 `refused` 在涨，先检查 `cap(v)` 是否不小于全局 cap——那会让分流永不触发。

## 5. 明确边界

- **本卡是建议，不是默认值**。代码默认、`boot` 默认、compose/env 默认都保持不变；启用与否由部署者显式决定。
- **mock 数字只作形状参考**：M4 同机、mock farm 64 槽、单分支 50ms，绝对值不可迁移到真机。
- **测不出的不编**：`maxConcurrentPerVassal`、真机每 Agent 槽位数、真机单分支服务时间，本卡均未给出数字；只给公式、约束与测法。
- 本卡不改变分流语义（候选集、评分重排、显式靶硬钉、全饱和回退），那些以 [design-backpressure.md](design-backpressure.md) 为准。

## 6. 演进日志

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| v0.1 | 2026-11-08 | 首版：基于 capacity-baseline §11 场景 E/F 的实测数字，给出 cap / queueLimit 推荐取值与尾延迟取舍；`maxConcurrentPerVassal` 明确待真机标定（≥3 真实 Agent）并给出测法；写明建议非默认、代码默认不变 |
