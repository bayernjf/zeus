# Agent 技术探索地图（Tech Exploration Map）

> 状态：**现行（活文档 v0.3，2026-09-22）**。这是 Agent 方向技术议题的登记处与优先级视图。（版本行自 v0.2 起漏更，2026-09-26 按文末演进日志对齐到 v0.3。）
> 用法：议题先在本文登记（含触发条件/状态）；成熟且相关者升级为 `docs/design-*.md` 或转入 [deferred-items.md](deferred-items.md)；实施进度只记 [handoff.md](../handoff.md)。
> 状态：🔜 A 组优先（已裁决）｜📝 待触发 / 登记中｜✅ 已有设计。

## 0. 核心定位

Zeus 是**高并发、多 Agent 协同决策平台**（见 [prd.md](prd.md) E1）。所有技术议题以"是否服务并发协同决策内核"为取舍准绳。

## A 组：紧贴内核，优先（2026-09-22 负责人裁决全部认同）

| 编号 | 议题 | 状态 | 关联设计 |
|---|---|---|---|
| S1 | **上下文工程 Context Engineering**：每 Agent 带哪些上下文、共享上下文裁剪、上下文预算分配、长任务压缩换入换出（与记忆一体两面） | ✅ **V1+V2 已落地**（2026-10-09，Active work 165/166：[design-context-engineering.md](design-context-engineering.md) v0.4——V1 §10：`src/context/assemble.ts` 记忆装配器 + `fanOutNew` 装配点 + 出站载荷 `contextAppendix` + 审计三值 + boot 接线；V2 §11：`assembleSkillInputs` 技能声明输入装配（显式补全 / unavailable 不臆造）+ 共享裁剪完整规则（去重取 updatedAt 最新 / 相关度闸 minScore / 敏感面）+ 出站 `skillInputs` + 审计 reason 扩 unavailable/relevance；V3 预算分配与换入换出待分期） | design-context-engineering.md |
| S2 | **裁决/Critic 机制**：聚合权重来源、独立 Judge、陪审团/对抗辩论、LLM-as-judge 校准 | ✅（`src/orchestrator/arbitration.ts` 后端仲裁 + `src/orchestrator/judge.ts` 对抗式复核 + `src/decision/` 模型无关决策后端；Active work 15/43，基线） | prd E1.3；design-supervision §8 |
| S3 | **DAG 依赖编排**：超越 fan-out 的有向无环调度、关键路径、部分失败 | ✅（`src/orchestrator/dag.ts` `dag-runner.ts`：拓扑分层/关键路径/上游失败跳过下游/产物下传；Active work 13 六切片） | design-supervision §4 |
| S4 | **终止与收敛**：防互相调用/辩论不收敛，步数/预算上限、熔断、确定性终止 | ✅（2026-10-08，design-supervision §7.1：意图级步数预算 + 连续失败熔断，默认开启、随快照恢复、审计两值，Active work 162） | prd E1.5 |
| S5 | **幂等与 exactly-once**：幂等键、重试副作用安全、去重 | ✅（intentId 幂等零出站重放 + cancel 回写；E1.5/F2，`src/orchestrator/orchestrator.ts` #intentId） | prd E1.5；design-supervision §5.2 |

## B 组：可靠性与安全（企业版硬门槛，随真机阶段触发）

