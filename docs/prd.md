# Zeus 产品需求文档（PRD）

> 状态：**现行 v0.23（2026-09-24，驾驶员 HTTP 补面：memory / skills+mentorship / org 责任链 / 决策回放）**
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
| E1.3 | 多 Agent 协同决策：多方案生成、加权/投票/规则聚合为一个决策建议 | P0 | ✅ | ✅ 确定性规则聚合 unanimous/majority/weighted 输出各方立场/权重/理由，分裂时 conclusion:null 不臆断；**LLM-as-judge 对抗复核已落地**（`src/orchestrator/judge.ts`）：规则有结论且≥2 立场后，独立决策后端复核——高置信校准同意则背书、高置信校准分歧不静默覆盖也不放行弱多数，转 needs-driver 并开 `kind:judge-review` 冲突走 E6.2 驾驶员闭环；低置信/未校准 LLM 默认不采纳/后端故障只记录不动状态；与仲裁互斥（无结论走 arbitrate，同后端不自评）；judge 记录进 E1.6 回放时间线，14 项测试。多方案生成（noul 开放生成）仍未做 |
| E1.4 | 冲突检测与消解：识别 Agent 间结论冲突，给消解路径或升级驾驶员 | P0 | ✅ | `detectConflicts` 标记规则无法消解的多立场分裂，status=needs-driver 并经 onConflict 回调进监督台、不静默选边；**冲突拍板回写已闭环**（E6.2）；更丰富的自动消解规则 / LLM critic（S2）未做 |
| E1.5 | 并发治理：并发上限、任务队列、超时与取消传播、幂等 | P0 | 🚧 | ✅ intentId 重放幂等（同键零出站）、cancelIntent 传播到全部非终态分支、单路超时、父子 runId 全链贯穿；并发上限/队列/背压未做（deferred #9，待 ≥3 封臣压测） |
| E1.6 | 决策可追溯：每个决策可回放参与 Agent、输入、立场、聚合过程 | P0 | ✅ | FanOutResult 记录各分支、positions、decision.rule/reason/margin、sourced 事件与分支 runId；**独立离线回放器已落地**（`src/orchestrator/replay.ts`：纯只读函数按合并流重建确定性时间线，含输入/参与方/立场/聚合/冲突/后端仲裁/驾驶员决议，replaySnapshot 从持久化快照批量回放，renderReplay 出人读文本；记录损坏 fail-loud，8 项测试）；**已上驾驶员面**（v0.23）：`GET /api/intents/:id/replay` 出 JSON 时间线、`?format=text` 出人读文本，配对 `Orchestrator.getRequest()` 取回原始派发输入，存储记录无法回放时返回 500 而非半条时间线（tests/http-replay.test.ts 6 项） |
| E1.7 | 并发可观测：在途任务数、各 Agent 延迟/失败率、队列深度 | P1 | ✅ | 库内 `ConcurrencyMetrics`（`src/orchestrator/metrics.ts`）：在途数、并发峰值、队列深度、完成/失败/超时计数、各封臣延迟 min/max/avg/p50/p95 与失败率，经 Orchestrator 注入、`bootKernel` 默认装配（5 项测试）；**已随 H2 经 `GET /api/metrics` 暴露**。背压/有界队列落地前队列深度恒 0（deferred #9） |

**容量目标（本机 mock 基线已产出，真机待标定）**：单意图并发 Agent 数、平台同时在途任务数、P95 决策延迟的本机回环基线见 [capacity-baseline.md](capacity-baseline.md)（舒适扇出 ≤16、验证到 128 在途分支零丢失）；真机阈值在 ≥3 真实封臣压测（deferred #9）后定值。

### E2. Skill 技能体系（一等模块）

