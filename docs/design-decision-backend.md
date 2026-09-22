# 决策后端抽象层设计（Decision Backend）

> 状态：**现行（设计稿 v0.2，2026-09-22）**。实施进度记 [handoff.md](../handoff.md)，本文只写设计。
> 上游：[tech-exploration-map.md](tech-exploration-map.md) S2（裁决/Critic）、S8（Guardrails）、S14（多模型异构调度）；[prd.md](prd.md) E1.3（规则聚合）、E1.4（冲突消解）、E6.2（升级拍板）；[design-fan-out.md](design-fan-out.md) §5/§6；[design-supervision.md](design-supervision.md) §8（开放问题：Critic 独立还是内置）。
> 版本说明：v0.2 起**与具体模型解耦**——决策层是抽象端口，两类实现家族并存：**专用决策模型**（首个实现 Jev）与**传统 LLM**（prompt + 结构化输出适配）。v0.1 曾以 Jev 为单一主轴，本轮改为模型无关。

## 0. 一句话

Zeus 的决策内核新增一个**与具体模型解耦的"决策后端"抽象层（Decision Backend）**：面向 Agent 运行中的分类 / 评分 / 是非判断，以统一的窄端口（noul / choice / score）接入**任意决策提供方**——既可以是 Jev 这类毫秒级、近免费的专用决策模型（System 1 快层），也可以是传统 LLM（System 2 慢层，经 prompt + 结构化输出适配）。内核通过注入端口使用它，**纯函数聚合规则照旧是底座**，无后端时一切按现状降级，**任何模型都不是内核的一部分**。

## 1. 为什么抽象成"模型无关"的决策层（而非绑定单一模型）

决策是内核的高频动作，而模型形态在快速分化：**专用决策模型**（Jev 类：不生成文本、原生类型化输出、校准置信度）与**传统 LLM**（可生成论证、但慢且贵、置信度不可靠）各有所长。若把架构绑死在某一个模型上，换模型就是改内核；抽象层让**决策能力**（要什么结论）与**提供方**（谁给结论）分离，符合项目一贯的"可替换后端"惯例（如 Realm SearchBackend、fealty 签名器）。

| 维度 | 专用决策模型（Jev 类） | 传统 LLM（适配） |
| --- | --- | --- |
| 输出形态 | 原生 Choice/Score/Noul + 概率 + 置信度 | 自由文本，需 prompt + JSON schema / function calling 约束 |
| 置信度 | 训练校准（如 Jev 的 RLCD）[langchain] | 不自带；需自报/启发式估计，不校准 |
| 延迟 / 成本 | 毫秒级、近免费（Jev：70–500ms，输入 $0.042/M token、输出免费）[36kr-2] | 秒级、按 token 计费（输出更贵） |
| 适用 | 高频、低利害、需要确定分支 | 低频、高利害、需要论证与解释（LLM-as-judge） |
| 幻觉面 | 结构化决策，无自由文本 | 有自由文本幻觉与解析失败面 |

**结论**：两者不是替代关系而是**两层分工**（呼应 S2 裁决/Critic 与 Kahneman 快慢思维）——快层用专用决策模型做高频率初判，慢层用 LLM 做低频率深度裁决；同一端口、由调用方/装配策略选择。

## 2. 在架构中的位置

```
驾驶员 / 封臣 / 未来 H2 API
        │
   ┌────┴─────────────────────────────┐
   │ 决策内核（E1 并发内核）            │
   │  aggregate() 纯函数规则（底座，无模型）│
   │  detectConflicts() 纯函数          │
   │  ↓ 规则无解 / 需快判时              │
   │  DecisionBackend 端口（注入，可空）  │ ← 本文（模型无关）
   └────┬─────────────────────────────┘
        │ 窄接口：noul / choice / score（统一语义）
   ┌────┴───────────┬───────────────────────┐
   │ 决策模型适配器    │ LLM 适配器             │
   │（Jev 类，原生）   │（prompt + 结构化输出）    │
   │  src/decision/  │  src/decision/        │
   └────┬───────────┘  └─────────┬───────────┘
        │ HTTP+JSON               │ LLM SDK / HTTP
   TypeSafe Jev API          任一传统 LLM（慢层）
```

硬约束：

