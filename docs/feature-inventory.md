# 功能清单（Feature Inventory）

状态：**现行 v0.2**（2026-09-30 随首轮代码审计建立、2026-10-01 随 A 级 12 条缺陷修复更新，基线 909 测试 / 92 文件；2026-10-01 再随 E2.3 `harden` 语义修正更新，基线 1012 测试 / 94 文件）

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

PRD 共 **54 条需求行**：✅ 46 / 🚧 2（E3.4 MCP 传输、E4.9 凭据委派）/ ⬜ 6（E3.8、E4.10、E5.4、E8.4、E9.4、E10.2）。

## 2. 运行时入口总览

| 入口 | 形态 | 规模 | 鉴权 |
| --- | --- | --- | --- |
| HTTP 门面 | Fastify 长驻进程，`npm start` | **75 条路由**（3 公开 + 72 bearer） | 公开 3 条无鉴权；其余同一 bearer |
| 终端面板 TUI | `npm run tui` | 11 类命令 | `--token` |
| 备份 CLI | `npm run vault` | 4 子命令 | 口令 env / key-file |
| 库公共面 | `import 'zeus'` | 116 处导出 | 不适用 |
| MCP 服务端 | `src/realm/mcp-stdio.ts` | 3 资源模板 + 2 工具 | 宿主预授权目录 |
| 脚本 | `scripts/` | 7 个 | 不适用 |

### 2.1 HTTP 路由（75 条）