| ID | 需求 | 优先级 | 状态 | 验收标准 |
|---|---|---|---|---|
| E2.1 | Skill 显式声明：输入/输出、权限、依赖、版本 | P0 | ✅ | SkillSpec 独立于 Agent Card：id/name/version(major.minor.patch)/inputs/outputs/permissions(封闭 scope 词汇 realm·execute·network·credential·mcp)/dependencies；`validateSkillSpecShape` 纯校验，注册强制形状校验、依赖须已注册（拒前向引用）、拒绝自依赖与依赖环；SkillRegistry 已在 `bootKernel` 装配（封臣 card 经 onRegister 钩子自动导入）并随 KernelSnapshot 持久化重启恢复，见 tests/skills-validation.test.ts、tests/kernel-skills-state.test.ts |
| E2.2 | Skill 注册中心：登记、检索、版本化 | P0 | ✅ | `src/skills/registry.ts` SkillRegistry：id+version 唯一键、多版本共存、get 默认最新 active（显式版本可查 deprecated 供审计）、deprecate 标记不删、按名/域（findByDomain）/标签检索、registerFromCard 从卡片登记目录版本、resolveTeam 多技能组队（10 项测试）；**已上驾驶员面**（v0.23）：`GET /api/skills[?domain|tag|status]`、`GET /api/skills/:id[/versions]`、`POST /api/skills`（E2.1 显式规格注册，**逐字段白名单拷贝**，任意 payload 不能把未知键写进持久目录） |
| E2.3 | Skill 安装 / 加固 / 卸载断权 | P1 | ✅ | `install/uninstall/harden`（src/skills/registry.ts）：安装即 active 生效；卸载立即 status=uninstalled，resolveTeam 即刻显示 missing、默认查询不可见（无缓存授权）；加固只能收窄权限（bare scope 可降到 scope:action，拒越权授予）、约束叠加合并，随 spec 持久化；deprecated 不可重装，见 tests/skills-lifecycle.test.ts（8 项）；**已上驾驶员面**（v0.23）：`POST /api/skills/:id/{install,uninstall,deprecate,harden}`（加固越权即 400，不做静默授予；deprecated 重装 409） |
| E2.4 | 协同决策按 Skill 自动组队：一意图映射到所需技能并选 Agent | P0 | ✅ | registry 有 findBySkill；SkillRegistry.resolveTeam 对多技能返回每技能 slot（providers/missing/ambiguous）与 complete/missingSkills/ambiguousSkills，多候选标 ambiguous 绝不静默随机选（E2.2 测试覆盖）；**已上驾驶员面**（v0.23）：`POST /api/skills/team`（`body.skills` 非空数组，歧义槽位原样返回供驾驶员选边） |
| E2.5 | Mentor 传授 Skill 给新 Agent/员工 | P2 | ✅ | 新增 `src/skills/mentor.ts`：`MentorshipLedger` 可审计带教路径——commission 要求 mentor 已是该技能在册提供者（非提供者/未知技能/自教均拒，技能须 active）、teach 记录传授单元、assess 以**胜任力检查而非出勤**认证（required 硬门全过 + 加权分 ≥ 阈值，默认 0.8，可自定义）；认证通过才经 `SkillRegistry.grantProvider` 把学习者登记为新提供者（进 resolveTeam），评估失败不动提供者集合；dismiss 作废；台账随 KernelSnapshot `mentorships` 段持久化重启恢复。见 tests/mentor-transfer.test.ts（9 项）、tests/kernel-mentor-state.test.ts；**已上驾驶员面**（v0.23）：`GET/POST /api/mentorships` + `/:id/{lessons,assess,dismiss}`，**刻意不暴露 `grantProvider` 直调**——提供者身份只能经认证获得，否则"学习结果可验证"被 HTTP 面绕过（tests/http-skills.test.ts 共 14 项） |

### E3. Realm 数据域（数据主权底座）