1. **内核不 import 任何外部模型 SDK**：`src/orchestrator/`、`src/dispatch/` 只依赖注入的 `DecisionBackend` 端口；所有适配器（决策模型 / LLM）隔离在 `src/decision/`。
2. **无后端 = 现状**：端口未配置时，聚合/冲突逻辑与今天完全一致（规则无解 → needs-driver 升级人），不产生任何外部调用，行为可离线复现。
3. **纯函数优先**：能由规则解决的问题绝不问模型；只有规则无解（`conclusion:null`）或显式要求快判（guardrail / triage）时才走端口。
4. **决策留痕**：每次外部决策调用记审计（提供方、模型、输入摘要、结果、置信度、耗时、成本），沿 runId 可回放——呼应 E1.6 可追溯。
5. **数据不出域默认**：state 只送"判断所需的最小字段"，敏感原文默认脱敏或拒绝；enterprise 域数据默认不送外部模型（见 §8）。
6. **换模型不动内核**：新增/更换提供方 = 新适配器 + 装配配置，内核零改动；这是本层存在的原因。

## 3. 融合点（四个接线位，均模型无关）

### 3.1 规则聚合仲裁（E1.3 升级）——主位

`aggregate()` 规则无解（`conclusion:null`，平票/未过半/未达阈值）时，当前直接 `needs-driver`。接入后：

1. 仍先走纯函数规则；
2. 规则无解且配置了 DecisionBackend → 调 `choice`（把各立场作为候选项，state=各方立场+理由摘要）做**快仲裁**；或调 `score`（对各立场可信度打分）；
3. **结果带置信度**：置信度 ≥ 阈值 → 采纳为 `conclusion`（在 `reason` 与结果中标注 `backend/model/confidence`）；< 阈值 → 仍 `needs-driver` 升级人；
4. 后端不可用/超时/失败 → 静默降级为 `needs-driver`，不阻塞、不假装有结论。

> 快慢两层都可用：默认快层（决策模型，高频率低利害）；高利害冲突可配慢层（LLM，产出论证与解释后仍按置信度门控）。

### 3.2 监督台 triage（E6.2 / E1.4）——拍板前过滤

升级请求进监督台前，可选做 `noul`/`score` 判断：该升级**是否值得打断驾驶员**、紧急度多高、路由给谁（choice）。低价值噪音升级被过滤或降级呈现。**过滤是建议不是裁决**：最终仍按 OversightDesk 语义入队，人可查可改。triage 属高频低利害，默认用快层。

### 3.3 派发 guardrail（S8 前置最小步）——执行前闸门

对高风险操作（merge-pr execute、production-rollback 等 execute 类 skill）派发前，可选 `noul` 校验："该任务/参数是否属于已声明允许范围、是否有越权/危险信号"。命中风险则升级人确认而非直接派发。**默认关闭**，逐 skill 开启。时延敏感场景用快层；需解释拒绝原因时可用慢层（LLM 给理由）。

### 3.4 异构调度评分（S14 落点）——路由辅助

封臣/模型选择、分支优先级排序等场景，可用 `score` 做轻量路由打分。本设计只定义端口与语义，**不预设路由策略**（策略随 S14 工程切片定；届时可同时比较决策模型与 LLM 的评分质量/成本）。

## 4. 端口设计（`src/decision/types.ts`，模型无关）

```ts
/** 决策后端提供方种类（审计与选择策略用；端口语义两者一致）。 */
export type DecisionBackendKind = 'decision-model' | 'llm';

/** 决策后端窄端口。内核与装配层共用；实现方（Jev/任意LLM/本地模型）负责协议与鉴权。 */
export type DecisionBackend = {
  kind: DecisionBackendKind;
  /** 审计标识，如 'jev-latest' / 'gpt-5.6-luna' / 'local:apus'. */
  model: string;
  /** 是非判断：某命题为真的概率（0–1）。 */
  noul(request: NoulRequest): Promise<NoulResult>;
  /** 从预定义候选中选一项，返回各选项概率与整体置信度。 */
  choice(request: ChoiceRequest): Promise<ChoiceResult>;
  /** 按区间规则评分，返回连续分数、分布与置信度。 */
  score(request: ScoreRequest): Promise<ScoreResult>;
};

export type QuestionBase = {
  /** 输入状态：仅含判断所需的最小字段（见 §8）。 */
  state: Record<string, unknown> | string;
  instructions: string;       // 判断标准（人话描述）
  /** 决策来源追踪。 */
  runId: string;
  realm: RealmType;
  maxWaitMs?: number;         // 单次调用超时；缺省：决策模型 1500 / LLM 15000
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
  runId: string;
  backend: DecisionBackendKind;
  model: string;
  request: { kind: 'noul'|'choice'|'score'; question: string; stateKeys: string[] };
  result?: unknown; error?: DecisionBackendError;
  latencyMs: number; cost?: { inputTokens: number; cents: number }; decidedAt: string;
};
```

