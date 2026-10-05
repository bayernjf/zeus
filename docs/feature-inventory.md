# 功能清单（Feature Inventory）

状态：**现行 v0.28**（2026-10-06 自托管 P1 批：`watch` 操作者 HTTP 面落地——五条路由（`POST`/`GET /api/watches`、`GET`/`DELETE /api/watches/:id`、`POST /api/watch-tick`），watch 生命周期动作进审计脊（`watch-registered`/`watch-disabled`/`watch-revoked`）；测试 1209/111 → **1218/112**（新建 `tests/http-watches.test.ts` 7 例、`tests/watch.test.ts` +2），冒烟 40 → 42，路由 83 → **88（3 公开 + 85 bearer）**，分组表「意图与编排」7 → 12；TUI/Web 的 watch 专属控件未做；上一条 v0.27（2026-10-06 P0 试点批：八步实跑判据全过，跑中修掉两条装配缺陷（desk 审计默认桥进真内核 + TUI 空 body POST），测试 1206/110 → **1209/111**（`boot-oversight-audit` 新建 2 例、tui-client +1）；上一条 v0.26（2026-10-06 自托管第 5 步收尾：TUI 命令面 + Web 监督台契约控件——TUI 命令 13 → **15 类**（`c <skill> <票据> <并发> [by]` 签发（能力钉 execute、24h 窗口）与 `c<n>` 撤销；`delegation-limit` 行的 `a<n>` 走 approve-contract 签新契约换绑，deck 亮明所批形状），§4 TUI 行与 §3.11 随改；Web 授权视图新增契约块（签发表单 + 台账表格 + 撤销），裁决视图 delegation-limit 行改出「签新契约并批准」；基线 1192/110 → **1209/111**（v0.27 随 Active work 138 再 +3）；上一条 v0.25（2026-10-06 自托管第 6 步：零运行时改动，`npm run smoke:core` 37 → **40 步**现测同步（+3：serve 真进程契约操作面装配、watch 命中恰一次真派发、execute watch 契约派生与撤销断流），§4 脚本行随改；上一条 v0.24（2026-10-05 自托管第 5 步 HTTP 半：有界委托契约的操作者面落 HTTP——契约签发/列表/读/撤销四端点（签发撤销进审计脊，撤销即刻阻断派生），`POST /api/escalations/:id/approve-contract` 把批准一条 delegation-limit 实现为“签一份仅覆盖 execute 的新契约 + 换绑命名 watch + 标 approved”，不重放被拒 fire（下一 tick 重新判条件）；路由 78 → **83（3 公开 + 80 bearer）**，分组表监督台 6→7、数据域与跨域 8→12；TUI/Web 专属控件未做；上一条 **v0.23**（2026-10-05 自托管第 4 步：execute 型 watch 的委托子票据派生与越限回落已接进真进程——`bootKernel` 装配 `DelegationContractRegistry`（随快照持久化），fire 时派生一次性子票据过既有 execute gate，无契约/无签名者/撞上限零出站 + desk 一条 `delegation-limit`（按 watch/契约/原因/tickSeq 幂等）；§4「已实现但未接线」**1 → 0 项**；库公共面 **124 条 export 语句 / 运行时 231 个导出**（本批只加类方法/类型字段与枚举行，无新 export 符号，语句与运行时计数 +0）；上一条 **v0.22**（2026-10-05 自托管第 3 步：`watch` 的 `connector` 源已接线——出站只走连接器声明的工具边界，未声明工具不可读、非标量或缺失路径按"读数不可得"处理；§3.11 该行 ⬜ → ✅；库公共面按现测 **124 条 export 语句 / 运行时 231 个导出**（语句 +0，运行时常量/函数 +3：`connectorReading`/`readPath`/`WATCH_PATH_GRAMMAR`）；上一条 v0.21：2026-10-05 自托管第 2 步：新增 §3.11 自托管回路能力域（11 → **12 个**），登记 watch 两个源已接线、connector/execute/操作面三步仍 ⬜；库公共面按现测 **124 条 export 语句 / 运行时 228 个导出**（+2 / +7，来自 `src/watch/watch.ts`）；上一条 v0.20（2026-10-05 运行时可靠性实测轮：脚本 **12 → 13 个**（新增 `verify-runtime-reliability.mjs`），§2.2 补其一行；顺手修掉本台账一处过期数字——冒烟步数写 36 而现测 **37/37**；上一条 v0.19：2026-10-05 自托管实施第 1 步：库公共面按现测改为 **122 条 export 语句 / 运行时 221 个导出**（+2 条语句、+6 个运行时符号，全部来自 `delegation-contract`），并把**有界委托契约**登记进 §4「已实现但未接线」——本节 0 → **1 项**，理由是没有生产调用方：`bootKernel` 不装配它、没有 HTTP 面、派发热路径不消费它下面的票据；上一条 v0.18：2026-10-05 审计 B-43 收口轮：§6 的文档一致性断言 16 → 17 项（新增"上线清单的活基线与 deferred 销项状态必须和台账一致"），并修掉清单三处过期（判定行与闸门行的活基线停在 1099/1109、两条已销项仍写"登记待做"）；上一条 v0.17：2026-10-05 审计 B-42 收口轮：§6 的文档一致性断言 15 → 16 项（新增"全库每一条可解析的代码引用都要落到真实文件的真实行区间"），本台账"在哪"列 11 处引用全部复钉成带校验词的全路径——抽查的 10 条里 7 条原本指向无关实现；上一条 v0.16：2026-10-05 审计 B-41 收口轮：§6 的文档一致性断言 14 → 15 项（新增"每条代码锚点必须带校验词并命中被引区间"）；上一条 v0.15：2026-10-04 审计 v0.9 修复轮：§6 的文档一致性断言项数从 9 改成现测 14（本行停在 9 是 v0.11 之后的漂移，闸门只比路由与 export 普查、不比这一格）；上一条 v0.14：2026-10-04 审计 v0.7 复审轮：台账自身四处修正 + E2.6 补入功能明细；2026-09-30 随首轮代码审计建立、2026-10-01 随 A 级 12 条缺陷修复更新，基线 909 测试 / 92 文件；2026-10-01 再随 E2.3 `harden` 语义修正更新，基线 1012 测试 / 94 文件；2026-10-02 随审计 C 级收口更新，基线 1015 测试 / 94 文件；2026-10-02 再随 lint 基线接入更新：脚本 7 → 8，补 `scan-secrets`；2026-10-02 再随 `startServer()` 接线更新：「已实现但未接线」3 → 2 项；2026-10-02 **评审 v0.21 修正规模普查**：路由 75 → 76（3 公开 + 73 bearer，分组表之和 70 → 73）、库导出口径改为 **118 条 export 语句 / 运行时 213 个导出**，三段计数入库为断言；2026-10-02 再更新：**`dataPolicy` 收缩口径已定**（design-realm §3.1，实现待落），基线 1018 测试 / 94 文件；2026-10-03 再更新：**数据二极管按 `dataPolicy` 收缩已接线**（dispatcher 判档 + `realmHitsOrigin` 来源标记 + `refused-data-policy`/`content-injected` 两条审计值，「已实现但未接线」2 → 1 项，Active work 103），基线 1022 测试 / 94 文件；2026-10-03 再更新（**Active work 104**）：路由 76 → 77（3 公开 + 74 bearer，分组表「数据域与跨域」7 → 8）、关闭 deferred #35（出站 DNS 重绑定守卫）、推进 deferred #33（执行授权票据签发端点/审计/nonce 持久化三项接线，「已实现但未接线」仍 1 项），基线 1048 测试 / 97 文件；2026-10-03 再更新（**Active work 107**）：执行授权票据**派发闸门 + execute/plan 模式**接线（`FanOutRequest.mode`、`Orchestrator.runBranch` 前置验签消费、审计 `execution-delegation-denied` 入 AUDIT_DECISIONS 与 TUI token、H2 意图面透传；「已实现但未接线」1 → **0 项**；修正一处标注错误：凭据委派原标 ⬜（E4.10），PRD E4.10 实为背压降级顺序，凭据委派对应 deferred #33 投递字段），基线 1048/97 → **1060/99**；2026-10-03 再更新（**Active work 109**）：E2.6 操作者意图识别接线（`POST /api/intents/recognize`，本地规则零出域默认 + 可插拔决策后端 opt-in，plan-only fail-closed；真进程验收 7 步入 `verify:intent-recognize`；index 公共导出 +2），路由 77 → **78**（3 公开 + 75 bearer，分组表「意图与编排」6 → 7），导出语句 118 → **120**，测试 1060/99 → **1084/101**；2026-10-03 再更新（**Active work 110**）：E2.6 意图识别接 **TUI 命令面**（`i <文本>` 本地规则零出域 / `im <文本>` 显式咨询决策后端 opt-in，结构化 fail-closed 422 以视图返回，命令词须为 `i`/`im` 后跟空格防 `info` 误判；真进程验收 `verify:tui-recognize` 7 步入册），TUI 命令 11 → **13** 类，路由 78 / 导出 120 不变，测试 1084/101 → **1099/101**；2026-10-04 再更新（**Active work 113–115**）：CORS 传输层（`ZEUS_CORS_ORIGINS` 白名单 + OPTIONS 预检 + hijack SSE 端点补 CORS 头）、Web 监督台 v1（`web/supervisor/index.html`，监控/裁决/授权/连接四视图 + 派发作战室 SSE 实时 + DAG 视图 + 意图识别入口）、fan-out **§7 运行中分支中断原语**（`DispatchRequest.signal` + `branchSignals` + `branch-aborted` 审计 + `canceled by the driver` 结算）、tui-tokens 补 `branch-aborted` 语义 token，测试 1099/101 → **1104/102**，冒烟 37/37；2026-10-04 再更新（**Active work 117**）：评审 §F 三项取证——签名链 `verify:roster --card` 卡片深比对真机正/反例补证（正例 VERIFIED、篡改 swornTo 反例 REJECTED）、容量基线 worktree 同机对照证 §7 无回归（capacity-baseline 升 **v0.4**，新增跨版本对照方法论）、Docker 容器级四项首次全证据（healthy / `/data` 0600 / SIGTERM 落盘 / 重启恢复并端到端派发 completed，另验生产无钥拒启）；容器验收抓到并修复**生产关键路径缺陷**——出站 guarded lookup 未遵守 Node 22 autoSelectFamily 的 `options.all=true` 数组回调契约，导致所有按主机名（域名，非裸 IP）连接执行 Agent/seed 的出站请求失败（IP 字面量不触发自定义 lookup，故冒烟/单测全漏），修复为 all:true 回地址数组、all:false 回标量、混合公私网答案仍整主机 fail-closed，并新增 `describeTransportError()` 走 undici cause 链透出真实错误码（EZEUSOUTBOUND/ECONNREFUSED）接入注册与健康检查 catch；测试 1104/102 → **1109/102**（outbound-dns +4 含主机名真实建连回归、registry +1），路由/导出/冒烟均不变；2026-10-04 再更新（**Active work 118**）：**Web 监督台 v1.3**（`web/supervisor/index.html`，纯前端零内核改动）——审计时间线过滤条（afDecision 动态下拉 / afVassal 服务端 / afKeyword 前端即时 / afCount 计数+空态）、并发趋势面板（SVG 双线 40 点环形 3s 采样、峰值/采样计数）、侧栏待决徽标全局刷新（非裁决视图 10s 轮询）、意图历史回写（renderIntent rememberIntent completed/failed，localStorage 持久化）；基线 1109/102 不变（Windows 本机 1083 绿 / 26 环境性失败），路由/导出/冒烟均不变；2026-10-04 再更新（**Active work 119**）：**Web 监督台 v1.4**（`web/supervisor/index.html`，纯前端、零内核改动、零新路由，全部消费已挂载 HTTP API）——作战室新增决策回放面板（`GET /api/intents/:id/replay?format=text` 人读时间线）与结果责任链面板（`GET /api/org/accountability/:id`，执行 Agent→部门 lead→裁决 driver，未安置单列）；新增组织视图（`GET /api/org/chart` 编制树）与目录视图（`GET /api/skills` 技能目录含状态前端过滤 + `GET /api/connectors` 连接器只读台账，令牌只显 hasToken 不回显）；监控名册每行加吊销/恢复治理按钮（`DELETE /api/vassals/:name`、`POST /api/vassals/:name/reinstate`，confirm 二次确认）；内核状态面板加决策后端徽章（`GET /api/decision`，rules-only 或 kind/model + 仲裁/judge 门限）；浏览器真机 E2E 六子项全过（含吊销→恢复闭环 UI+API 双断言、连接器令牌不回显）；基线 1109/102 不变，路由 78 / 导出 120 / 冒烟均不变；2026-10-04 再更新（**审计 v0.7 复审轮 / Active work 120**，纯台账修正、零代码零测试改动，基线 1109/102 不变）：修掉台账自身的三处错——① TUI 行「鉴权」格原写 `--token`，而代码**显式拒绝**该旗标（`src/tui/cli.ts:44-48 #token`：命令行秘密进 `ps` 与 shell 历史），改为 `ZEUS_INTERNAL_TOKEN` 并注明旗标被拒；② 「脚本 8 个」→ **12 个**（`ls scripts/*.mjs` 现测；漂移的 4 个是 `verify-decision-backend` / `verify-execute-delegation` / `verify-intent-recognize` / `verify-tui-recognize`，全是后续批次加的真机验收入口）；③ §2.1 标题「76 条」→「**78 条：3 公开 + 75 bearer**」——同一份文档 §2 表第 26 行本就写 78，标题与表自相矛盾已统一；另在 §3.2 技能体系补 **E2.6 操作者自然语言意图识别**一行（此前该能力只在 §2 路由表与 TUI 命令表登记，按 Epic 读的功能明细缺行）；`--token` 之外未改任何运行时行为，四处修正的复现命令见 [audit-2026-09.md](audit-2026-09.md) §10.5）

