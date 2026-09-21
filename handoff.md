# Handoff

State of Zeus as of 2026-09-21.

> Zeus 处于「核心内核起步」阶段：A1 注册中心、A2 派发器、A4 监督台最小版已落地（纯 TS 库 + vitest，58 项测试绿）；派发侧治理闭环（吊销强制力 + 审计桥）、名册投影器 R0、**D1 Realm P0（只读 personal 数据域）**、**Realm 只读 MCP stdio 脚手架**已落地；封臣协议契约⇄代码一致性审计已完成并修复漂移。本文件记录项目当前状态、活跃任务与文档索引。

## Current state

- 已完成上层方向定位与产品画像 v0.1（2026-09-21）。
- 项目骨架文档已按 agent-world 惯例建立：AGENTS.md / handoff.md / docs/。
- 已 `git init` 并推 GitHub private；HTTP 技术栈已选型（Fastify + 长驻 Node，薄传输层，H1 随 roster R1 装依赖，见 docs/design-http-transport.md）；内核仍为纯 TS 库。
- 封臣治理闭环打通：registry 实时目录（asVassalLookup）→ dispatcher 派发前吊销阻断 → 审计桥统一记录（2026-09-21）。
- bayjf 封神榜设计 v0.1 完成，R0 名册投影器（internal/public 双快照）落地（2026-09-21）。
- Realm 两个 P0 前开放问题已拍板（v0.2：对外唯一传输 MCP、P0 文件系统扫描）；Realm P0 库内实现落地（2026-09-21）。
- 库公共入口与构建链落地（2026-09-21）：`src/index.ts` 聚合六模块公共面，`npm run build` 出 `dist/`（含 .d.ts），package.json 声明 main/types/exports。
- Realm 只读 MCP stdio 脚手架落地（2026-09-21）：零新依赖，resources 映射 manifest/search/read，宿主预连接授权目录、协议不暴露 connect，绝对路径不出进程；12 项协议测试 + 真实子进程 stdio 冒烟通过。**非正式 P1 启动**（触发条件仍是 read-realm 封臣出现）。

## Active work

