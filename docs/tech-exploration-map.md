# Agent 技术探索地图（Tech Exploration Map）

> 状态：**现行（活文档 v0.1，2026-09-22）**。这是 Agent 方向技术议题的登记处与优先级视图。
> 用法：议题先在本文登记（含触发条件/状态）；成熟且相关者升级为 `docs/design-*.md` 或转入 [deferred-items.md](deferred-items.md)；实施进度只记 [handoff.md](../handoff.md)。
> 状态：🔜 A 组优先（已裁决）｜📝 待触发 / 登记中｜✅ 已有设计。

## 0. 核心定位

Zeus 是**高并发、多 Agent 协同决策平台**（见 [prd.md](prd.md) E1）。所有技术议题以"是否服务并发协同决策内核"为取舍准绳。

## A 组：紧贴内核，优先（2026-09-22 负责人裁决全部认同）

| 编号 | 议题 | 状态 | 关联设计 |
|---|---|---|---|
| S1 | **上下文工程 Context Engineering**：每 Agent 带哪些上下文、共享上下文裁剪、上下文预算分配、长任务压缩换入换出（与记忆一体两面） | 🔜 | design-memory-consolidation.md |
| S2 | **裁决/Critic 机制**：聚合权重来源、独立 Judge、陪审团/对抗辩论、LLM-as-judge 校准 | 🔜 | prd E1.3；design-supervision §8 |
| S3 | **DAG 依赖编排**：超越 fan-out 的有向无环调度、关键路径、部分失败 | 🔜 | design-supervision §4 |
| S4 | **终止与收敛**：防互相调用/辩论不收敛，步数/预算上限、熔断、确定性终止 | 🔜 | prd E1.5 |
| S5 | **幂等与 exactly-once**：幂等键、重试副作用安全、去重 | 🔜 | prd E1.5；design-supervision §5.2 |

## B 组：可靠性与安全（企业版硬门槛，随真机阶段触发）

| 编号 | 议题 | 要点 | 状态 |
|---|---|---|---|
| S6 | 可观测性：trace/metrics/log + LLM replay | 跨 Agent 调用链调试；审计已有，补分布式 trace | 📝 |
| S7 | Evals 与质量回归 | 离线 eval 集、改 prompt 防漂移、线上 A/B（呼应 verify before asserting） | 📝 |
| S8 | Guardrails：注入/越权/PII | prompt injection 经数据跨 Agent 传播，多 Agent 放大攻击；越权工具调用 | 📝（高优，建议紧随 A 组） |
| S9 | 成本治理 | 任务/租户 token 预算、执行中预算闸门、异常熔断；cost 字段已有 | 📝 |
| S10 | Human-in-the-loop 时机 | 何时打断人、何时异步介入，不打断心流 | 📝 |

## C 组：能力与运行时（中期）

| 编号 | 议题 | 要点 | 状态 |
|---|---|---|---|
| S11 | 工具/Skill 发现与组合 | 自动选工具、工具链拼装、工具失败恢复 | 📝 |
| S12 | 规划：单/多 planner、重规划 | 计划竞争、计划与执行交错、replan | 📝 |
| S13 | 长流程持久化执行 | checkpoint、崩溃恢复、断点续跑（随 H2） | 📝 |
| S14 | 多模型异构调度 | 按子任务难度路由强/便宜/快/本地模型；**Jev 决策模型落此层（快决策后端，见 design-decision-backend.md）** | ✅ |
| S15 | 流式体验工程 | 部分结果先呈现、流式合并、思考态 UX | 📝 |
| S16 | 沙箱与代码执行 | 容器/microVM 隔离、资源配额 | 📝 |
| S17 | Agent 测试策略 | 契约测试、录制重放、mock LLM、混沌测试 | 📝（契约测试已有实践） |

## D. 待确认外部输入

- ~~**Jev 模型（2026-09-22 负责人提及）**~~ ✅ 已核实并落设计：Jev = TypeSafe AI 首个公开 "System One" 决策模型（2026-09-15，创始人 Diogo Almeida 为前 OpenAI 研究员）；不吃文本，输入 state + 类型化问题，输出 Choice/Score/Noul 带概率与置信度；输入 $0.042/M token、输出免费、延迟 70–500ms；已上 Cloudflare AI 目录。**设计落点：快决策层 DecisionBackend（design-decision-backend.md），S14 快决策模型层**。Jev 是首个实现（可替换），不是驱动模型、不是封臣。

## E. 已覆盖（已有点名或设计，避免重复立项）

- 协议层：MCP / A2A / 封臣超集（design-vassal-protocol）
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
| v0.2 | 2026-09-22 | Jev 已核实并落设计（design-decision-backend.md，快决策层）；S14 状态 ✅ |
