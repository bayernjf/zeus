# Zeus 文档地图

> **场景导航 + 文档状态约定**。完整文档清单（每个文档的一句话定位）的单一事实源是 [handoff.md](../handoff.md) 的「Project documents」区——本文档不重复维护清单，只回答「我想做某事该看哪个」。

## 怎么读这个仓库（按场景）

| 我想… | 看 |
| --- | --- |
| 知道 Zeus 是什么、愿景与设计哲学 | [product-portrait.md](product-portrait.md) ★ |
| 盘点全部功能点：有什么、在哪、什么状态 | [feature-inventory.md](feature-inventory.md) v0.8 ★（11 个能力域 × 77 条 HTTP 路由 × 4 类 CLI × 118 条 export 语句（运行时 213 个导出）；含「已实现但未接线」专节，2026-10-03 数据二极管接线后为 1 项，同日执行授权票据三项接线后仍为 1 项派发闸门） |
| 看代码审出了哪些缺陷、哪几条要先修 | [audit-2026-09.md](audit-2026-09.md) v0.6（首轮全量静态审计：A 12 / B 34 / C 22 条，逐条带 `file:line` 与复检命令；**A 级 12 条、B 级 34 条已于 2026-10-01 全部修复，C 级 22 条已于 2026-10-02 全部修复**（1–17 条于 2026-10-01 晚间随 A/B 批次落地、12/19/20/22 于 2026-10-02 修复，commit 对照与植入证据见 audit §5/§8）；§6「注释承诺了代码没做的事」中 `startServer()` 一行已于 2026-10-02 闭合；**§4.2 row3 的数据二极管收缩已于 2026-10-03 修复闭合**（Active work 103：policy×origin 判档、`realmHitsOrigin`、两条审计值）） |
| 查看需求拆解、优先级与验收标准 | [prd.md](prd.md) ★ |
| 梳理 Agent 技术议题与探索优先级 | [tech-exploration-map.md](tech-exploration-map.md) ★ |
| 理解多 Agent 记忆如何沉淀与整理 | [design-memory-consolidation.md](design-memory-consolidation.md) |
| 理解 supervisor 与 subagent 的控制关系 | [design-supervision.md](design-supervision.md) |
| 理解一个意图如何扇出多 Agent 并行并聚合成决策 | [design-fan-out.md](design-fan-out.md)（扇出/幂等/取消传播/合并流/规则聚合/冲突升级，PRD E1） |
| 理解执行 Agent 饱和时如何把溢出意图分流给同技能最优提供方 | [design-backpressure.md](design-backpressure.md)（deferred #9：饱和信号、候选集过滤、可靠度×延迟评分重排、显式靶硬钉、全饱和回退拒绝+审计） |
| 理解决策后端抽象层（模型无关）怎么接入决策能力 | [design-decision-backend.md](design-decision-backend.md)（DecisionBackend 端口：noul/choice/score、两类实现家族——专用决策模型 Jev（快层）/ 传统 LLM 适配（慢层）、四接线位、数据主权硬线） |
| 探讨 AI 时代多系统怎么沟通、Agent 与确定性原语边界划在哪 | [design-agentic-integration.md](design-agentic-integration.md)（Agent 作编排层的两层架构、划边界四轴、确定性闸门、钉死/交给清单、MCP/A2A/Skill 插座） |
| 给数据目录（含内核状态文件）出备份清单、做备份与恢复演练 | [design-vault.md](design-vault.md) v0.2（`MapSource`：Realm 或文件白名单、图只存引用 + 指纹、AES-GCM 密钥分离、`LiveSource` 原地校验/漂移检测、加密备份包跨位恢复，E8.1/E8.2 + deferred #13）；CLI 操作（build/check/backup/restore、`--files` 白名单、cron 示例）见 [deployment.md](deployment.md) §7（E3.7） |
| 把记忆按天写成可回溯的日记，落盘 / 导出 / 经 HTTP 读取生成 | [design-diary.md](design-diary.md)（事件按天分桶/排序、内容不臆造、锚 eventId、经 Realm.write 落 `diary/YYYY-MM-DD.md`；H2 `GET /api/diary`、`POST /api/diary/generate`，E8.3） |
| 建立虚拟部门编制、持久化、经 HTTP 建编安置、把任务结果追到责任人和操作者 | [design-org.md](design-org.md)（部门单 lead/成员唯一、org chart 编制可视、OrgRegistry 持久化重启不丢、H2 chart/建编/安置、traceAccountability 责任链，E9.3） |
| 知道内核能扛多少并发、怎么复跑压测 | [capacity-baseline.md](capacity-baseline.md)（E10.4 本机 mock 回环基线 **v0.3**，五场景：A 扇出宽度 / B 并发意图 / C H2 门面全链路吞吐 / D 高并发取消传播 / **E 并发闸门代价（`--cap` 显式开启）**；容量初步回答、绝对值散布与不变量、`npm run bench:capacity` 复跑方法、真机重测条件） |
| 回放一个历史决策（谁参与、什么输入、什么立场、怎么聚合的） | `src/orchestrator/replay.ts`（E1.6：replayDecision/replaySnapshot/renderReplay，从内核快照离线重建确定性时间线） |
| 了解行业内决策层现状与分化趋势 | [research-decision-layer-industry.md](research-decision-layer-industry.md)（LLM-as-judge 主流 + 四条分化路线、对决策后端设计的印证、来源清单） |
| 想知道项目离可上线还有多远 | [review-mvp-2026-09.md](review-mvp-2026-09.md)（现行 **v0.22**：三维评审 + MVP 判定，**每轮重跑取证而不采信上一轮记录**。**当前判定：产品核心完全可用 MVP = ✅；可上线交付真实用户 = ❌**——v0.22（2026-10-03，macOS 本机，1048/97）关闭 deferred #35（出站 DNS 重绑定守卫）、推进 deferred #33（执行授权票据签发/审计/nonce 持久化三项接线），并修掉一条让最近两次 CI 失败的 smoke 隐式 any；出货件已变、镜像容器级四项无新证据。上一轮 v0.21 抓并修掉功能清单规模普查缺陷、三段计数入库为断言，逐条见下一行） |
| 上线前要跑哪些验收、哪几条是硬阻塞、每次必跑的回归门 | [pre-launch-checklist.md](pre-launch-checklist.md)（A 硬阻塞 / B 部署运营 / C 阈值标定 / D 待决定 / E 发布动作 / F 每次必跑的验证门；每条带证据分级：实测 / 记录 / 待做） |
| 知道现在做到哪、接下来做什么 | [handoff.md](../handoff.md) ★ 交接必读 |
| 理解个人版与企业版的差异 | [product-portrait.md](product-portrait.md) §4 用户画像 |
| 理解产品矩阵如何并入 Zeus | [product-portrait.md](product-portrait.md) §7 执行 Agent 式联邦 |
| 查看开放问题 / 缓做项 | [deferred-items.md](deferred-items.md) |
| 接手某个模块的设计决策 | 对应 [design-\*.md](design-vassal-protocol.md)（执行 Agent 协议：A2A 超集，fealty/结果回传/升级/治理） |
| 看 UI 候选方案 | [design-ui.md](design-ui.md)（草案：A 实时监督台 / B 多视图工作台 / C 双门户 / D 终端 TUI；立项条件见 deferred #34） |
| 统一 UI 的颜色/间距/字号与多语言，避免各页样式对不齐 | [design-ui-foundations.md](design-ui-foundations.md)（现行：design token 三层模型、light/dark + TUI 子集、i18n key/ICU、无裸值与审计等价校验闸门） |
| 理解执行型 Agent 的不可逆写操作怎么获得一次性授权 | [design-execution-delegation.md](design-execution-delegation.md)（v0.1 现行：操作者一次性短时授权票据，Ed25519 签名/能力白名单/单 nonce 防重放/fail-closed；纯原语已落，派发与 A2A 投递待 pr-helper 凭据接口，deferred #33） |
| 理解 Realm 数据域（目录即数据库）的接口契约 | [design-realm.md](design-realm.md) v0.7（connect/search/read/write、数据二极管执行点与 **§3.1 `dataPolicy` 收缩契约（2026-10-03 已落地）**、企业域三级租户与双域授权 §7、**签名且一次性的企业写凭证 §7.7**、备份清单依赖） |
| 决定要不要把历史标识符（`vassal`/`vault`/`ZEUS_*`/`x-zeus-fealty`）改成工程术语 | [design-naming-migration.md](design-naming-migration.md)（四档代价 + 逐档迁移机制 + 本轮结论 T2/T3/T4 不做）|
| 看懂一个 Agent 怎么"上岗即用"：四道门与首日简报 | [design-onboarding.md](design-onboarding.md)（seat/account/authorization/mentorship 现算不缓存、显式豁免、first-task 真派发） |
| 理解 bayjf 如何从陈列馆升级为公开签名目录名册 | [design-bayjf-roster.md](design-bayjf-roster.md)（名册字段映射、内外双视图、签名链闸门、R0–R2） |
| 设计/实现名册公开前的签名验签链 | [design-fealty-signing.md](design-fealty-signing.md)（威胁模型、Zeus 单签 v1、Ed25519+JCS、两层信封、吊销失效语义、验收用例） |
| 设计/裁定 Zeus 的入站 A2A 面（别的 Agent 派任务给 Zeus） | [design-inbound-a2a.md](design-inbound-a2a.md)（deferred #19，v0.1 方向固化：Zeus 自己的 agent card、`tasks/send` 落 H2 意图面、三问暂定答案；实现待真实上游触发） |
| 真实核对 Jev 决策后端（等 key，规程已备） | [verify-jev-backend.md](verify-jev-backend.md)（v0.1：四个未证实假设逐项核对步骤 + 判定矩阵与不符处置；复用 `npm run verify:decision-backend`，无新代码） |
| 了解 Zeus 服务端 HTTP 栈怎么选、端点怎么长 | [design-http-transport.md](design-http-transport.md)（网络面划分、Fastify+长驻裁决、薄传输层、H1–H3 端点） |
| 把 Zeus 进程真正跑起来 / 上线（Docker、密钥、状态卷、备份调度） | [deployment.md](deployment.md)（部署手册：Dockerfile 与 compose、RSK 密钥生成与生产守卫、systemd 备选、§7 Vault 备份恢复 CLI 与 cron、上线检查清单） |
| 让外部系统经 MCP 接进 Zeus，或把 Zeus 的数据域接进别人的宿主 | [mcp-integration.md](mcp-integration.md) **v0.1**（对接方视角的契约与用法：stdio 服务端的根授权两条入口 / 资源与工具参考 / 快照 vs 实时读取 / 7 个错误码 / 四条"这里没有"的边界；客户端连接器的封闭权限词汇与能力裁剪层次；请求-响应原文与复跑命令） |
| 翻译项目术语（执行 Agent/结果回传/备份清单 → 行业用语） | [terminology.md](terminology.md)（31 行映射表：叙事隐喻 ↔ 工程原语 ↔ 行业标准用语 + **冲突风险分级 A/B/C**（哪些可直说、哪些要加注、哪些与既有术语同名异义必须改写）+ 使用约定：内部保留隐喻、对外用专业词） |
| 了解 AI 协作 / commit 约定 | [AGENTS.md](../AGENTS.md) + [git-commit-message.md](../git-commit-message.md) |

## 文档状态约定

- **现行**：当前事实，AI 与开发者以此为准；改动直接更新。
- **历史**：决策过程记录，结论已体现在现行文档；如需修改结论，改现行文档而非历史记录。
- **归档**：冻结内容，只读参考，不追加新内容。
- **实施进度**：统一记在 [handoff.md](../handoff.md)，设计文档只写设计，不重复记进度。
- **完整清单**：所有文档（含一句话定位）见 [handoff.md](../handoff.md)「Project documents」区——那是清单的单一事实源，新增文档先在那里登记。
