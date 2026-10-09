# 设计稿：可观测性——分布式 trace、调用链与重放（tech map S6）

- 状态：**现行 v0.1（2026-10-09）**：设计探索先行，未落码。本文定义从既有事件/审计/runId 命名装配 trace span 树的纯函数切法，不新造事件流。
- 演进：v0.1（2026-10-09）首版——现状盘点（审计脊 + 进程内 metrics + 决策 replay + progress SSE 已齐，缺统一 trace 树与跨 Agent 透传）+ span 模型 + `buildTraceTree` 草案 + 分期。
- 关联：tech map S6（跨 Agent 调用链调试；审计已有，补分布式 trace）；design-supervision.md（fan-out/DAG/升级的时间线）；design-fan-out.md（runId/resumeNo 命名）；design-tool-discovery.md（tool-selected/换将链入 trace）；design-hil.md（介入级别作为 span 事件）；design-cost-governance.md（S9，span 上挂 cost）；`src/orchestrator/metrics.ts`（ConcurrencyMetrics 进程内滚动窗口）、`src/orchestrator/replay.ts`（replayDecision 人读时间线）、`src/orchestrator/progress.ts`（branch 生命周期事件）、`src/dispatch/dispatcher.ts`（审计 runId 贯穿）。
- 本文是 trace/调用链可观测性的单一事实源；handoff 与 PRD 只索引。

## 1. 背景与现状

**已有可观测资产盘点（2026-10-09）**：

| 能力 | 现状 | 形状 | 位置 |
| --- | --- | --- | --- |
| 审计脊 | 全决策 jsonl（33+ decision 值），轮转、0600、bearer API 读回 | 事件日志，runId 贯穿 | dispatcher、boot auditSink、`/api/audit` |
| 实时指标 | 在途数、每 Agent 在途、失败率、p50 延迟、熔断计数 | 进程内滚动窗口（默认 1000 次分支历史），快照可导出 | `src/orchestrator/metrics.ts`、`/api/metrics` |
| 决策回放 | 一次 fan-out 的步骤时间线、参与方、冲突/仲裁 | 人读结构化时间线 | `src/orchestrator/replay.ts`、`/api/intents/:id/replay` |
| 实时进度 | branch-started / branch-ended / intent-finished | SSE 广播，分支为最细粒度（分支内事件不增量流式，见 progress.ts 注释） | `src/orchestrator/progress.ts` |
| runId 谱系 | 分支 runId；resume 为 `parentRunId:vassal:resumeN` | 命名约定已含父子/重试信息 | orchestrator `branchRunId` |
| 归档 | out-window intent 可经 archive 读回 | 持久化 | `src/state/archive.ts` |

**缺口**：

1. **没有统一的 trace 树**。一次意图扇出 N 个分支、DAG 分层、换将（diversion）、resume、升级、记忆装配——这些散落在审计日志（平铺 jsonl）、progress（生命周期）、replay（人读叙述）三处，没有一个**机器可读、可导出、父子关系明确**的 span 树。排查"一次慢决策卡在哪一跳"需要人肉拼日志。
2. **trace 不出进程**。内核的 runId 不随 A2A 请求透传给执行 Agent（协议无 trace 上下文字段）。当执行 Agent 内部再扇出/再调用（嵌套 A2A、delegation 换绑），跨进程的两段调用无法关联——多 Agent 协同越深，断点越难追。
3. **metrics 无历史维度**。ConcurrencyMetrics 是进程内实时窗口，重启归零（落盘的只有治理状态快照，不含指标史）；无法回答"上周 p50 是不是变差了"。
4. **决策重放不可导出复现**。decision backend 的输入/输出有测试级 replay，但没有"一次线上决策的完整输入快照可离线重放"的产物（与 S17 录制重放衔接）。

## 2. 目标与边界

**目标**：在不新造第二条事件总线的前提下，定义一棵从**既有审计 + progress + runId 谱系**确定性装配出来的 trace span 树，覆盖意图→分支→换将/resume→升级，并为跨 Agent 透传规定协议字段。原则：**trace 是只读投影**——所有 span 事实都来自已存在的事件，装配是纯函数；trace 自身不产生授权、不影响调度。

**边界（明确不做）**：

- V1 不引入 OpenTelemetry SDK / 外部 collector / 网络导出：仓库外依赖，exporter 留窄端口，默认空实现。
- 不做分支内部的 token 级流式 span（最细粒度到分支/换将/resume/升级；分支内增量属于 S15 流式体验）。
- 不做 metrics 长期存储与时序数据库：历史指标聚合另立分期，避免在 trace 设计里夹带存储工程。
- 不要求外部执行 Agent 必须支持 trace 透传：字段可选，不识别的 Agent 不影响派发（fail-open 的观测字段，不是授权字段）。