**语义约定**：
- 结果必须带 `confidence`；**提供方类型决定其可信度**：
  - `decision-model`：模型原生校准置信度（Jev RLCD [langchain]），可直接用于阈值门控；
  - `llm`：无原生校准，适配器须明确置信度来源——默认让模型自报并标注 `calibrated:false`，**高利害门控不得仅凭 LLM 自报置信度放行**（可降级要求升级人，或配快层复核）。`DecisionTrace` 记录 `backend/model`，使置信度来源可审计。
- `maxWaitMs` 超时 → 实现方抛 `timeout` 错误，调用方按 §7 降级。
- 调用方约定：任何错误/超时都走**降级路径**（默认=不采纳该结果，按未配置处理），绝不让外部模型成为派发/聚合的硬依赖。

## 5. 实现家族 A：专用决策模型适配器（`src/decision/decision-model.ts`，首个实现 Jev）

- Jev 请求形态：`{ model, state, questions: { <name>: { type: 'noul'|'choice'|'score', instructions, options?/levels? } } }`，单次返回全部问题的类型化答案 [langchain][progressive]。适配器把三个端口方法各自映射为单问题调用（或未来合并为一次多问题批调，见 §10 优化）。
- 鉴权/配置：`ZEUS_DECISION_API_KEY` + `ZEUS_DECISION_MODEL=jev-latest`（env 装配，与 `serve.ts` 同风格）；未配置 → 端口为 `null`，内核零变化。
- 成本记录：按官方口径输入 $0.042/M token、输出免费 [36kr-2]；适配器按 `inputTokens` 估算并写入 `cost`（±20% 精度即可，仅用于审计与 S9 预算闸门，不计费）。
- 错误折叠：网络失败→`unavailable`；401/403→`auth`；4xx/5xx→`unavailable`；超 `maxWaitMs`→`timeout`。**不允许把外部服务的原始错误细节透传给调用方**（避免把外部服务信息混入内核日志/审计）。
- 可替换性：同属 `decision-model` 的后端（本地/开源决策模型，如 APUS 复现 [央广网]）实现同一端口，数据不出域。

## 6. 实现家族 B：传统 LLM 适配器（`src/decision/llm.ts`，慢层）

把任意传统 LLM 包进同一端口：

- **映射**：`noul`/`choice`/`score` 各翻译为一组 prompt 模板 + 结构化输出约束（JSON schema / function calling / 约束解码），由 LLM 产出后**本地校验、解析**成端口结果；解析失败/格式非法 → `invalid` 错误走降级。
- **置信度**：请求 LLM 在结构化输出中自报置信度，适配器标记 `calibrated:false`（见 §4 语义约定）；不假设 LLM 自报值可信。
- **鉴权/配置**：`ZEUS_LLM_BASE_URL` / `ZEUS_LLM_API_KEY` / `ZEUS_LLM_MODEL`（env 装配）；可同时装配快层与慢层两个后端，由调用方/策略按场景选择。
- **成本**：按模型公开 token 单价估算并写入 `cost`；输出 token 计费（与决策模型不同），LLM 适配器成本记录必须含输出 token。
- **适用提示**：慢层用于低频、高利害、需论证的场景（S2 LLM-as-judge）；高频路径不要默认走 LLM（成本/延迟与快层差数量级，见 §1 表）。

## 7. 选择与降级（装配层职责，非内核）