| ID | 需求 | 优先级 | 状态 | 验收标准 |
|---|---|---|---|---|
| E3.1 | connect 目录生成 manifest（确定性 realmId、类型固定 personal/enterprise） | P0 | ✅ | realpath 派生 id 且幂等；未 connect 拒绝读写；类型不可变 |
| E3.2 | 扫描式 search + read | P0 | ✅ | 文本白名单/剪枝/1MiB 上限/symlink 拒绝；路径穿越双检拒绝 |
| E3.3 | contentDigest 基线 | P0 | ✅ | 全量指纹稳定（顺序无关），供备份与漂移对账 |
| E3.4 | Realm MCP server 正式暴露（streamable HTTP + 鉴权） | P1 | 🚧 stdio | stdio 壳已落地（root/connect 不出协议）；正式触发：read-realm 封臣出现 |
| E3.5 | write 与驾驶员授权凭证 | P1 | 🚧 | **库内 write 已落地**（`FsRealmStore.write` + `src/realm/grant.ts`：personal 默认可写、readOnly 连接拒写、enterprise 写须 `DriverWriteGrant` 经 `verifyDriverWriteGrant` 校验形状/绑定域/有效期；tmp+rename 原子写、延续路径穿越/symlink/文本扩展名/1MiB 防护、写后 connect 快照与 `contentDigest`/itemCount 一致、可选审计回调；22 项测试）。**仍待 P1**：enterprise realm 的 connect（当前 connect 拒 enterprise）与 MCP write tool 暴露，随 E3.4 read-realm 封臣触发 |
| E3.6 | enterprise Realm 多租户 | P1 | ⬜ | 组织/部门/个人分级，与个人域默认二极管隔离 |
| E3.7 | 备份策略执行器 + 漂移检测 | P2 | ✅ | `src/vault/cli.ts` 零依赖执行器（`dist/vault/cli.js` / `npm run vault`）：`build`（密封 manifest-only 图）、`check`（L0 重连现盘对账 ok/changed/missing/unexpected，只读）、`backup`（密封 map+full bundle 两文件）、`restore`（digest 绑定校验后跨位写盘并复验）；密钥经 `ZEUS_VAULT_PASSPHRASE`（scrypt）或 `--key-file`（32 字节/hex），退出码 0 健康/1 错误/2 漂移/3 root 不可达供调度器判断；12 项 tests/vault-cli.test.ts + 编译产物全链路冒烟。**调度不内置**（design-vault §9：由外部 cron/systemd timer 触发，示例见 deployment.md §7） |
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
| E4.9 | fealty 签名链 v1（生产 RSK + R1/R2 接线） | P1 | 🚧 | 纯函数 + H1 public 封签 + **R1 internal 封签（v1.1：active\|revoked 两态 attestation，含吊销行的 internal 快照可封签离线验）均已接**；销项仍须生产 RSK 密钥托管/轮换与 R2 bayjf 客户端公钥验签、过八条验收（deferred #7，触发=bayjf 公开前） |
| E4.10 | 封臣背压降级顺序 | P2 | ⬜ | ≥3 封臣在线压测（deferred #9） |

### E5. HTTP 门面与名册