> 本文件是 Zeus **全部功能点的资产台账**：有什么、在哪、什么状态。缺陷台账在 [audit-2026-09.md](audit-2026-09.md)。需求优先级与验收标准在 [prd.md](prd.md)；"做到哪了"在 [handoff.md](../handoff.md)。本文件只回答"有什么"，不记进度。

## 1. 产品定位与能力分层

Zeus 是**AI 原生的多 Agent 团队运行时**：给一个本地目录即可使用，用户正文不出本机，外部能力只经三条通道接入——**MCP**（连接外部系统）、**Skill**（能力与权限声明）、**A2A**（跨 Agent 协作）。

| 层 | 内容 | 代码位置 |
| --- | --- | --- |
| 内核原语 | 协议类型、名册与签名链、派发与审计、监督台 | `a2a` `registry` `dispatch` `oversight` |
| 编排决策 | 扇出聚合、冲突与仲裁、DAG、指标、回放、并发闸 | `orchestrator` `decision` `delegation` |
| 数据主权 | 目录即数据库、记忆沉淀、备份与恢复 | `realm` `memory` `vault` |
| 能力接入 | MCP 客户端与连接器、技能目录与生命周期 | `mcp` `skills` |
| 组织协作 | 编制与责任链、上岗门与首日简报、叙事化日记 | `org` `onboarding` `diary` |
| 接入面 | HTTP 门面、终端面板、启动装配与持久化 | `http` `tui` `state` |

