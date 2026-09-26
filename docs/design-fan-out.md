# 并发决策内核设计（Fan-out / Aggregation / Conflict）

> 状态：**现行（设计稿 v0.1，2026-09-22，M2 第一批）**。实施进度记 [handoff.md](../handoff.md)，本文只写设计。
> 上游需求：[prd.md](prd.md) E1（并发协同与决策内核）、E2.4（按技能组队）；技术议题 S3/S4/S5 见 [tech-exploration-map.md](tech-exploration-map.md)；控制关系见 [design-supervision.md](design-supervision.md)。
> 边界：v0.1 只做**库内、确定性、不调 LLM** 的最小闭环；持久化、服务端 SSE、完整 DAG 当时不在内（见 §7）。**LLM-as-judge 对抗复核已于 v0.18 落地（见 §5.1，`src/orchestrator/judge.ts`），与 S2 决策后端端口对接见 [design-decision-backend.md](design-decision-backend.md)。**

## 0. 一句话

一个意图（intent）按技能/显式名单**扇出**给 N 个执行 Agent**并行**执行，经幂等去重、可取消传播、多流合并、规则聚合、冲突检测，产出一个带来源、可追溯、需要人时进监督台的**合并决策视图**。编排器只调度与归并，数据二极管/脱敏/吊销/审计仍由现有 `Dispatcher` 负责。

## 1. 在架构中的位置

```
操作者 / 未来 H2 API
        │  一个意图 FanOutRequest
   src/orchestrator/        ← 本设计：扇出 / 幂等 / 取消传播 / 合并 / 聚合 / 冲突
        │  逐路调用（复用，不重写治理）
   src/dispatch/Dispatcher  ← 数据二极管、脱敏、吊销阻断、SLA、审计
        │  A2A JSON-RPC + SSE（出站）
      执行 Agent ×N
```

硬约束：

1. 编排器**不绕过** `Dispatcher` 直接发 HTTP；治理（二极管/吊销/token/审计）只有一处实现。
2. merge / aggregate / conflict 是**纯函数**，不碰网络、不碰时钟、不调模型，可独立单测。
3. 编排器不硬依赖 `OversightDesk`：需要人时经注入的 `onConflict` 回调上抛，由装配层接到监督台（内核平级解耦）。
4. 状态仍是**进程内存**（幂等表、在途索引）；重启不丢任务的持久化是 E5.3，不在本批。

## 2. 核心类型（`src/orchestrator/types.ts`）

```ts
type FanOutRequest = {
  intentId?: string;            // 幂等键；不传则每次新扇出、不去重
  skill: string;                // 按技能选执行 Agent
  vassals?: string[];           // 显式名单；缺省 = 所有提供该技能的活跃执行 Agent
  params: Record<string, unknown>;
  realm: RealmType;
  runId?: string;               // 父 runId；缺省生成
  realmHits?: Array<{ itemId: string; snippet: string }>;
  aggregation?: AggregationRule; // 见 §5，默认 majority
  branchTimeoutMs?: number;      // 单路超时；缺省不超时
};

type BranchOutcome = {
  vassal: string;
  runId: string;                // 分支 runId = `${parentRunId}:${vassal}`
  ok: boolean;
  state?: TaskState;
  taskId?: string;
  task?: Task;
  events: A2AEvent[];
  reason?: string;              // 失败 / 超时 / 被策略拒绝
  timedOut?: boolean;
};

type FanOutStatus = 'completed' | 'partial' | 'failed' | 'needs-driver';

type FanOutResult = {
  intentId: string;
  runId: string;
  skill: string;
  realm: RealmType;
  branches: BranchOutcome[];
  stream: SourcedEvent[];       // §4
  positions: Position[];        // §5
  decision: AggregatedDecision; // §5
  conflicts: Conflict[];        // §6
  status: FanOutStatus;
  replayed?: boolean;
  createdAt: string;
};
```

编排器依赖两个窄端口（`Dispatcher` 实例天然满足）：

```ts
type DispatchPort = {
  dispatch(req: DispatchRequest): Promise<DispatchResult>;
  cancel(vassal: string, taskId: string): Promise<unknown>;
};
// 选目标复用 registry 的 VassalLookup（findBySkill / statusOf）
```

## 3. F1 扇出 + F2 幂等

**选目标**：显式 `vassals` 优先；否则 `lookup.findBySkill(skill)` 全选（fan-out 语义本就是多投，**不触发**单派发器的"多执行 Agent歧义"错误）。目标为空 → `failed`。

**并行**：`Promise.allSettled` 并发逐路 `Dispatcher.dispatch`，每路传分支 runId 与同一份 params/realmHits（脱敏仍由 Dispatcher 按各执行 Agent fealty 处理）。单路异常/拒绝/超时不拖垮其它路。

**单路超时（S4 最小步）**：`branchTimeoutMs` 到时未决，该路记 `timedOut:true`、`ok:false`，其余继续。v0.1 不 abort 在途请求（Dispatcher 尚未透传 AbortSignal），只不再等待——进行中硬取消列入 §7。

**幂等（F2 / S5）**：以 `intentId` 为键存结果。同键再次 `fanOut` 直接返回已存结果并标 `replayed:true`，**不产生任何出站派发**。无 `intentId` 不去重。幂等表为进程内存（持久化随 E5.3）。

**状态判定**（优先级从高到低）：
1. 无成功分支 → `failed`；
2. 存在规则无法消解的立场冲突 → `needs-driver`；
3. 部分分支失败/超时 → `partial`；
4. 其余 → `completed`。
纯执行类任务（执行 Agent不回立场）不构成冲突，成功即 `completed`。

