# Zeus 产品需求文档（PRD）

> 状态：**现行 v0.12（2026-09-22，记忆 P2 漂移对账：快照逐字段 diff + 横切不变量校验，P2 三项齐）**
> 上游：[product-portrait.md](product-portrait.md)（愿景与设计哲学的单一事实源，本文件不复制愿景全文）。
> 边界：本文件回答「做什么、优先级、验收标准」；「怎么建」看 `docs/design-*.md`；「做到哪」看 [handoff.md](../handoff.md)。
> 状态图例：✅ 已落地（有测试）｜🚧 部分落地 / 有脚手架｜⬜ 未启动。

## 1. 背景与问题

- **核心命题**：现实业务与生活任务越来越需要多个专业 Agent **同时开工、共同参与一个决策**，而现有产品要么是单 Agent 串行问答，要么并发能力薄弱、决策不可追溯。市场缺一个**高并发多 Agent 协同决策平台**作为内核。
- 个人用户：工作提效之外，记忆与数据散落各 SaaS，**无主权、不可备份、不可传承**；情绪层面缺少"被记住、被保护"的长期载体。
- 企业用户：Agent 能力点状存在，新员工上岗成本高，知识随人流失；缺少员工可驾驶、可监督、且对业务结果负责的多 Agent 协作层。
- 供给侧：已有产品矩阵（agent-world、job-agent、agent-dev、pr-helper、atlas、loom；展示站 bayjf）各自独立，用户被迫面对一整组工具，产品之间存在隔阂。

## 2. 产品目标与非目标

### 2.1 目标

1. **（核心）高并发多 Agent 协同决策**：一个意图可扇出多个 Agent 并行执行，结果可聚合、冲突可消解、决策可追溯，驾驶员只面对一个合并视图。
2. Skill 作为显式的一等模块：能力以 Skill 声明、安装、加固、传授，协同决策按技能自动组队。
3. 用户给一个目录即可用：目录即数据库，先连接、经接口访问，备份为第一公民。
4. 用户只面对 Zeus 一扇门：矩阵产品以封臣身份效忠，星型编排、可吊销、名册可验。
5. 双态闭环：个人藏宝图真实可恢复；企业员工以驾驶员身份上岗、Mentor 带业务、全程审计。

### 2.2 非目标（Non-goals）

- 不自造 MCP/A2A 之外的私有封闭协议；Zeus v1 不做 A2A server（发起方永远是 Zeus/驾驶员）。
- Realm 不做独立 HTTP API（对外唯一传输为 MCP）。
- 不做封臣之间的 P2P 直连；不做企业→个人数据域的任何互通（无例外）。
- 传承的法律框架与企业计费模型不在 v1 实施（deferred #3/#4）。

## 3. 用户与核心场景

| 用户 | 核心场景 | 承诺 |
|---|---|---|
| 个人用户 | 一个意图 → 多个 Agent 并行处理工作/生活数据；日记/藏宝图备份与恢复；可选传承 | 被记住、被保护、不被绑架 |
| 员工（驾驶员） | 监督多 Agent 协同决策，在冲突/升级点拍板；上岗即被 Mentor 带教 | 港湾：有导师、有归属 |
| 企业采购方 | Zeus 作为虚拟部门高并发承接流程；权限可审计、知识不流失 | 人效、留存、合规 |

## 4. 需求拆解（Epic → 需求 → 验收）

优先级：P0 = v1 必须；P1 = v1.x；P2/P3 = 后续版本。

### E1. 并发协同与决策内核（核心）