| ID | 需求 | 优先级 | 状态 | 验收标准 |
|---|---|---|---|---|
| E5.1 | roster internal/public 双投影 | P0 | ✅ | public 裁掉端点/探针/已吊销；确定性排序 |
| E5.2 | H1：/healthz、/api/roster/public（seal）、/api/roster（bearer） | P0 | ✅ | public 与 **internal 双份快照均封签、离线可验**（签名链 v1.1：attestation 扩 `active\|revoked` 两态，internal 含 revoked 行各自封签；revoked attestation 证永久吊销事实、不带硬过期，快照整体新鲜度由 seal maxAge 绑定；验签要求 attestation 状态与条目**精确匹配**，缺 source / 状态矛盾 fail-loud，仅 active 校验硬过期）；internal 响应 `Cache-Control: no-store`、bearer 常量时间比对、未配 token 整组不挂载；条目/provenance/签名三类篡改与过期均拒绝 |
| E5.3 | 持久化注册表（替换实例内存） | P1 | ✅ | `src/state/kernel-state.ts`：封臣注册表（含已吊销）、监督台升级队列（重建 task/conflict 幂等索引）、编排意图结果与原始请求（重启后幂等重放、resumeBranch 可用）经 `FileKernelStateStore` 原子落盘（tmp+rename）与版本校验恢复；已接入 `bootKernel` 启动装配（`ZEUS_STATE_FILE` 启动恢复、SIGINT/SIGTERM 原子落盘）。**Realm 连接状态已纳入快照并重启自动 reconnect（G4 ✅）**；metrics 运行态不持久化 |
| E5.4 | bayjf R2 验签封神榜 | P1 | ⬜ | 只消费 seal 快照并客户端验签；闸门 = E4.9 |
| E5.5 | H2 驾驶员 API + 服务端 SSE（含多 Agent 合并流） | P1 | ✅ | **H2 驾驶员 API**（bearer 保护，未配 `ZEUS_INTERNAL_TOKEN` 整组不挂载）：`POST /api/intents` 扇出、`GET /api/intents/:id` 回查、`POST /api/intents/:id/cancel`、`GET /api/escalations` + `POST .../:id/approve|reject|resolve`（resolve 把拍板立场回写聚合决策，打通 E6.2）、`GET /api/metrics`；端到端测试 `tests/http-h2.test.ts` + 进程级冒烟。**H3 服务端 SSE 已落地**：`GET /api/intents/:id/events` 经 `ProgressHub` 实时推送 branch-started/branch-ended/intent-finished（15s keepalive、已完成意图回放、flushHeaders），见 tests/http-sse.test.ts。**封臣上线入口已接**：`POST/DELETE /api/vassals` + `ZEUS_VASSAL_SEEDS`（G1）。**v0.23 补面（"内核有、驾驶员看不见"四类一次接上，全部 bearer 保护、未配 token 整组不挂载）**：`/api/memory/{events,facts,recall,retractions,integrity}` + `POST /api/memory/{retract,forget-subject}`、`/api/skills*` 与 `/api/mentorships*`、`GET /api/org/accountability/:intentId`、`GET /api/intents/:id/replay`；Realm/Vault 仍不上 HTTP（design-realm §6.1 唯一传输 MCP、design-vault §9 CLI+外部调度） |

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
| E8.1 | Map 藏宝图：加密 manifest + 恢复协议 | P1 | ✅ | `src/vault`：buildVault 从 Realm 连接出图，marks 只存 itemId + sha256 指纹（**正文零泄漏**有断言）；seal/open 走 AES-256-GCM（scrypt 口令派生或 raw 32-byte key），密钥与图分离；原地 restoreDryRun 重连校验。**按图真实恢复走通**，见 tests/vault.test.ts（20 项） |
| E8.2 | 藏宝图备份与备份思路 | P1 | ✅ | 图经 seal 加密静态保存、可复制；packFull 产出 manifest-only / full 两档（full 带加密内容包）；restoreFromBundle 在目录被清空或换新位置时写盘恢复并复验，恢复流程经测试演练。自动/异地/云备份为非目标（design-vault §9） |
| E8.3 | Diary 日记：记忆叙事化备份 | P2 | ✅ | **已落地**（`src/diary`，[design-diary](design-diary.md) v0.1）：buildDiary 纯函数按日历天（UTC/IANA 时区）分桶、确定性排序、renderEventContent 只呈现不臆造（string / ClaimContent / 对象 / 空内容四态、超长截断标注）、可选纳入事实、算内容 digest；每行锚 eventId、provenance 覆盖全部来源，混 realm 拒绝；persistDiary 经 Realm.write 写 `diary/YYYY-MM-DD.md`（幂等）、exportDiary 稳定 JSON；buildDiariesFromState 按 realm 分组、按需（realm/date）构建；**驾驶员 HTTP**：GET /api/diary（按 realm/date 读，缺日 404）、POST /api/diary/generate（经 Realm.write 落 `diary/YYYY-MM-DD.md`，无可写 realm 409、无事件 400）。25 项测试（diary 19 + http-diary 6）含真实 realm 往返 |
| E8.4 | 传承（dead-man switch + 密钥托管） | P3 | ⬜ | 触发可靠、可撤销；法律框架齐备（deferred #2/#3） |
| E8.5 | 记忆整理与遗忘权（事件→事实、混合检索、擦除、漂移对账） | P1 | ✅ | **补记行**：能力在 v0.8–v0.12 已落地并验收，此前只进演进日志、PRD 无对应需求行。`src/memory`（[design-memory-consolidation](design-memory-consolidation.md) v0.3）：append-only 事件日志，**事实无公开写入口**（只经纯函数 `consolidate` 产出、逐条带 provenance）、观察去重累积、矛盾默认 disputed 并确定性升级进监督台、置信度按可靠度加权（指标 failureRate 派生 + 驾驶员纠错 −0.15/次）、跨 realm 读写拒绝并审计、沿 runId 离线回放；P2 三项齐（BM25+向量混合检索与可重建派生索引、`retractFacts`/`forgetSubject` 遗忘权 + tombstone、`reconcileMemoryStates`/`verifyMemoryState` 漂移对账与横切不变量）；随 KernelSnapshot 持久化重启恢复。**v0.23 上驾驶员面**：`/api/memory/{events,facts,recall,retractions,integrity}` + `POST /api/memory/{retract,forget-subject}`（11 项 tests/http-memory.test.ts；本面只有读与擦除，没有事实写入口） |