- 内核不感知后端具体是谁——调用方（编排器/监督台接线）从装配层拿 `DecisionBackend`（可为 null）。
- **多后端并存**：装配层可注册多个后端（如 `{fast: Jev, slow: LLM}`），按策略 `resolveBackend({realm, skill, risk, needExplanation})` 选择；策略本体随 S14 切片，本设计只给选择维度。
- **统一降级**：任一后端错误/超时 → 不采纳该结果、按未配置处理；配置了慢层且时间允许时，可"快层失败 → 慢层兜底"（由装配策略决定，默认不自动兜底以免隐藏故障）。
- 未配置任何后端时，全系统行为与 v0.1 之前完全一致。

## 8. 数据主权与安全（设计哲学硬线，模型无关）

1. **state 最小化**：适配器只允许传 `stateKeys` 白名单内的字段；默认白名单为空 → 任何调用都需显式声明字段。Realm 内容、私密上下文**默认拒绝出域**。
2. **enterprise 域默认不送**：`realm:'enterprise'` 的决策请求默认拒绝送外部模型（除非装配层显式开启 `allowEnterpriseExfiltration: true` 并逐 skill 声明——默认关）。LLM 与决策模型同样受限。
3. **脱敏钩子**：装配层可注入 `redact(state)`，在送模型前清洗（人名/ID/token 替换）。
4. **审计**：每次调用写 `DecisionTrace`（含 `backend/model`、`stateKeys` 而非原文），沿 runId 可回放，满足 E1.6。
5. **可选本地后端**：端口允许任何实现——本地/自托管模型（决策模型或 LLM）经同一端口接入，数据不出域；这是"用户是底座、产品是插件"的体现（外部模型是插件，不是底座）。

## 9. 验收（映射地图/PRD）

1. 未配置后端时：全量现有测试行为不变（124 项绿，聚合/冲突零变化）；
2. 规则能解决的不问模型：`majority` 有结论时不产生任何决策调用（可测：注入 spy 端口，断言零调用）；
3. 规则无解 + 后端高置信 → 采纳并带 `backend/model/confidence` 标注；低置信/失败/超时 → 仍 `needs-driver`；
4. 后端抛错/超时 → 调用方降级成功、审计留 `error` 痕、不阻塞不伪造；
5. **模型无关**：同一组测试用 spy 同时验证 `decision-model` 与 `llm` 两种 kind 的实现（置信度语义差异按 §4 约定分别断言——LLM 自报置信度不得单独放行高利害门控）；
6. enterprise 域默认拒绝出域；`stateKeys` 白名单外的字段不到达实现方；
7. guardrail 默认关闭，逐 skill 开启；命中 → 升级人而非静默拦截；
8. 每次调用有 `DecisionTrace`，沿 runId 可回放，含 `backend/model`。

## 10. 明确不做（本批边界）

- LLM 深度 Critic / 对抗辩论 / 陪审团（S2 慢层完整形态，需独立切片）；
- 多后端合并批调、缓存层、自动"快层失败→慢层兜底"（随 S14 切片）；
- 决策结果写回封臣/重派（E6.3）；
- 自托管后端的部署方案（端口保留，不写部署手册）；
- 路由策略本身（S14 只给 `score` 语义与选择维度，不给调度算法）。

## 11. 演进日志

| 版本 | 日期 | 变更 |
|---|---|---|
| v0.1 | 2026-09-22 | 初稿：DecisionBackend 端口（noul/choice/score）、Jev 首个实现、四个融合接线位、数据主权硬线、七条验收 |
| v0.2 | 2026-09-22 | **与模型解耦**：决策层改为模型无关抽象端口；新增 `DecisionBackendKind`（decision-model / llm）与 `model` 审计字段；新增实现家族 B——传统 LLM 适配器（prompt + 结构化输出，慢层，置信度校准约定）；新增 §7 选择与降级（多后端并存、resolveBackend 维度）；验收增模型无关测试项（第 5 条） |

## 附：关键事实来源

- [36kr-1] Jev 与 TypeSafe：https://36kr.com/p/3988164509711361 、https://36kr.com/p/3992394169613316
- [36kr-2] 定价与性能口径：https://36kr.com/p/3988164509711361 （$0.042/M input、输出免费、70–500ms、193.6×/444.6×）
- [langchain] Jev 机制与接入：https://www.langchain.com/blog/building-a-harness-with-jev
- [progressive] 三种原语：https://www.progressiverobot.com/2026/09/16/jev-model-typesafe-programmatic-logic/
- [央广网] APUS 开源复现：http://tech.cnr.cn/techph/20260920/t20260920_527819594.shtml