| ID | 需求 | 优先级 | 状态 | 验收标准 |
|---|---|---|---|---|
| E1.1 | 单意图扇出（fan-out）：按技能/域一次并行派发多个 Agent（含封臣） | P0 | ✅ | 一层 fan-out/join 已落地（`Orchestrator` 按技能/显式名单并行派发、`Promise.allSettled`、部分失败/单路超时、failed/partial/needs-driver/completed 状态判定，见 design-fan-out.md）；**S3 完整 DAG 依赖编排已落地**（`src/orchestrator/dag.ts` 纯图函数：环/重复/未知依赖校验、拓扑分层、关键路径；`dag-runner.ts` 按波次并行、上游失败则下游跳过、needs-driver 冒泡、上游产物经 resolveParams 下传，6 项测试） |
| E1.2 | 多流合并：多路 SSE/结果合并为驾驶员单视图，保持来源可辨 | P0 | ✅ | `mergeBranches` 分支内保序、分支间按选择顺序拼接，每事件带来源 vassal/taskId/runId；缺路按 branchTimeout/失败策略归为 partial/failed。服务端 SSE 推送合并流属 E5.5 |
| E1.3 | 多 Agent 协同决策：多方案生成、加权/投票/规则聚合为一个决策建议 | P0 | 🚧 | ✅ 确定性规则聚合 unanimous/majority/weighted 已落地，输出含各方立场/权重/理由，分裂时 conclusion:null 不臆断；多方案生成与 LLM-as-judge/对抗（S2）未做 |
| E1.4 | 冲突检测与消解：识别 Agent 间结论冲突，给消解路径或升级驾驶员 | P0 | ✅ | `detectConflicts` 标记规则无法消解的多立场分裂，status=needs-driver 并经 onConflict 回调进监督台、不静默选边；**冲突拍板回写已闭环**（E6.2）；更丰富的自动消解规则 / LLM critic（S2）未做 |
| E1.5 | 并发治理：并发上限、任务队列、超时与取消传播、幂等 | P0 | 🚧 | ✅ intentId 重放幂等（同键零出站）、cancelIntent 传播到全部非终态分支、单路超时、父子 runId 全链贯穿；并发上限/队列/背压未做（deferred #9，待 ≥3 封臣压测） |
| E1.6 | 决策可追溯：每个决策可回放参与 Agent、输入、立场、聚合过程 | P0 | 🚧 | ✅ FanOutResult 记录各分支、positions、decision.rule/reason/margin、sourced 事件与分支 runId，决策来源可辨；独立离线回放器未做 |
| E1.7 | 并发可观测：在途任务数、各 Agent 延迟/失败率、队列深度 | P1 | ✅ | 库内 `ConcurrencyMetrics`（`src/orchestrator/metrics.ts`）：在途数、并发峰值、队列深度、完成/失败/超时计数、各封臣延迟 min/max/avg/p50/p95 与失败率，经 Orchestrator 注入、`bootKernel` 默认装配（5 项测试）；**已随 H2 经 `GET /api/metrics` 暴露**。背压/有界队列落地前队列深度恒 0（deferred #9） |

**容量目标（待压测基线）**：单意图并发 Agent 数、平台同时在途任务数、P95 决策延迟在 M2 压测后定值。

### E2. Skill 技能体系（一等模块）

| ID | 需求 | 优先级 | 状态 | 验收标准 |
|---|---|---|---|---|
| E2.1 | Skill 显式声明：输入/输出、权限、依赖、版本 | P0 | ✅ | SkillSpec 独立于 Agent Card：id/name/version(major.minor.patch)/inputs/outputs/permissions(封闭 scope 词汇 realm·execute·network·credential·mcp)/dependencies；`validateSkillSpecShape` 纯校验，注册强制形状校验、依赖须已注册（拒前向引用）、拒绝自依赖与依赖环；SkillRegistry 已在 `bootKernel` 装配（封臣 card 经 onRegister 钩子自动导入）并随 KernelSnapshot 持久化重启恢复，见 tests/skills-validation.test.ts、tests/kernel-skills-state.test.ts |
| E2.2 | Skill 注册中心：登记、检索、版本化 | P0 | ✅ | `src/skills/registry.ts` SkillRegistry：id+version 唯一键、多版本共存、get 默认最新 active（显式版本可查 deprecated 供审计）、deprecate 标记不删、按名/域（findByDomain）/标签检索、registerFromCard 从卡片登记目录版本、resolveTeam 多技能组队（10 项测试） |
| E2.3 | Skill 安装 / 加固 / 卸载断权 | P1 | ✅ | `install/uninstall/harden`（src/skills/registry.ts）：安装即 active 生效；卸载立即 status=uninstalled，resolveTeam 即刻显示 missing、默认查询不可见（无缓存授权）；加固只能收窄权限（bare scope 可降到 scope:action，拒越权授予）、约束叠加合并，随 spec 持久化；deprecated 不可重装，见 tests/skills-lifecycle.test.ts（8 项） |
| E2.4 | 协同决策按 Skill 自动组队：一意图映射到所需技能并选 Agent | P0 | ✅ | registry 有 findBySkill；SkillRegistry.resolveTeam 对多技能返回每技能 slot（providers/missing/ambiguous）与 complete/missingSkills/ambiguousSkills，多候选标 ambiguous 绝不静默随机选（E2.2 测试覆盖） |
| E2.5 | Mentor 传授 Skill 给新 Agent/员工 | P2 | ⬜ | 带教路径可执行，学习结果可验证 |