PRD 共 **55 条需求行**：**P0 26/26 ✅**；非 P0 未闭合 **8 条**（E3.4 MCP 传输、E3.8、E4.9、E4.10、E5.4、E8.4、E9.4、E10.2——全部挂仓库外动作或真实规模触发条件）。

## 2. 运行时入口总览

| 入口 | 形态 | 规模 | 鉴权 |
| --- | --- | --- | --- |
| HTTP 门面 | Fastify 长驻进程，`npm start` | **88 条路由**（3 公开 + 85 bearer） | 公开 3 条无鉴权；其余同一 bearer |
| 终端面板 TUI | `npm run tui` | 15 类命令 | `ZEUS_INTERNAL_TOKEN`（env）——**`--token` 被显式拒绝**：命令行秘密在 `ps` 与 shell 历史里可见（`src/tui/cli.ts:44-48 #token`；原台账此格误写为 `--token`，见审计报告 §10 B-37） |
| Web 监督台（方案 A v1.4） | `web/supervisor/index.html` + 静态托管 | 监控（内核状态/指标+决策后端徽章/名册含吊销·恢复治理/审计时间线+过滤/并发趋势）/ 意图派发+作战室（详情/SSE 实时/DAG/取消/决策回放/结果责任链）/ 裁决 / 授权 / 组织（编制树）/ 目录（技能+连接器只读）/ 连接；v1.1 派发作战室+SSE、v1.2 DAG+识别+loading+SSE 重连、v1.3 审计过滤+趋势+徽标全局刷新+历史回写、v1.4 回放+责任链+组织+目录+名册治理+决策徽章 | 浏览器侧 localStorage 存 bearer；服务侧 `ZEUS_CORS_ORIGINS` 白名单 |
| 备份 CLI | `npm run vault` | 4 子命令 | 口令 env / key-file |
| 库公共面 | `import 'zeus'` | **124 条 export 语句**（构建产物运行时 231 个导出） | 不适用 |
| MCP 服务端 | `src/realm/mcp-stdio.ts` | 3 资源模板 + 2 工具 | 宿主预授权目录 |
| 脚本 | `scripts/` | **13 个**（`ls scripts/*.mjs` 现测；上一记为 12 个，本批新增 `verify-runtime-reliability.mjs`；更早原记 8 个，漂移的 4 个是 `verify-decision-backend` / `verify-execute-delegation` / `verify-intent-recognize` / `verify-tui-recognize`，见 §10 C-26） | 不适用 |

