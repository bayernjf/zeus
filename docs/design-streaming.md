# 设计稿：流式体验工程——部分结果、流式合并与思考态（tech map S15）

- 状态：**现行 v0.1（2026-10-09）**：设计探索先行，未落码。本文在不破坏 merge.ts 来源/排序不变量的前提下，定义分支内增量帧的归并纯函数与接线分期。
- 演进：v0.1（2026-10-09）首版——现状盘点（A2A SSE 已消费到内核、progress 只到分支粒度、分支事件落定才全量可见）+ 增量帧归并模型 + `streamWindow`/`appendStreamFrame` 草案 + 分期。
- 关联：tech map S15（部分结果先呈现、流式合并、思考态 UX）；design-fan-out.md（扇出与多流合并视图 F4）；design-supervision.md（DAG 节点级进度）；design-observability.md（S6，流式帧也是 span 事件来源）；design-backpressure.md（慢分支/饱和与流式窗口背压）；design-ui*.md（TUI/H2 呈现）；`src/dispatch/client.ts`（A2A SSE 帧消费）、`src/orchestrator/merge.ts`（分支事件合并，已立排序与来源原则）、`src/orchestrator/progress.ts`（branch 粒度事件，注释明示分支内不增量流式）、`src/http/server.ts`（progress SSE 广播）。
- 本文是流式体验的单一事实源；handoff 与 PRD 只索引。

## 1. 背景与现状

| 能力 | 现状 | 边界 |
| --- | --- | --- |
| A2A 流式接入 | dispatch/client 消费执行 Agent 的 SSE 帧（working 状态更新 → 最终 task） | 帧在 dispatcher 内部被消费，**落定后**才作为完整 DispatchResult 返回 |
| 分支事件合并 | merge.ts 把各分支 events 按**分支选择序**拼接，每事件带 `source {vassal, runId, taskId}`；明确**不按时间戳排序**（vassal 时钟不可信、时间戳可选） | 输入是已落定分支的全量 event list，不含进行中分支的增量帧 |
| 实时进度 | branch-started / branch-ended / intent-finished SSE 广播 | progress.ts 注释明示：**最细粒度到分支**，分支内部不增量流式 |
| HTTP 推送 | H2 已有 progress SSE 通道 | 只推生命周期，不推内容增量 |
| 聚合 | 多分支结论按策略聚合（unanimous/majority/仲裁） | 在全部分支落定后运行；无部分结果呈现 |

**缺口**：

1. **部分结果不可见**。一个长任务扇出 3 个 Agent，先完成的分支结论必须等最慢分支（或扇出整体落定）才呈现；操作者在等待期只看到"分支开始/结束"，看不到任何中间产出。
2. **分支内增量不到内核**。执行 Agent 的 working 帧（含部分文本/阶段标记）在 client 被消费即丢弃，既不进合并视图、也不进 trace/审计（除最终 task）。
3. **无流式聚合与思考态 UX**。没有"已就绪结论先呈现、未完成分支显示进行中状态"的视图模型；UI 无统一的思考态/部分态契约（什么字段可信、什么只是预告）。

## 2. 目标与边界

**目标**：把分支内增量帧从 dispatcher 安全地接到一个**确定性流式归并层**，使操作者面能：先看到已落定分支的完整结论、进行中分支看到带来源标签的增量与思考态、最终视图与现有 merge.ts 结果**严格一致**（流式只是提前呈现，不改变最终合并语义）。

**边界（明确不做）**：

- 不做 token 级跨分支交错合并：分支内保持 SSE 到达序，分支间保持选择序（沿用 merge.ts 已立原则）；不按不可信时间戳重排。
- 增量帧是**预览不是结论**：部分内容绝不进入聚合裁决、记忆沉淀、技能 inputs 或任何授权/决策路径——只有落定 task 才被下游消费（与 guardrails"Agent 产出是数据"、记忆只认真落定一致）。
- 不要求所有 Agent 支持增量：不发 working 帧的 Agent 维持"分支结束一次性呈现"的现状（能力协商走 agent-card capabilities，已有 streaming 位）。
- 不在 V1 改 UI 渲染：先定视图模型纯函数，TUI/H2 呈现是后续分期。

## 3. 流式归并模型

### 3.1 帧的分级

| 帧类型 | 来源 | 可呈现 | 可进决策/记忆 |
| --- | --- | --- | --- |
| branch-started / ended | 内核 progress | 是（思考态基线） | 生命周期事件可入 trace |
| working 增量帧 | Agent SSE status-update（部分内容/阶段） | 是，明确标"进行中预览"，带来源 | **否** |
| input-required | Agent 最终帧 | 是（挂起态，接升级队列） | 走既有 task-input 流程 |
| 最终 task（completed/failed/…） | Agent SSE 最终帧 | 是，转为正式分支结论 | 是（唯一进入聚合/记忆的内容） |