1. ~~拍板封臣协议形态~~ ✅ 2026-09-21 已定：A2A 超集（deferred #1 销项）。
2. ~~起草 design-vassal-protocol.md~~ ✅ 2026-09-21 完成 v0.1。
3. pr-helper 封臣验收（design-vassal-protocol.md §7，共 6 项）：#1 Agent Card + fealty ✅、#2 tasks/sendSubscribe 全流程 ✅（JSON-RPC + SSE，14 项单测）、#3 战报三字段 ✅、#4 escalation ✅（merge-pr / production-rollback execute 模式升级）、#5 Zeus 派发侧 ✅ 2026-09-21（脱敏/数据二极管早有；本轮补齐吊销强制力：registry `asVassalLookup()` 实时目录、dispatcher 派发前阻断已吊销封臣且不发请求不发 token、`revokeAuditBridge` 把 vassal-revoked 治理事件并入审计；端到端治理闭环测试 tests/governance-flow.test.ts）。**剩 #6 标准客户端守护测试（需部署后真机验证）**。已知限制：任务存储为实例内存（跨调用尽力而为）、execute 模式待凭据委派。
4. ~~bayjf 名册改造方案~~ ✅ 2026-09-21：docs/design-bayjf-roster.md v0.1（单一事实源在封臣、内外双视图裁剪、签名链为公开闸门、R0–R2 阶段）；R0 投影器已落地（`src/registry/roster.ts`：listAll → internal/public 两份 RosterSnapshot，3 项测试）。后续 R1 待 HTTP 层、R2 为 bayjf 仓库改造（公开前须销项 deferred #7 签名链）。
5. ~~Realm 契约开放问题拍板 + P0 实现~~ ✅ 2026-09-21：传输层拍板**对外唯一 MCP server**（P0 库内先行、P1 第一件事包 MCP，不做独立 HTTP API），检索拍板**P0 文件系统扫描 + 可替换 SearchBackend**（升级阈值登记 deferred #10）；契约升 v0.2。P0 已落地 `src/realm/`（FsRealmStore：connect/manifest/search/read，只读 personal，8 项测试）：确定性 realmId（realpath 派生）、connect 幂等、contentDigest 基线、文本白名单/隐藏与依赖目录剪枝/1MiB 上限/symlink 拒绝、read 路径穿越防护（路径段 + realpath 双检）。**已知边界**：search 基于 connect 快照（重连刷新），read 实时读盘（保证恢复协议正确）；Realm 状态为实例内存；无传输层（仅 MCP stdio 脚手架）；enterprise/write/tags 检索为 P1。下一步：P1 MCP server 正式暴露（read-realm 封臣出现时启动）；只读 stdio 脚手架已先行落地（见 Active work 8）。
6. ~~loom 封臣接入~~ ✅ 2026-09-21 负责人裁决四项全按草案；loom 侧第一阶段 plan 模式已落地（Q150：`backend/app/core/a2a/` card·skills·rpc·router，12 单测 + 10 集成测试全绿，commit 0ba84d3/6404b99 在 loom dev 分支）。边界：任务进程内存、未真机联调。下一步：Zeus↔loom 联调（待部署）。
7. ~~A4 监督台最小版 + registry 全量视图~~ ✅ 2026-09-21：`src/oversight/`（OversightDesk：收集 input-required 升级请求、approve/reject、reject 联动 cancel、按 taskId 幂等、全程审计，8 项单测）；registry 新增 `listAll()`（含已吊销封臣，带 active/revoked 状态，供监督台视角）。全量 24 项测试绿、tsc 干净。边界：纯库类，尚无 HTTP 层；approve 仅记录决议，补参重派仍由调用方执行。
8. **库形态收尾与对外前置批次（2026-09-21 起，纯库内可闭环，不依赖部署）**：
   - ~~公共 API 入口 + 构建产物链~~ ✅ 2026-09-21：`src/index.ts` 聚合导出六模块公共面（a2a/registry/roster/dispatch/oversight/realm，23 个运行时导出）；`tsconfig.build.json` 出 `dist/`（.js + .d.ts + sourcemap，dist 已 gitignore）；package.json 补 main/types/exports/files 与 `build` 脚本。产物冒烟通过，40 项测试绿、tsc 干净。
   - ~~补写 README.md 仓库入口文档~~ ✅ 2026-09-21：根目录 README（定位、六模块说明、build/test/typecheck 命令与 Realm 最小示例、当前边界、文档导航、协作约定）。
   - ~~deferred #7 fealty 签名链设计草案~~ ✅ 2026-09-21：`docs/design-fealty-signing.md` v0.1（威胁模型 T1–T4；裁决 v1 Zeus 单签背书、v2 封臣自签交叉背书；Ed25519 + RFC 8785 JCS；条目 attestation + 快照 seal 两层信封；RSK 密钥归属/轮换；吊销四层失效含 TTL 硬过期；发布管线与接口草案；v1 八条验收）。**注意：设计完成 ≠ deferred #7 销项**，销项标准是 v1 随 R1/R2 实现并通过八条验收；触发条件「bayjf 公开前」不变。
   - ~~HTTP 技术栈选型设计~~ ✅ 2026-09-21：`docs/design-http-transport.md` v0.1 拍板 Fastify + 长驻 Node（不选 serverless），薄传输层 src/http 单向依赖内核、Realm 不挂 HTTP；H1 三端点（healthz/roster public 签名快照/roster internal 鉴权）随 roster R1 装依赖，H2 驾驶员 API 待持久化。
   - ~~Realm P1 MCP stdio 壳 + store→MCP resource 映射~~ ✅ 2026-09-21：`src/realm/mcp.ts`（零依赖 JSON-RPC 处理器：initialize 版本协商、resources/list·templates/list·read，只读不声明 tools；URI `zeus-realm://{realmId}/manifest|search|item`）+ `src/realm/mcp-stdio.ts`（进程入口，argv/env 预连接授权目录、只读 connect、stderr 日志/stdout 纯协议）。**路径不外泄**：connect 不经协议暴露、manifest 剥 root、错误消息只含相对 itemId；12 项测试（tests/realm-mcp.test.ts）+ build 后真实子进程冒烟全过，全量 52 项绿。边界：未引官方 SDK，protocolVersion/模板兼容性待正式 P1 用标准 client 复核；不做鉴权/HTTP（stdio only），正式启动仍待 read-realm 封臣出现。
   - ~~契约⇄代码一致性审计~~ ✅ 2026-09-21（对照 loom `backend/app/core/a2a/` 与 pr-helper `api/a2a/` 真实实现逐条核对）。**已修漂移 3 处**：① §4.5 fealty.version 版本协商原未实现（registry 只查字段存在）→ 新增 `SUPPORTED_FEALTY_VERSIONS=['1']`，不支持版本拒绝注册；② `AgentCard` 类型缺标准字段 `defaultInputModes`/`defaultOutputModes`/`provider`（§3.1 要求、两个封臣实发）→ 补可选字段；③ §4.3 战报示例含 `confidence` 但 `ZeusReport` 类型与 loom/pr-helper 三处实现均无（验收 #3 不含它）→ 示例对齐并注明非 v1 契约。**核对一致**：roster 字段映射与双视图裁剪、SSE 帧（`data:{jsonrpc,id,result:event|task}`）、出站 sendSubscribe 请求形态与 data.skill/runId 透传、战报四字段、defaultTaskUrl 三条路径、Realm resources/root 剥离/只读、HTTP H0 零依赖。**有意缺口（不修，已登记）**：Task.history（Zeus 消费端宽松兼容，loom 无/pr-helper 有，无故障）、file/URI artifact part（P1）、ackSeconds 强制计时（运行时 SLA 治理，R1 后）、backpressure（deferred #9）。
   - ~~测试覆盖矩阵补缺（第一批）~~ ✅ 2026-09-21：registry 补版本协商拒绝、完整标准 card 形态 2 项（9→11）；新增 tests/digest.test.ts 4 项（digestManifest 顺序无关、路径/内容敏感、Buffer/string 一致、sha256 已知向量）。全量 52→58 项绿、tsc 干净。oversight cancel 失败保持 pending、数据二极管、脱敏、吊销阻断、public 裁剪等不变量经核对已有测试覆盖。
   - 在途：Zeus↔loom 契约兼容性测试（mock loom 真实 card/SSE fixture）、验收 #6 标准客户端真机脚本、签名链 v1 纯函数、CI workflow（触发验证待 push）。