### 2.1 HTTP 路由（83 条：3 公开 + 80 bearer）

量法：`src/http/server.ts` 里 `app.<verb>('<path>'` 的注册数（每条注册一路由，无重复注册；`tests/doc-consistency.test.ts` 已把本行与下表之和钉成断言，故三个数字不会再各自漂移）。

公开面（始终挂载，无鉴权）：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/healthz` | 存活探针（status/version/ts，无业务信息） |
| GET | `/api/roster/public` | 已签名公开名册快照，离线可验 |
| GET | `/api/roster/keys` | 名册根公钥（JWKS + SPKI PEM + 指纹），供第三方验签 |

内部面（全部 `requireBearer`，未配 `ZEUS_INTERNAL_TOKEN` 时整组不挂载）：

| 组 | 条数 | 代表路由 |
| --- | --- | --- |
| 名册与执行 Agent | 4 | `GET /api/roster`、`POST /api/vassals`、`DELETE /api/vassals/:name`、`POST /api/vassals/:name/reinstate` |
| 意图与编排 | 12 | `POST /api/intents`、`POST /api/intents/recognize`（E2.6）、`GET /api/intents/:id`、`POST /:id/cancel`、`GET /:id/dag`、`GET /:id/events`（SSE）、`GET /:id/replay`、`POST`/`GET /api/watches`、`GET`/`DELETE /api/watches/:id`、`POST /api/watch-tick`（自托管 P1：watch 登记/读/撤销 + 调用方驱动 tick） |
| 监督台 | 7 | `GET /api/escalations`、`GET /:id`、`POST /:id/approve`、`/reject`、`/approve-resume`、`/resolve`、`/approve-contract`（自托管第 5 步：批准委托越限项 = 签新契约并换绑 watch） |
| 指标与状态 | 3 | `GET /api/metrics`、`GET /api/state`、`GET /api/audit` |
| 组织编制 | 13 | `GET /api/org/chart`、`GET /api/org/accountability/:intentId`、部门建编/安置/设 lead/移除成员、带教立项/授课/豁免/撤回/台账、`GET /:id/briefing/:agentId`、`POST /:id/first-task` |
| 记忆 | 10 | `/api/memory/{events,facts,replay,recall}`、`/retract`、`/forget-subject`、`/retractions`、`/integrity`、`/snapshot`、`/reconcile` |
| 日记 | 3 | `GET /api/diary`、`GET /api/diary/export`、`POST /api/diary/generate` |
| 技能与带教 | 14 | `/api/skills` 目录与版本、`install`/`uninstall`/`deprecate`/`harden`/`team`、`/api/mentorships` 全生命周期 |
| 连接器 | 6 | `/api/connectors` 声明/连接/吊销、`POST /api/connectors/:id/tools/:name/call` |
| 数据域与跨域 | 12 | `GET /api/domains`、`GET /api/domains/access`、`POST`/`DELETE /api/domains/grants`、`POST /api/realm/write-grants`、`POST /api/execution-delegations`、`POST`/`GET`/`GET :id`/`DELETE /api/delegation-contracts`（自托管第 5 步：有界委托契约签发/读/撤销）、域断开与租户重定向 |
| 决策后端 | 1 | `GET /api/decision` |

路由按内核组件可用性分批挂载：同一 token 下，未装配某组件时该组路由不存在。

### 2.2 CLI 与脚本

| 命令 | 形态 | 能力 |
| --- | --- | --- |
| `npm run vault build` | 子命令 | 绘制备份清单（manifest-only）并加密封印 |
| `npm run vault backup` | 子命令 | 打包清单 + 全量备份包（AES-256-GCM） |
| `npm run vault check` | 子命令 | L0 就地校验，按清单指纹查漂移；退出码 0/1/2/3 |
| `npm run vault restore` | 子命令 | 按清单 + 备份包跨位恢复（含 dry-run 与 plan） |
| `npm run tui` | 交互面板 | 刷新、批准/拒绝升级、按立场裁决、吊销 Agent、签发/撤销跨域授权、**签发/撤销委托契约（`c <skill> <票据> <并发> [by]`，能力钉 execute / `c<n>`）**、**意图识别（`i <文本>` 本地零出域 / `im <文本>` 模型 opt-in，plan-only）**、退出；写操作需 `y/N` 确认；zh-CN/en 双语言 |
| `npm run smoke:core` | 脚本 | 真进程 + 真 socket 核心链路冒烟（**40 步**，2026-10-06 现测；自托管第 6 步 +3：契约操作面 / watch 真派发 / 契约派生与撤销断流；本台账原记 36） |
| `npm run acceptance:fanout` | 脚本 | 对真实执行 Agent 的扇出验收 |
| `npm run bench:capacity` | 脚本 | 五场景容量压测（扇出宽度 / 并发意图 / HTTP 门面吞吐 / 取消传播 / 并发闸门代价） |
| `npm run verify:reliability` | 脚本 | **运行时可靠性实测**（审计 §11.3 四格）：有界并发闸的真配置行为、升级队列跨 SIGTERM 重启、SSE 断流重连与取消时序、台账与 RSS 增长斜率；每项都带正控，退出码 0/1/2 |
| `npm run verify:roster` | 脚本 | 名册封签离线验签（含 `--card` 深校验） |
| `scripts/acceptance-standard-a2a.mjs` | 脚本 | 纯标准 A2A 客户端验收，不认任何私有头 |
| `scripts/gen-rsk-key.mjs` | 脚本 | Ed25519 密钥对生成（私钥 0600），零依赖跨平台 |
| `npm run lint:secrets` | 脚本 | 密钥样貌扫描（10 组保守模式，默认全量 tracked、`--diff` 扫变更集，命中 exit 1），零依赖 |

## 3. 功能点明细

状态标记：✅ 已落地且已接线｜🚧 部分落地或已实现未接线｜⬜ 未实现。

### 3.1 并发协同与决策内核（PRD E1）

| 功能 | 落地位置 | 状态 |
| --- | --- | --- |
| 一层扇出/汇聚：按技能或显式名单并行派发 N 个执行 Agent | `orchestrator/orchestrator.ts` | ✅ |
| 意图幂等：同 intentId 重放零出站 | `src/orchestrator/orchestrator.ts:191-193 #intentId` | ✅ |
| 取消传播到全部非终态分支 | `src/orchestrator/orchestrator.ts:480-510 #cancelIntent` | ✅（A-11 已修：意图在首个分支派发前落最小可取消态，取消结果回写分支与聚合） |
| 多流合并（带来源 vassal/taskId/runId） | `orchestrator/merge.ts` | ✅ |
| 规则聚合：unanimous / majority / weighted，分裂不臆断 | `orchestrator/aggregate.ts` | ✅ |
| 冲突检测与升级进监督台 | `orchestrator/conflict.ts` + `oversight` | ✅ |
| 决策后端仲裁（规则无解时按置信度闸门采纳） | `orchestrator/arbitration.ts` | ✅ |
| 对抗式复核（阈值闸门 + 分歧升级） | `orchestrator/judge.ts` | ✅ |
| 并发闸：信号量 + 有界 FIFO 队列，队列深度为真值 | `orchestrator/semaphore.ts` | ✅ |
| 饱和分流给同技能最优提供方 | `orchestrator/diversion.ts` | ✅ |
| 离线决策回放（纯只读时间线重建） | `orchestrator/replay.ts` | ✅ |
| 并发指标：在途/峰值/队列深度/延迟分位/失败率 | `orchestrator/metrics.ts` | ✅ |
| 完整 DAG：拓扑分层、关键路径、上游失败跳过下游、产物下传 | `orchestrator/dag.ts` `dag-runner.ts` | ✅ |
| 进度事件与服务端 SSE | `orchestrator/progress.ts` + HTTP `/events` | ✅ |
| 进行中硬 abort | 未实现 | ⬜ |

