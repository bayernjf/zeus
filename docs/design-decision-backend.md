# 快决策层设计（Decision Backend）

> 状态：**现行（设计稿 v0.1，2026-09-22）**。实施进度记 [handoff.md](../handoff.md)，本文只写设计。
> 上游：[tech-exploration-map.md](tech-exploration-map.md) S2（裁决/Critic）、S8（Guardrails）、S14（多模型异构调度）；[prd.md](prd.md) E1.3（规则聚合）、E1.4（冲突消解）、E6.2（升级拍板）；[design-fan-out.md](design-fan-out.md) §5/§6；[design-supervision.md](design-supervision.md) §8（开放问题：Critic 独立还是内置）。
> 技术选型：**Jev（TypeSafe AI "System One" 决策模型）**为首个实现。

## 0. 一句话

Zeus 的决策内核新增一个**可替换的"快决策层"（Decision Backend）**：面向 Agent 运行中高频的分类 / 评分 / 是非判断，由外部决策模型（首个实现为 Jev）在**毫秒级、近乎免费**地给出带置信度的类型化结论；内核通过窄端口注入它，**纯函数聚合规则照旧是底座**，无后端时一切按现状降级，绝不把外部模型写进内核。

## 1. 为什么选 Jev（选型依据）

Jev 是 TypeSafe AI 于 2026-09-15 发布的第一个公开 "System One" 模型（前 OpenAI 研究员、InstructGPT 论文主要作者 Diogo Almeida 创立）[36kr-1][langchain]。它不是 LLM：不生成自然语言，输入一段状态 + 预定义的类型化问题，输出 **Choice（从预定义候选中选）/ Score（区间评分）/ Noul（0–1 概率是非判断）** 三种结果，每个答案带概率与置信度，单请求多问题并行 [langchain][progressive][dev]。

| 决策原语 | 返回 | Zeus 对应场景 |
| --- | --- | --- |
| Choice | 选项 + 各选项概率 + confidence | 封臣/分支仲裁、升级路由、立场归类 |
| Score | 连续分数 + 分布 + confidence | 立场可信度、质量分级、冲突严重度 |
| Noul | 0–1 概率 | guardrail（是否危险/越权/值得打扰人）、一致性校验 |

选型理由（对照内核需求）：

1. **成本/延迟量级**：官方定价输入 $0.042/百万 token、输出免费，端到端延迟 70–500ms [36kr-2][mindstudio]。一次决策调用约 0.3s、约 $0.00004（社区实测口径）[dev-bench]。这使"每个决策点都问一下模型"从奢侈变为默认可行——正好补上 E1.3/1.4 目前"规则无解就只能升级人"的成本缺口。
2. **类型化、无幻觉文本**：Jev 只输出结构化决策（官方称结构化输出错误率按构造为 0% [jevapi]），不产出自由文本——可直接进分支逻辑，无 parse 成本、无 prompt 注入自由文本面。这比 LLM-as-judge 更适合做**高频率、低风险**的 System 1 判断。
3. **置信度校准（RLCD）**：训练目标是让置信度贴近真实准确率 [langchain][36kr-1]——正是监督台"该不该打断人"的判据；低置信才升级，高置信直接采纳。
4. **接入成本低**：标准 JSON API，已有 Cloudflare AI 目录、LangChain 集成、社区 ~500 个开源项目与 APUS 开源复现 [cloudflare][央广网][极客公园]。
5. **可替换**：按立国三纲，能力接入必须可落到 MCP/Skill/A2A；Jev 是**首个实现**而非唯一实现，端口抽象保证可换本地/开源/自托管模型（APUS 复现即候选）。

**边界澄清（避免错位）**：Jev 不是驱动模型（不生成文本，不能当主脑）、不是封臣（是模型服务不是 Agent）；它是**决策后端**——供内核快判、供封臣/驾驶员经 MCP 调用的外部能力。技术探索地图 S14（多模型异构调度）中，Jev 的落点是"快决策模型层"。

## 2. 在架构中的位置

```
驾驶员 / 封臣 / 未来 H2 API
        │
   ┌────┴─────────────────────────────┐
   │ 决策内核（E1 并发内核）            │
   │  aggregate() 纯函数规则（底座，无模型）│
   │  detectConflicts() 纯函数          │
   │  ↓ 规则无解 / 需快判时              │
   │  DecisionBackend 端口（注入，可空）  │ ← 本文
   └────┬─────────────────────────────┘
        │ 窄接口：noul / choice / score
   Jev 适配器（首个实现，HTTP+JSON）
        │
   TypeSafe Jev API（外部模型服务）
```

硬约束：