| 编号 | 议题 | 要点 | 状态 |
|---|---|---|---|
| S6 | 可观测性：trace/metrics/log + LLM replay | 跨 Agent 调用链调试；审计已有，补分布式 trace | 📝→✅ 设计稿已出（2026-10-09，[design-observability.md](design-observability.md) v0.1——从既有审计/progress/runId 谱系装配 span 树的纯函数 `buildTraceTree`，trace 不出进程先落库内；V2 出站透传 traceparent + 只读端点；V1 纯函数待落码） |
| S7 | Evals 与质量回归 | 离线 eval 集、改 prompt 防漂移、线上 A/B（呼应 verify before asserting） | 📝→✅ 设计稿已出（2026-10-09，[design-evals.md](design-evals.md) v0.1——EvalCase 固定世界 + 双侧错误率指标族（误/漏升级、漏/误报、无证据断言恒 block）+ 纯函数评分器 scoreEvalRun，runner 复用 smoke 夹具；V1 纯函数待落码） |
| S8 | Guardrails：注入/越权/PII | prompt injection 经数据跨 Agent 传播，多 Agent 放大攻击；越权工具调用 | 📝→✅ 设计稿已出（2026-10-09，[design-guardrails.md](design-guardrails.md) v0.1——内容来源分级 + `classifyContentRisk` 判定链（放行/标注/脱敏/拒绝/升级）+ 跨 Agent 传播三不变量；V1 纯函数待落码。高优，建议紧随 A 组） |
| S9 | 成本治理 | 任务/租户 token 预算、执行中预算闸门、异常熔断；cost 字段已有 | 📝→✅ 设计稿已出（2026-10-09，[design-cost-governance.md](design-cost-governance.md) v0.1——可信/自报双层口径 + 与 S4 同构的 CostLedger 纯函数（admit/软阈值/速率熔断）+ 超限复用 cancel/降级/L1 升级；阈值标定挂 #9，V1 纯函数待落码） |
| S10 | Human-in-the-loop 时机 | 何时打断人、何时异步介入，不打断心流 | ✅ **V1 已落地**（2026-10-09，Active work 167：[design-hil.md](design-hil.md) v0.2——`src/oversight/interrupt.ts` 纯函数 `classifyInterruption`：六信号（branch-failed/circuit-open/intent-conflict/task-input-missing/delegation-limit-hit/explicit-branch-failed）→ L0 不介入 / L1 异步介入 / L2 同步打断（仅「无替代 + 下游依赖」双条件）固定判定链 + `interruptionReason` 措辞 + 审计 3 值 interrupt-level-* + TUI token；零 IO 零接线，V2 接升级队列） |

## C 组：能力与运行时（中期）

| 编号 | 议题 | 要点 | 状态 |
|---|---|---|---|
| S11 | 工具/Skill 发现与组合 | 自动选工具、工具链拼装、工具失败恢复 | ✅ **V1 已落地**（2026-10-09，Active work 168：[design-tool-discovery.md](design-tool-discovery.md) v0.2——`src/orchestrator/discovery.ts` 纯函数 `selectCandidates`（点名钉选 > 自动选靶饱和过滤 > tier-1 只读收窄 fail-closed > 能力面 execute/plan）+ `recoverChain`（重试→换将→降级→升级，高利害跳过重试、熔断跳过自动路径）+ 审计 5 值 tool-selected/tool-failed/chain-retried/chain-switched/chain-degraded + TUI token；V2 接 selectTargets，V3 接工具链） |
| S12 | 规划：单/多 planner、重规划 | 计划竞争、计划与执行交错、replan | 📝→✅ 设计稿已出（2026-10-09，[design-planning.md](design-planning.md) v0.1——规划即扇出（planner 是规划技能 Agent，计划是待校验数据）+ validatePlan/scorePlans/selectPlan/replanDelta 纯函数（冻结已完成节点、replan 计入步数预算防不收敛）；V1 纯函数待落码） |
| S13 | 长流程持久化执行 | checkpoint、崩溃恢复、断点续跑（随 H2） | 📝→✅ 设计稿已出（2026-10-09，[design-long-running.md](design-long-running.md) v0.1——崩溃恢复四分类纯函数 `classifyRecoverable`（自动续跑/等人/判失败/判取消，execute 默认等人、零僵尸）+ 最小 checkpoint 集；V2 启动恢复接线，V3 周期 checkpoint 触发条件同 retention） |
| S14 | 多模型异构调度 | 按子任务难度路由强/便宜/快/本地模型；**决策后端抽象层落此层（DecisionBackend：专用决策模型 Jev 与 LLM 均可接入，见 design-decision-backend.md）** | ✅ |
| S15 | 流式体验工程 | 部分结果先呈现、流式合并、思考态 UX | 📝→✅ 设计稿已出（2026-10-09，[design-streaming.md](design-streaming.md) v0.1——增量帧五级分类 + 归并不变量（来源标签/选择序/预览不进决策/全落定与 mergeBranches 等价）+ streamWindow 纯函数；V1 纯函数待落码） |
| S16 | 沙箱与代码执行 | 容器/microVM 隔离、资源配额 | 📝 |
| S17 | Agent 测试策略 | 契约测试、录制重放、mock LLM、混沌测试 | 📝（契约测试已有实践） |

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