### 3.2 技能体系（E2）

| 功能 | 落地位置 | 状态 |
| --- | --- | --- |
| 显式技能规格（id/版本/schema/权限/依赖）与形状校验 | `skills/validate-spec.ts` | ✅ |
| 技能注册中心：多版本共存、默认取最新 active、deprecated 保留可审计 | `skills/registry.ts` | ✅ |
| 从执行 Agent 卡片导入技能目录 | `registerFromCard` + boot 钩子 | ✅ |
| 生命周期：install / uninstall / deprecate / harden（权限只收窄；省略 `permissions` 的加固沿用既有有效声明） | `skills/registry.ts` | ✅ |
| 多技能组队，歧义不静默选边 | `resolveTeam` | ✅ |
| 派发前技能闸门（三态：未注册放行 / 注册无 active 拒绝） | `activeProviders` + dispatcher | ✅ |
| 带教台账：立项/授课/胜任力评估/作废 | `skills/mentor.ts` | ✅ |
| 操作者自然语言意图识别（E2.6：plan-only、默认本地规则零出域、外部模型仅显式 `useModel: true` 经窄端口） | `src/intent/recognize.ts`；HTTP `POST /api/intents/recognize`（`src/http/server.ts:1318 #recognize`）；TUI `i` / `im`；库导出 `src/index.ts:218 #recognizeIntent` | ✅（本轮补登：此前只出现在 §2 路由表与 TUI 表，Epic 维表缺行，见审计报告 §10 C-25） |

### 3.3 数据域与数据主权（E3）

| 功能 | 落地位置 | 状态 |
| --- | --- | --- |
| 目录即数据库：connect / manifest / search / read | `realm/store.ts` | ✅ |
| 确定性 realmId（realpath 派生）与内容指纹 | `realm/store.ts` `realm/digest.ts` | ✅ |
| 路径逃逸防护（路径段 + realpath 双检，拒符号链接） | `src/realm/store.ts:199-224 #isInsideRoot` | ✅ |
| 文本白名单、隐藏与依赖目录剪枝、1MiB 上限 | `realm/store.ts` scan | ✅ |
| 数据二极管：域须在 fealty 声明内才注入 | `src/dispatch/dispatcher.ts:211-225 #diode` | ✅ |
| 企业域三级租户（org/department/member） | `realm/tenant.ts` | ✅ |
| 双域授权：个人↔企业单向隔离，显式签名一次性授权 | `realm/authorization.ts` | ✅ |
| 企业域写凭证：签名且一次性，nonce 账本 | `realm/grant.ts` | ✅ |
| 内核侧域检索（内核自己取数并核对声明域类型） | `realm/source.ts` | ✅ |
| 只读 MCP 服务端（stdio）：资源映射、工具白名单、绝对路径不出进程 | `realm/mcp.ts` `mcp-stdio.ts` | 🚧（P0 已落地，正式 P1 待标准 client 复核） |
| 备份清单与恢复协议：原地校验 + 加密备份包跨位恢复 | `vault/` | ✅ |
| 执行授权票据（一次性短时授权，签名 + 单 nonce） | `delegation/execution-delegation.ts`、`http` 签发端点 | ✅（Zeus 侧闭环：原语 + 签发/审计/nonce 持久化 + 派发闸门/execute 模式；A2A 投递字段留对端，deferred #33） |