### E3. Realm 数据域（数据主权底座）

| ID | 需求 | 优先级 | 状态 | 验收标准 |
|---|---|---|---|---|
| E3.1 | connect 目录生成 manifest（确定性 realmId、类型固定 personal/enterprise） | P0 | ✅ | realpath 派生 id 且幂等；未 connect 拒绝读写；类型不可变 |
| E3.2 | 扫描式 search + read | P0 | ✅ | 文本白名单/剪枝/1MiB 上限/symlink 拒绝；路径穿越双检拒绝 |
| E3.3 | contentDigest 基线 | P0 | ✅ | 全量指纹稳定（顺序无关），供备份与漂移对账 |
| E3.4 | Realm MCP server 正式暴露（streamable HTTP + 鉴权） | P1 | 🚧 stdio | stdio 壳已落地（root/connect 不出协议）；正式触发：read-realm 封臣出现 |
| E3.5 | write 与驾驶员授权凭证 | P1 | ⬜ | personal 默认可写；enterprise 写须授权凭证并审计 |
| E3.6 | enterprise Realm 多租户 | P1 | ⬜ | 组织/部门/个人分级，与个人域默认二极管隔离 |
| E3.7 | 备份策略执行器 + 漂移检测 | P2 | ⬜ | manifest-only/full 可执行；digest 对账报漂移 |
| E3.8 | 检索后端升级（倒排/向量） | P2 | ⬜ | SearchBackend 接口不变；阈值见 deferred #10 |

### E4. 封臣联邦（Vassal Protocol）

| ID | 需求 | 优先级 | 状态 | 验收标准 |
|---|---|---|---|---|
| E4.1 | Agent Card + fealty 注册（版本协商、健康探针） | P0 | ✅ | 无 fealty/版本不支持拒绝；字段与标准对齐 |
| E4.2 | tasks/send 与 sendSubscribe（JSON-RPC + SSE） | P0 | ✅ | 全链路状态机完整；SSE 缺终态快照即报错 |
| E4.3 | 战报 report-back（summary/evidence/cost/followUps） | P0 | ✅ | 四字段齐备；成本口径按 deferred #8 |
| E4.4 | 升级 escalation（input-required / 不可逆操作） | P0 | ✅ | 不可逆 execute 必须升级；带 approve/reject |
| E4.5 | 数据二极管与 dataPolicy 脱敏 | P0 | ✅ | 按 fealty 裁剪；越域即拒并审计 |
| E4.6 | 吊销强制力 | P0 | ✅ | 派发前阻断，不发请求/token；重复吊销幂等 |
| E4.7 | 全程审计（决策链 + 治理桥 + SLA 计时） | P0 | ✅ | 审计有序；sla.ackSeconds 违约单独决策 |
| E4.8 | 标准客户端守护（超集不破坏标准） | P0 | 🚧 | 脚本已备；真机待 pr-helper 部署 |
| E4.9 | fealty 签名链 v1（生产 RSK + R1/R2 接线） | P1 | 🚧 | 纯函数与 H1 public 已接；销项须生产密钥 + 八条验收（deferred #7） |
| E4.10 | 封臣背压降级顺序 | P2 | ⬜ | ≥3 封臣在线压测（deferred #9） |

### E5. HTTP 门面与名册

