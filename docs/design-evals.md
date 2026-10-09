# 设计稿：Evals 与质量回归（tech map S7）

- 状态：**现行 v0.1（2026-10-09）**：设计探索先行，未落码。本文定义离线 eval 用例形状与纯函数评分器，runner 复用既有 smoke/acceptance 夹具，不新造第二套测试基建。
- 演进：v0.1（2026-10-09）首版——现状盘点（单元/契约/冒烟/验收已密，缺"决策质量"维度的回归集）+ 质量指标族 + EvalCase/`scoreEvalRun` 草案 + 分期。
- 关联：tech map S7（离线 eval 集、改 prompt 防漂移、线上 A/B；呼应 verify before asserting）；design-supervision.md §8（裁决/Critic）；design-hil.md（介入分级，误升级/漏升级是核心 eval 指标）；design-tool-discovery.md（选靶/恢复链正确性）；design-guardrails.md（S8 护栏命中率）；design-cost-governance.md（S9 成本上限）；design-agent-testing.md（S17，录制重放/混沌为 eval 供给夹具）；`scripts/smoke-core.mjs`、`scripts/acceptance-*.mjs`、`scripts/verify-*.mjs`（既有 harness）；`src/orchestrator/judge.ts`（对抗式复核，"无证据不断言"的执行点）。
- 本文是质量回归体系的单一事实源；handoff 与 PRD 只索引。

## 1. 背景与现状

| 设施 | 规模/形状 | 覆盖什么 | 不覆盖什么 |
| --- | --- | --- | --- |
| 单元/契约测试 | 1430 测试 / 127 文件（2026-10-09 基线） | 纯函数正确性、协议契约、装配、审计存在性 | 不评"决策质量"——输入是构造的，断言是确定的，没有质量分布 |
| smoke-core | 45 步真实编译进程 + 临时目录 + 脚本化 Agent | 端到端关键路径（扇出、Realm、记忆、恢复、名册……） | 单条黄金路径，不做性质的批量统计 |
| acceptance-* | loom-interop / real-fanout / standard-a2a 三个 harness | 协议互操作、真机扇出 | 手动/半自动，非每次回归跑 |
| verify-* | decision-backend / delegation / reliability 等脚本 | 专项能力人工验证 | 无通过/失败的机器评分聚合 |
| decision-replay | 决策输入输出可回放 | 单次决策追溯 | 不做跨用例对比、不做版本间漂移度量 |

**缺口**：现有测试回答"代码是否按设计工作"，没有一套设施回答"**决策质量在改动后是否漂移**"。具体：

1. 改聚合权重、改裁决/Critic 规则、改介入分级阈值、改选靶评分后，只有确定性单测兜底；"同样一批疑难意图，新旧版本的结论/升级/换将分布差了多少"无度量。
2. 产品核心原则"**verify before asserting**（无证据不断言）"没有回归抓手——judge/聚合在证据不足时是否克制，靠零散用例，没有成集的对抗样本。
3. 没有误升级率/漏升级率（S10）、误换将/漏换将（S11）、护栏漏报/误报（S8）这类**双侧错误率**指标。
4. 线上 A/B 与离线 eval 的关系未定义。

## 2. 目标与边界

**目标**：建立**离线、确定性、可重复**的 eval 集——每条用例是固定世界（Realm 夹具 + intent + 脚本化 Agent 行为）+ 对可观测产物（最终裁决、冲突、升级、换将、证据链、成本）的**性质断言与评分**；一次代码改动跑全集，产出与基线版本的指标对比，质量漂移可见、可卡门禁。

**边界（明确不做）**：

- V1 不做线上 A/B / 影子流量：需要真实用户与多实例部署，属真机阶段；离线集先行。
- 不用 LLM 当 eval 裁判作为唯一判据：评分以**确定性性质**为主（结构、计数、阈值、证据链完备性）；LLM-as-judge 只用于开放式输出质量且必须带校准（呼应 S2 已有的模型无关裁决后端，不新拉外部依赖）。
- eval 不追求"像人一样答题"的主观分：Zeus 是协同决策内核，eval 评的是**决策正确性、克制性、可追溯性、成本**，不是文采。
- 不新造 runner 基建：eval 世界复用 smoke/acceptance 的脚本化 Agent 与临时目录夹具（S17 录制重放成熟后直接喂真实录制）。

## 3. Eval 用例与指标族

### 3.1 用例形状

