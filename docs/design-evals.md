# 设计稿：Evals 与质量回归（tech map S7）

- 状态：**现行 v0.8（2026-10-31）**：**Tier0 M4 核心批（W4-1/W4-2/W4-3，见 §6）已落码——LLM-as-judge 打分器（hub alias、温度 0、fail-soft observe）、runs JSONL 持久化 + `GET /api/v1/eval-runs` 查询面、`budget.maxCostTokens` 接 per-call 账本；eval 集 31 例/56 checks 与钉住基线不动，judge 只对标注 `judge` 期望的 case 生效（现 eval 集零标注，CI 行为不变）**；其下为 v0.7 基线：V1 评分器、V2 runner + eval 集、V3 CI 门禁（block 退化卡 CI）+ **PR 评论指标 diff（Active work 221 落地，V3 至此全部完成）**已落码；guardrails 族对抗样本已补齐（eval 集 17 例 / 35 checks，六族全覆盖）；**eval 集随 S9/S10/S11 的对抗样本已扩充（Active work 208：runner 支持 case 级 costLimit 注入与执行 agent `fail` 标志（脚本化终态 failed）；新增 escalation / selection / budget 四例，eval 集 17 例/35 checks → 21 例/44 checks，基线重钉）**；**S12/S13/S15/S16 四族对抗样本已补齐（Active work 211：scorer FAMILIES 6 → 10 族——planning/recovery/streaming/isolation 四族 check 分支，eval-run 支持 planner 卡/结构化草稿/SSE 流式帧/progressHub 事件收集；新增 planning 3/recovery 3/streaming 2/isolation 2 共 10 例，evals-score 22 → 30 例，eval 集 21 例/44 checks → 31 例/56 checks 十族全覆盖，基线 1668/152 → 1676/152、--baseline 无回归）**；**V3 的 PR 评论指标 diff 已落地（Active work 221，见下）**；V4 真机录制待后续分期。
- 演进：v0.8（2026-10-31）Tier0 M4 核心批（W4-1/W4-2/W4-3，FR5-1/2/3）——见 §6（新增 `src/evals/judge.ts`、`src/evals/runs-store.ts`，评分器 trace 增 `judgeVerdicts`/`traces` 两个预收集输入，FAMILIES 10 → 11 族（judge），runner 增 `--runs-file/--suite/--revision` 与 case 级 `decisionBackend` 夹具，HTTP 增 `GET /api/v1/eval-runs`（serve 侧 `ZEUS_EVAL_RUNS_FILE` 只读挂载），env 增 `ZEUS_EVAL_JUDGE_ENABLED/_ALIAS/_TIMEOUT_MS`；基线 2460/211 → 2496/214，eval 集与 `evals/baseline.json` 零动、--baseline exit 0 实测）；v0.7（2026-10-12）V3 PR 评论指标 diff（Active work 221）——`scripts/eval-run.mjs` 新增 `--comment-out <path>`：把本次 run 的 Cases/Checks 汇总、分族 markdown 表与相对 `evals/baseline.json` 的指标 diff（`[block]/[warn] family.metric prev -> cur`）渲染成评论体，首行带固定幂等标记 `<!-- zeus-eval-gate -->`；评论体在退出码判定**之前**写出，block 退化 exit 1 时仍留 body；新增零依赖发布器 `scripts/ci-pr-comment.mjs`（Node 22 全局 fetch）：从 `GITHUB_EVENT_PATH` 读 PR 编号，非 pull_request 事件 / 无 `GITHUB_TOKEN`（fork PR 只读令牌）/ API 非 2xx 一律 warn + exit 0（评论是信息性，不翻转门禁结论），按标记 GET 既有评论 → 有则 PATCH、无则 POST（每个 PR 一条、原地更新）；`ci.yml` eval-gate job 的 eval 步带 `--comment-out`，新增发布步 `if: always() && github.event_name == 'pull_request'`（always 保证 block 退化时评论仍发出，job 结论仍由 eval 步变红）；测试 `eval-runner` 4 → 6 例（绿跑评论体含标记/判定行/分族表/No metric movement；block 退化 exit 1 仍写出评论体含 BLOCK REGRESSION 与 `` `decision.blocked` ``），新建 `ci-pr-comment` 4 例（loopback 模拟 GitHub API：无标记评论 POST、有标记评论 PATCH 精确路径、push 事件零调用、空令牌零调用）；脚本 17 → 18 个，基线 1752/155 → 1758/156；v0.6（2026-10-10）S12/S13/S15/S16 族对抗样本（Active work 211）——scorer 四族 check 分支：planning 读 `plan-*` 审计行（选定时撞 conflict/unplannable 即失败、planner 名查 plan-selected detail）、recovery 读 `recovery-*`（expected/forbidden 双向）、streaming 滤 branch-delta/intent-partial（previewNotInDecision 把 decision 结论与 stance/rationale 拼串查泄漏）、isolation 对比 `trace.isolation {level,valid,reasons}`；eval-run 分派四条新路径（planFlow.run requireConfirmation / 动态 import executeRecovery / classifyIsolation+validateIsolation / 默认 fanOut + progressHub.subscribe 事件收集）；新增 10 例对抗样本（planning 单草稿 selected+planner 名、双草稿平局 conflict、无草稿 malformed-unplannable；recovery clean auto-resumes 禁 awaiting/settled、非幂等 awaits 禁 auto、circuitOpen settles-failed 禁 auto；streaming deltaCountAtLeast+previewNotInDecision、partialSeen；isolation tier-1 stdio 网络直连无容器 → L-container invalid、stdio 网络关+资源声明 → L-process-restricted valid）；evals-score 22 → 30 例（含 preview 泄漏进 rationale 失败例与 isolation forbidden reason 失败例）；基线重钉 56 checks、--baseline 无回归；v0.5（2026-10-10）对抗样本扩充（Active work 208）——RunnerCase 增可选 `costLimit`（bootKernel 注入，驱动 S9 成本闸门样本）与执行 agent `fail` 标志（task 终态 failed，驱动 S10/S11 恢复链对抗样本）；新增 4 例：escalation/branch-failed-fails-intent（失败无 stance 可仲裁，升级行不出；tool-failed 审计是机器治理事实）、selection/pinned-target-failure-no-switch（显式钉选失败不重指向）、budget/window-cost-exceeded-refused（S9 漏拒防线）、budget/cost-gate-off-passes（S9 误报防线）；首版全红逼出 S10 分支失败终态缺陷（runBranch 成功路径把 failed 终态返回 ok:true → 静默 completed，修复见 Active work 207）；基线重钉 44 checks；v0.4（2026-10-10）guardrails 族对抗样本落地（Active work 206）——runner 支持 case 级个人域记忆种子（`memory` claim 夹具，boot 后 append + consolidateRealm）；新增 guardrails 族 3 例（external-url / instruction-phrase 记忆装配标注，signals 断言；无召回内容 pass），eval 集 14 例/28 checks → 17 例/35 checks；评分器 guardrails 期望增 `signals` 断言且只匹配审计 detail 的 `signals …` 段（修复 intent-id 由 case id 派生导致的全 detail includes 假绿，回归测试入库）；v0.3（2026-10-10）V3 CI 门禁核心落地——`--baseline` blocked 退化 exit 1（warn 不拦）+ `--baseline-file` 注入 + ci.yml eval-gate job + tests/eval-runner.test.ts 4 例；v0.2（2026-10-10）V2 落地——`scripts/eval-run.mjs`（复用 bootKernel + 脚本化执行 Agent，不新造第二套 harness）+ `evals/cases/` 首批 14 条六族 eval 集 + JSON 报告 + 基线钉 `evals/baseline.json`（--write-baseline / --baseline），退出码 0/1/2，`npm run evals`；v0.1（2026-10-09）首版——现状盘点（单元/契约/冒烟/验收已密，缺"决策质量"维度的回归集）+ 质量指标族 + EvalCase/`scoreEvalRun` 草案 + 分期。
- 关联：tech map S7（离线 eval 集、改 prompt 防漂移、线上 A/B；呼应 verify before asserting）；design-supervision.md §8（裁决/Critic）；design-hil.md（介入分级，误升级/漏升级是核心 eval 指标）；design-tool-discovery.md（选靶/恢复链正确性）；design-guardrails.md（S8 护栏命中率）；design-cost-governance.md（S9 成本上限）；design-agent-testing.md（S17，录制重放/混沌为 eval 供给夹具）；`scripts/smoke-core.mjs`、`scripts/acceptance-*.mjs`、`scripts/verify-*.mjs`（既有 harness）；`src/core/orchestrator/judge.ts`（对抗式复核，"无证据不断言"的执行点）。
- 本文是质量回归体系的单一事实源；handoff 与 PRD 只索引。

