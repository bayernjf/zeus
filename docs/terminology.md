# Zeus 术语对照（叙事隐喻 ↔ 工程原语 ↔ 行业标准用语）

> 现行 v0.1（2026-09-25）。用途：对外文档（评审、PRD、演示、接口文档）与内部交流之间的术语翻译约定；避免读者把项目的叙事化命名误读为行业标准术语。

## 背景与约定

Zeus 的项目文档与代码大量使用**叙事化隐喻**（封臣/效忠/战报/藏宝图等）。这是设计哲学明确允许的命名层——「叙事化概念必须与真实可执行的工程原语同构」（见 docs/product-portrait.md 设计哲学第 2 条），即每个隐喻词都严格对应一个可运行的代码实体，内部全局一致。

- **内部**（handoff / 设计文档 / 代码注释）：保留隐喻命名，不加额外说明（项目惯例已如此）。
- **对外**（评审报告、PRD 面向非项目读者、演示、对外接口文档）：以专业用语为主，隐喻仅作加注或括号说明，避免"封建制隐喻 vs 技术架构"的误读。
- 代码注释已有"叙事 + 专业"双写的先例（如 `src/orchestrator/types.ts` 中 `Position` 的注释直接使用专业描述），新写注释沿用此惯例。

## 核心映射表

| 项目隐喻 | 专业/标准用语 | 代码/设计落点 |
| --- | --- | --- |
| 封臣（vassal） | 子代理 / 执行者 / worker / A2A agent | `VassalEntry`（`src/registry/registry.ts`：可派发执行者，经 A2A 标准交互注册、状态 active/revoked、带出站凭证） |
| 封臣响应（vassal response） | 执行者的立场回传 / 子代理意见 | `Position = { vassal, stance, weight?, rationale? }`（`src/orchestrator/types.ts`：从任务终态产物提取的决策立场） |
| 立场（stance） | 决策立场 / 证据意见 | `Position.stance`，聚合规则的输入单位 |
| 效忠（fealty） | 注册握手 / 凭证契约 | `x-zeus-fealty` 头 + `AgentCard` 校验（`src/registry/registry.ts`、`src/a2a/types.ts`、docs/design-vassal-protocol.md） |
| 名册 / 封神榜（roster） | 可派发执行者目录 | `src/registry/roster.ts`（internal/public 双快照、签名封签） |
| 扇出（fan-out） | 并行任务派发 / 扇出路由 | `src/dispatch/`（Dispatcher：JSON-RPC + SSE 客户端） |
| 聚合规则 | 共识聚合（一致 / 多数 / 加权投票） | `AggregationRule`（`src/orchestrator/types.ts`） |
| 仲裁（arbitrate） | 模型裁决（置信闸门） | `arbitrateSplit`（`src/decision/arbitrate.ts`） |
| 对抗复核（judge） | 对抗性复核 / adversarial review | `judgeDecision`（`src/orchestrator/judge.ts`，E1.3） |
| 战报（report-back） | 任务产物回传 | A2A `Artifact`/`Task` 终态（docs/design-vassal-protocol.md） |
| 升级（escalation） | 升级人工驾驶 / needs-driver | `src/oversight/`（OversightDesk：task-input / intent-conflict 升级队列） |
| 上岗门 | 上岗资格校验（seat/account/authorization/mentorship） | `src/onboarding/`（E9.1/E9.2，现算不缓存） |
| 数据域（realm） | 数据边界 / 数据域（personal / enterprise） | `src/realm/`（目录即数据库、数据二极管） |
| 藏宝图（vault） | 备份与恢复协议（引用 + 指纹 + 加密备份包） | `src/vault/`（E8.1/E8.2/E3.7） |
| 立国三纲 | 能力接入三原语：MCP / Skill / A2A | docs/design-agentic-integration.md §2A |
| 决策后端（decision backend） | 模型无关决策端口 | `DecisionBackend`（noul/choice/score，`src/decision/types.ts`） |

## 对外一句话示例

内部写法：

> 意图（结构化）→ fanOut → 封臣响应 → 规则聚合 → 结论

对外专业写法：

> 结构化意图经驱动接口进入编排器，按技能路由将任务并行扇出给多个注册执行器（A2A 子代理）；各执行器回传带依据与权重的决策立场，规则引擎按一致 / 多数 / 加权策略聚合出决策结论；结论不成立时进入升级链（置信闸门、对抗复核或人工驾驶接管）。

## 维护约定

- 本表只收录**已在代码/设计中存在的映射**；新增叙事命名时，落地代码前先在 `docs/design-*.md` 里写明其工程原语对应物（设计哲学第 2 条的执行要求）。
- 术语含义以代码为准；本表与代码不一致时，改本表，不改代码。
