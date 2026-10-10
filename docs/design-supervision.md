# Supervisor 与 Subagent 控制关系设计（Supervision Model）

> 状态：**现行（设计稿 v0.1，2026-09-22）**。实施进度记 [handoff.md](../handoff.md)，本文只写设计。**实现已落地（2026-10-08 核对）**：监督台控制关系（升级队列/裁决/补参重派）对应 PRD E6.1–E6.3 ✅ 与 `web/supervisor/index.html` + TUI 命令面（17 类）；本稿为控制关系模型设计，实现明细见 feature-inventory §3.6 与 handoff。
> 上游：[prd.md](prd.md) E1（并发决策内核）、E4（执行 Agent 协同）；与 [design-memory-consolidation.md](design-memory-consolidation.md) 配套（信任校准依赖记忆）。

## 0. 一句话

**supervisor / subagent 不是固定岗位，而是按任务临时成立的控制关系两端**：持有意图、负责分解与裁决者为 supervisor；对一个明确子目标负责、结果回交者为 subagent。任务结束关系解除；同一 Agent 在不同关系中可互换角色。

## 1. 角色本质

### 1.1 Subagent：边界窄，而非能力弱
- 接收**已结构化的子目标**：输入、输出形态、约束、死线明确。
- **信息最小暴露**：只给完成子任务必需的上下文；不看全局。这是安全边界，也是无依赖并发的前提。
- 对结果真实性负责：产物、证据、置信度、以及"搞不定/需升级"的诚实上报；不替上级做战略判断。

### 1.2 Supervisor：承担组合责任
四项主责：
1. **分解**：意图 → 可并行 / 有依赖的子目标，决定粒度；
2. **选择与授权**：按 Skill/域挑 subagent（含执行 Agent），给凭据与数据范围；
3. **汇聚与校验**：多路结果一致性检查、冲突识别、质量把关（非原样转交）；
4. **裁决/升级**：可消解者自决，否则带选项上呈操作者。

> subagent 负责"把事做对"；supervisor 负责"做对的事 + 把对的结果拼起来"。

## 2. 三条硬规则

1. **Supervisor 不埋头执行**：执行下放，否则成为并发瓶颈；编排与判断才是其主活。
2. **监督不是转发**：禁止做透传路由器；价值发生在汇聚与校验（即决策内核的聚合）。
3. **默认扁平、必要才分层**：每加一层增加延迟、信息损耗与责任模糊；多层为受控例外。

## 3. 控制关系的契约（TypeScript 形态）

```ts
interface WorkOrder {              // supervisor → subagent
  runId: string;
  subGoal: string;
  inputs: unknown;                // 最小必要上下文
  expectedOutput: { schema: string };
  constraints: { dataRealms: string[]; dataPolicy: string; budget?: Tokens; deadline?: string };
  credentials?: { kind: string; ref: string };
}

interface WorkReceipt {            // 受理
  taskId: string; state: 'accepted'; ackAt: string;
}

type HandbackStatus = 'completed' | 'partial' | 'failed' | 'escalated';

interface Handback {               // subagent → supervisor
  runId: string; taskId: string;
  status: HandbackStatus;
  result?: unknown;
  evidence: string[];
  confidence: number;
  escalation?: { reason: string; options: string[] };
}
```

与执行 Agent 协议对应：`sendSubscribe`=派活，`x-zeus-report`=Handback，`x-zeus-escalation`=上报边界外事项。星型拓扑保证 subagent 不私下协作，**一切汇聚经 supervisor**——这是数据二极管与可追溯性的执行点。

## 4. 编排形态

- **fan-out（并行）**：同层 N 个互不依赖的 subagent；内核合并多流。
- **DAG（有依赖）**：B 等 A、C/D 并行；关键路径与部分失败策略（见技术探索地图 S3/S4）。
- **分层**：sub-supervisor 对其下属是 supervisor、对上层是 subagent；受跨度/深度规则约束。

### 4.1 跨度与粒度规则（初版，待压测校准）
- 单 supervisor 直接跨度：默认上限 N（建议 7±2），超出则分组引入 sub-supervisor；
- 层级深度：默认 ≤ 2 层，高利害流程可申请 3 层；
- 粒度：优先粗到"一个可独立验收的结果"，过细则协调成本超过并发收益。

## 5. 信任校准与失败语义

### 5.1 信任校准（依据记忆）
- supervisor 不盲信、不事事复核；按 subagent 历史可靠度（结果回传/失败率/被纠错）选择全验或抽查；
- 新 subagent 默认高校验；持续可靠后降低复核频率；结果事后回写可靠度。