## 1. 背景与现状

| 设施 | 规模/形状 | 覆盖什么 | 不覆盖什么 |
| --- | --- | --- | --- |
| 单元/契约测试 | 1430 测试 / 127 文件（2026-10-09 基线） | 纯函数正确性、协议契约、装配、审计存在性 | 不评"决策质量"——输入是构造的，断言是确定的，没有质量分布 |
| smoke-core | 47 步真实编译进程 + 临时目录 + 脚本化 Agent | 端到端关键路径（扇出、Realm、记忆、恢复、名册……） | 单条黄金路径，不做性质的批量统计 |
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
  guardrails?: { expectedHandling?: ContentHandling['action']; signals?: ContentSignal[] };
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

- **V1（纯函数评分器）**：types + scoreEvalRun/summarize/diff + 测试（每指标族正反例、severity 权重、基线退化判定、无证据断言必 block）；不跑世界、不接 CI。✅ 已落地（2026-10-10，Active work 181）。
- **V2（runner + 首批 eval 集）**：eval-run.mjs 复用 smoke 夹具；从现有 harness 提炼 10–20 条高价值 case；本地一键跑 + JSON 报告；钉第一版基线。✅ 已落地（2026-10-10，Active work 189）：`scripts/eval-run.mjs` + `evals/cases/index.mjs` 首批 14 条（decision 4 / escalation 2 / selection 3 / data-policy 2 / evidence 2 / budget 1，六族 28 checks 全绿）+ `evals/baseline.json` 基线 + `evals/reports/` JSON 报告；oversight 升级经桥转 `interrupt-level-N` 审计行喂评分器（S10 介入级别是治理事实）；退出码 0 全过 / 1 有失败 / 2 缺构建。
- **V3（CI 门禁 + 漂移报告）**：block 指标退化卡 CI；PR 评论产出指标 diff；eval 集随新设计稿（S8/S9/S10/S11）补对抗样本。✅ **门禁核心已落地**（2026-10-10，Active work 205）：① `scripts/eval-run.mjs` `--baseline` 模式下任一 family 的 blocked 计数相对基线增长即 **exit 1**（warn 级 passed 收缩仍只打印不拦截），新增 `--baseline-file <path>` 供 CI 矩阵与测试注入任意基线（缺文件 exit 2）；② `.github/workflows/ci.yml` 新增独立 **eval-gate** job（Node 22、build 后跑 `node scripts/eval-run.mjs --baseline`，loopback-only 无外部网络）；③ `tests/eval-runner.test.ts` 4 例钉死脚本层退出码接线（同基线 exit 0 / block 退化 exit 1 / 仅 warn 不拦 exit 0 / 缺基线 exit 2，含摘掉 exit 1 的缺陷植入对照），block 退化的正向语义（1 > 0）由 V1 `evals-score.test.ts` 覆盖。✅ **PR 评论指标 diff 已落地**（2026-10-12，Active work 221，v0.7）：`eval-run.mjs --comment-out <path>` 渲染评论体（Cases/Checks 汇总 + 分族表 + 基线 diff，固定标记 `<!-- zeus-eval-gate -->`，退出码判定前写出），零依赖发布器 `scripts/ci-pr-comment.mjs` 按标记幂等 upsert（GET 找既有评论 → PATCH/POST；非 PR 事件、无令牌、API 失败均 warn + exit 0，不翻转门禁），`ci.yml` eval-gate job 加 `if: always()` 发布步；eval 集随 S9/S10/S11 的对抗样本已在 Active work 208 补齐。✅ **guardrails 族对抗样本已落地**（2026-10-10，Active work 206，v0.4）：runner 的 RunnerCase 增可选 `memory` 个人域 claim 种子（boot 后 append 到 memoryStore 并 consolidateRealm；request 须带 realmId 且 message 词法命中才触发召回）；`evals/cases/index.mjs` 新增 3 例——`guardrails/external-url-memory-annotated`（召回记忆含外部 URL → guardrail-annotated，signals 含 external-url，且 plan 模式不产生 interrupt 升级行）、`guardrails/injection-phrase-memory-annotated`（召回记忆含指令注入短语 → annotate，signals 含 instruction-phrase）、`guardrails/no-signal-passes`（不 seed 记忆的普通扇出 → 零 guardrail-* 行；注意 plan 模式对每条召回事实按构造做来源标注，"干净记忆"不可能零行，pass 的真实路径是无内容可扫）；guardrails 期望增 `signals?: ContentSignal[]`，评分器只在审计 detail 的 `signals …` 段内匹配（审计桥格式 `annotated (data-boundary:…, signals a,b)`）——首版全 detail includes 匹配被变异测试抓出假绿：detail 前缀含由 case id 派生的 intent id（`eval-guardrails-external-url-…` 自带 "external-url"），无信号的来源标注也会误判；eval 集现 17 例 / 35 checks（decision 17 / escalation 8 / selection 3 / evidence 3 / guardrails 3 / budget 1，checks 为跨族计数），基线已重钉。
- **V4（真机录制供给 / 线上 A/B）**：S17 录制重放成熟后，真机流量脱敏（S8 PII）进 eval 集；线上 A/B 随真机部署阶段另立。