```
EvalCase
├── world：Realm 夹具（文件/命中/签名）、注册名册与技能声明、信任档配置
├── agents：每个 vassal 的脚本化行为（结论、证据、延迟、失败模式、SSE 帧序列）
│           —— 与 smoke vassalFetch / S17 录制格式同构
├── input：intent（skill/realm/params/聚合策略）
├── expect：性质集合（不是单一答案字符串）
│   ├── decision：最终裁决应满足的断言（如 unanimous 下必须 failed/冲突）
│   ├── escalation：应否升级、级别（L0/L1/L2）
│   ├── selection：应选/不应选哪些 vassal、是否允许换将
│   ├── evidence：结论必须引用的证据、禁止出现的无证据断言
│   ├── guardrails：应命中的护栏处置（S8）
│   └── budget：成本/步数上限（S9/S4）
└── severity：该性质失败的门禁权重（block / warn / observe）
```

### 3.2 核心指标（双侧错误率为主）

| 指标族 | 指标 | 来源设计 |
| --- | --- | --- |
| 裁决正确性 | 聚合结论正确率；冲突**检出率/误报率**；无证据断言率（应恒为 0，block） | aggregate/conflict/judge |
| 介入质量 | **误升级率**（不该打扰却 L1/L2）、**漏升级率**（该打断却自动跑） | design-hil |
| 选靶质量 | 误换将率、饱和漏换率、恢复链次序符合率 | design-tool-discovery / backpressure |
| 护栏 | 注入样本**漏报率**、正常样本**误报率**、跨域违规率（应恒为 0） | design-guardrails |
| 收敛与成本 | 步数/分支数分布、熔断触发正确性、成本超限率 | S4 / S9 |
| 可追溯 | 审计完整率（每个关键决策有对应审计行）、replay 可渲染率 | observability |

每次 eval run 产出指标向量；与**钉住的基线版本**对比，block 级指标退化即卡合入（CI 门禁，与现有 lint/冒烟并列）。

## 4. 落地接口草案（设计级，未落码）

```ts
// src/evals/types.ts（设计级，零运行时依赖）
export type EvalExpectation = {
  decision?: (outcome: FanOutResult) => boolean;
  escalation?: { expected: boolean; level?: 0 | 1 | 2 };
  selection?: { mustInclude?: string[]; mustExclude?: string[]; diversionAllowed?: boolean };
  evidence?: { mustCite?: string[]; forbidBareAssertions?: boolean };
  guardrails?: { expectedHandling?: ContentHandling['action'] };
  budget?: { maxBranches?: number; maxCostTokens?: number };
  severity: 'block' | 'warn' | 'observe';
};
export type EvalCase = { id: string; world: unknown; agents: unknown; input: FanOutRequest; expect: EvalExpectation[] };

// src/evals/score.ts（纯函数：对一次实际运行的产物打分，不负责运行世界）
export type EvalResult = {
  caseId: string;
  checks: Array<{ name: string; passed: boolean; severity: EvalExpectation['severity']; detail?: string }>;
};
export function scoreEvalRun(c: EvalCase, trace: { outcome: FanOutResult; audit: AuditEntry[]; events: ProgressEvent[] }): EvalResult;

// 纯函数：聚合多 case 结果为指标向量 + 与基线对比（退化检测）
export function summarizeEvalRun(results: readonly EvalResult[]): EvalMetricsReport;
export function diffAgainstBaseline(current: EvalMetricsReport, baseline: EvalMetricsReport): EvalRegression[];
```

- runner（V2）：`scripts/eval-run.mjs` 读 eval case 集，复用 smoke 的进程拉起/脚本化 Agent，把 trace 喂给 score；产物为机器可读 JSON + 人读摘要。
- eval 集目录（V2）：`evals/cases/*.json|ts`，首批从已有 smoke/acceptance 最有判定价值的步骤**提炼**（冲突、升级、换将、dataPolicy 拒绝、无证据裁决），不重复造世界。
- "无证据不断言"检查：扫描最终裁决文本/结构是否带 evidence 引用（judge.ts 已有对抗复核位），缺引用即 block——这是 verify-before-asserting 的机器抓手。

## 5. 分期

- **V1（纯函数评分器）**：types + scoreEvalRun/summarize/diff + 测试（每指标族正反例、severity 权重、基线退化判定、无证据断言必 block）；不跑世界、不接 CI。
- **V2（runner + 首批 eval 集）**：eval-run.mjs 复用 smoke 夹具；从现有 harness 提炼 10–20 条高价值 case；本地一键跑 + JSON 报告；钉第一版基线。
- **V3（CI 门禁 + 漂移报告）**：block 指标退化卡 CI；PR 评论产出指标 diff；eval 集随新设计稿（S8/S9/S10/S11）补对抗样本。
- **V4（真机录制供给 / 线上 A/B）**：S17 录制重放成熟后，真机流量脱敏（S8 PII）进 eval 集；线上 A/B 随真机部署阶段另立。

**验收（V1 实施时）**：每指标族至少一正一反例；`forbidBareAssertions` 对无证据裁决必判失败；同一 trace 多次评分字节一致（确定性）；全量与冒烟不回归（V1 零运行时行为变化）。