### 3.2 归并不变量（与 merge.ts 对齐并扩展）

1. **来源标签不丢**：每个增量帧携带 `source {vassal, runId}`，UI 任何时刻能区分内容来自哪个分支。
2. **分支内有序、分支间按选择序**：增量帧追加在所属分支的尾部；视图按分支选择序排列分支块，不按帧时间戳跨分支排序。
3. **预览可被替换不可被引用**：working 帧内容在最终 task 到达时整体替换；预览内容不产生稳定 id、不被聚合/记忆/审计正文引用（审计可记"收到 N 个增量帧"这种计数事实，不记内容）。
4. **最终视图等价**：所有分支落定后，流式视图的正式结论部分与 `mergeBranches(branches)` 字节级一致——流式层是 merge 的**增量预览版**，不是第二套合并规则。
5. **背压下保序不阻塞**：慢消费者（SSE 订阅者）追不上时，增量帧可合并/丢弃（只保留每分支最新预览 + 计数），但 branch-started/ended 与最终帧不可丢（与 backpressure 设计的水位策略一致）。

### 3.3 思考态视图契约

每分支对外状态：`waiting（未开始）→ thinking（有增量帧，附最新预览与帧计数）→ settled（落定，附正式结论）/ blocked（input-required，接 L1）/ failed`。意图整体状态在所有分支 settled 前为 `partially-ready`（已有 N/M 分支正式结论），落定后为现有聚合结果。

## 4. 落地接口草案（设计级，未落码）

```ts
// src/orchestrator/stream-merge.ts（纯函数，零 IO）
export type StreamFrame =
  | { kind: 'branch-started'; vassal: string; runId: string; at: string }
  | { kind: 'branch-delta'; vassal: string; runId: string; seq: number; preview: string; at: string }
  | { kind: 'branch-settled'; vassal: string; runId: string; branch: BranchOutcome; at: string };

export type StreamView = {
  order: string[];                          // 分支选择序（vassal 顺序）
  branches: Record<string, {
    state: 'waiting' | 'thinking' | 'settled' | 'blocked' | 'failed';
    preview?: string; deltaCount: number;
    settled?: BranchOutcome;
  }>;
  partiallyReady: number;                   // 已 settled 分支数
};

// 追加一帧产出新视图（不可变）；任何时刻全部 settled 后，正式结论 == mergeBranches
export function appendStreamFrame(view: StreamView, frame: StreamFrame, selectionOrder: string[]): StreamView;
export function emptyStreamView(selectionOrder: string[]): StreamView;
// 收敛断言（供测试与最终一致性校验）：全 settled 视图与 mergeBranches 等价
export function settledViewMatchesMerge(view: StreamView, branches: BranchOutcome[]): boolean;
```

- 接线点（V2，设计级）：dispatch/client 在 SSE working 帧到达时经新增窄回调（如 `onBranchDelta`，与 onProgress 同形状）上报；orchestrator 维护每意图 StreamView（内存态，不持久化预览）；H2 SSE 在 progress 通道增帧类型；落定分支仍走现有 publishBranch/merge/聚合路径，**不改变**。
- 审计：不新增逐帧内容审计；最终 task 审计照旧；可选 `stream-delta-count` 计数型审计（实施时定，默认不记内容）。

## 5. 分期

- **V1（纯函数归并层）**：stream-merge.ts 三函数 + 测试（帧序、来源标签、预览替换、部分就绪计数、乱序/迟到帧处理、**全 settled 与 mergeBranches 等价**的收敛断言、慢消费者丢帧不丢最终帧）；不接 dispatcher/UI。
- **V2（dispatcher 增量回调 + H2 SSE）**：client working 帧经 onBranchDelta 上报；H2 SSE 推 branch-delta 与 partially-ready；内存视图随意图落定清理。
- **V3（TUI/H2 思考态 UI）**：按 §3.3 状态契约渲染（进行中预览、N/M 就绪、blocked 挂起）；预览视觉与正式结论明确区分。
- **V4（可选）**：流式部分聚合（如多数分支已给一致结论时提前显示"倾向性结果（未裁决）"）——必须带未裁决水印且不触发任何下游动作，需 S8/S10 评审后再做。

**验收（V1 实施时）**：五类帧状态迁移正反例；预览内容永不出现在 settled 正式结论之外的输出结构里（独立不变量）；收敛等价性对随机帧序列成立（属性测试思路）；全量与冒烟不回归（V1 零运行时行为变化）。