### 3.4 执行 Agent 联邦（E4）

| 功能 | 落地位置 | 状态 |
| --- | --- | --- |
| A2A 超集协议：卡片、fealty 版本协商、SSE 流、任务产物回传字段 | `a2a/types.ts` `dispatch/client.ts` | ✅ |
| 名册内外双视图投影与公开封签 | `registry/roster.ts` `registry/signing.ts` | ✅ |
| Ed25519 + JCS 两层信封（条目 attestation + 快照 seal），离线可验 | `registry/signing.ts` | ✅ |
| 吊销强制力：派发前阻断、凭据即刻断流、四视图不回显 | `registry/registry.ts` `dispatch/dispatcher.ts` | ✅ |
| 出站凭据注入（`url｜token` seed、快照持久化、0600） | `registry/registry.ts` `tokenFor` | ✅ |
| SLA 受理计时审计 | `src/dispatch/dispatcher.ts:269-277 #ackSeconds` | ✅ |
| 文件/URI 产物部件（只呈现不自动拉取） | `a2a/parts.ts` | ✅ |
| 对线上真实执行 Agent 的协议验收 | `scripts/acceptance-standard-a2a.mjs` | ✅（E4.8 已实跑 PASS） |
| 凭据委派（execute 模式） | 未实现 | ⬜（deferred #33 投递字段：对端凭据代理接口未定义；PRD E4.10 是背压降级顺序，与凭据委派无关） |
| 入站 A2A 面 | 未实现 | ⬜（deferred #19） |

### 3.5 HTTP 门面与名册（E5）

| 功能 | 落地位置 | 状态 |
| --- | --- | --- |
| 薄传输层：全库仅 `http/` 引 fastify，内核零传输依赖 | `http/server.ts` | ✅ |
| 常量时间 bearer 比对，未配 token 则写面整组不挂载 | `src/http/server.ts:285-286 #internalToken`（无 token 则整组不挂载）、`src/http/server.ts:2617 #timingSafeEqual` | ✅ |
| 根公钥发布端点 | `GET /api/roster/keys` | ✅ |
| 生产密钥硬化：内联 PEM / 文件挂载 / production 无钥拒启 | `http/rsk.ts` | ✅ |
| 启动装配：四组件一次装配、快照恢复、信号优雅落盘 | `state/boot.ts` | ✅ |
| 内核状态原子落盘（tmp + rename，0600）与快照版本校验 | `state/kernel-state.ts` | ✅ |
| 服务端 SSE 合并流 | `GET /api/intents/:id/events` | ✅ |
| 静态 JSON 产物分发 | 未实现 | ⬜（E5.4） |

### 3.6 监督台与操作者（E6）

| 功能 | 落地位置 | 状态 |
| --- | --- | --- |
| 升级队列：input-required 收集、按 taskId 幂等、全程审计 | `oversight/oversight.ts` | ✅ |
| 批准 / 拒绝（拒绝联动取消）/ 冲突裁决 | `oversight/oversight.ts` | ✅ |
| 决议回写聚合（清冲突、重算状态、记操作者决议） | `orchestrator/resolution.ts` | ✅ |
| 一键补参重派 | `POST /api/escalations/:id/approve-resume` | ✅ |
| 跨域授权台账（签发/撤销/决策审计） | `realm/authorization.ts` + HTTP `/api/domains` | ✅ |
| 终端面板操作面 | `tui/` | ✅ |

### 3.7 MCP 连接器（E7）

| 功能 | 落地位置 | 状态 |
| --- | --- | --- |
| MCP 客户端：streamable-HTTP JSON-RPC、握手发现（tools/resources/prompts） | `mcp/client.ts` | ✅ |
| 连接器注册表：声明（封闭权限词汇）/ 连接 / 吊销即时移出 | `mcp/connectors.ts` | ✅ |
| 最小权限：能力按声明裁剪，`mcp:<tool>` 精确放行 | `mcp/connectors.ts` | ✅（A-09 已修：空权限 = 空能力，调用时按声明重推导） |
| 工具调用面与上游失败 502 | `POST /api/connectors/:id/tools/:name/call` | ✅ |
| 服务端 tools/list + tools/call（域白名单） | `realm/mcp.ts` | ✅ |

### 3.8 记忆与叙事层（E8）