公开面（始终挂载，无鉴权）：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/healthz` | 存活探针（status/version/ts，无业务信息） |
| GET | `/api/roster/public` | 已签名公开名册快照，离线可验 |
| GET | `/api/roster/keys` | 名册根公钥（JWKS + SPKI PEM + 指纹），供第三方验签 |

内部面（全部 `requireBearer`，未配 `ZEUS_INTERNAL_TOKEN` 时整组不挂载）：

| 组 | 条数 | 代表路由 |
| --- | --- | --- |
| 名册与执行 Agent | 3 | `GET /api/roster`、`POST /api/vassals`、`DELETE /api/vassals/:name` |
| 意图与编排 | 6 | `POST /api/intents`、`GET /api/intents/:id`、`POST /:id/cancel`、`GET /:id/dag`、`GET /:id/events`（SSE）、`GET /:id/replay` |
| 监督台 | 6 | `GET /api/escalations`、`GET /:id`、`POST /:id/approve`、`/reject`、`/approve-resume`、`/resolve` |
| 指标与状态 | 3 | `GET /api/metrics`、`GET /api/state`、`GET /api/audit` |
| 组织编制 | 9 | `GET /api/org/chart`、`GET /api/org/accountability/:intentId`、部门建编/安置、上岗与首日简报、`POST /:id/first-task` |
| 记忆 | 12 | `/api/memory/{events,facts,replay,recall}`、`/retract`、`/forget-subject`、`/retractions`、`/integrity`、`/snapshot`、`/reconcile` |
| 日记 | 3 | `GET /api/diary`、`GET /api/diary/export`、`POST /api/diary/generate` |
| 技能与带教 | 14 | `/api/skills` 目录与版本、`install`/`uninstall`/`deprecate`/`harden`/`team`、`/api/mentorships` 全生命周期 |
| 连接器 | 6 | `/api/connectors` 声明/连接/吊销、`POST /api/connectors/:id/tools/:name/call` |
| 数据域与跨域 | 7 | `GET /api/domains`、`GET /api/domains/access`、`POST`/`DELETE /api/domains/grants`、`POST /api/realm/write-grants`、域断开与租户重定向 |
| 决策后端 | 1 | `GET /api/decision` |

路由按内核组件可用性分批挂载：同一 token 下，未装配某组件时该组路由不存在。

### 2.2 CLI 与脚本

| 命令 | 形态 | 能力 |
| --- | --- | --- |
| `npm run vault build` | 子命令 | 绘制备份清单（manifest-only）并加密封印 |
| `npm run vault backup` | 子命令 | 打包清单 + 全量备份包（AES-256-GCM） |
| `npm run vault check` | 子命令 | L0 就地校验，按清单指纹查漂移；退出码 0/1/2/3 |
| `npm run vault restore` | 子命令 | 按清单 + 备份包跨位恢复（含 dry-run 与 plan） |
| `npm run tui` | 交互面板 | 刷新、批准/拒绝升级、按立场裁决、吊销 Agent、签发/撤销跨域授权、退出；写操作需 `y/N` 确认；zh-CN/en 双语言 |
| `npm run smoke:core` | 脚本 | 真进程 + 真 socket 核心链路冒烟（36 步） |
| `npm run acceptance:fanout` | 脚本 | 对真实执行 Agent 的扇出验收 |
| `npm run bench:capacity` | 脚本 | 五场景容量压测（扇出宽度 / 并发意图 / HTTP 门面吞吐 / 取消传播 / 并发闸门代价） |
| `npm run verify:roster` | 脚本 | 名册封签离线验签（含 `--card` 深校验） |
| `scripts/acceptance-standard-a2a.mjs` | 脚本 | 纯标准 A2A 客户端验收，不认任何私有头 |
| `scripts/gen-rsk-key.mjs` | 脚本 | Ed25519 密钥对生成（私钥 0600），零依赖跨平台 |

## 3. 功能点明细

状态标记：✅ 已落地且已接线｜🚧 部分落地或已实现未接线｜⬜ 未实现。

### 3.1 并发协同与决策内核（PRD E1）

| 功能 | 落地位置 | 状态 |
| --- | --- | --- |
| 一层扇出/汇聚：按技能或显式名单并行派发 N 个执行 Agent | `orchestrator/orchestrator.ts` | ✅ |
| 意图幂等：同 intentId 重放零出站 | `orchestrator.ts:121-126` | ✅ |
| 取消传播到全部非终态分支 | `orchestrator.ts:337-359` | ✅（A-11 已修：意图在首个分支派发前落最小可取消态，取消结果回写分支与聚合） |
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

### 3.3 数据域与数据主权（E3）

| 功能 | 落地位置 | 状态 |
| --- | --- | --- |
| 目录即数据库：connect / manifest / search / read | `realm/store.ts` | ✅ |
| 确定性 realmId（realpath 派生）与内容指纹 | `realm/store.ts` `realm/digest.ts` | ✅ |
| 路径逃逸防护（路径段 + realpath 双检，拒符号链接） | `realm/store.ts:178-199` | ✅ |
| 文本白名单、隐藏与依赖目录剪枝、1MiB 上限 | `realm/store.ts` scan | ✅ |
| 数据二极管：域须在 fealty 声明内才注入 | `dispatch/dispatcher.ts:132` | ✅ |
| 企业域三级租户（org/department/member） | `realm/tenant.ts` | ✅ |
| 双域授权：个人↔企业单向隔离，显式签名一次性授权 | `realm/authorization.ts` | ✅ |
| 企业域写凭证：签名且一次性，nonce 账本 | `realm/grant.ts` | ✅ |
| 内核侧域检索（内核自己取数并核对声明域类型） | `realm/source.ts` | ✅ |
| 只读 MCP 服务端（stdio）：资源映射、工具白名单、绝对路径不出进程 | `realm/mcp.ts` `mcp-stdio.ts` | 🚧（P0 已落地，正式 P1 待标准 client 复核） |
| 备份清单与恢复协议：原地校验 + 加密备份包跨位恢复 | `vault/` | ✅ |
| 执行授权票据（一次性短时授权，签名 + 单 nonce） | `delegation/execution-delegation.ts` | 🚧（原语已落，派发闸门未接线，deferred #33） |

### 3.4 执行 Agent 联邦（E4）

| 功能 | 落地位置 | 状态 |
| --- | --- | --- |
| A2A 超集协议：卡片、fealty 版本协商、SSE 流、任务产物回传字段 | `a2a/types.ts` `dispatch/client.ts` | ✅ |
| 名册内外双视图投影与公开封签 | `registry/roster.ts` `registry/signing.ts` | ✅ |
| Ed25519 + JCS 两层信封（条目 attestation + 快照 seal），离线可验 | `registry/signing.ts` | ✅ |
| 吊销强制力：派发前阻断、凭据即刻断流、四视图不回显 | `registry/registry.ts` `dispatch/dispatcher.ts` | ✅ |
| 出站凭据注入（`url｜token` seed、快照持久化、0600） | `registry/registry.ts` `tokenFor` | ✅ |
| SLA 受理计时审计 | `dispatch/dispatcher.ts:147-176` | ✅ |
| 文件/URI 产物部件（只呈现不自动拉取） | `a2a/parts.ts` | ✅ |
| 对线上真实执行 Agent 的协议验收 | `scripts/acceptance-standard-a2a.mjs` | ✅（E4.8 已实跑 PASS） |
| 凭据委派（execute 模式） | 未实现 | ⬜（E4.10） |
| 入站 A2A 面 | 未实现 | ⬜（deferred #19） |

### 3.5 HTTP 门面与名册（E5）

| 功能 | 落地位置 | 状态 |
| --- | --- | --- |
| 薄传输层：全库仅 `http/` 引 fastify，内核零传输依赖 | `http/server.ts` | ✅ |
| 常量时间 bearer 比对，未配 token 则写面整组不挂载 | `http/server.ts:229` `:2040` | ✅ |
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
| 文档一致性断言（9 项机械校验） | `tests/doc-consistency.test.ts` | ✅ |

## 4. 已实现但未接线的功能

这一类不在 PRD 的 ⬜ 里，因此最容易在盘点时被算成"已完成"。它们是**能力齐备但没接到主路径上**。2026-10-01 的 A 级修复批把原列 6 项中的 per-vassal 并发上限（A-01）、跨域授权 nonce 防重放（A-04）、连接器空权限 fail-closed（A-09）三项接上了主路径，下表为剩余 3 项：

| 功能 | 位置 | 缺的那一步 |
| --- | --- | --- |
| 执行授权票据派发闸门 | `delegation/` 原语已落 | 派发路径与 A2A 投递未接线（deferred #33） |
| 数据二极管按 `dataPolicy` 收缩范围 | `dispatcher.ts:139` | 只区分 `none`，两档等价 |
| `startServer()` | `http/server.ts:1703` | 无调用方，且未从 `index.ts` 导出 |

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
