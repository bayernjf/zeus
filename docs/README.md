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
| 知道现在做到哪、接下来做什么 | [handoff.md](../handoff.md) ★ 交接必读 |
| 理解个人版与企业版的差异 | [product-portrait.md](product-portrait.md) §4 用户画像 |
| 理解产品矩阵如何并入 Zeus | [product-portrait.md](product-portrait.md) §7 封臣式联邦 |
| 查看开放问题 / 缓做项 | [deferred-items.md](deferred-items.md) |
| 接手某个模块的设计决策 | 对应 [design-\*.md](design-vassal-protocol.md)（封臣协议：A2A 超集，fealty/战报/升级/治理） |
| 理解 Realm 数据域（目录即数据库）的接口契约 | [design-realm.md](design-realm.md)（connect/search/read/write、数据二极管、藏宝图依赖） |
| 理解 bayjf 如何从陈列馆升级为封神榜名册 | [design-bayjf-roster.md](design-bayjf-roster.md)（名册字段映射、内外双视图、签名链闸门、R0–R2） |
| 设计/实现名册公开前的签名验签链 | [design-fealty-signing.md](design-fealty-signing.md)（威胁模型、Zeus 单签 v1、Ed25519+JCS、两层信封、吊销失效语义、验收用例） |
| 了解 Zeus 服务端 HTTP 栈怎么选、端点怎么长 | [design-http-transport.md](design-http-transport.md)（网络面划分、Fastify+长驻裁决、薄传输层、H1–H3 端点） |
| 了解 AI 协作 / commit 约定 | [AGENTS.md](../AGENTS.md) + [git-commit-message.md](../git-commit-message.md) |

## 文档状态约定

- **现行**：当前事实，AI 与开发者以此为准；改动直接更新。
- **历史**：决策过程记录，结论已体现在现行文档；如需修改结论，改现行文档而非历史记录。
- **归档**：冻结内容，只读参考，不追加新内容。
- **实施进度**：统一记在 [handoff.md](../handoff.md)，设计文档只写设计，不重复记进度。
- **完整清单**：所有文档（含一句话定位）见 [handoff.md](../handoff.md)「Project documents」区——那是清单的单一事实源，新增文档先在那里登记。