### E9. 企业组织层

| ID | 需求 | 优先级 | 状态 | 验收标准 |
|---|---|---|---|---|
| E9.1 | Mentor Agent：文化/业务/职责带教 | P2 | ⬜ | 新员工首日无人工介入获得岗位上下文 |
| E9.2 | 上岗即用流程 | P2 | ⬜ | 账号→授权→Mentor→首日任务全链路 |
| E9.3 | 虚拟部门编制（Team）与结果责任 | P2 | ✅ | **已落地**（`src/org`，[design-org](design-org.md) v0.1）：Department 不可变、单 lead、成员按 agentId 唯一（createDepartment/assignMember/removeMember/setLead）；buildOrgChart/renderOrgMarkdown 编制可视；traceAccountability 把真实 FanOutResult 追到执行 Agent、部门 lead（去重）、拍板 driver，无编制 Agent 标 unassigned 不丢弃；**OrgRegistry** 有状态持有编制、纳入 KernelSnapshot 随 boot 持久化（重启不丢）；**驾驶员 HTTP**：GET /api/org/chart、POST /api/org/departments、POST /api/org/departments/:id/members（建编/安置 lead·member，未知部门 404、重复 409）。29 项测试（org 15 + org-registry 8 + http-org 6）；**责任链已上驾驶员面**（v0.23）：`GET /api/org/accountability/:intentId` 把已存意图投影为 执行 Agent → 部门 lead → 拍板驾驶员（+5 项 http-org-accountability；需 orgRegistry 与 orchestrator 同时装配才挂载） |
| E9.4 | 外部 Agent 信任分级与沙箱 | P2 | ⬜ | 首个矩阵外 Agent 接入前完成（deferred #5） |

### E10. 平台工程