| 功能 | 落地位置 | 状态 |
| --- | --- | --- |
| 追加与修改分离：Agent 只 append 事件，事实只经整理产出 | `memory/memory-store.ts` | ✅ |
| 确定性整理：去重、争议、取代、provenance 累积 | `memory/consolidate.ts` | ✅ |
| 置信度按 Agent 可靠度加权，同源重复不增强 | `memory/consolidate.ts` | ✅ |
| 跨域读写拒绝并审计 | `memory/memory-store.ts` | ✅ |
| 混合检索：BM25 + 本地哈希向量，可调 alpha，中文分词 | `memory/recall.ts` | ✅ |
| 遗忘权：撤回事实、抹除主体、tombstone 持久化 | `memory/memory-store.ts` | ✅（A-06 已修：整理期维护 tombstone 抑制集，撤回主体在墓碑存在期间不重建） |
| 漂移对账：两时点 diff + 横切完整性校验 | `memory/reconcile.ts` | ✅ |
| 可靠度纠错回写 | `memory/memory-store.ts` + oversight 钩子 | ✅ |
| 记忆事件生产者（扇出结论沉淀为 claim） | `memory/producer.ts` | ✅ |
| 叙事化日记：按天分桶、锚 eventId、落盘/导出/HTTP 生成 | `diary/` | ✅（A-07 已修：渲染排除 `status === 'retracted'` 的事实） |
| 真实同域 embedding 模型接入 | 未实现 | ⬜（deferred #10 触发） |

### 3.9 组织层（E9）

| 功能 | 落地位置 | 状态 |
| --- | --- | --- |
| 虚拟部门：单 lead、成员唯一、不可变原语 | `org/department.ts` | ✅ |
| 编制注册表与持久化（随 boot，重启不丢） | `org/registry.ts` | ✅ |
| 编制可视（org chart，确定性排序 + markdown 渲染） | `org/chart.ts` | ✅ |
| 结果责任链：执行 Agent → 部门 lead → 操作者 | `org/accountability.ts` | ✅ |
| 上岗四道门（seat / account / authorization / mentorship），现算不缓存 | `onboarding/commission.ts` | ✅ |
| 首日简报：只从已有事实装配，答不上来的写进 gaps | `onboarding/briefing.ts` | ✅ |
| first-task 过门后真派发 | HTTP `POST /:id/first-task` | ✅ |
| 企业席位与配额管理 | 未实现 | ⬜（E9.4） |

### 3.10 平台工程（E10）

| 功能 | 落地位置 | 状态 |
| --- | --- | --- |
| 审计 JSONL 落盘 + 可回读，0600 与自限轮转 | `dispatch/audit.ts` | ✅ |
| 结构化日志 | 未实现 | ⬜（E10.2） |
| 容量基线 harness 与五场景数据 | `scripts/bench-capacity.mjs` + `docs/capacity-baseline.md` | ✅ |
| 容器部署形态（多阶段、非 root、健康检查、状态卷） | `Dockerfile` + `docs/deployment.md` | ✅ |
| CI：Node 双矩阵 typecheck → test → build + 独立时钟偏移 job | `.github/workflows/ci.yml` | ✅ |
| 文档一致性断言（17 项机械校验） | `tests/doc-consistency.test.ts` | ✅ |

### 3.11 自托管回路（[design-self-host-loop.md](design-self-host-loop.md) §7 分步）

| 功能 | 落地位置 | 状态 |
| --- | --- | --- |
| 有界委托契约：签发 / 验签 / 派生子票据 / 计数与持久化 / 撤销 | `src/delegation/delegation-contract.ts` + `boot.ts` 装配 + HTTP 面 | ✅ 原语 + 已接线 + **HTTP 操作者面**（第 1+4+5 步）：boot 装配 registry（随快照持久化），execute fire 派生子票据过 gate，派发落定归还并发槽；`POST/GET/DELETE /api/delegation-contracts` 签发/读/撤销，签发与撤销走审计脊；TUI 专属签发视图仍未做 |
| `watch` 触发器：`metrics` 与 `realm` 两个源（无出站） | `src/watch/watch.ts` + `boot.ts` 的 `runWatchTick` | ✅ 已接线（第 2 步） |
| `watch` 的 `connector` 源 | `src/watch/watch.ts`（`WATCH_PATH_GRAMMAR` / `readPath` / `connectorReading`）+ `boot.ts` 的 connector 端口 | ✅ 已接线（第 3 步）：走连接器声明的工具边界，未声明工具不可读、非标量按读数不可得 |
| HTTP 契约签发面 + 越限批准换绑 | `src/http/server.ts` | ✅（第 5 步 HTTP 半）：`POST /api/delegation-contracts`（含上限/窗口/能力校验）、`GET` 列表与单个、`DELETE` 撤销即刻阻断派生；`POST /api/escalations/:id/approve-contract` 对 delegation-limit 项签一份仅覆盖 `execute` 的新契约、换绑命名 watch、标 approved，**不重放被拒 fire**（下一 tick 重新判条件） |
| 监督台/TUI 的契约专属视图 | 未实现 | ⬜（第 5 步剩余：Web 监督台与 TUI 暂只以通用升级队列展示 delegation-limit 行，没有签发/换绑的专属控件） |

## 4. 已实现但未接线的功能