| ID | 需求 | 优先级 | 状态 | 验收标准 |
|---|---|---|---|---|
| E5.1 | roster internal/public 双投影 | P0 | ✅ | public 裁掉端点/探针/已吊销；确定性排序 |
| E5.2 | H1：/healthz、/api/roster/public（seal）、/api/roster（bearer） | P0 | ✅ | 离线验签；三类篡改拒绝；未配 token 不挂载 |
| E5.3 | 持久化注册表（替换实例内存） | P1 | ✅ | `src/state/kernel-state.ts`：封臣注册表（含已吊销）、监督台升级队列（重建 task/conflict 幂等索引）、编排意图结果与原始请求（重启后幂等重放、resumeBranch 可用）经 `FileKernelStateStore` 原子落盘（tmp+rename）与版本校验恢复；已接入 `bootKernel` 启动装配（`ZEUS_STATE_FILE` 启动恢复、SIGINT/SIGTERM 原子落盘）。**Realm 连接状态已纳入快照并重启自动 reconnect（G4 ✅）**；metrics 运行态不持久化 |
| E5.4 | bayjf R2 验签封神榜 | P1 | ⬜ | 只消费 seal 快照并客户端验签；闸门 = E4.9 |
| E5.5 | H2 驾驶员 API + 服务端 SSE（含多 Agent 合并流） | P1 | ✅ | **H2 驾驶员 API**（bearer 保护，未配 `ZEUS_INTERNAL_TOKEN` 整组不挂载）：`POST /api/intents` 扇出、`GET /api/intents/:id` 回查、`POST /api/intents/:id/cancel`、`GET /api/escalations` + `POST .../:id/approve|reject|resolve`（resolve 把拍板立场回写聚合决策，打通 E6.2）、`GET /api/metrics`；端到端测试 `tests/http-h2.test.ts` + 进程级冒烟。**H3 服务端 SSE 已落地**：`GET /api/intents/:id/events` 经 `ProgressHub` 实时推送 branch-started/branch-ended/intent-finished（15s keepalive、已完成意图回放、flushHeaders），见 tests/http-sse.test.ts。**封臣上线入口已接**：`POST/DELETE /api/vassals` + `ZEUS_VASSAL_SEEDS`（G1） |

### E6. 监督台与驾驶员

| ID | 需求 | 优先级 | 状态 | 验收标准 |
|---|---|---|---|---|
| E6.1 | OversightDesk：升级队列 + approve/reject + reject 联动 cancel | P0 | ✅ | taskId 幂等；只受非终态；全程审计 |
| E6.2 | 多 Agent 冲突升级与拍板 | P0 | ✅ | 冲突经 onConflict→`conflictsToDesk`→OversightDesk.ingestConflict 入队（按 intentId 幂等）；decideConflict 校验立场后，Orchestrator.resolveIntent 经纯函数 applyConflictResolution 把驾驶员立场回写聚合决策、清空冲突、重算状态、记 driverResolution（6 项测试） |
| E6.3 | approve 后补参自动重派 | P1 | ✅ | 库内 `Orchestrator.resumeBranch` 单分支带合并参数重派、整意图重算（仍 needs-driver 再升级）；冲突拍板回写经 `POST /api/escalations/:id/resolve`（E6.2）；**一键 HTTP 闭环已接线（G6）**：`POST /api/escalations/:id/approve-resume` approve 携带 params 后经 `findIntentForBranchRun` 定位意图自动 resumeBranch，见 tests/http-approve-resume.test.ts |
| E6.4 | 双域共存授权界面 | P2 | ⬜ | 授权粒度与审计呈现（deferred #6） |

### E7. MCP 连接器（立国三纲·连接世界）

| ID | 需求 | 优先级 | 状态 | 验收标准 |
|---|---|---|---|---|
| E7.1 | 基于 MCP 的外部系统接入（resources/tools/prompts） | P1 | ✅ | 新增 `src/mcp`：`McpClient` 零 SDK 实现 streamable-HTTP JSON-RPC（initialize 握手 + initialized 通知，兼容 application/json 与 text/event-stream 两种响应），tools/resources/list 发现能力；`ConnectorRegistry.connect` 执行握手，服务器不可达拒绝并审计（refused），`revoke` 立即移出活动集合，见 tests/mcp-connectors.test.ts（8 项） |
| E7.2 | 连接器登记与最小权限声明 | P1 | ✅ | `declare` 强制封闭权限词汇（validatePermissionClaims）、重复声明拒绝；连接后只暴露声明边界内工具（bare `mcp` 全放行，`mcp:<tool>` 精确授权，边界外工具不出现）；连接器声明经 bootKernel 装配并随 KernelSnapshot `connectors` 段持久化恢复（连接不自动重建立） |

### E8. 个人情感层

| ID | 需求 | 优先级 | 状态 | 验收标准 |
|---|---|---|---|---|
| E8.1 | Map 藏宝图：加密 manifest + 恢复协议 | P1 | ⬜ | **按图必须真实恢复宝藏**（生命线）；只存引用 |
| E8.2 | 藏宝图备份与备份思路 | P1 | ⬜ | 图有可用备份；恢复流程经演练 |
| E8.3 | Diary 日记：记忆叙事化备份 | P2 | ⬜ | 可回溯、可导出，底层走 Realm 接口 |
| E8.4 | 传承（dead-man switch + 密钥托管） | P3 | ⬜ | 触发可靠、可撤销；法律框架齐备（deferred #2/#3） |