| ID | 需求 | 优先级 | 状态 | 验收标准 |
|---|---|---|---|---|
| E10.1 | CI（typecheck/test/build 矩阵） | P0 | ✅ | `.github/workflows/ci.yml`（Node 20/22 矩阵，npm ci → typecheck → test → build，零 secret）。**2026-09-25 首次真机确认**：dev 分支 push `206af94..3e91a9a` 触发 run 36024156638，两个矩阵各约 28s **全绿**（472/472，无 flaky 复现）——此前各批次只有"本地按 CI 序列实跑全绿"，GitHub 侧结果一直未观测。遗留注解（checkout@v4/setup-node@v4 target Node 20 被强制跑在 24、ubuntu-latest 2026-10-19 迁移）登记 deferred #12 |
| E10.2 | 真机部署：pr-helper + Zeus 门面 | P1 | ⬜ | 支撑 E4.8 真机验收与 Zeus↔loom 联调 |
| E10.3 | 库公共入口与构建产物 | P0 | ✅ | src/index.ts 聚合导出；dist 含 .d.ts |
| E10.4 | 并发压测与容量基线 | P1 | ✅ | **本机 mock 回环基线已产出 v0.2**（[capacity-baseline.md](capacity-baseline.md)，`npm run bench:capacity`），四场景：A 扇出宽度、B 并发意图、**C H2 门面全链路（真实 `app.listen` 回环 TCP + bearer + JSON，128 分支点门面附加仅约 5–10ms 墙钟、吞吐约低 10–15%，低并发几乎无差）**、**D 高并发取消传播（128 个 input-required 挂起分支 14–18ms 全部取消、mock farm 实收 240 个 tasks/cancel 零丢失零重复）**；单意图扇出 ≤16 墙钟≈单封臣（内核附加 5–15ms）、128 在途分支零丢失、metrics 峰值准确。**口径限制**：D 取消的是已 settle 的非终态（input-required）分支，对仍 working、fanOut 未返回的进行中意图尚无按 intentId 的一等取消；真机容量（LLM/网络）待 ≥3 真实封臣 + deferred #9 有界队列后按同法重测 |

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
| v0.13 | 2026-09-22 | E2.5 Mentor 传授落地：新增 `src/skills/mentor.ts` `MentorshipLedger`（commission 须在册提供者、teach 记录、assess 胜任力硬门+加权阈值、认证才 grantProvider、dismiss）；SkillRegistry 增 isProvider/grantProvider；台账经 KernelSnapshot `mentorships` 段持久化；E2.5 升 ✅；新增 10 项测试；全量 290 绿（41 文件） |
| v0.14 | 2026-09-23 | 新增架构立场文档 [design-agentic-integration](design-agentic-integration.md) v0.4（本文件不复制全文）：Agent 是新的编排/集成层而非替代 REST，两层形态=智能层（协商/非确定）压在原语层（契约/确定/可回放）之上；边界收口为「结构化意图→确定性闸门」，按可逆性/确定性需求/可验证性/爆炸半径四轴划分；行业现状五种主流实践与 L1 连接/L2 工具设计/L3 护栏三层成熟度；明确 Zeus 定位为 **AI 原生多 Agent 团队运行时**，目标软件的 Agent 可用成熟度决定团队如何调用。无代码变更 |
| v0.15 | 2026-09-23 | Vault 藏宝图与恢复协议落地（[design-vault](design-vault.md) v0.1）：新增 `src/vault`——buildVault 出图只存引用+逐 item 指纹（正文零泄漏）、AES-256-GCM seal/open（scrypt/raw key，密钥分离）、L0 原地 restoreDryRun 重连校验与漂移检测、L1 packFull 加密内容包 + restoreFromBundle 跨位写盘恢复（FsRestoreSink）；Realm 增只读 `entries()` 枚举；E8.1/E8.2 升 ✅、E3.7 升 🚧；新增 20 项测试，全量 310 绿（42 文件） |
| v0.16 | 2026-09-23 | E3.7 备份策略执行器落地：新增 `src/vault/cli.ts` 零依赖 CLI（build/check/backup/restore，密钥经口令 env 或 key-file，退出码 0/1/2/3），`npm run vault` 入口；deployment.md 增 §7 备份恢复与 cron 示例（调度不内置，design-vault §9 边界不变）；12 项 CLI 测试 + 编译产物全链路冒烟（出图→篡改 exit 2→全包→销毁→跨位恢复内容一致→错钥 exit 1）；E3.7 升 ✅；全量 322 绿（43 文件） |
| v0.17 | 2026-09-24 | **E1.6 离线决策回放器**（`src/orchestrator/replay.ts`：replayDecision/replayDecisions/replaySnapshot/renderReplay，纯离线只读、确定性时间线、损坏 fail-loud，8 项测试）升 ✅；**E10.4 本机容量基线**（`scripts/bench-capacity.mjs` + `npm run bench:capacity` + docs/capacity-baseline.md：真实回环 HTTP mock 封臣群，扇出宽度/并发意图两场景，≤16 扇出墙钟≈单封臣、128 在途分支零丢失，明确 mock 近似与真机重测触发条件）升 ✅；全量 330 绿（44 文件） |
| v0.18 | 2026-09-24 | **E1.3 LLM-as-judge 对抗复核接决策后端**：新增 `src/orchestrator/judge.ts` `judgeDecision` 纯函数（规则有结论后独立复核：同意背书、高置信分歧升级 judge-review 冲突走驾驶员闭环、低置信/未校准/故障只记录），OrchestratorOptions 增 judge* 开关组（默认关），fanOut/resumeBranch 接线，与 S2 仲裁互斥；Conflict 增 `kind:split|judge-review`、FanOutResult 增 `judgeReview`；E1.6 回放器增 judge-reviewed 时间线节点；index 公共导出；新增 14 项测试，全量 344 绿（45 文件）；E1.3 升 ✅（多方案 noul 开放生成仍待后续） |
| v0.19 | 2026-09-24 | **E3.5 Realm write 与驾驶员授权凭证（库内部分）**：`FsRealmStore.write`（personal 默认允许、readOnly 拒、enterprise 须凭证；字符串/JSON 序列化、自动 itemId、tmp+rename 原子写、路径/symlink/扩展名/1MiB 防护、写后快照与 contentDigest 一致、审计回调），新增 `src/realm/grant.ts` `verifyDriverWriteGrant` 纯函数（missing/malformed/wrong-realm/expired 门），RealmStore 接口补 write、新增 UnauthorizedRealmWriteError/UnsupportedWriteError，index 公共导出；enterprise connect 与 MCP write tool 仍 P1；新增 22 项测试，全量 366 绿（46 文件）；E3.5 ⬜→🚧 |
| v0.20 | 2026-09-24 | **E8.3 Diary 日记 + E9.3 虚拟部门编制落地**：`src/diary` 把记忆事件按天叙事成可回溯（每行锚 eventId）、可经 Realm.write 落盘 / 稳定 JSON 导出的日记（19 测试，design-diary）；`src/org` 建立部门编制（单 lead、成员唯一、不可变）与 traceAccountability 责任链（执行 Agent → 部门 lead → 拍板驾驶员，无编制标 unassigned，15 测试，design-org）；全量 411 绿（49 文件），E8.3/E9.3 升 ✅ |
| v0.21 | 2026-09-24 | **Diary 与 Org 接通持久化与驾驶员 HTTP**：OrgRegistry 有状态编制纳入 KernelSnapshot 随 boot 重启恢复（8 测试）；Org HTTP（chart/建编/安置，6 测试）；buildDiariesFromState 按 realm 分组构建 + Diary HTTP（GET 读、POST generate 经 Realm.write 落盘，6 测试）；全量 431 绿（52 文件） |
| v0.22 | 2026-09-24 | **签名链 v1.1 internal 名册封签 + 容量四场景 + 评审 v0.4**：E5.2 internal `GET /api/roster` 由裸快照改为封签信封（attestation 扩 active\|revoked 两态，revoked 证永久吊销无硬过期、新鲜度由 seal maxAge 绑定，验签状态精确匹配防提升/掩盖、缺 source 或矛盾 fail-loud，no-store），public 路径不变，signing 新增 5 项；E10.4 容量基线升 v0.2，增 C（H2 门面全链路，附加 5–10ms/吞吐约低 10–15%）与 D（128 挂起分支 14–18ms 全取消、240 cancel 零丢失）；E4.9 仍 🚧（R1 internal 已补，待生产 RSK 托管/轮换与 R2 bayjf 公钥验签，deferred #7）；项目级评审刷新到 v0.4（库内已无 P0 功能缺口，产品级上线仅剩仓库外真机/凭证/发布动作）；全量 436 绿（52 文件） |
| v0.23 | 2026-09-24 | **驾驶员 HTTP 补面（接线批次，不新增内核能力）**：复核"库内已无可闭环任务"的判断后发现它只对 **P0 功能缺口** 成立——四块已落地能力经 HTTP 完全不可见，本批一次接上。① **Memory 面**（E8.5 补记行）：`/api/memory/{events,facts,recall,retractions,integrity}` + `POST retract|forget-subject`，只读与擦除、无事实写入口；② **Skills 面**（E2.1/2.2/2.3/2.4）：目录检索·显式规格注册（逐字段白名单，任意 payload 写不进持久目录）·装卸/加固/废弃（越权加固 400、deprecated 重装 409）·组队；③ **Mentorship 面**（E2.5）：立项/授课/评估/作废，**不暴露 `grantProvider` 直调**（提供者身份只能经认证获得）；④ **Org 责任链**（E9.3）：`GET /api/org/accountability/:intentId`；⑤ **决策回放**（E1.6）：`GET /api/intents/:id/replay`（含 `?format=text`），配 `Orchestrator.getRequest()` 取回原始派发输入，无法回放的存储记录返回 500 而非半条时间线。新增 36 项测试，全量 **472 绿（56 文件）**；此前"未定位的并行 flaky"定位到成因（无 vitest 配置 × 5s 默认超时 × CPU 争抢），按先例放宽 vault L1 与 RSK keygen 两处，根治登记 deferred #11；README 纠正两处过期表述（internal 名册"不封签"、H3 SSE"按需立项"）并补 memory 模块行 |
