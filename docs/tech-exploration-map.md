# Agent 技术探索地图（Tech Exploration Map）

> 状态：**现行（活文档 v0.5，2026-10-10）**。这是 Agent 方向技术议题的登记处与优先级视图。
> 用法：议题先在本文登记（含触发条件/状态）；成熟且相关者升级为 `docs/design-*.md` 或转入 [deferred-items.md](deferred-items.md)；实施进度只记 [handoff.md](../handoff.md)。
> 状态：🔜 A 组优先（已裁决）｜📝 待触发 / 登记中｜✅ 已有设计/已落地。

## 0. 核心定位

Zeus 是**高并发、多 Agent 协同决策平台**（见 [prd.md](prd.md) E1）。所有技术议题以"是否服务并发协同决策内核"为取舍准绳。

## A 组：紧贴内核，优先（2026-09-22 负责人裁决全部认同）

| 编号 | 议题 | 状态 | 关联设计 |
|---|---|---|---|
| S1 | **上下文工程 Context Engineering**：每 Agent 带哪些上下文、共享上下文裁剪、上下文预算分配、长任务压缩换入换出（与记忆一体两面） | ✅ **V1+V2+V3§5 已落地**（2026-10-09，[design-context-engineering.md](design-context-engineering.md) v0.5——V1 §10 `src/context/assemble.ts` 记忆装配；V2 §11 `assembleSkillInputs` 技能输入 + 共享裁剪；**V3§5 `src/context/budget.ts` per-branch 预算分配**（四源优先级、低优先级源截前缀、只截出站副本、context-budget-exceeded 带 source，DEFAULT_BRANCH_CONTEXT_LIMIT=64）；§6 长任务换入换出仍挂 #9 真实负载基准） | design-context-engineering.md |
| S2 | **裁决/Critic 机制**：聚合权重来源、独立 Judge、陪审团/对抗辩论、LLM-as-judge 校准 | ✅（`src/orchestrator/arbitration.ts` 后端仲裁 + `src/orchestrator/judge.ts` 对抗式复核 + `src/decision/` 模型无关决策后端；Active work 15/43，基线） | prd E1.3；design-supervision §8 |
| S3 | **DAG 依赖编排**：超越 fan-out 的有向无环调度、关键路径、部分失败 | ✅（`src/orchestrator/dag.ts` `dag-runner.ts`：拓扑分层/关键路径/上游失败跳过下游/产物下传；Active work 13 六切片） | design-supervision §4 |
| S4 | **终止与收敛**：防互相调用/辩论不收敛，步数/预算上限、熔断、确定性终止 | ✅（2026-10-08，design-supervision §7.1：意图级步数预算 + 连续失败熔断，默认开启、随快照恢复、审计两值，Active work 162） | prd E1.5 |
| S5 | **幂等与 exactly-once**：幂等键、重试副作用安全、去重 | ✅（intentId 幂等零出站重放 + cancel 回写；E1.5/F2，`src/orchestrator/orchestrator.ts` #intentId） | prd E1.5；design-supervision §5.2 |

## B 组：可靠性与安全（企业版硬门槛，随真机阶段触发）

| 编号 | 议题 | 要点 | 状态 |
|---|---|---|---|
| S6 | 可观测性：trace/metrics/log + LLM replay | 跨 Agent 调用链调试；审计已有，补分布式 trace | 📝→✅ 设计稿已出（2026-10-09，[design-observability.md](design-observability.md) v0.1——从既有审计/progress/runId 谱系装配 span 树的纯函数 `buildTraceTree`，trace 不出进程先落库内；V2 出站透传 traceparent + 只读端点；**V1 已落码（2026-10-10，Active work 180：`src/observability/trace.ts`，`tests/trace.test.ts` 12 例，零新增审计值）**） |
| S7 | Evals 与质量回归 | 离线 eval 集、改 prompt 防漂移、线上 A/B（呼应 verify before asserting） | 📝→✅ 设计稿已出（2026-10-09，[design-evals.md](design-evals.md) v0.1——EvalCase 固定世界 + 双侧错误率指标族（误/漏升级、漏/误报、无证据断言恒 block）+ 纯函数评分器 scoreEvalRun，runner 复用 smoke 夹具；**V1 已落码（2026-10-10，Active work 181：`src/evals/types.ts` + `src/evals/score.ts`，`tests/evals-score.test.ts` 19 例，maxCostTokens 标记 not-assessable-in-v1 不猜数）**） |
| S8 | Guardrails：注入/越权/PII | prompt injection 经数据跨 Agent 传播，多 Agent 放大攻击；越权工具调用 | ✅ **V1 已落地**（2026-10-09，Active work 174：[design-guardrails.md](design-guardrails.md) v0.2——`src/guardrails/content-risk.ts` `classifyContentRisk` 判定表（refuse > escalate > redact > annotate > pass：audit 凭据打码 / cross-domain PII 按 grant 脱敏或拒绝 / execute 外联凭据升级 L1 / 其余 annotate 带 provenance 边界）+ `scanContentSignals` 确定性扫描器（内置最小指令短语清单 + URL/凭据/PII 正则）+ 审计 3 值登记 + TUI token；23 例测试；V2 接装配与记忆待分期） |
| S9 | 成本治理 | 任务/租户 token 预算、执行中预算闸门、异常熔断；cost 字段已有 | 📝→✅ 设计稿已出（2026-10-09，[design-cost-governance.md](design-cost-governance.md) v0.1——可信/自报双层口径 + 与 S4 同构的 CostLedger 纯函数（admit/软阈值/速率熔断）+ 超限复用 cancel/降级/L1 升级；阈值标定挂 #9；**V1 已落码（2026-10-10，Active work 183：`src/orchestrator/cost-ledger.ts`，admit 闸门/软阈值/速率熔断/窗口 roll，`tests/cost-ledger.test.ts` 11 例，自报成本永不进闸门）+ 审计 4 值 cost-* 登记）** |
| S10 | Human-in-the-loop 时机 | 何时打断人、何时异步介入，不打断心流 | ✅ **V1+V2 已落地**（2026-10-09，Active work 167 + A2 批：[design-hil.md](design-hil.md) v0.2——`src/oversight/interrupt.ts` 纯函数 `classifyInterruption`：六信号（branch-failed/circuit-open/intent-conflict/task-input-missing/delegation-limit-hit/explicit-branch-failed）→ L0 不介入 / L1 异步介入 / L2 同步打断（仅「无替代 + 下游依赖」双条件）固定判定链 + `interruptionReason` 措辞 + 审计 3 值 interrupt-level-* + TUI token；零 IO 零接线；**V2 已落地（2026-10-09，design-hil v0.3）**：升级队列登记 interruptLevel 0/1/2、watch 两处 execute 拒绝路径传级、escalateLimit/boot 透传、TUI 级别徽标） |