1. **内核不 import 任何外部模型 SDK**：`src/orchestrator/`、`src/dispatch/` 只依赖注入的 `DecisionBackend` 端口；Jev 适配器单独在 `src/decision/`（类比 `src/http/` 只允许 fastify 的隔离惯例）。
2. **无后端 = 现状**：端口未配置时，聚合/冲突逻辑与今天完全一致（规则无解 → needs-driver 升级人），不产生任何外部调用，行为可离线复现。
3. **纯函数优先**：能由规则解决的问题绝不问模型；只有规则无解（`conclusion:null`）或显式要求快判（guardrail / triage）时才走端口。
4. **决策留痕**：每次外部决策调用记审计（模型、输入摘要、结果、置信度、耗时、成本），沿 runId 可回放——呼应 E1.6 可追溯。
5. **数据不出域默认**：state 只送"判断所需的最小字段"，敏感原文（Realm 内容、私密上下文）默认脱敏或拒绝；enterprise 域数据默认不送外部模型（见 §6）。

## 3. 融合点（四个接线位）

### 3.1 规则聚合仲裁（E1.3 升级）——主位

`aggregate()` 规则无解（`conclusion:null`，平票/未过半/未达阈值）时，当前直接 `needs-driver`。接入后：

1. 仍先走纯函数规则；
2. 规则无解且配置了 DecisionBackend → 调 `choice`（把各立场作为候选项，state=各方立场+理由摘要）做**快仲裁**；或调 `score`（对各立场可信度打分）；
3. **结果带置信度**：置信度 ≥ 阈值 → 采纳为 `conclusion`（在 `reason` 与结果中标注 `decisionBackend: 'jev', confidence`）；< 阈值 → 仍 `needs-driver` 升级人；
4. 后端不可用/超时/失败 → 静默降级为 `needs-driver`，不阻塞、不假装有结论。

> 对应 design-fan-out §5 边界"本批不做 LLM-as-judge"的**快层**：Jev 负责 System 1 快判；LLM 深度 critc（对抗辩论、长文论证）仍是 S2 慢层，本设计不取代它。

### 3.2 监督台 triage（E6.2 / E1.4）——拍板前过滤

升级请求进监督台前，可选做 `noul`/`score` 判断：该升级**是否值得打断驾驶员**、紧急度多高、路由给谁（choice）。低价值噪音升级被过滤或降级呈现，驾驶员只看到值得看的冲突。**过滤是建议不是裁决**：最终仍按 OversightDesk 语义入队，人可查可改。

### 3.3 派发 guardrail（S8 前置最小步）——执行前闸门

对高风险操作（merge-pr execute、production-rollback 等 execute 类 skill）派发前，可选 `noul` 校验："该任务/参数是否属于已声明允许范围、是否有越权/危险信号"。命中风险则升级人确认而非直接派发。**默认关闭**，逐 skill 开启（呼应 S8 高优但需谨慎，避免把 guardrail 做成静默拦截）。

### 3.4 异构调度评分（S14 落点）——路由辅助

封臣/模型选择、分支优先级排序等场景，可用 `score` 做轻量路由打分。本设计只定义端口与语义，**不预设路由策略**（策略随 S14 工程切片定）。

## 4. 端口设计（`src/decision/types.ts`）

```ts
/** 决策后端窄端口。内核与装配层共用；实现方（Jev/本地/开源）负责 HTTP 与鉴权。 */
export type DecisionBackend = {
  /** 是非判断：某命题为真的概率（0–1）。 */
  noul(request: NoulRequest): Promise<NoulResult>;
  /** 从预定义候选中选一项，返回各选项概率与整体置信度。 */
  choice(request: ChoiceRequest): Promise<ChoiceResult>;
  /** 按区间规则评分，返回连续分数、分布与置信度。 */
  score(request: ScoreRequest): Promise<ScoreResult>;
};

export type QuestionBase = {
  /** 输入状态：仅含判断所需的最小字段（见 §6）。 */
  state: Record<string, unknown> | string;
  instructions: string;       // 判断标准（人话描述）
  /** 决策来源追踪。 */
  runId: string;
  realm: RealmType;
  maxWaitMs?: number;         // 单次调用超时；缺省 1500
};

export type NoulRequest = QuestionBase & { question: string };
export type NoulResult = { probability: number; confidence: number; decisionAt: string };

export type ChoiceRequest = QuestionBase & { question: string; options: string[] };
export type ChoiceResult = {
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
  decisionAt: string;
};

export type ScoreRequest = QuestionBase & { question: string; levels: string[] }; // 低/中/高…
export type ScoreResult = { score: number; level?: string; distribution: Record<string, number>; confidence: number; decisionAt: string };

/** 统一的失败语义：实现方应把网络/鉴权/超时折叠为 DecisionBackendError。 */
export type DecisionBackendError = { code: 'unavailable' | 'timeout' | 'auth' | 'invalid'; message: string };

export type DecisionTrace = {
  runId: string; backend: string; request: { kind: 'noul'|'choice'|'score'; question: string; stateKeys: string[] };
  result?: unknown; error?: DecisionBackendError;
  latencyMs: number; cost?: { inputTokens: number; cents: number }; decidedAt: string;
};
```

**语义约定**：
- 结果必须带 `confidence`（模型校准或实现方估计）；缺失置信度的后端按 `confidence=0` 处理（永远不采纳）。
- `maxWaitMs` 超时 → 实现方抛 `timeout` 错误，调用方按 §5 降级。
- 调用方约定：任何错误/超时都走**降级路径**（默认=不采纳该结果，按未配置处理），绝不让外部模型成为派发/聚合的硬依赖。

