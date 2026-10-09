# 设计稿：长流程持久化执行——checkpoint、崩溃恢复、断点续跑（tech map S13）

- 状态：**现行 v0.1（2026-10-09）**：设计探索先行，未落码。本文区分"优雅退出快照（已有）"与"崩溃恢复（缺口）"，定义恢复分级纯函数。
- 演进：v0.1（2026-10-09）首版——现状盘点（KernelSnapshot 优雅落盘 + 显式 resume 已有，崩溃后在途意图无恢复策略）+ 恢复三分类 + `classifyRecoverable`/`computeCheckpoint` 草案 + 分期。
- 关联：tech map S13（checkpoint、崩溃恢复、断点续跑，随 H2）；design-intent-retention.md（状态窗口/归档，是**体积治理**；本设计是**执行连续性**，两者正交）；design-fan-out.md（幂等键与零出站重放，自动恢复的安全前提）；design-hil.md（恢复需人时落 L1/L2）；design-supervision.md §7.1（熔断随快照恢复）；design-cost-governance.md（S9，恢复重跑受预算约束）；design-sandbox.md（S16，外部写的不可逆性影响恢复分类）；`src/state/kernel-state.ts`（KernelSnapshot）、`src/state/archive.ts`、`src/orchestrator/orchestrator.ts`（resume/resumeNo）。
- 本文是长流程持久化执行的单一事实源；handoff 与 PRD 只索引。

## 1. 背景与现状

| 能力 | 现状 | 边界 |
| --- | --- | --- |
| 状态快照 | KernelSnapshot 在优雅退出（SIGTERM）时全量落盘 0600：registry/oversight/orchestrator/realms/skills/memory/connectors/mentorships/org/grants | **只覆盖优雅退出**；kill -9、断电、OOM 时最后一次落盘之后的状态丢失 |
| 启动恢复 | 重启从快照恢复名册、治理状态、Realm、记忆等（smoke 45 步含 restart 系列验证） | 恢复的是**静态治理状态**；在途意图的执行不自动续 |
| 显式 resume | 操作者驱动：input-required 补参后 resume、失败分支 resumeNo 续跑，runId 谱系 `parent:vassal:resumeN` | 需要人显式触发；没有崩溃后的自动判定 |
| 幂等重放 | intentId 幂等，重放零出站（F2） | 是自动恢复**安全性**的前提，但本身不触发恢复 |
| 归档 | out-window 意图进 archive，replay 可追溯 | 面向历史查询，不面向续跑 |
| 分支事件 | dispatcher 落定时带全量 event list（progress.ts 注释明示分支内不增量流式） | 分支执行中途崩溃，其未落定事件全部丢失 |

**缺口**：

1. **崩溃后在途意图无归属**。进程在分支等待 SSE 时被 kill，重启后该意图在快照里处于"曾 running"，但没有分支会回来——既不自动续跑，也不自动失败，也不进升级队列，成为僵尸状态（操作者不查 replay 就不知道它死了）。
2. **无周期性 checkpoint**。落盘只在退出点；长流程（数十分钟到数小时的 DAG/多轮 fan-out）崩溃代价 = 整个进程自上次退出以来的全部在途进度。
3. **无恢复规划**。即使有 checkpoint，"哪些意图/分支可以安全自动续、哪些必须等人、哪些应当判失败"没有判定——非幂等的 execute 分支自动重跑可能重复外部写（这是最危险的恢复错误）。
4. **断点续跑只到分支粒度**。分支内部（多帧 SSE、长任务）无中间产物持久化，恢复只能整分支重跑。

## 2. 目标与边界

**目标**：定义崩溃恢复的**确定性分类与续跑协议**——重启时对快照中每个未完成意图产出恢复裁决（自动续跑 / 等操作者 / 判失败收尾），并定义周期性 checkpoint 的最小内容，使长流程在崩溃后要么安全自动继续、要么显式挂起等人，**绝不留僵尸、绝不重复不可逆写**。

**边界（明确不做）**：

- 不做分支内部的逐帧 checkpoint（外部 Agent 的中间态内核拿不到、也不该替它存；分支粒度是 A2A 协议决定的边界）。
- 不做跨主机迁移/热漂移：恢复在同一数据目录、同一内核身份下进行（数据主权与签名链约束）；换机恢复走 vault 备份恢复协议，另案。
- 不替外部 Agent 保证其侧幂等：自动续跑只在内核**幂等键 + 零出站重放**能保证安全的范围内发生；Agent 侧是否幂等由协议契约声明（design-vassal-protocol），未声明幂等的分支一律不自动重跑。
- checkpoint 不引入新存储引擎：复用 KernelSnapshot/archive 的文件形状与 0600/备份纳入策略。

## 3. 恢复分类设计

重启（或 checkpoint 加载）时，对每个快照中未 settle 的意图逐分支裁决：