## 3. Span 模型

```
intent (trace root)
├── branch  vassal=A  runId=...                [span: dispatch]
│   ├── diversion?  from→to                     [span event: target-switch]
│   ├── resume 1..N                             [span: retry, parent 续接]
│   ├── escalation?  level=L0/L1/L2            [span event: interrupt]
│   └── context-assembly?  budget-truncations   [span event: context]
├── branch  vassal=B ...
├── dag node（DAG 驱动时，按拓扑层挂为子 span，产物下传记为 span link）
└── aggregation / arbitration / conflict        [span: decide]
```

- **traceId**：意图级，派生自 intentId（显式指定则原样，否则一次 fanOut 的根 runId）。**spanId**：分支级 runId；resume 不换 traceId、以 `:resumeN` 区分 span 并指回 parent。
- **跨进程传播**：出站 A2A 请求携带 `traceparent`（W3C 形状：`{traceId, spanId, flags}`）作为**协议可选元数据**；外部 Agent 若回传其内部子调用的 trace 信息，作为 `external-link` 挂在该分支 span 上（只记录、不校验、不参与授权）。
- span 属性（确定性，全部可从既有事件得到）：vassal、skill、realm、start/end、outcome（completed/failed/timeout/canceled）、failureRate/p50 快照值、cost 指针（S9 落地后）、interruptLevel、divertedFrom。
- 时钟：与 merge.ts 同一原则——**外部 Agent 的时间戳不可信、可选**；span 起止一律用内核时钟（this.now()），外部回传时间只作注释属性，不参与排序。

## 4. 落地接口草案（设计级，未落码）

```ts
// src/observability/trace.ts（纯函数，零 IO）
export type TraceSpanKind = 'intent' | 'branch' | 'dag-node' | 'decide';
export type TraceSpan = {
  traceId: string;
  spanId: string;                 // 分支 runId；intent 根用 intentId
  parentSpanId?: string;
  kind: TraceSpanKind;
  vassal?: string; skill?: string; realm?: string;
  startedAt: string; endedAt?: string;
  outcome?: BranchOutcomeKind;
  events: Array<{ kind: 'target-switch' | 'resume' | 'interrupt' | 'context-budget' | 'external-link'; at: string; detail?: string }>;
};
export type TraceTree = { traceId: string; root: TraceSpan; spans: TraceSpan[] };

// 从既有事实确定性装配；输入是审计条目 + progress 事件（或一次 replay 的结果），
// 不订阅任何新事件源。缺失事件按"未发生"处理，不猜测。
export function buildTraceTree(input: {
  audit: readonly AuditEntry[];
  progress: readonly ProgressEvent[];
}): TraceTree;

// 导出窄端口：默认无操作；OTLP/JSON 文件等实现是装配后的事（V2+）。
export interface TraceExporter { export(tree: TraceTree): void | Promise<void>; }
```

- 协议字段（V2，设计级）：A2A task/metadata 增加可选 `traceparent`（design-vassal-protocol / design-http-transport 同步），dispatcher 出站时填入当前 traceId/spanId；入站 A2A（外部 Agent 调内核）若携带则记录为 external-link 的父线索。
- 审计不新增 decision 值——trace 是投影；只有"外部回传了无法解析的 trace 链接"这类**新事实**才考虑审计登记（实施时定）。

## 5. 分期

- **V1（纯函数装配）**：`buildTraceTree` + 测试（单分支/扇出多分支/换将/resume/升级/DAG 各一树；时钟只用内核时间；缺事件不臆造）；不接 exporter、不改协议。
- **V2（出站透传 + 只读端点）**：dispatcher 出站带 `traceparent`；`GET /api/intents/:id/trace` 返回装配树（bearer，与 replay 同授权）；external-link 记录。
- **V3（exporter + 指标史）**：TraceExporter 的 JSON/OTLP 实现（默认关闭、本地文件优先，守数据主权）；metrics 快照按窗口落本地（复用 archive 形状），回答趋势问题。
- **V4（可选）**：决策输入快照随 span 导出，支撑离线重放（与 S17 录制重放合流）。

**验收（V1 实施时）**：每类 span/事件至少一例；同一输入（audit+progress 夹具）两次装配结果字节一致（确定性）；resume 与换将的父子关系断言；全量与冒烟不回归（V1 零运行时行为变化）。