### E9. 企业组织层

| ID | 需求 | 优先级 | 状态 | 验收标准 |
|---|---|---|---|---|
| E9.1 | Mentor Agent：文化/业务/职责带教 | P2 | ⬜ | 新员工首日无人工介入获得岗位上下文 |
| E9.2 | 上岗即用流程 | P2 | ⬜ | 账号→授权→Mentor→首日任务全链路 |
| E9.3 | 虚拟部门编制（Team）与结果责任 | P2 | ⬜ | 编制可视，任务追到 Agent 与驾驶员 |
| E9.4 | 外部 Agent 信任分级与沙箱 | P2 | ⬜ | 首个矩阵外 Agent 接入前完成（deferred #5） |

### E10. 平台工程

| ID | 需求 | 优先级 | 状态 | 验收标准 |
|---|---|---|---|---|
| E10.1 | CI（typecheck/test/build 矩阵） | P0 | ✅ | GitHub Actions Node 20/22 全绿（push 待授权） |
| E10.2 | 真机部署：pr-helper + Zeus 门面 | P1 | ⬜ | 支撑 E4.8 真机验收与 Zeus↔loom 联调 |
| E10.3 | 库公共入口与构建产物 | P0 | ✅ | src/index.ts 聚合导出；dist 含 .d.ts |
| E10.4 | 并发压测与容量基线 | P1 | ⬜ | 产出 E1 容量目标基线，作为背压/扩容依据 |

## 5. 里程碑（建议）

| 里程碑 | 内容 | 出口标准 |
|---|---|---|
| M1 内核基座（当前） | E3.1–3.3、E4.1–4.7、E5.1–5.2、E6.1、E10.1/10.3 | 98 测试绿；治理闭环库内可验证 |
| M2 并发决策内核 | E1.1–1.6、E2.1/2.2/2.4、E10.4 | 单意图多 Agent 并发+聚合+冲突升级可演示；容量有基线 |
| M3 真机闭环 | E4.8、E10.2、Zeus↔loom 联调、E5.3 | 两封臣真机受调度；重启状态不丢 |
| M4 Realm 开放 | E3.4/3.5、E4.9、E5.4 | 标准 MCP client 可读 Realm；bayjf 公开验签名册 |
| M5 情感与成长 | E8.1–8.3、E2.3、E7 | 藏宝图恢复演练通过；Skill 可安装/传授 |
| M6 企业/传承 | E9、E8.4 | 员工上岗即用；继承协议端到端（P3） |

## 6. 成功指标（待基线）

- **并发决策（核心）**：单意图可并发 Agent 数、同时在途任务数、P95 决策延迟、多 Agent 决策与单 Agent 的质量对比、冲突被正确识别率。
- 信任：藏宝图恢复成功率（目标 100%）；数据事故数（目标 0）；吊销生效延迟（目标实时）。
- 个人：周活留存、备份覆盖率、情感闭环验证用户数。
- 企业：新员工上岗耗时、流程 A2A 承接比例、知识可检索率；SLA 受理违约率。

## 7. 演进日志