**验收（V1 实施时）**：每指标族至少一正一反例；`forbidBareAssertions` 对无证据裁决必判失败；同一 trace 多次评分字节一致（确定性）；全量与冒烟不回归（V1 零运行时行为变化）。

## 6. Tier0 M4 扩展（W4-1 / W4-2 / W4-3，2026-10-31 落码）

> 依据：bayjf《Tier0-产品族扩展PRD》F5（FR5-1/2/3）与《Tier0-产品族扩展落码任务列表》M4 节；
> D-2 裁定（zeus eval 体系为主战场）。W4-4（agent-dev 门）与 W4-5（第二基准）不在本批。

### 6.1 W4-1 · LLM-as-judge 打分器（FR5-1）

- **输入面**：`EvalExpectation` 增 `judge?: { rubric: string; minScore?: number }`——开放式回答质量类 case 的标注位；只有声明了该期望的 case 会触达 judge（确定性性质检查仍是主判据，LLM 永远不是唯一判据，§2 边界不变）。`minScore` 缺省 0.7。
- **模型来源**：hub 文本 alias 经既有 model-kit 解析——复用 `activeHubModelResolve`（与 memory embedder 同一进程级解析口，一进程一 hub 接线不变）；alias 取 `ZEUS_EVAL_JUDGE_ALIAS`（默认 `choice`），kill switch `ZEUS_EVAL_JUDGE_ENABLED`，单次调用超时 `ZEUS_EVAL_JUDGE_TIMEOUT_MS`（默认 30s）。温度 0；hub adapter 声明了合法温度的模型（如 Ark 拒 0）按 adapter 覆盖——与决策后端同一规则。结构化输出：`response_format: json_object` + 系统提示 JSON-only 契约，解析 `{score 0..1, reason}`，容忍 ```json 围栏与前后散文。
- **fail-soft 语义（本设计的硬规则）**：未启用、alias 未解析、HTTP 非 2xx、超时、输出不可解析——一律折叠为显式 fail-soft 判定 `{ok: false, reason}`，评分器记为 passed=true + `judge-unavailable: …` detail + **observe severity**：judge 不可用永远不能阻断 gate；只有 judge 真实返回且分数低于 minScore 才按 case 声明的 severity 判败（block 才卡 CI）。
- **确定性保持**：judge 调用发生在评分**之前**（runner 按 case 的 judge 期望逐条调用、按声明序收集 verdict 数组注入 trace）；`scoreEvalRun` 只消费预收集数据——同一 trace 多次评分仍字节一致。
- **聚合**：scorer FAMILIES 10 → 11 族（`judge`）；`summarizeEvalRun`/`diffAgainstBaseline` 照常聚合，钉住基线无 `judge` 键时 diff 自动跳过（零动基线）。
- **测试**：`tests/evals-judge.test.ts` 19 例（解析正反例、传输契约断言温度 0/JSON-only/鉴权头、五类 fail-soft、env 接线、评分器集成含 fail-soft 降级与声明序消费）——judge 模型调用一律 fake fetch，零真实网络。

### 6.2 W4-2 · runs 持久化与查询（FR5-2）

- **存储**：`src/evals/runs-store.ts` 的 `JsonlEvalRunsStore`，形状对齐 `JsonlTraceExporter`：append-only JSONL、0700 目录 / 0600 文件、按 `runId` 键控追加（重试不会双写）、插入序内存索引 `readBack` 重启读回。
- **记录形状 = legacy 超集**：`runId / suite / model / judgeModel? / revision?` 增列在旁，legacy `evals/reports/` JSON 的 `ranAt / cases / report` 三字段原样保留在顶层——现有消费者不破。
- **产出方**：离线 runner `--runs-file <path>`（opt-in 追加一条记录；`--suite` 默认 core、`--revision` 供 CI 传 git sha）。legacy 报告仍是默认输出，runs 存储是第二份产物，不是替代。
- **查询面**：`GET /api/v1/eval-runs`（bearer，与其他观测面同门禁）——suite/model/run_id/时间窗（from/to 作用于 ranAt）/limit（默认 50、封顶 200）过滤，纯投影。serve 进程经 `ZEUS_EVAL_RUNS_FILE` 挂只读 store；未设 = 端点不挂载。**写者只有离线 runner，serve 只读**。API-only 登记（operator-surface READ_API_ONLY）：PRD F5 MVP 边界明确不做评测 UI。

### 6.3 W4-3 · 成本/质量指标补齐（FR5-3）

- **账本来源**：`createScriptedDecisionBackend` 增 `usage` / `onTrace`——每次调用产出一条 `DecisionTrace`（TracePort v1 §2 语义：runId 取请求、usage 在、脚本化失败记折叠 error、无 pricing 无 cost 块），loopback 确定性、零网络。
- **runner 夹具**：RunnerCase 增 `decisionBackend?: { model?, usage?, failWith? }`——声明了夹具的 case 仲裁/judge 路径在 loopback 内真实激活，DecisionTrace 集中收集注入 `trace.traces`。注意：启用后端会改变仲裁行为，夹具 case 的期望须按此书写。
- **评分器消费**：`budget.maxCostTokens` 有账本即实评——token 总量 = Σ(usage 优先、cost 审计估算兜底) + reasoning tokens；cap 为闭区间（≤ 过、> 败），失败按 case severity。**空账本（`[]`）是"零调用零 token"的事实，可评**；无账本路径（`traces` 缺省——loopback-only 默认，含全部 31 例钉住 case）保持显式 not-assessable detail，语义不猜测。
- **现状边界**：现 eval 集无 case 声明 `decisionBackend` 夹具（31 例基线零动是本批硬约束）；夹具的消费样例由 W4-5（第二条基准）落 case 时给出。

### 6.4 门禁与兼容性影响（本批实测）

- eval 集 31 例 / 56 checks 与 `evals/baseline.json` **零改动**；`node scripts/eval-run.mjs --baseline` exit 0。新能力全部是 opt-in（env 开关 / CLI 旗标 / case 级夹具），未触碰时 CI 行为与 v0.7 逐字节一致。
- 新增 HTTP 读路由 `GET /api/v1/eval-runs`（路由 census 129 → 130）；`.env.example` 增 4 个变量（config-surface 与 doc-consistency 双闸同步通过）；基线账面 2460/211 → 2496/214。