| 裁决 | 条件（全部满足） | 动作 |
| --- | --- | --- |
| **auto-resume** | 分支为只读/plan 模式或技能声明幂等；幂等键可零出站重放；无未消费的 execute 授权票据；预算（S9）未耗尽 | 重启后自动以原 intentId/续 resumeNo 重派；审计 `recovery-auto-resumed` |
| **await-operator（L1）** | 分支含 execute/非幂等外部写；或曾有 input-required 未决；或自崩溃起超过配置时长 | 进升级队列（design-hil），带"崩溃恢复待确认"选项（续跑/终止/改派），审计 `recovery-awaiting-operator` |
| **settle-failed** | 原分支已明确失败且无替代 provider（S11 恢复链已耗尽）；或熔断打开且为自动路径；或意图已不完整（缺关键快照段且无法重建） | settle 为 failed，reason 标注崩溃恢复，审计 `recovery-settled-failed` |
| **settle-canceled** | 崩溃前已发出 cancel 但未落定 | 按 cancel 语义收尾（F3） |

**硬不变量**：

1. **execute 分支默认等人**：没有可验证的幂等声明/未消费授权票据，自动恢复绝不重发外部写（与 execution delegation gate 同原则：没有授权就没有执行）。
2. **恢复动作本身可重入**：恢复流程在任何时刻再次崩溃，重启后重新分类不得产生重复派发——auto-resume 重派前先查幂等键与在途表（与 F2 同一道闸）。
3. **不留 running 僵尸**：每个未完成意图重启后必须落入上述四类之一，不存在"恢复后仍 running 但无人执行"的状态。

### 3.1 checkpoint 内容（最小集）

在既有 KernelSnapshot 之上，周期性 checkpoint 增补：意图/分支当前状态与 runId 谱系、每分支的派发模式（plan/execute）与技能幂等声明、已消费/未消费授权票据 nonce、在途幂等键集合、熔断与预算账本当前值。分支中间产物**不纳入**（§2 边界）。checkpoint 是"可恢复点"不是"完整执行镜像"。

## 4. 落地接口草案（设计级，未落码）

```ts
// src/orchestrator/recovery.ts（纯函数，零 IO）
export type RecoveryVerdict =
  | { kind: 'auto-resume'; resumeNo: number }
  | { kind: 'await-operator'; level: 1 | 2; reason: string }
  | { kind: 'settle-failed'; reason: string }
  | { kind: 'settle-canceled' };

export function classifyRecoverable(branch: {
  mode: 'plan' | 'execute';
  skillDeclaresIdempotent: boolean;
  idempotencyKeyReusable: boolean;     // F2 零出站重放是否仍覆盖
  unconsumedDelegationNonce: boolean; // 未消费的 execute 票据存在
  lastOutcome?: 'failed' | 'input-required' | 'running';
  hasFallbackProvider: boolean;       // S11 恢复链
  circuitOpen: boolean;
  budgetExhausted: boolean;
  crashedForMs?: number;
}): RecoveryVerdict;

// 从当前内核状态计算最小可恢复 checkpoint（纯投影，不落盘；落盘由 state 层做）
export function computeCheckpoint(snapshot: OrchestratorSnapshot): RecoveryCheckpoint;
```

- 接线点（V2，设计级）：boot 恢复序列在静态状态恢复之后、HTTP 接受新意图之前，对在途意图逐分支分类并执行；周期 checkpoint 由定时器/在途状态变更触发（频率配置化，默认关闭，触发条件见 §5）。
- 审计新值：`recovery-auto-resumed` / `recovery-awaiting-operator` / `recovery-settled-failed` / `checkpoint-written` 入 AUDIT_DECISIONS。
- TUI/H2：await-operator 的恢复行复用升级队列视图，措辞区分"运行中升级"与"崩溃恢复"。

## 5. 分期与触发条件

- **V1（纯函数分类器）**：recovery.ts 两函数 + 判定表测试（四类裁决正反例、execute 默认等人、可重入不变量、僵尸为零的全分类断言）+ 审计值登记；不接触启动流程。
- **V2（启动恢复接线）**：boot 恢复序列接入分类，崩溃模拟测试（kill -9 夹具：起进程→扇出→杀进程→重启→断言四类结局与审计）；先不做周期 checkpoint，崩溃窗口=上次优雅落盘以来。
- **V3（周期 checkpoint）**：触发条件实测后开启——出现首个连续运行 ≥2 周实例，或实测崩溃丢失窗口不可接受（与 design-intent-retention §5 同一触发口径）；在此之前不做半程落盘工程。
- **V4（可选）**：分支内断点（需协议支持执行 Agent 侧 checkpoint，跨仓库协议改动，随真机阶段）。

**验收（V1 实施时）**：四类裁决各有正反例；"无幂等声明的 execute 分支永不 auto-resume"独立不变量；任意输入都有裁决（无"未分类"分支）；全量与冒烟不回归（V1 零运行时行为变化）。
