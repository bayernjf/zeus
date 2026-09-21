# Handoff

State of Zeus as of 2026-09-21.

> Zeus 处于「核心内核起步」阶段：A1 注册中心、A2 派发器、A4 监督台最小版已落地（纯 TS 库 + vitest）。本文件记录项目当前状态、活跃任务与文档索引。

## Current state

- 已完成上层方向定位与产品画像 v0.1（2026-09-21）。
- 项目骨架文档已按 agent-world 惯例建立：AGENTS.md / handoff.md / docs/。
- 已 `git init` 并完成首次 docs 提交；尚未选型技术栈。

## Active work

1. ~~拍板封臣协议形态~~ ✅ 2026-09-21 已定：A2A 超集（deferred #1 销项）。
2. ~~起草 design-vassal-protocol.md~~ ✅ 2026-09-21 完成 v0.1。
3. pr-helper 封臣验收（design-vassal-protocol.md §7，共 6 项）：#1 Agent Card + fealty ✅、#2 tasks/sendSubscribe 全流程 ✅（JSON-RPC + SSE，14 项单测）、#3 战报三字段 ✅、#4 escalation ✅（merge-pr / production-rollback execute 模式升级）。剩 #5 Zeus 派发侧（脱敏/吊销/审计）、#6 标准客户端守护测试（需部署后真机验证）。已知限制：任务存储为实例内存（跨调用尽力而为）、execute 模式待凭据委派。
4. bayjf 名册改造方案（数据来源 = Agent Card + fealty，单一事实源在封臣）。
5. Realm 契约开放问题拍板（design-realm.md §6：传输层 HTTP vs MCP；检索实现）→ 之后启动 Realm P0 实现。
6. ~~loom 封臣接入~~ ✅ 2026-09-21 负责人裁决四项全按草案；loom 侧第一阶段 plan 模式已落地（Q150：`backend/app/core/a2a/` card·skills·rpc·router，12 单测 + 10 集成测试全绿，commit 0ba84d3/6404b99 在 loom dev 分支）。边界：任务进程内存、未真机联调。下一步：Zeus↔loom 联调（待部署）。
7. ~~A4 监督台最小版 + registry 全量视图~~ ✅ 2026-09-21：`src/oversight/`（OversightDesk：收集 input-required 升级请求、approve/reject、reject 联动 cancel、按 taskId 幂等、全程审计，8 项单测）；registry 新增 `listAll()`（含已吊销封臣，带 active/revoked 状态，供监督台视角）。全量 24 项测试绿、tsc 干净。边界：纯库类，尚无 HTTP 层；approve 仅记录决议，补参重派仍由调用方执行。

## Project documents

📚 **文档地图（按场景怎么读）**：[docs/README.md](docs/README.md)。以下为完整清单的单一事实源：

* [docs/product-portrait.md](docs/product-portrait.md) — 产品画像活文档：定位、设计哲学（目录底座/藏宝图/MCP·Skill·A2A）、个人与企业双态画像、分层架构、封臣式产品矩阵、路线图；文末演进日志 ★
* [docs/design-vassal-protocol.md](docs/design-vassal-protocol.md) — 封臣协议设计（A2A 超集 v0.1）：fealty 契约 / intake / report-back / escalation / 治理 / 星型拓扑 / pr-helper 六项验收清单 ★
* [docs/design-realm.md](docs/design-realm.md) — Realm 数据域接口契约 v0.1（D1）：目录即数据库、connect/search/read/write、数据二极管执行点、藏宝图依赖 ★
* 代码：`src/registry/registry.ts`（A1 封臣注册中心：卡片拉取注册/fealty 校验/健康探针/吊销/listAll 全量视图）、`src/dispatch/`（A2 派发器：JSON-RPC + SSE 客户端、数据二极管与脱敏、审计 sink）、`src/oversight/`（A4 监督台：升级请求队列 + approve/reject）、`tests/`（24 项）
* [docs/deferred-items.md](docs/deferred-items.md) — 缓做/低优事项登记表（开放问题与挂起项 + 触发条件的单一事实源）
* [AGENTS.md](AGENTS.md) — AI 协作规范与文档分层约定
* [git-commit-message.md](git-commit-message.md) — commit message 规范

## Recent changes

| 日期 | 变更 |
|---|---|
| 2026-09-21 | 产品画像 v0.1 初稿；按 agent-world 惯例建立项目文档骨架 |
| 2026-09-21 | 封臣协议拍板为 A2A 超集；design-vassal-protocol.md v0.1 完成（fealty/intake/report-back/escalation/治理/星型拓扑/pr-helper 验收清单） |
| 2026-09-21 | Zeus 代码动工：A1 注册中心 + A2 派发器（15 项单测）；D1 Realm 接口契约 v0.1 定稿；loom 封臣草案已交 loom 侧待裁决 |
| 2026-09-21 | loom 第二封臣裁决并落地第一阶段（loom Q150，plan 模式三 skills + JSON-RPC/SSE + Q88 Key + 审计，22 项测试绿）；Zeus 仓库推 GitHub private |
| 2026-09-21 | A4 监督台最小版落地（OversightDesk：input-required 升级队列、approve/reject、reject 联动 cancel、审计）；registry 补 listAll 全量视图；zeus 全量 24 项测试绿 |