## 4. F4 多流合并（`merge.ts`，纯函数）

```ts
type SourcedEvent = { source: { vassal: string; taskId?: string; runId: string }; event: A2AEvent };
```

`mergeBranches(branches)`：分支内保持 SSE 原序，分支间按选目标顺序拼接，每个事件可反查 `source`。不做跨执行 Agent全局时间戳排序（执行 Agent时钟不可信、时间戳不保证）；需要时间序的呈现层可在拿到可信时钟后另排。

## 5. F5 规则聚合（`aggregate.ts`，纯函数，不调 LLM）

执行 Agent立场从终态 `task.artifacts` 的 data part 中提取 `stance`（或同义 `verdict`）字符串；提不到的分支记为"无立场"，不参与投票、不构成冲突。

```ts
type Position = { vassal: string; stance: string; weight?: number; rationale?: string };
type AggregationRule = { kind: 'unanimous' } | { kind: 'majority' } | { kind: 'weighted'; threshold?: number };
type AggregatedDecision = {
  rule: AggregationRule['kind'];
  conclusion: string | null;    // null = 规则无法得出结论
  positions: Position[];
  margin?: { winner: string; winnerCount: number; total: number };
  reason: string;               // 可解释说明
};
```

- `unanimous`：有立场者全部一致 → 结论为该立场，否则 `null`。
- `majority`（默认）：最多数且**过半** → 结论；平票/未过半 → `null`。
- `weighted`：按 `weight`（缺省 1）累加，最高权重 stance 且达阈值（缺省 0.5）→ 结论，否则 `null`。

输出始终带每个执行 Agent 的立场与权重，保证可解释。

### 5.1 LLM-as-judge 对抗复核（v0.18 补，`judge.ts` 纯函数）

规则聚合得出结论**之后**，若配置了决策后端且显式开启（`judgeEnabled`，默认关），再请一个独立后端对多立场决策做对抗复核。它与 S2 仲裁（`arbitration.ts`）职责互斥、前后衔接：

- **仲裁**：规则**无结论**（`conclusion === null`，needs-driver）时，请后端替代操作者裁决分裂。
- **judge**：规则**有结论且 ≥2 立场**时，请后端独立复核该结论。

判定与处置（`judgeDecision`，与仲裁同一套置信闸门：阈值默认 0.8、未校准 LLM 默认不采纳、后端故障不阻塞）：

| 复核结果 | 处置 |
| --- | --- |
| 过门且同意规则结论 | 记录背书 `agreesWithRule:true`，状态不变 |
| 过门、高置信**分歧** | **不静默覆盖规则，也不放行弱多数**：状态转 needs-driver，追加一个 `kind:'judge-review'` 的 `Conflict`（两方 stance 按字母排序，summary 分别标注规则结论与 judge 推荐及置信度），复用 F6/E6.2 监督台→操作者 resolve 闭环 |
| 低置信 / 未校准（未显式放行）/ 后端故障 / 单立场 / 规则无结论 / 结论本由后端仲裁给出 | 只记录 `judged:false` 与 `reason`，状态不动（同一后端不自评其仲裁结论） |

judge 记录（`FanOutResult.judgeReview`）随意图持久化，并进入 E1.6 离线回放时间线（`judge-reviewed` 节点）。judge 只产生第二意见与升级，不直接改写结论——最终裁决权在规则或操作者。

## 6. F6 冲突检测与升级（`conflict.ts` 纯函数 + 编排回调）

`detectConflicts(positions, decision)`：存在 ≥2 种 stance **且** `decision.conclusion === null` 时产出 `Conflict`（列各方 vassal/stance/权重）。一致或规则已得出结论则无冲突。

编排器发现未消解冲突时：置 `status='needs-driver'`，并调用构造时注入的 `onConflict?(conflicts, result)`；**绝不静默选边**。装配层把该回调接到 `OversightDesk`（复用升级队列 approve/reject；补参重派 E6.3 后续）。

## 7. 明确不做（本批边界）

- 完整 **DAG 依赖编排**（S3 的有向无环/关键路径/跨阶段依赖）：本批只有一层 fan-out/join。
- 任务/幂等表**持久化**、崩溃恢复、断点续跑（E5.3 / S13）。
- 进行中 fan-out 的**硬 abort**（需把 AbortSignal 透传到 `sendTaskSubscribe`）。
- 服务端 **SSE 合并流** / H2 操作者 API（E5.5）。
- **LLM 裁决 / Critic / 陪审团**（S2）、终止熔断的完整策略（S4，本批仅单路超时）。
- 背压分流（deferred #9，待 ≥3 执行 Agent压测）。

## 8. 验收（映射 PRD）

- **E1.1**：一意图并发派 ≥2 执行 Agent；全成功聚合；单路失败/超时不炸且状态正确。
- **E1.5**：同 `intentId` 重放零出站；`cancelIntent` 传播到全部非终态分支、终态分支不重复取消、runId 全链贯穿。
- **E1.2**：合并流每个事件可反查来源执行 Agent/taskId/runId。
- **E1.3**：三种规则聚合结论正确，输出含各方立场与权重，无结论时 `conclusion:null`。
- **E1.4/E6.2**：相反立场必被标记；规则无解 → `needs-driver` 且触发 `onConflict`，不静默选边。
- 全量既有测试不回归，`tsc --noEmit` / `build` 通过。

## 9. 演进日志

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| v0.1 | 2026-09-22 | 初稿：一层 fan-out/join；intentId 幂等；非终态 cancel 传播；合并流；unanimous/majority/weighted 规则聚合；冲突经回调升级；列明 DAG/持久化/硬 abort/SSE/S2 边界 |
