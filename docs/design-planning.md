# 设计稿：规划——计划生成、多计划竞争与重规划（tech map S12）

- 状态：**现行 v0.1（2026-10-09）**：设计探索先行，未落码。本文把规划定义为"产出 DagSpec 的一种特殊扇出"，最大化复用既有 fan-out/聚合/DAG 内核，不新造规划运行时。
- 演进：v0.1（2026-10-09）首版——现状盘点（DAG 执行内核已齐、缺从目标到 DagSpec 的生成与重规划）+ 规划即扇出的切法 + `scorePlan`/`replanDelta` 纯函数草案 + 分期。
- 关联：tech map S12（单/多 planner、计划竞争、计划与执行交错、replan）；design-supervision.md §4（DAG 编排：拓扑分层/关键路径/上游失败跳过/产物下传）；design-fan-out.md（扇出/聚合/冲突，多 planner 竞争直接复用）；design-tool-discovery.md（S11，节点技能/Agent 选靶与失败恢复）；design-context-engineering.md（S1 V2 技能 inputs 声明，计划可满足性的依据）；design-hil.md（计划分歧/重规划升级）；design-long-running.md（S13 checkpoint 为 replan 提供状态基线）；`src/orchestrator/dag.ts`（validateDag/topologicalLayers/criticalPath）、`src/orchestrator/dag-runner.ts`（DAG driver face）、`src/skills/registry.ts`（技能目录）。
- 本文是规划能力的单一事实源；handoff 与 PRD 只索引。

## 1. 背景与现状

| 能力 | 现状 | 位置 |
| --- | --- | --- |
| DAG 执行 | 给定 **DagSpec（静态声明的节点+依赖）**，可做校验、拓扑分层、关键路径、依赖满足判定、上游失败跳过下游、产物下传、needs-driver 挂起 | `src/orchestrator/dag.ts`、`dag-runner.ts` |
| DAG 驱动面 | HTTP 暴露、真实进程装配（smoke 有 unknown-dag 404 与匿名 401 验证） | server.ts DAG driver face |
| 扇出/聚合/冲突 | 多 Agent 并发 + 多策略聚合 + 冲突检出升级 | orchestrator/aggregate/conflict/arbitration |
| 技能目录 | 技能声明、providedBy、inputs 字段、只读 tag | registry.ts、S1 V2 |
| 失败恢复 | 节点失败后的重试/换将/降级/升级固定链 | discovery.ts recoverChain、S11 |

**缺口**：DagSpec 从哪来？现状是**调用方手写/外部提供**——内核会执行计划，不会**制定**计划。

1. **无目标→计划的生成**。给一个高层目标（"调研 X 并产出对比"）和可用技能目录，没有原语把它分解成带依赖、带技能绑定、带 inputs 映射的 DagSpec。
2. **无多计划竞争**。多个具备规划能力的 Agent 可能给出不同计划，现状没有对计划候选做评分、选择、合并的环节（fan-out/聚合是为**结论**设计的，计划候选的质量维度不同：可行性、覆盖度、成本、关键路径长度）。
3. **无 replan**。执行中节点失败链耗尽、熔断打开、L2 卡死、崩溃恢复后世界变化，现状只能挂起/失败，不能"基于已完成节点修订剩余计划"。
4. **计划可满足性无校验闭环**。一个计划引用了目录里没有的技能、或某节点 inputs 无法由上游产物/显式载荷满足，应当在执行前拒绝，现状 validateDag 只校验图结构（无环/依赖存在），不校验技能与输入可满足性。

## 2. 目标与边界

**目标**：把规划定义为内核的一层**纯增量**——

1. **规划即扇出**：planner 不是新运行时，而是一类提供"规划技能"的 Agent；一次规划 = 一次 fan-out，每个 planner 产出一份 DagSpec 候选，复用并发、幂等、取消、审计全套原语。
2. **计划是数据**：planner 产出是**待校验的草稿**，不是可直接执行的指令；内核用确定性纯函数校验、评分、选择后，才交给既有 dag-runner（与 guardrails"Agent 产出永远是数据"同构）。
3. **重规划只动未发生的部分**：replan 基于当前 DAG 状态产出**增量**，已完成节点及其产物不回滚、不重跑（数据主权与幂等约束）。

**边界（明确不做）**：

- V1 不内置规划模型/不写规划 prompt：planner 是外部 Agent 或 DecisionBackend 的事；内核只定协议、校验、评分、编排。
- 不做全自动 replan 闭环（机器自行无限改计划）：重规划触发与 S4/S10/S11/S13 的升级信号挂钩，超阈值或计划分歧大时升级操作者（L1），避免"规划-执行-再规划"不收敛（收敛性归 S4 管）。
- 不做层级任务网络（HTN）等重型规划理论实现：产出格式就是 DagSpec，表达力以既有 DAG 能力为界。
- 计划不授予任何执行授权：计划里出现 execute 节点，执行时仍逐节点过 delegation gate（计划不是授权书）。

## 3. 规划链设计

### 3.1 生成（plan = 一种 fan-out）

- 输入：目标（目标描述 + 验收标准）、技能目录快照（id/inputs/providedBy/tags/只读 tag）、Realm 可用面、约束（成本上限 S9、步数上限 S4、时限）。
- 扇出到所有声明规划技能（如 `planning.compose`）的 Agent；tier/只读/能力面判定照走 E9.4/S11。
- 每个 planner 回传结构化 DagSpec 草稿（非自由文本；解析失败的候选直接淘汰并审计 `plan-malformed`）。