这一类不在 PRD 的 ⬜ 里，因此最容易在盘点时被算成"已完成"。它们是**能力齐备但没接到主路径上**。2026-10-01 的 A 级修复批把原列 6 项中的 per-vassal 并发上限（A-01）、跨域授权 nonce 防重放（A-04）、连接器空权限 fail-closed（A-09）三项接上了主路径，2026-10-02 又把 `startServer()` 接线（见下表之后的说明），2026-10-03 又把**数据二极管按 `dataPolicy` 收缩**接线（Active work 103），同日再把**执行授权票据的签发端点、审计、nonce 持久化**三项接线（Active work 104，派发闸门仍留对端），**已接线移出本表（2026-10-03，Active work 107）**：执行授权票据派发闸门——`Orchestrator.runBranch` 出站前验签消费一次性票据（capability 固定 `'execute'`），无授权 fail-closed 零出站，审计 `execution-delegation-denied`；`FanOutRequest.mode` 区分 plan/execute。**本节现为 0 项（2026-10-05，Active work 134）**：最后一项有界委托契约 `src/delegation/delegation-contract.ts` 已接进真进程——`bootKernel` 装配 `DelegationContractRegistry`（随内核快照持久化），execute 型 watch 在 fire 时经 `deriveExecutionDelegation` 派生一次性子票据，票据过既有 execute gate 后真派发，派发落定归还契约并发槽；无契约/无签名者/撞任一上限则零出站并由 `oversight.ingestDelegationLimit` 产出一条可读、幂等的 `delegation-limit` 升级项（真进程证据 `tests/boot-watch-execution.test.ts` 3 例）。**仍缺的不是接线而是操作者面**：契约还没有 HTTP 签发端点（`POST /api/delegation-contracts` 仍 404），desk 上一条 delegation-limit 还不能一键签新契约——那是设计稿 §7 第 5 步，缺它意味着"真实用户自助使用有界自主"仍未达成，但已不属于"能力齐备而无生产调用方"这一类，故移出本节。

**已接线移出本表**：`startServer()`（2026-10-02）。接线前它是"同一句启动有两种答案"：这个导出的起步函数零调用方、默认 `port: 0`（随机端口），而进程入口 `serve.ts` 自带一份 `8787`，两处默认值可以各自漂移。现改为**单一起步原语**——进程入口调它，绑定默认值只有一份（`DEFAULT_HTTP_HOST` / `DEFAULT_HTTP_PORT`），`ZEUS_HOST` / `ZEUS_PORT` 仅作覆盖，进程日志打印 socket **实际绑定**的地址（`ZEUS_PORT=0` 时请求值与实际值不同，日志是操作者唯一能读到真实端口的地方）。`index.ts` 仍不导出任何 HTTP 符号——传输层不属于内核，`package.json` 的 `./http` 子路径是它的唯一入口。**数据二极管按 `dataPolicy` 收缩**（2026-10-03）：`dispatcher.ts` 的注入点从"`none` 之外一律放行"改为按 **policy×origin** 判档（design-realm §3.1）——命中非空且来源缺失即拒（fail-closed）、`none` 一律拒、`read-task-scope` 仅收内核解析、`read-realm`/`write` 允许操作者自报；HTTP 装配层补 `realmHitsOrigin` 标记（`caller-asserted` / `kernel-resolved`）并把内核解析的命中全字段透传（不再丢 `tags`/`modifiedAt`）；放行与拒绝都写审计（`refused-data-policy` / `content-injected`，detail 点名 policy、来源与条数），TUI 语义 token 同步。五条验收（含缺陷植入 4 红）见 [handoff](../handoff.md) Active work 103。

## 5. 配置面（环境变量）

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `ZEUS_HOST` / `ZEUS_PORT` | `127.0.0.1` / `8787` | 监听地址与端口 |
| `ZEUS_INTERNAL_TOKEN` | 无 | bearer；**空则 72 条写面路由全不挂载** |
| `ZEUS_STATE_FILE` | 无 | 内核状态持久化路径（无则纯内存） |
| `ZEUS_AUDIT_FILE` | 无 | 审计 JSONL 路径（0600） |
| `ZEUS_AUDIT_MAX_BYTES` / `ZEUS_AUDIT_KEEP` | 64MiB / 5 | 轮转上限与保留代数 |
| `ZEUS_VASSAL_SEEDS` | 无 | `cardUrl｜token` 逗号列表，启动自动注册 |
| `ZEUS_RSK_KEY` / `_FILE` / `ZEUS_RSK_KEY_ID` | 无 / `zeus-rsk-dev` | 名册封印密钥 |
| `NODE_ENV` | — | `production` 且无密钥时拒启 |
| `ZEUS_MAX_CONCURRENT_BRANCHES` / `ZEUS_BRANCH_QUEUE_LIMIT` | 无界 / 无界 | 全局并发闸与排队上限 |
| `ZEUS_MAX_CONCURRENT_PER_VASSAL` | 无 | per-vassal 饱和上限（A-01 已接线到编排器） |
| `ZEUS_OUTBOUND_ALLOW_HOSTS` | 无 | A-12：出站 URL 守卫的显式放行名单（逗号分隔，`.suffix` 整段后缀匹配），跳过非公网地址检查 |
| `ZEUS_REALM_ROOTS` / `ZEUS_REALM_ENTERPRISE` | 无 | 个人域根（逗号分隔）/ 企业域挂载 `root::tenant` |
| `ZEUS_JUDGE_ENABLED` / `_THRESHOLD` / `_ALLOW_UNCALIBRATED` | false / 无 / false | 对抗式复核开关与闸门 |
| `ZEUS_DECISION_API_KEY` / `_BASE_URL` / `_MODEL` | 无 | Jev 决策后端 |
| `ZEUS_LLM_BASE_URL` / `_API_KEY` / `_MODEL` | 无 | OpenAI 兼容后端 |
| `ZEUS_VAULT_PASSPHRASE` | 无 | 备份包口令（默认 env 名） |
| `ZEUS_BASE_URL` / `ZEUS_TUI_INTERVAL_MS` | `http://127.0.0.1:8787` / 3000 | 终端面板目标与轮询间隔 |

## 6. 维护约定

- 新增功能点 → 更新本文件对应域的表，并在 [handoff.md](../handoff.md) 记录实施进度（本文件不记进度）。
- 功能状态与 [audit-2026-09.md](audit-2026-09.md) 冲突时，以代码为准；审计报告的 A 级条目即"✅ 但有条件"。
- 本文件随代码变化过期：基线 909 测试 / 92 文件，HEAD `b1cf1a6`（A 级修复批末笔）。