| 版本 | 日期 | 变更 |
|---|---|---|
| v0.1 | 2026-09-22 | 首版：9 Epic、~40 需求、里程碑与成功指标 |
| v0.2 | 2026-09-22 | 核心定位修正为"高并发多 Agent 协同决策平台"：新增 E1 并发协同与决策内核；Skill 提升为独立 E2 并前置；新增容量目标、并发指标与 M2 里程碑，后续 Epic 顺延 |
| v0.3 | 2026-09-22 | M2 第一批落地：E1.1 一层 fan-out/join、E1.2 多流合并、E1.5 幂等/cancel 传播/单路超时、E1.3 规则聚合、E1.4 冲突升级（库内，design-fan-out.md，26 项测试）；E1 状态由 ⬜/🚧 更新 |
| v0.4 | 2026-09-22 | MVP 评审后六切片批次：E2.2 Skill 注册中心 ✅、E2.4 组队解析 ✅、E1.1 S3 完整 DAG ✅、E1.4/E6.2 冲突拍板回写 ✅、E6.3 补参重派骨架 🚧、E1.7 库内并发指标 🚧、E5.3 内核状态落盘恢复 🚧；另落地模型无关决策后端 src/decision（Jev/LLM 适配器，见 design-decision-backend v0.2）；全量 166 测试绿（22 文件） |
| v0.5 | 2026-09-22 | H2 驾驶员 API 落地：E5.5 升 🚧（意图扇出/回查/取消、升级队列 list/approve/reject/resolve 决议回写、GET /api/metrics，bearer 保护，12 项端到端测试 + 进程级冒烟）；E1.7 升 ✅（指标经 HTTP 暴露）；E5.3 已接启动装配；修复服务端生成 intentId 的意图不落表导致无法回查/决议的缺口；全量 199 测试绿（26 文件） |
| v0.6 | 2026-09-22 | A 批次收口四个缺口：**G1 封臣上线入口**（`POST/DELETE /api/vassals` + `ZEUS_VASSAL_SEEDS`）、**G4 Realm 连接持久化**（snapshot 增 realms、重启 reconnect、`ZEUS_REALM_ROOTS`）、**G6 E6.3 一键补参重派**（`POST .../approve-resume` + `findIntentForBranchRun`）、**G5 H3 SSE**（`GET /api/intents/:id/events` + `ProgressHub`，branch 生命周期实时事件）；E5.3/E5.5/E6.3 升 ✅；全量 217 测试绿（31 文件） |
| v0.7 | 2026-09-22 | E2.1 Skill 显式规格落地：SkillSpec 独立于卡片（version/inputs/outputs/permissions 封闭 scope/dependencies），注册强制形状校验、依赖须已注册、拒自依赖与依赖环（validate-spec 纯函数）；SkillRegistry 接入 bootKernel（onRegister 自动导入 card skills）并随快照持久化恢复；E2.1 升 ✅；全量 229 测试绿（33 文件） |
| v0.8 | 2026-09-22 | 记忆整理协议 P0 落地（design-memory-consolidation §7）：新增 `src/memory`——append-only 事件日志、事实无公开写入口（仅经纯函数 `consolidate`）、同事实观察去重合并累积 provenance、矛盾默认 disputed + 可确定性生成的 escalation（later-and-more-reliable 规则方可 supersede）、置信度按 Agent 历史可靠度加权（同源重复不增强、独立来源印证小幅提升）、跨 realm 读写拒绝并审计、沿 runId 离线回放事件与事实；八条首版验收逐条覆盖，11 项测试；全量 240 绿（34 文件） |
| v0.9 | 2026-09-22 | 记忆 P1 落地：事件日志与事实纳入 KernelSnapshot（`memory` 段，重启完整恢复）；FanOutRequest/Result 与 intent-finished 事件贯通 `realmId`；意图进入终态时自动整理对应 realm（可靠度从并发指标 failureRate 派生，无记录默认 0.5），矛盾经新增 `memory-dispute` 升级类型幂等进 OversightDesk；`POST /api/intents` 透传 realmId；3 项测试；全量 243 绿（35 文件） |
| v0.10 | 2026-09-22 | 三块收口：**可靠度纠错回写**（OversightDesk onDecided 钩子，驾驶员拍板 memory-dispute 后对败诉作者记 correction，每次 −0.15，随快照持久化）、**E2.3 Skill 生命周期**（install/uninstall/harden，卸载即时断权、加固只能收窄）、**E7 MCP 连接器**（零 SDK JSON-RPC client + 连接器登记/最小权限/发现/吊销，声明随快照持久化）；E2.3/E7 升 ✅；新增 17 项测试，全量 260 绿（37 文件） |
| v0.11 | 2026-09-22 | 记忆 P2 落地：新增 `src/memory/recall.ts`——混合检索（BM25 词法 + 向量余弦，alpha 可调，默认本地确定性 signed-hashing embedder、`Embedder` 端口可注入同域模型），召回索引为不持久化的可重建派生物，仅 active/disputed 入索引；遗忘权（`retractFacts` 即时摘除索引、`forgetSubject` 按主体抹除，tombstone 台账随快照持久化，事件日志 append-only 保留供治理回放）；11 项测试；全量 271 绿（38 文件） |
| v0.12 | 2026-09-22 | 记忆 P2 漂移对账落地：新增 `src/memory/reconcile.ts`——`reconcileMemoryStates` 两时点快照逐字段 diff（事件增删、事实 added/removed/changed、correction/tombstone 增量）、`verifyMemoryState` 横切不变量校验（factId 可重算、provenance 可解析且不跨域、retract↔tombstone 一一配对、事实不重复），`MemoryStore.verifyIntegrity` 便捷入口；factId 计算导出复用；9 项测试；P2 三项齐；全量 280 绿（39 文件） |