## 5. Jev 适配器（`src/decision/jev.ts`，首个实现）

- 请求形态：Jev API 为 `{ model, state, questions: { <name>: { type: 'noul'|'choice'|'score', instructions, options?/levels? } } }`，单次返回全部问题的类型化答案 [langchain][progressive]。适配器把三个端口方法各自映射为单问题调用（或未来合并为一次多问题批调，见 §10 优化）。
- 鉴权/配置：`ZEUS_DECISION_API_KEY` + `ZEUS_DECISION_MODEL=jev-latest`（env 装配，与 `serve.ts` 同风格）；未配置 → 端口为 `null`，内核零变化。
- 成本记录：按官方口径输入 $0.042/M token、输出免费 [36kr-2]；适配器按 `inputTokens` 估算并写入 `cost`（±20% 精度即可，仅用于审计与 S9 预算闸门，不计费）。
- 错误折叠：网络失败→`unavailable`；401/403→`auth`；4xx/5xx→`unavailable`；超过 `maxWaitMs`→`timeout`。**不允许把 Jev 的原始错误细节透传给调用方**（避免把外部服务信息混入内核日志/审计）。

## 6. 数据主权与安全（设计哲学硬线）

1. **state 最小化**：适配器只允许传 `stateKeys` 白名单内的字段；默认白名单为空 → 任何调用都需显式声明字段。Realm 内容、私密上下文**默认拒绝出域**。
2. **enterprise 域默认不送**：`realm:'enterprise'` 的决策请求默认拒绝送外部模型（除非装配层显式开启 `allowEnterpriseExfiltration: true` 并逐 skill 声明——默认关）。
3. **脱敏钩子**：装配层可注入 `redact(state)`，在送模型前清洗（人名/ID/token 替换）。
4. **审计**：每次调用写 `DecisionTrace`（含 `stateKeys` 而非原文），沿 runId 可回放，满足 E1.6。
5. **可选本地后端**：Jev 是默认实现，端口允许任何实现——本地/自托管模型（如 APUS 开源复现 [央广网]）经同一端口接入，数据不出域；这是"用户是底座、产品是插件"的体现（外部模型是插件，不是底座）。

## 7. 验收（映射地图/PRD）

1. 未配置后端时：全量现有测试行为不变（124 项绿，聚合/冲突零变化）；
2. 规则能解决的不问模型：`majority` 有结论时不产生任何决策调用（可测：注入 spy 端口，断言零调用）；
3. 规则无解 + 后端高置信 → 采纳并带 `decisionBackend/confidence` 标注；低置信/失败/超时 → 仍 `needs-driver`；
4. 后端抛错/超时 → 调用方降级成功、审计留 `error` 痕、不阻塞不伪造；
5. enterprise 域默认拒绝出域；`stateKeys` 白名单外的字段不到达实现方；
6. guardrail 默认关闭，逐 skill 开启；命中 → 升级人而非静默拦截；
7. 每次调用有 `DecisionTrace`，沿 runId 可回放。

## 8. 明确不做（本批边界）

- LLM 深度 Critic / 对抗辩论 / 陪审团（S2 慢层，仍需 LLM 切片）；
- Jev 批量多问题合并、缓存层（先单问题逐调，性能优化随 S14 切片）；
- 决策结果写回封臣/重派（E6.3）；
- 自托管后端的部署方案（APUS 复现接入只保留端口，不写部署手册）；
- 路由策略本身（S14 只给 `score` 语义，不给调度算法）。

## 9. 演进日志

| 版本 | 日期 | 变更 |
|---|---|---|
| v0.1 | 2026-09-22 | 初稿：DecisionBackend 端口（noul/choice/score）、Jev 首个实现、四个融合接线位（聚合仲裁/监督台 triage/派发 guardrail/异构评分）、数据主权硬线、七条验收 |

## 附：关键事实来源

- [36kr-1] Jev 与 TypeSafe：https://36kr.com/p/3988164509711361 、https://36kr.com/p/3992394169613316
- [36kr-2] 定价与性能口径：https://36kr.com/p/3988164509711361 （$0.042/M input、输出免费、70–500ms、193.6×/444.6×）
- [langchain] Jev 机制与接入：https://www.langchain.com/blog/building-a-harness-with-jev
- [progressive] 三种原语：https://www.progressiverobot.com/2026/09/16/jev-model-typesafe-programmatic-logic/
- [dev] Choice/Score/Noul 用法：https://dev.to/simonli/everything-about-jev-5b0i
- [dev-bench] 单次成本/延迟社区实测：https://dev.to/aitejiu/benchmarking-jev-what-a-decision-model-can-and-cant-do-in-an-agent-harness-20po
- [jevapi] 结构化输出错误率口径：https://jevapi.org/
- [cloudflare] Cloudflare AI 目录：https://developers.cloudflare.com/ai/models/typesafe/jev/
- [央广网] APUS 开源复现：http://tech.cnr.cn/techph/20260920/t20260920_527819594.shtml
- [极客公园] 社区生态：http://m.toutiao.com/group/7687949565651092003/
