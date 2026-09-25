# Zeus 文档地图

> **场景导航 + 文档状态约定**。完整文档清单（每个文档的一句话定位）的单一事实源是 [handoff.md](../handoff.md) 的「Project documents」区——本文档不重复维护清单，只回答「我想做某事该看哪个」。

## 怎么读这个仓库（按场景）

| 我想… | 看 |
| --- | --- |
| 知道 Zeus 是什么、愿景与设计哲学 | [product-portrait.md](product-portrait.md) ★ |
| 查看需求拆解、优先级与验收标准 | [prd.md](prd.md) ★ |
| 梳理 Agent 技术议题与探索优先级 | [tech-exploration-map.md](tech-exploration-map.md) ★ |
| 理解多 Agent 记忆如何沉淀与整理 | [design-memory-consolidation.md](design-memory-consolidation.md) |
| 理解 supervisor 与 subagent 的控制关系 | [design-supervision.md](design-supervision.md) |
| 理解一个意图如何扇出多 Agent 并行并聚合成决策 | [design-fan-out.md](design-fan-out.md)（扇出/幂等/取消传播/合并流/规则聚合/冲突升级，PRD E1） |
| 理解决策后端抽象层（模型无关）怎么接入决策能力 | [design-decision-backend.md](design-decision-backend.md)（DecisionBackend 端口：noul/choice/score、两类实现家族——专用决策模型 Jev（快层）/ 传统 LLM 适配（慢层）、四接线位、数据主权硬线） |
| 探讨 AI 时代多系统怎么沟通、Agent 与确定性原语边界划在哪 | [design-agentic-integration.md](design-agentic-integration.md)（Agent 作编排层的两层架构、划边界四轴、确定性闸门、钉死/交给清单、MCP/A2A/Skill 插座） |
| 给数据目录出藏宝图、做备份与恢复演练 | [design-vault.md](design-vault.md)（图只存引用 + 指纹、AES-GCM 密钥分离、原地校验/漂移检测、加密备份包跨位恢复，E8.1/E8.2）；CLI 操作（build/check/backup/restore、cron 示例）见 [deployment.md](deployment.md) §7（E3.7） |
| 把记忆按天写成可回溯的日记，落盘 / 导出 / 经 HTTP 读取生成 | [design-diary.md](design-diary.md)（事件按天分桶/排序、内容不臆造、锚 eventId、经 Realm.write 落 `diary/YYYY-MM-DD.md`；H2 `GET /api/diary`、`POST /api/diary/generate`，E8.3） |
| 建立虚拟部门编制、持久化、经 HTTP 建编安置、把任务结果追到责任人和驾驶员 | [design-org.md](design-org.md)（部门单 lead/成员唯一、org chart 编制可视、OrgRegistry 持久化重启不丢、H2 chart/建编/安置、traceAccountability 责任链，E9.3） |
| 知道内核能扛多少并发、怎么复跑压测 | [capacity-baseline.md](capacity-baseline.md)（E10.4 本机 mock 回环基线 **v0.3**，五场景：A 扇出宽度 / B 并发意图 / C H2 门面全链路吞吐 / D 高并发取消传播 / **E 并发闸门代价（`--cap` 显式开启）**；容量初步回答、绝对值散布与不变量、`npm run bench:capacity` 复跑方法、真机重测条件） |
| 回放一个历史决策（谁参与、什么输入、什么立场、怎么聚合的） | `src/orchestrator/replay.ts`（E1.6：replayDecision/replaySnapshot/renderReplay，从内核快照离线重建确定性时间线） |
| 了解行业内决策层现状与分化趋势 | [research-decision-layer-industry.md](research-decision-layer-industry.md)（LLM-as-judge 主流 + 四条分化路线、对决策后端设计的印证、来源清单） |
| 想知道项目离可上线还有多远 | [review-mvp-2026-09.md](review-mvp-2026-09.md)（现行 v0.7：功能性/完整度/可上线三维评审、v0.1 五硬阻塞重判；结论=M1/M2 达成、M3 **差执行不差工程**。**v0.5 更正 E4.8 归因（pr-helper 早已上线，卡的是没人对线上跑过一次验收）；v0.6 关闭"push + 云端 CI 首绿"关口；v0.7 收口 E3.6/E6.4，并更正 §C 自己的"库内已无可闭环项"判断 → 剩余项分"仓库外执行"与"库内可做但需拍板"两类**） |
| 知道现在做到哪、接下来做什么 | [handoff.md](../handoff.md) ★ 交接必读 |
| 理解个人版与企业版的差异 | [product-portrait.md](product-portrait.md) §4 用户画像 |
| 理解产品矩阵如何并入 Zeus | [product-portrait.md](product-portrait.md) §7 封臣式联邦 |
| 查看开放问题 / 缓做项 | [deferred-items.md](deferred-items.md) |
| 接手某个模块的设计决策 | 对应 [design-\*.md](design-vassal-protocol.md)（封臣协议：A2A 超集，fealty/战报/升级/治理） |
| 理解 Realm 数据域（目录即数据库）的接口契约 | [design-realm.md](design-realm.md)（connect/search/read/write、数据二极管、企业域三级租户与双域授权 §7、藏宝图依赖） |
| 理解 bayjf 如何从陈列馆升级为封神榜名册 | [design-bayjf-roster.md](design-bayjf-roster.md)（名册字段映射、内外双视图、签名链闸门、R0–R2） |
| 设计/实现名册公开前的签名验签链 | [design-fealty-signing.md](design-fealty-signing.md)（威胁模型、Zeus 单签 v1、Ed25519+JCS、两层信封、吊销失效语义、验收用例） |
| 了解 Zeus 服务端 HTTP 栈怎么选、端点怎么长 | [design-http-transport.md](design-http-transport.md)（网络面划分、Fastify+长驻裁决、薄传输层、H1–H3 端点） |
| 把 Zeus 进程真正跑起来 / 上线（Docker、密钥、状态卷、备份调度） | [deployment.md](deployment.md)（部署手册：Dockerfile 与 compose、RSK 密钥生成与生产守卫、systemd 备选、§7 Vault 备份恢复 CLI 与 cron、上线检查清单） |
| 了解 AI 协作 / commit 约定 | [AGENTS.md](../AGENTS.md) + [git-commit-message.md](../git-commit-message.md) |

## 文档状态约定

- **现行**：当前事实，AI 与开发者以此为准；改动直接更新。
- **历史**：决策过程记录，结论已体现在现行文档；如需修改结论，改现行文档而非历史记录。
- **归档**：冻结内容，只读参考，不追加新内容。
- **实施进度**：统一记在 [handoff.md](../handoff.md)，设计文档只写设计，不重复记进度。
- **完整清单**：所有文档（含一句话定位）见 [handoff.md](../handoff.md)「Project documents」区——那是清单的单一事实源，新增文档先在那里登记。