### 5.2 失败处理（决策顺序）
subagent 失败时按固定次序判定：**重试（幂等前提下）→ 换将（同 Skill 他人）→ 降级（缩减目标）→ 升级（监督台）**；高利害操作跳过重试直接升级。背压分流见 deferred #9。

### 5.3 责任归属
决策回放须区分：**执行错**（subagent 结果错且证据可证）与**监督失察**（supervisor 未做应有的校验）；两者均沿 runId 留痕。

## 6. 在 Zeus 中的落点

| 概念 | 落点 |
|---|---|
| 操作者 | 最高 supervisor：意图、授权、冲突点裁决，不做手工执行 |
| 编排 supervisor | 决策内核：fan-out、合并、聚合、冲突消解、可追溯（PRD E1） |
| subagent | 按 Skill 组队的执行单元，含执行 Agent（pr-helper/loom…） |
| Mentor | 特殊 supervisor：产物是"带出来的能力"而非一次性结果 |
| 监督台 | 裁决接口：升级与不可自动消解冲突在此决议 |

## 7. 验收标准（首版）

1. 每个 WorkOrder 带最小化 inputs 与显式约束，subagent 无法越出授予的数据域；
2. supervisor 不直接执行（执行路径均经 subagent），有测试证明；
3. 汇聚层对冲突/缺失结果有处理，不允许原样透传即视为完成；
4. 超跨度自动分组，深度超限拒绝编排；
5. 重试仅在幂等任务上发生，非幂等失败不重试而升级；
6. 任一最终决策沿 runId 可区分执行错与监督失察。

### 7.1 终止与收敛（S4，2026-10-08 补，意图级）

技术探索地图 A 组 S4 的最小闭环，落在决策内核（PRD E1.5 并发治理之上的一层**意图级守卫**——并发治理管"同时在途多少"，本节管"一个意图累计派生多少、连续失败多久还继续"）。

**两重守卫**

1. **步数预算**：`maxBranchesPerIntent`（默认 256）——同一意图**累计**分支数上限（首次 fan-out 的 N 个分支 + 每次 resume 派生 1 个都计入）。超限拒绝派生：新 fan-out 结算为 failed（reason `budget-exceeded`），resume 抛 `IntentBudgetExceededError`（HTTP 409）。预算覆盖一切派生（含操作者显式点名与人工 approve 驱动的 resume）——它防的是意图分支总量失控，与治理面无关。
2. **连续失败熔断**：`maxConsecutiveBranchFailures`（默认 8）——同一意图**连续**失败分支数（`branch.ok === false`）达到阈值后，**自动选靶**路径拒绝新派生（reason `circuit-open`）；显式点名的执行 Agent 不受熔断（与 skillGovernor/背压的 explicit override 先例一致——操作者显式点名是人的意图，不是自动循环）；resume 是操作者驱动的明确重派，同样不受熔断、受预算约束。

**语义要点**

- **守卫默认开启**（fail-closed）：与 #35 DNS 重绑定先例同族——安全守卫不等触发条件先做。默认值（256/8）是**结构守卫默认**不是性能标定，真实负载下的校准挂 #9 同一触发条件（≥3 真实执行 Agent 压测），不凭空拍数。
- **状态随快照恢复**：预算/熔断计数纳入 `OrchestratorSnapshot`（可选字段，向后兼容），重启不因计数清零而绕过守卫。
- **审计**：拒绝各记一条 `intent-branch-budget-exceeded` / `intent-circuit-opened`（含 intentId/used/limit 与 detail），经 onRefusal 桥进审计脊。
- **边界**：意图级、进程内守卫；跨实例协调不做（同 #9 口径）。E1.5 的 `maxConcurrentBranches`/`branchQueueLimit` 不变。

**纯函数**：`src/orchestrator/termination.ts`（`budgetExceeded` / `circuitOpen` / `advanceBudget`（spawn 时预记在途分支）/ `settleBranch`（分支结算折叠连续失败计数）/ `mayDispatch`（判别联合 `DispatchGate`，fan-out 派发边界的预算与熔断闸））。

## 8. 开放问题

- Critic/Judge 是独立 Agent 还是 supervisor 内置（见技术探索地图 S2）。
- 多层编排下 SLA/预算如何逐层分配与汇总——**意图级已由 §7.1 落地**，跨层（子意图/多层 supervisor）的逐层预算分配仍开放。

## 9. 演进日志

| 版本 | 日期 | 变更 |
|---|---|---|
| v0.2 | 2026-10-08 | 新增 §7.1 终止与收敛（S4）：意图级步数预算 + 连续失败熔断，默认开启、随快照恢复、审计进脊 |
| v0.1 | 2026-09-22 | 首版：控制关系定义、契约结构、编排形态、跨度粒度、信任校准与失败语义、责任归属、六条验收 |