## C 组：能力与运行时（中期）

| 编号 | 议题 | 要点 | 状态 |
|---|---|---|---|
| S11 | 工具/Skill 发现与组合 | 自动选工具、工具链拼装、工具失败恢复 | ✅ **V1+V2+V3 slice 1 已落地**（2026-10-09，Active work 168 + A3 批 + 173：[design-tool-discovery.md](design-tool-discovery.md) v0.4——`src/orchestrator/discovery.ts` 纯函数 `selectCandidates`（点名钉选 > 自动选靶饱和过滤 > tier-1 只读收窄 fail-closed > 能力面 execute/plan）+ `recoverChain`（重试→换将→降级→升级，高利害跳过重试、熔断跳过自动路径）+ 审计 5 值 tool-selected/tool-failed/chain-retried/chain-switched/chain-degraded + TUI token；**V2 已落地（2026-10-09，design-tool-discovery v0.3）**：fanOutNew 无条件构造统一候选面喂实时饱和数据 + onCandidatesSelected hook + tool-selected 审计首次实发（selectTargets 本体 2026-09-27 已接线）；**V3 slice 1 已落地（2026-10-09，design-tool-discovery v0.4）**：recoverChain 接失败分支运行时（onChainRecovered hook + fanOutNew 恢复循环 + boot `tool-failed` 实发 / `chain-*` 按裁决分流）；**V3 slice 2 已落地（2026-10-10，Active work 175）**：`planRecovery`（ChainPlan/DAG 步面可执行检索指令——retry 同面候选 / switch 首个异构候选 / degrade / escalate+reason，越界 stepIndex 抛 RangeError 不猜裁决），`tests/plan-recovery.test.ts` 新建 11 例） |
| S12 | 规划：单/多 planner、重规划 | 计划竞争、计划与执行交错、replan | 📝→✅ 设计稿已出（2026-10-09，[design-planning.md](design-planning.md) v0.1——规划即扇出（planner 是规划技能 Agent，计划是待校验数据）+ validatePlan/scorePlans/selectPlan/replanDelta 纯函数（冻结已完成节点、replan 计入步数预算防不收敛）；**V1 已落码（2026-10-10，Active work 176：`src/orchestrator/planning.ts` validatePlan/scorePlans/selectPlan/replanDelta，`tests/planning.test.ts` 15 例）+ 审计 5 值 plan-* 登记）** |
| S13 | 长流程持久化执行 | checkpoint、崩溃恢复、断点续跑（随 H2） | 📝→✅ 设计稿已出（2026-10-09，[design-long-running.md](design-long-running.md) v0.1——崩溃恢复四分类纯函数 `classifyRecoverable`（自动续跑/等人/判失败/判取消，execute 默认等人、零僵尸）+ 最小 checkpoint 集；**V1 已落码（2026-10-10，Active work 178：`src/orchestrator/recovery.ts` classifyRecoverable/computeCheckpoint，`tests/recovery.test.ts` 18 例全布尔面穷举）+ 审计 4 值 recovery-* 登记**；V2 启动恢复接线，V3 周期 checkpoint 触发条件同 retention） |
| S14 | 多模型异构调度 | 按子任务难度路由强/便宜/快/本地模型；**决策后端抽象层落此层（DecisionBackend：专用决策模型 Jev 与 LLM 均可接入，见 design-decision-backend.md）** | ✅ |
| S15 | 流式体验工程 | 部分结果先呈现、流式合并、思考态 UX | 📝→✅ 设计稿已出（2026-10-09，[design-streaming.md](design-streaming.md) v0.1——增量帧五级分类 + 归并不变量（来源标签/选择序/预览不进决策/全落定与 mergeBranches 等价）+ streamWindow 纯函数；**V1 已落码（2026-10-10，Active work 177：`src/orchestrator/stream-merge.ts` 不可变视图 + settledViewMatchesMerge，`tests/stream-merge.test.ts` 12 例，零新增审计值）**） |
| S16 | 沙箱与代码执行 | 容器/microVM 隔离、资源配额 | 📝→✅ 设计稿已出（2026-10-09，[design-sandbox.md](design-sandbox.md) v0.1——执行体四级隔离（内置/本地 stdio 子进程/容器/远程）+ IsolationManifest 启动前 fail-closed 校验纯函数，stdio 子进程最小权限面为首要缺口；**V1 已落码（2026-10-10，Active work 179：`src/mcp/isolation.ts` classifyIsolation/validateIsolation fail-closed，`tests/isolation.test.ts` 15 例）+ 审计 3 值 connector-* 登记**；V2 收窄 spawn，容器挂 V3 真机阶段） |
| S17 | Agent 测试策略 | 契约测试、录制重放、mock LLM、混沌测试 | 📝→✅ 设计稿已出（2026-10-09，[design-agent-testing.md](design-agent-testing.md) v0.1——Recording 录制格式（脱敏后做夹具）+ 七类故障确定性混沌注入器 `withChaos` + 协议兼容矩阵，供单测/冒烟/S7 eval 共用；**V1 已落码（2026-10-10，Active work 182：`src/testing/recording.ts` Recording/redactRecording/recordingToFetch + `withChaos` 七类故障，`tests/testing.test.ts` 10 例）**） |