### 3.2 校验与评分（确定性纯函数）

| 检查 | 不满足时 |
| --- | --- |
| 图结构：validateDag（无环、依赖闭合、ID 唯一） | 淘汰 |
| 技能存在：每节点 skill 在目录中 | 淘汰 |
| inputs 可满足：节点 inputs 由上游产物（产物下传字段）或显式载荷提供，否则标 unavailable（S1 V2 同规则，不臆造） | 淘汰或挂 needs-driver |
| 权限可行：execute 节点存在可达的授权路径（不代表已授权） | 标 needs-driver |
| 评分维度：目标覆盖度、关键路径长度（criticalPath）、预估成本（节点数×技能历史成本，S9）、单点依赖数、可恢复性（失败链替代面，S11） | 通过校验的候选按分排序 |

### 3.3 选择与分歧

- 单候选合格 → 直接进入执行（操作者可配置"计划必须确认"开关，默认自动）。
- 多候选：分差显著取最高分；分差接近或**节点集合实质分歧**（不是同计划的措辞差异）→ 作为 plan-conflict 进升级队列（L1，带两份计划的差异与评分），由操作者选——复用 intent-conflict 通道，新增 reason。
- 无合格候选 → L1 升级（目标在当前目录/约束下不可规划），不降级执行一个已知不可行的计划。

### 3.4 执行交错与 replan

- 选定计划交 dag-runner 执行（既有能力），规划面与执行面通过 DagSpec 版本号衔接。
- replan 触发：节点失败恢复链耗尽、熔断、L2 卡死、checkpoint 恢复后、操作者显式要求。
- replan 约束：**已 completed 节点冻结**（产物保留、不重跑）；replan 只对 pending/未触达节点产出新 DagSpec + 变更集（新增/移除/改依赖）；正在 running 的节点不撤销（cancel 需走 F3 显式语义）；变更集经 §3.2 重新校验。
- 防不收敛：同一意图 replan 次数计入 S4 步数预算；超限即 L2/失败，不无限重规划。

## 4. 落地接口草案（设计级，未落码）

```ts
// src/orchestrator/planning.ts（纯函数，零 IO）
export type PlanCandidate = { planner: string; spec: DagSpec; malformed?: string };
export type PlanScore = {
  planner: string;
  feasible: boolean;
  rejects: string[];                  // 校验失败原因（技能缺失/输入不可满足/图非法/授权不可达）
  coverage: number;                  // 目标覆盖度（由目标-技能映射确定性计算，V1 用关键词/标签匹配）
  criticalPathLength: number;
  estimatedCost: number;
  singlePoints: number;              // 无替代 provider 的节点数
};

export function validatePlan(p: PlanCandidate, catalogue: SkillSpec[], goal: PlanGoal): PlanScore;
export function scorePlans(candidates: readonly PlanCandidate[], catalogue: SkillSpec[], goal: PlanGoal): PlanRanking;
// 选择：最高分 / plan-conflict（分歧）/ 无可行计划
export function selectPlan(ranking: PlanRanking, tieThreshold: number):
  | { kind: 'selected'; planner: string } | { kind: 'conflict'; planners: string[] } | { kind: 'unplannable' };
// replan 增量：冻结已完成节点，只产出未开始部分的变更
export function replanDelta(current: DagState, revised: DagSpec): { kept: string[]; added: DagNode[]; removed: string[]; rewired: Array<{ id: string; deps: string[] }> };
```

- 协议（V2，设计级）：规划技能在技能声明中以 tag（如 `planning`）标记；planner 产出经 A2A task 的结构化 data part 承载（非 ZeusReport 自由文本）。
- 审计新值：`plan-malformed` / `plan-selected` / `plan-conflict` / `plan-rejected-unplannable` / `plan-replanned` 入 AUDIT_DECISIONS。
- H2/TUI：plan-conflict 复用升级队列视图；选定计划与 DAG 进度在既有 DAG driver 面可见。

## 5. 分期

- **V1（纯函数校验/评分/增量）**：planning.ts 四函数 + 测试（图非法/技能缺失/inputs 不可满足/授权不可达各一例；评分排序与 tie 分歧；replan 冻结已完成节点的不变量；replan 变更不触碰 running 节点）+ 审计值登记；不接扇出、不调 planner。
- **V2（规划即扇出接线）**：规划技能 tag 识别、fan-out 到 planner、草稿解析/校验/评分/选择落运行时、plan-conflict 进升级队列、选定计划交 dag-runner。
- **V3（replan）**：接 S11/S4/S10/S13 触发信号产出 replanDelta，replan 计数入步数预算，变更集重新校验与审计。
- **V4（可选）**：目标-技能映射的语义化（经 DecisionBackend，模型无关）；多计划合并（merge 互补节点）在有真实 planner 样本后再议。

**验收（V1 实施时）**：每类 reject 正反例；"计划不产生执行授权"有独立断言（纯类型/文档级，V2 落集成测试）；replanDelta 对任意 current/revised 都不改动 completed 节点；全量与冒烟不回归（V1 零运行时行为变化）。