## Project documents

📚 **文档地图（按场景怎么读）**：[docs/README.md](docs/README.md)。以下为完整清单的单一事实源：

* [docs/product-portrait.md](docs/product-portrait.md) — 产品画像活文档：定位、设计哲学（目录底座/藏宝图/MCP·Skill·A2A）、个人与企业双态画像、分层架构、封臣式产品矩阵、路线图；文末演进日志 ★
* [docs/design-vassal-protocol.md](docs/design-vassal-protocol.md) — 封臣协议设计（A2A 超集 v0.1）：fealty 契约 / intake / report-back / escalation / 治理 / 星型拓扑 / pr-helper 六项验收清单 ★
* [docs/design-realm.md](docs/design-realm.md) — Realm 数据域接口契约 v0.1（D1）：目录即数据库、connect/search/read/write、数据二极管执行点、藏宝图依赖 ★
* [docs/design-bayjf-roster.md](docs/design-bayjf-roster.md) — bayjf 封神榜名册改造 v0.1：单一事实源在封臣、字段映射、内外双视图裁剪、签名链公开闸门、R0–R2 阶段 ★
* [docs/design-fealty-signing.md](docs/design-fealty-signing.md) — fealty 签名链设计 v0.1（deferred #7）：威胁模型、Zeus 单签 v1/封臣自签 v2、Ed25519+JCS、两层签名信封、RSK 密钥与轮换、吊销四层失效、v1 八条验收 ★
* [docs/design-http-transport.md](docs/design-http-transport.md) — HTTP 传输层选型 v0.1：网络面划分、Fastify+长驻 Node 裁决、薄传输层单向依赖、H1–H3 端点规划与验收 ★
* 代码：`src/index.ts`（公共 API 聚合入口，构建产物 `dist/`）、`src/registry/registry.ts`（A1 封臣注册中心：卡片拉取注册/fealty 校验/健康探针/吊销/listAll 全量视图/asVassalLookup 实时目录）、`src/registry/roster.ts`（名册投影器：internal/public RosterSnapshot）、`src/dispatch/`（A2 派发器：JSON-RPC + SSE 客户端、数据二极管与脱敏、吊销阻断、审计 sink + 吊销审计桥）、`src/oversight/`（A4 监督台：升级请求队列 + approve/reject）、`src/realm/`（D1 Realm P0：FsRealmStore 只读 personal 数据域、扫描检索、contentDigest、路径穿越防护；`mcp.ts`/`mcp-stdio.ts` 只读 MCP stdio 脚手架）、`tests/`（58 项）
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
| 2026-09-21 | pr-helper 验收 #5 销项：registry 实时目录 asVassalLookup + onRevoke 钩子，dispatcher 派发前阻断已吊销封臣（不发请求/不发 token），revokeAuditBridge 治理事件入审计；端到端治理闭环测试；全量 29 项测试绿（commit c1a0b27） |
| 2026-09-21 | bayjf 封神榜设计 v0.1（design-bayjf-roster.md）；R0 名册投影器落地（internal/public 双快照，确定性排序，JSON 可序列化）；全量 32 项测试绿（commit dadbe7b） |
| 2026-09-21 | Realm 开放问题拍板（契约 v0.2：对外唯一 MCP 传输、P0 扫描检索 + 可替换后端，升级阈值入 deferred #10；commit f2223f8） |
| 2026-09-21 | Realm P0 落地（src/realm/：只读 personal 数据域，connect/manifest/search/read，确定性 realmId 与幂等 connect、扫描纪律、read 路径穿越双检、快照检索/实时读分离；8 项测试，全量 40 项绿，commit 3bd6d51） |
| 2026-09-21 | 库公共入口与构建链：src/index.ts 聚合六模块公共面（23 个运行时导出）、tsconfig.build.json 出 dist（.js/.d.ts/sourcemap）、package.json main/types/exports/files + build 脚本；产物冒烟通过，40 项测试绿、tsc 干净 |
| 2026-09-21 | 补写根目录 README.md（仓库入口：定位、六模块、快速开始与 Realm 示例、当前边界、文档导航） |
| 2026-09-21 | fealty 签名链设计草案 v0.1（design-fealty-signing.md）：v1 Zeus 单签（Ed25519+JCS，条目 attestation+快照 seal，TTL 硬过期）、v2 封臣自签超集；deferred #7 设计完成，实现随 R1/R2 销项 |
| 2026-09-21 | HTTP 传输层选型拍板（design-http-transport.md）：Fastify+长驻 Node、薄适配层、Realm 不挂 HTTP；H1 三端点随 roster R1，H2 驾驶员 API 待持久化；H0 不装依赖 |
| 2026-09-21 | Realm 只读 MCP stdio 脚手架（src/realm/mcp.ts + mcp-stdio.ts）：零新依赖，resources 映射 manifest/search/read，宿主预连接、协议不暴露 connect、root 不出进程；12 项协议测试 + 真实子进程冒烟，全量 52 项绿、tsc 干净；非正式 P1 启动 |
| 2026-09-21 | 契约⇄代码一致性审计（对照 loom/pr-helper 真实实现）：修 3 处漂移——fealty.version 版本协商落地（不支持版本拒绝注册）、AgentCard 补 defaultInputModes/defaultOutputModes/provider 标准字段、战报示例去 confidence；补缺测试 6 项，全量 58 项绿 |