## D. 待确认外部输入

- ~~**Jev 模型（2026-09-22 负责人提及）**~~ ✅ 已核实并落设计：Jev = TypeSafe AI 首个公开 "System One" 决策模型（2026-09-15，创始人 Diogo Almeida 为前 OpenAI 研究员）；不吃文本，输入 state + 类型化问题，输出 Choice/Score/Noul 带概率与置信度；输入 $0.042/M token、输出免费、延迟 70–500ms；已上 Cloudflare AI 目录。**设计落点：决策后端抽象层 DecisionBackend（design-decision-backend.md v0.2，模型无关）——Jev 作为专用决策模型家族的首个实现，传统 LLM 经适配器同端口接入（慢层）**；S14 落此层。

## E. 已覆盖（已有点名或设计，避免重复立项）

- 协议层：MCP / A2A / 执行 Agent 超集（design-vassal-protocol）
- 记忆：分层与整理协议（design-memory-consolidation）
- 控制关系：supervisor/subagent（design-supervision）
- 数据主权：Realm 目录底座、签名链、内外名册（design-realm / signing / roster）
- 并发内核：fan-out/聚合/冲突/可追溯（prd E1）

## 维护约定

- 新议题先在对应组登记并编号；每组按"离内核多近"排序。
- 议题升级为正式设计后，在本表标注关联文件，原文保留。
- 重大技术方向的取舍记入本表并同步 handoff。

## 演进日志

| 版本 | 日期 | 变更 |
|---|---|---|
| v0.1 | 2026-09-22 | 首版：A 组五条优先（已裁决）、B/C 组 12 条登记、Jev 模型待确认（S14 候选）、已覆盖清单 |
| v0.2 | 2026-09-22 | Jev 已核实并落设计（design-decision-backend.md v0.1，快决策层）；S14 状态 ✅ |
| v0.3 | 2026-09-22 | 决策后端抽象层升级为**模型无关**（design-decision-backend.md v0.2）：DecisionBackendKind=decision-model/llm，Jev 为专用决策模型家族首个实现，传统 LLM 经适配器同端口接入（慢层） |
| v0.4 | 2026-10-09 | B/C 组九篇设计稿一次出齐（均 v0.1，V1 纯函数切法，未落码）：S8 护栏 design-guardrails、S6 可观测性 design-observability、S9 成本治理 design-cost-governance、S13 长流程恢复 design-long-running、S7 evals design-evals、S12 规划 design-planning、S15 流式 design-streaming、S16 沙箱 design-sandbox、S17 Agent 测试 design-agent-testing；tech map 九行 📝→✅ 设计稿已出 |
| v0.5 | 2026-10-10 | 九项 V1 纯函数一次落码（Active work 175–183）：S11 V3 slice 2 planRecovery、S12 规划 planning、S15 流式 stream-merge、S16 沙箱 isolation、S13 恢复 recovery、S6 trace、S7 evals、S17 混沌+录制、S9 成本账本；S11 行补 slice2，S6/S7/S9/S12/S13/S15/S16/S17 八行 📝→✅ 设计稿已出 → ✅ V1 已落码；审计 +16 值（plan-*5 / connector-*3 / recovery-*4 / cost-*4）；基线 1458/130 → 1581/139 |
