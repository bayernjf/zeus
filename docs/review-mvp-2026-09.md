# Zeus 项目级评审：功能性 / 完整度 / 可上线（MVP 判定）

> 状态：**现行（评审报告 v0.39，2026-10-09，S11 V3 slice 1 轮（评审对象：Active work 173，基线现测 **1435 总量 / 1435 绿 / 0 失败 / 129 文件**、冒烟 45/45、doc-consistency 18/18、typecheck/build exit 0：两个判定维持——**核心 MVP ✅ / 可上线 ❌**，可上线 ❌ 理由清单无新增，全部在仓库外。**本批推进**：recoverChain 接失败分支运行时（`OrchestratorOptions.onChainRecovered` hook + `fanOutNew` 恢复循环：ChainFailure 构造 idempotent:false / retriesLeft:0 / highStakes=execute / circuitOpen=预算熔断现态 / hasAlternateProvider=候选面未派发者 / requiredStep:true；boot 审计脊 `tool-failed` 实发、`chain-*` 按裁决分流——意图级 fan-out 候选面全派发、内核不持幂等/重试预算/可选步声明，故裁决恒 escalate，retry/switch/degrade 可执行动作随 V3 slice 2 ChainPlan/DAG 步面），+5 测试 / +1 文件（`tests/orchestrator-recovery.test.ts`），11 处文档行号锚点按校验词新行号批量修正。上一条 v0.38（2026-10-09，A 档三批 + B 档九篇设计稿轮（评审对象：Active work 169–172，基线现测 **1430 总量 / 1430 绿 / 0 失败 / 128 文件**、冒烟 45/45、doc-consistency 18/18、typecheck/build/lint exit 0：两个判定维持——**核心 MVP ✅ / 可上线 ❌**，可上线 ❌ 理由清单无新增，全部在仓库外。**本批推进**：A1 S1 V3 per-branch 上下文预算（`src/context/budget.ts`：四源优先级、低优先级源截前缀、只截出站副本）、A2 S10 V2 介入分级 interruptLevel 0/1/2 全链接升级队列、A3 S11 V2 候选面接 fanOutNew 实况选靶 + `onCandidatesSelected` hook + `tool-selected` 审计首次实发，合计 +20 测试 / +2 文件；**B 档九篇 tech map 设计稿一次出齐**（S8 内容护栏 / S6 分布式 trace / S9 成本治理 / S13 崩溃恢复 / S7 evals / S12 规划 / S15 流式 / S16 沙箱 / S17 Agent 测试，均 v0.1、V1 零 IO 纯函数切法、未落码）。上一条 v0.37（2026-10-09，S10/S11 V1 落码轮（评审对象：Active work 167/168，基线现测 1410 总量 / 1410 绿 / 0 失败 / 126 文件、冒烟 45/45、doc-consistency 18/18、typecheck/build/lint exit 0：两个判定维持——核心 MVP ✅ / 可上线 ❌。**本批推进**：tech map B/C 组两篇设计稿 V1 落码——介入分级判定（Active work 167：`src/oversight/interrupt.ts` `classifyInterruption` 六信号→L0/L1/L2 固定判定链，L2 仅「无替代 provider + 下游依赖」双条件；`interruptionReason` 措辞纯函数，零 IO 零接线）+ 工具/Skill 选择与恢复（Active work 168：`src/orchestrator/discovery.ts` `selectCandidates` 点名钉选 > 自动选靶饱和过滤 > tier-1 只读收窄 fail-closed > 能力面 execute/plan；`recoverChain` 重试→换将→降级→升级，高利害跳过重试、熔断跳过自动路径）+ 审计 8 值入 AUDIT_DECISIONS（33 个）+ TUI token；design-hil/design-tool-discovery 升 v0.2，tech map S10/S11 升"V1 已落地"。**可上线 ❌ 理由清单无新增**，剩余理由全部在仓库外（真机部署验收 #6、RSK 托管 + 带外公钥公告、#9 阈值调参、bayjf R2 公开）。上一条 v0.36（2026-10-09，S1 上下文工程 V2 技能 inputs 装配轮（评审对象：Active work 166，基线现测 1379 总量 / 1379 绿 / 0 失败 / 125 文件、冒烟 45/45、doc-consistency 18/18、typecheck/build/lint exit 0：两个判定维持——核心 MVP ✅ / 可上线 ❌。**本批推进**：S1 上下文工程 V2 技能 inputs 装配（Active work 166）——`src/context/skill-inputs.ts` 纯函数 `assembleSkillInputs`（`SkillSpec.inputs` 从死声明变装配约束：显式载荷补全 / 缺失标 `unavailable` 不臆造）+ 共享裁剪完整规则（去重取 updatedAt 最新 / 相关度闸 minScore 默认关闭 / 敏感面保留）+ `fanOutNew` 装配点 skillInputsProvider 窄端口 + 出站载荷 `skillInputs`（dispatcher 与 contextAppendix 同层）+ boot 接线（skillRegistry.get(id)?.inputs，A2A 卡协议形状不携带 inputs，显式注册是唯一声明路径）+ 审计 reason 扩 `unavailable|relevance` 带 source 分流措辞；design-context-engineering v0.4，tech map S1 升"V1+V2 已落地"。**可上线 ❌ 理由清单无新增**，剩余理由全部在仓库外（真机部署验收 #6、RSK 托管 + 带外公钥公告、#9 阈值调参、bayjf R2 公开）。上一条 v0.35（2026-10-09，S1 上下文工程 V1 记忆装配轮（评审对象：Active work 165，基线现测 1368 总量 / 1368 绿 / 0 失败 / 124 文件、冒烟 43/43、doc-consistency 18/18、typecheck/build/lint exit 0：两个判定维持——核心 MVP ✅ / 可上线 ❌。**本批推进**：S1 上下文工程 V1 记忆装配（Active work 165）——`src/context/assemble.ts` 纯函数装配器（factId 去重取高分 / 凭证形态敏感面剔除 / 降序截断，事件 `context-assembled|context-trimmed|context-budget-exceeded`）+ `fanOutNew` 装配点（S4 预算闸后、分支构造前一次装配，缺 store / 未命名 realm 优雅降级零装配零审计）+ 出站载荷 `contextAppendix` 随分支派发（dispatcher 与 realmHits 同层）+ boot 接线（memoryStore/contextOptions/onContextAssembled 审计桥）+ TUI token；design-context-engineering v0.3，tech map S1 升"V1 已落地"。**可上线 ❌ 理由清单无新增**，剩余理由全部在仓库外（真机部署验收 #6、RSK 托管 + 带外公钥公告、#9 阈值调参、bayjf R2 公开）。上一条 v0.34（2026-10-08，E9.4 V2 技能只读 tag 轮（评审对象：Active work 163 + S1 设计稿，基线现测 1352 总量 / 1352 绿 / 0 失败 / 122 文件、冒烟 42/42、doc-consistency 18/18、typecheck/build/lint exit 0：两个判定维持——核心 MVP ✅ / 可上线 ❌。**本批推进**：E9.4 V2 技能只读 tag 体系（Active work 163，`src/trust/tier.ts` 增 `READ_ONLY_TAG`/`isReadOnlyTagged`，入站 A2A 面 tier-1 能力面收窄为只读技能白名单——缺 registry / 未注册 / 非只读 fail-closed 403 + `inbound-task-refused`（带 tier-1）审计，零出站，tier-2/3 现行规则；design-external-trust v0.2，PRD E9.4 补注 V2）与 tech map S1 上下文工程设计稿（design-context-engineering v0.1，四源装配/共享裁剪/预算/换入换出接口，只设计不落码）。**可上线 ❌ 理由清单无新增**，剩余理由全部在仓库外（真机部署验收 #6、RSK 托管 + 带外公钥公告、#9 阈值调参、bayjf R2 公开）。上一条 v0.33，2026-10-08，S4 终止与收敛轮（评审对象：Active work 161–162，基线现测 1344 总量 / 1344 绿 / 0 失败 / 122 文件、冒烟 42/42、doc-consistency 18/18、typecheck/build/lint exit 0：两个判定维持——核心 MVP ✅ / 可上线 ❌。**本批推进**：E9.4 信任分级 V1（Active work 161，`src/trust/tier.ts`，入站 A2A 有卡调用方判档、tier-1 锁 plan、审计 external-agent-admitted/refused）与 S4 意图级终止守卫（Active work 162，`src/orchestrator/termination.ts`，步数预算 256 + 连续失败熔断 8，默认开启、随快照恢复、审计两值，design-supervision §7.1 / tech map A 组 S2/S3/S4/S5 全部 ✅）。**可上线 ❌ 理由清单无新增**，剩余理由全部在仓库外（真机部署验收 #6、RSK 托管 + 带外公钥公告、#9 阈值调参、bayjf R2 公开）；库内可一口气推进项：tech map A 组已收口，剩台账时效维护级候选与 deferred 外部触发项。上一条 v0.32，2026-10-08，口径纠错轮（评审对象：Active work 158，基线现测 1320 总量 / 1320 绿 / 0 失败 / 120 文件（env 配置面双向普查断言 +1，doc-consistency 17 → 18 例）、typecheck exit 0、doc-consistency 18/18：两个判定维持——核心 MVP ✅ / 可上线 ❌。**本批只纠口径、不新增能力**：① 理由清单 ① 的口径混淆纠正——pr-helper 侧验收 #6（标准 A2A 客户端打 pr-helper）早已销项（checklist A1 ①：守护脚本 2026-09-25 首次、09-27/29 对线上 pr-helper-ten.vercel.app 复跑 exit 0），未做的是 **Zeus 门面真机部署（PRD E10.2）后用标准 A2A 客户端打 Zeus 自己的入站面**（`/.well-known/agent-card.json` + `tasks/send`，deferred #19 入站面 2026-10-07 落地）；② env 配置面双向一致性断言入库（doc-consistency 第 18 例：src 直接读取的 `ZEUS_*` 必须在 .env.example 文档化、模板列出的必须被代码读取或持证据入动态名白名单，双向缺陷植入验证；checklist B4 的逐行手工核对从此机械化）。上一条 v0.31，2026-10-08，台账销 A3 余波轮（评审对象：Active work 154–155，基线现测 1319 总量 / 1319 绿 / 0 失败 / 120 文件（联调库内件 +3）、typecheck exit 0、doc-consistency 17/17：两个判定维持——核心 MVP ✅ / 可上线 ❌，但"可上线 ❌"理由清单又划掉一条——**③ Zeus↔loom 真机联调已于 2026-10-08 对隔离真机栈实跑销项**（`acceptance:loom` 18/18 exit 0，`x-zeus-report` 原文回传，见 handoff Active work 154/155 与 design-loom-interop v0.2），剩余理由全部在仓库外（真机部署验收 #6、RSK 托管 + 带外公钥公告、#9 阈值调参、bayjf R2 公开）；库内可一口气推进项已枯竭——剩余纯库内候选仅台账时效维护，deferred 未销项全挂外部触发或仓库外。上一条 v0.30（2026-10-08，台账过期批 + 补证轮（评审对象：Active work 145–148，基线现测 1316 总量 / 1316 绿 / 0 失败 / 119 文件、冒烟 42/42、doc-consistency 17/17、typecheck / build exit 0、三条验收脚本 9/9·7/7·7/7）：两个判定维持——核心 MVP ✅ / 可上线 ❌，但"可上线 ❌"的库内唯一理由 B-44 已销（142 封顶 + 145 出窗归档双线闭合），剩余理由全部在仓库外（真机部署验收 #6、RSK 托管 + 带外公钥公告、Zeus↔loom 联调、#9 阈值调参、bayjf R2 公开）；deferred #42/#43 本批销项，库内可一口气推进项已枯竭——剩余纯库内候选仅台账时效维护，deferred 未销项全挂外部触发或仓库外。上一条 v0.29（2026-10-07，库内能力完备度推进轮（评审对象：Active work 142–144，基线现测 1270 总量 / 1270 绿 / 0 失败 / 117 文件、冒烟 42/42 复跑、doc-consistency 17/17、typecheck / build / lint / lint:secrets 各自 exit 0、三条验收脚本 9/9·7/7·7/7）：两个判定维持——核心 MVP ✅ / 可上线 ❌。deferred #19 入站 A2A 面与 deferred #18 MCP streamable HTTP 传输层提前实现（方向已固化项按 #6 先例落地），feature-inventory §4「已实现但未接线」0 项维持；库内可一口气推进项收窄为评审刷新本身，其余全挂仓库外动作或外部触发。上一条 v0.28（2026-10-06，证据补强轮（评审对象：Active work 140–141，基线现测 1223 总量 / 1223 绿 / 0 失败 / 112 文件、冒烟 42/42 复跑、doc-consistency 17/17、typecheck / lint / lint:secrets 各自 exit 0）：两个判定维持——核心 MVP ✅ / 可上线 ❌。自托管设计稿 §7 六步全部完成、P0 八步试点实跑全过（Active work 138，含两条装配缺陷的现场修复）、P1 `watch` HTTP 操作者面落地（Active work 139），P1 仅剩 TUI/Web watch 专属控件；仓库外关口集合不变，库内 B-44 保留策略批仍开放）**
> 评审方法：PRD 逐条核对（代码 + 测试证据）、全量验证实跑（vitest / tsc / build）、容量压测实跑（四场景）、部署/运行入口与制品面检查（Dockerfile / serve.ts / RSK 工具）。**v0.9 追加两问法**：① 每条支柱不查"有没有实现"，查"操作者从文档出发能不能走到它"（grep 到动词的**读取方**才算执行点）；② 首跑路径在**编译产物真进程**上按 `.env.example` 原样跑，并做 A/B 对照定位因果。
> **⚠️ 下面这句 v0.4 结论已被 v0.9 改判，保留只为追溯"一句过期陈述如何被逐份继承"**：**库内"内核 + 可部署制品"级 MVP 已达成——v0.1 所列 5 个硬阻塞在代码/制品侧均已有对应实现；产品级"可上线 MVP"仍未达成，但剩余关口已全部是仓库外验收动作（真机 docker build/run、真机执行 Agent 部署与 loom 联调、RSK 实际托管/公钥发布、Jev key。**push 后云端 CI 这条已于 2026-09-25 销项，见下方 v0.6**），库内已无 P0 功能缺口。**

> **【2026-09-22 六切片批次后 · 销项更新 v0.2】** 下列为评审 v0.1 之后的库内进展（全量 **166 测试绿 / 22 文件**，typecheck/build 过；以下为现状，原 §1–§7 快照保留不改）：
> - 硬阻塞 **#3 E2.2 Skill 注册中心 → ✅ 销项**：`src/skills/`（多版本共存、deprecate 标记、按名/域/标签检索、registerFromCard、resolveTeam 多技能组队且歧义不静默选边，10 测试）。E2.4 组队解析一并 ✅。
> - 硬阻塞 **#4 E6.2 决议反馈闭环 → ✅ 销项**：冲突经 onConflict 入监督台（幂等）、decideConflict 校验立场、applyConflictResolution 纯函数回写聚合决策并重算状态（6 测试）。E6.3 补参重派**骨架**（resumeBranch）已落地，"approve 一键自动重派"的装配/HTTP 闭环随 H2（E6.3 仍 🚧）。
> - 硬阻塞 **#2 E5.3 持久化 → 🚧 大幅缓解但未全销**：`src/state/kernel-state.ts` 把执行 Agent 注册表（含已吊销）、升级队列（重建幂等索引）、编排意图结果+原始请求原子落盘（tmp+rename）并可恢复，重启后幂等重放与 resumeBranch 可用（6 测试）。**未做**：Realm 连接状态未纳入快照、文件存储未接入进程启动装配/H2——长驻服务"重启自动恢复"仍需接线。
> - 软阻塞 **#8 E1.7 可观测 → 🚧 库内已落地**：`ConcurrencyMetrics`（在途数/并发峰值/队列深度/完成失败超时/各执行 Agent 延迟 p50·p95/失败率，5 测试）；HTTP 指标端点随 H2。
> - 非阻塞增强：**完整 DAG（S3）→ ✅**（`src/orchestrator/dag*.ts`，拓扑分层/关键路径/部分失败跳过，6 测试）；**决策后端工程切片 → ✅**（`src/decision/`，模型无关端口 + Jev/LLM 适配器 + 降级，9 测试；Jev 真实 endpoint/envelope 待有 key 真机核对）。
> - **仍未销项（故产品级可上线 MVP 判定不变：仍未达成）**：硬阻塞 #1 部署形态、#5 生产 RSK 密钥；软阻塞 #6 E4.8 真机验收、#7 真机联调、#9 push + 云端 CI 首绿（需授权）；以及 E5.3 的启动装配接线与 Realm 持久化、E10.4 容量压测。

> **【2026-09-22 A 批次（G1/G4/G5/G6）后 · 销项更新 v0.3】** 评审 v0.2 之后的库内进展（全量 **217 测试绿 / 31 文件**，tsc 过；以下为现状，原 §1–§7 快照保留不改）：
> - **G1 执行 Agent 上线入口（致命缺口）→ ✅ 销项**：`POST /api/vassals`（拉 card + fealty 校验注册，卡片不可达 502）、`DELETE /api/vassals/:name`（吊销，未知/已吊销 404）；`ZEUS_VASSAL_SEEDS` 支持启动 seed，已在状态快照中的 URL 跳过不重复拉取。长驻服务不再以空 registry 启动。
> - **G4 Realm 连接持久化 → ✅ 销项**：KernelSnapshot 增 `realms`（连接参数 root/realmId/type/readOnly，向后兼容可选字段）；`bootKernel` 装配 FsRealmStore，重启自动 reconnect 重建检索索引；`ZEUS_REALM_ROOTS` 支持启动连接；已持久化 root 不可达时 fail-loud 拒启，不静默丢域。
> - **G6 E6.3 一键补参重派 → ✅ 销项**：`POST /api/escalations/:id/approve-resume` 携带 params，approve 后经新增 `Orchestrator.findIntentForBranchRun` 定位意图并自动 `resumeBranch` 重派、重算整意图。
> - **G5 H3 服务端 SSE → ✅ 销项**：编排器发出 branch-started/branch-ended/intent-finished 进度事件到新增 `ProgressHub`；`GET /api/intents/:id/events` 输出 SSE（15s keepalive ping、已完成意图回放单事件后关闭、无 hub 时未知意图 404）；hijack 后 `flushHeaders` 保证客户端即时收到响应头。
> - **产品级可上线 MVP 判定仍为：未达成**。剩余关口全部在仓库外或需授权，库内已无法继续闭环：E4.8 真机验收（pr-helper 部署）、Zeus↔loom 真机联调、push dev→云端 CI 首绿（需授权）、E10.4 容量压测基线、Jev 真实 endpoint/key 核对。

## v0.5 更正（2026-09-25，唯一变化是 E4.8/M3 的阻塞归因）

> v0.4 的功能性/完整度/MVP 判定结论**不变**；本节只修一处被 v0.1→v0.4 一路转述、从未被核实的错误陈述。

- **错在哪**：v0.3/v0.4 都把"E4.8 真机验收"的阻塞写成 **"pr-helper 部署"**（"剩余关口全部在仓库外…E4.8 真机验收（pr-helper 部署）"）。**事实：pr-helper 早已部署在生产并每天被使用**（`https://pr-helper-ten.vercel.app`）。核实依据读自 `../pr-helper` 仓库：`vercel.json:9` 将 `/.well-known/agent-card.json` rewrite 到 `/api/a2a/agent-card`；`api/a2a/agent-card.ts` 引入 `handleJsonRpc` + `createTaskStore`；`docs/verification-report.md:40` 记 Production 域；`handoff.md:211` 说明该域签发 GitHub OAuth 会话。
- **正确说法**：E4.8 仍 🚧，但**卡点是"没人对线上执行过一次这条验收"，不是"待部署"**。zeus 与 pr-helper 两边的记录里都没有任何一次线上 A2A 验证。关闭动作：`BASE_URL=https://pr-helper-ten.vercel.app node scripts/acceptance-standard-a2a.mjs`（默认 `deployment-health`，只读）。
- **对 M3 的连带重估**：M3（真机闭环）此前被判为"制品就绪、真机未验"，语气像是要等外部工程。**实际只差执行**：执行 Agent 在生产、Zeus 侧制品（Docker / 持久化 / 注册入口 / H2 操作者面 / 签名名册）齐备，需要的是跑一次验收 + 起一个 Zeus 实例注册它 + 一次真机扇出。
- **不可由评审者自行完成的部分**：本次评审所在的沙箱到不了该域（本地 DNS 解析到 `199.96.59.95`、TCP :443 不可达；`pr-helper.pages.dev` 只回 SPA 外壳，A2A 函数在 Vercel 侧），**故本条不声称"已验证"**，只声称"已核实该服务的部署事实与代码存在性"。
- **纪律**：本文档链条显示一个可复现的失效模式——**一条过期陈述会被后续每份报告原样继承**（v0.1 写下"待部署"，v0.3/v0.4/PRD/README/handoff 全部沿用）。此后引用任何"待 X / 已 Y"状态句，先跑一条命令核实。

## v0.6 销项（2026-09-25，唯一变化是"push + 云端 CI"这条关口关闭）

> v0.4 的功能性/完整度判定与 v0.5 的归因更正**均不变**；本节只关闭一条从 v0.1 挂到 v0.5 的关口。

- **关闭的关口**：v0.1 起的每一步评审都把"push dev → 云端 CI 首绿（需授权）"列为剩余动作，且历史上只写过"workflow 已备、本地按 CI 序列实跑全绿"。现状：**三次 push 均在 GitHub 侧拿到结论，Node 20.x / 22.x 双矩阵全绿** —— run 36024156638（472/56 文件）、36045209815（512/60）、36061395015（**532/61**，26s/22s），无 flaky 复现。`git rev-list --left-right --count origin/dev...HEAD` = `0 0`。
- **基线随之刷新（v0.4-A 表保留为 2026-09-24 快照）**：现行本机 + 云端基线 = **532 测试 / 61 文件、`tsc --noEmit` 与 build exit 0**，容量侧为**五场景**（原四场景 + E1.5 闸门档），数据与口径见 capacity-baseline v0.3。
- **新增一条 runner 层风险（已于 2026-09-26 销项）**：每次 run 都重复注解 `ubuntu-latest` 将于 **2026-10-19** 自动迁 Ubuntu 26 —— 换构建机不需要我们改代码，也不需要任何人批准。登记 deferred **#16**，当日决定**钉 `ubuntu-24.04`**（`.github/workflows/ci.yml` 内注明理由与"换镜像要有意地换并复验"）；Node 矩阵仍归 #15，不随本条变。
- **对判定的影响（说清楚，不夸大）**：这条关口从来不是功能缺口，所以 **MVP 判定不变**；变的是剩余关口的**性质**——v0.6 之后，清单里**没有任何一条是"等授权/等确认"**，全部是需要真实环境、真实凭证或真实执行 Agent 的执行项（真机 docker build/run、对线上跑一次 E4.8 验收、Zeus↔loom 联调、RSK 托管与公钥发布、Jev endpoint/key 核对）。

## v0.8 更新（2026-09-25，E9.1 / E9.2 上岗门收口，并记一条测试结构性缺口）

- **关闭两项 P2**：E9.1 首日岗位简报 ✅、E9.2 上岗即用流程 ✅（设计与边界见 [design-onboarding](design-onboarding.md)）。做法是一个**只负责拒绝的组合层** `src/onboarding/`：四道门各自的证据来自拥有它的模块（编制 E9.3 / 执行 Agent 目录 / 域判定 E3.6+E6.4 / 认证 E2.5），**资格每次现算不缓存**——签字之后吊销执行 Agent 或撤出名册，资格自己就没了。
- **v0.7 的两类划分当场得到验证**：那批被标为"库内可做、等的是判断不是环境"的工作，同日真的做完了。剩余项随之收窄：库内可推进 = E8.4（传承，P3）、#13、#17、#18；仓库外 = E4.8（**P0 唯一未闭合项**）、E10.2/真机 docker、RSK 托管与公钥发布、Jev key、以及"由真实执行 Agent 当一次 Mentor"。
- **一条结构性缺口值得单记（不是本批引入的）**：`fix(registry) 151ab3b` 修的是"fealty 缺字段的卡片能注册、派发时才以 TypeError 崩"。它之所以在 620 项测试全绿的状态下活了四天（`src/registry/registry.ts` 自 2026-09-21 起就这样）：：测注册的 fixture 从不派发，测派发的用例注入 port 从不调 `register()`——两半各自绿，串起来才炸。这不是断言不够多，是**测试里缺少把两个模块串起来的真实路径**；同日两次冒烟（E6.4 签发 nonce、E9.2 卡片 oath）都是真实进程先发现的。评审口径据此加一条：涉及跨模块契约的改动，只看 inject 测试不足以判"已验证"。
- **基线**：**620 测试 / 68 文件**，`tsc --noEmit` 与 build exit 0；门的可失效性做了四次缺陷植入（2 / 3 / 2 / 4 例红），每次改回后 diff 校验字节一致。
- **判定不变**：库内内核级 MVP ✅；产品级可上线 MVP ❌——差的仍是真实环境里跑起来、联起来、签出去。

## v0.7 更新（2026-09-25，E3.6 / E6.4 在库内收口，并更正一处评审自身的判断）

- **关闭两项**：E3.6 企业域三级租户 ✅、E6.4 双域授权与审计呈现 ✅（设计在 design-realm §7，验收细节在 PRD 对应行）。**P0 侧未闭合项仍只有 E4.8**（对线上跑一次验收，纯执行）。
- **这批补的是"可核验性"而不是功能面**：此前 `realmHits` 由调用方自报、内核从不进任何 Realm，所以"声明 personal 域却携带企业域内容"这类越界**没有任何执行点可以拒绝**——边界写在文档里，不在代码里。现在内核自己按 realmId 取数、核对真实域类型与声明是否一致，判定住在唯一函数 `decideRealmAccess` 里，放行与拒绝写入同一条审计链。
- **更正本文档自己的一个判断**：§C 在 v0.4 写"PRD 剩余项无一项能在库内继续闭环"，**这句被后续批次证伪两次**（E3.6/E6.4 正是库内做的）。已改为两类划分：**仓库外执行类**（真机、密钥托管、外部凭证）与**库内可做但需决策类**（E9.1/E9.2 带教上岗、E8.4 传承、#13、#17、#18）。这与 v0.5 记的"过期陈述被逐份继承"是同一种失效模式，只是这次失效的是评审本身。
- **基线刷新**：本机与云端同口径 **587 测试 / 66 文件**，容量侧五场景（含 E1.5 闸门档）。真实进程冒烟覆盖了本批（挂载租户、访问探针、签发、重启恢复），并**在冒烟中抓到一个"587 项测试全绿但功能实际不可用"的缺陷**（签发接口要求调用方自带 nonce，而我的测试每次都传了 nonce）——这是"仅 inject 测试不足"的新证据。
- **判定不变**：库内内核级 MVP ✅；**产品级可上线 MVP ❌**，差的仍是真实环境里的跑起来、联起来、签出去。
- **本批留下两条诚实的尾巴**（登记而非半做）：**#17** 改租户 / 下线 Realm 无可执行路径；**#18** MCP 资源读取侧没有 actor 概念，故 §7 的规则在那条路径上暂无执行点。

## v0.19 复核（2026-09-27，评审 v0.18 之后的仓库：**核心 MVP ✅ / 可上线 ❌ 维持**；本轮把账算准——一处**上线验证门文档里的活基线落后两批**、一处 v0.18 自己引偏的行号，并因**出货件动过**而重新实构实跑镜像层）

> 方法不变：v0.18 的记录不作依据，凡判定里含动词的条目重新取证。评审对象：`dev` HEAD `25c601c`，距 v0.18 的 `8b53c8e` **24 个 commit**。**本轮与往轮的一处方法差别**：先跑 `git diff --stat 8b53c8e..HEAD -- src/`，发现 `src/http/rsk.ts`、`src/http/serve.ts`、`src/http/server.ts` 在 v0.18（Active work 62）之后被 Active work 65 改过——**出货件动过，镜像层就不能沿用上一轮的结论**，于是本轮重新 `docker build` + 实跑（§F），而不是像 v0.18 那样声明"src 零改动所以未跑"。
>
> **耗时与负载口径（先说，因为它影响每一条读秒数的结论）**：本轮同机 load 从 **349 起、峰值 514**（多会话并行），`npm test` 因此 **140.47s**（空闲时约 4–15s）。本轮**未出现超时红**，一次全绿——这是本轮的运气，不是负载变轻。

### A. 验证基线（本机实跑，非转述）

| 项 | 结果（2026-09-27 本轮） | 量法 |
|---|---|---|
| 全量测试 | **786 passed / 83 files / 0 失败**，140.47s（同机 load 349 → 峰值 514） | `npm test; echo $?` → **exit 0**。退出码不经管道取 |
| typecheck / build | 各自 exit 0，`dist/` 完整 | `npm run typecheck`、`npm run build`（按 CI 顺序在 test 之前） |
| 核心链路冒烟 | **35/35**，两次实跑（一次 `--keep` 留产物、一次干净跑） | `npm run smoke:core` → **exit 0** |
| 独立边界探针 | **6/6**（本轮自写的一次性脚本，**不是仓库资产**，与冒烟相互独立） | 见 §C 末行 |
| 镜像 | `docker build` exit 0（`zeus:review-v019`，369MB），实跑见 §F | 用完只删自己起的容器与标签：实测 `docker images` 无该标签、`docker ps -a` 无该容器，**同机他人镜像/容器（`zeus-review`）未触碰** |
| 远端同步 | `git ls-remote` 实测 `origin/dev` = 本地 HEAD `25c601c`，`rev-list --count` = 0 | **云端 CI 是否绿本轮未验证**（`gh` 被权限层拦），不写成结论 |

### B. 需求覆盖：机械核对，不读叙述

- **PRD §4 共 54 条需求行。P0 = 26 条，状态列 26 个 ✅，非绿 0 条。** 逐行解析表格第 3/4 列，不读任何正文。
- **非 P0 未完成 8 条**：E3.4 🚧、E3.8 ⬜、E4.9 🚧、E4.10 ⬜、E5.4 ⬜、E8.4 ⬜、E9.4 ⬜、E10.2 ⬜——与 v0.17 / v0.18 同一集合，本轮零变化。成因与阻塞面见 §G。
- 本轮**未**在状态列里再抓到限定词混入（v0.18 的 `🚧 stdio` 已成闸门，`tests/doc-consistency.test.ts` 第 5 例在跑）。

### C. 装配核对：核装配而不是核注册（行号本轮重新定位）

| 面 | 执行点（本轮 grep 实测行号） | 判读 |
|---|---|---|
| A2A 出站凭证 | `src/state/boot.ts:354` `tokenFor: name => registry.tokenFor(name)` | ✅ 在位 |
| 冲突升级闭环 | `src/state/boot.ts:360` `onConflict: conflictsToDesk(oversight)` | ✅ 在位 |
| Skill 治理闸门 + 分流候选 | `src/orchestrator/orchestrator.ts:142` 与 `:169`，`:170` 调 `selectTargets` | ✅ 同一 `activeProviders` 被两处复用 |
| MCP 域边界 | `src/realm/mcp.ts:39` 常量；**拒绝分支本轮实测在 `:191`（`realm.search`）与 `:267`（资源读取）**，`:340` 是错误码映射 | ✅ 有读取方。**v0.18 引的 `:340` 现指向错误码映射器，不是拒绝分支**——见 §E |
| DAG 操作者入口 | `src/http/serve.ts:153` 注入 `dagRunner` → `src/http/server.ts:323`/`:328` 运行、`:428`/`:429` 回读 | ✅ 真进程不会 503（v0.18 引 `serve.ts:149` → `server.ts:312/:317/:415`，**三处均已漂移**） |
| 记忆事件生产者 | `src/state/boot.ts:391` `intent-finished` → `:392` `recordBranchVerdicts` → `:393` `consolidateFinishedMemory` | ✅ 先写 claim 再整理 |
| 根公钥发布 | `src/http/server.ts:190` 路由（鉴权组**之外**） → `src/registry/signing.ts:151` `publishRootKey()` | ✅（v0.18 引 `:183` → `signing.ts:127`，均已漂移） |

**边界探针（本轮自写、与冒烟独立的一次性脚本）6/6**：`/api/roster/keys` 与 `/api/roster/public` **无 bearer 即 200**；`/api/roster` 无 bearer **401**、带 bearer **200**；`POST /api/intents` 无 bearer **401**；`GET /api/intents/:id/dag` 无 bearer **401**、带 bearer 对未知意图返回 **404 `unknown dag`**（**不是 503**，证明 `dagRunner` 真注入了 HTTP 依赖，而非只在测试里注册）。**该脚本用完即删，不是资产**——所以它只能作为本轮证据，不能替代冒烟里那几条常驻断言。

### D. 签名链与离线验签：出货命令复跑（本轮五条）

对象是本轮冒烟真封出来的名册（`schemaVersion=1`、`entries=3`、`keyId=zeus-rsk-dev`）：

| 情形 | 输入 | 退出码 | 脚本给的原因 |
|---|---|---|---|
| 正向 | 原件 + 正确公钥，`--now` 在窗口内 | **0** | `VERIFIED … signature, digest binding, freshness and per-entry attestations all check out` |
| 时钟对照 | 同一份字节、同一把钥，`--now` 越过 `maxAgeSeconds` | **1** | `REJECTED: snapshot seal past maxAgeSeconds` |
| 载荷篡改（本轮手跑） | 改 `snapshot.entries[0].name` | **1** | `REJECTED: snapshotDigest mismatch: snapshot content was altered` |
| 陌生钥（本轮手跑） | 另生成一把真钥来验 | **1** | `REJECTED: seal signature verification failed (keyId=zeus-rsk-dev)` |
| 只用端点响应 | 公钥取自 `GET /api/roster/keys` 的 `spkiPem` 字段本身 | **0** | 同正向 |

后两条本轮**手工**在冒烟留存的产物上复跑（冒烟自身不含"篡改 / 陌生钥"两格）；前三条由冒烟的在库断言覆盖。同一冒烟里另有负对照：把 `spkiPem` 换成 JWK 的 `x` 串 → **exit 2** 点名 `DECODER routines::unsupported`。**五条里没有一条是本轮新发明**——新增的只是"这一轮它们确实又跑了一遍"。

### E. 本轮抓到并已修：一处活基线落后两批（外加一处 v0.18 的行号引偏）

1. **`docs/pre-launch-checklist.md` 里两处活基线落后**：§F-3 写"当前 **784 测试 / 83 文件**；核心链路冒烟 **34 步**"，§F-8 写"**33 步**全绿才退 0"——真实基线是 **786 / 83、35 步**（§A 现测）。**类别与 v0.18 §E-2 同源**：销项批次（Active work 65/66/67）改的是它们自己的门禁行，而 checklist 这两句是**每次上线都要照着跑的活指令**，没人会去比对，于是落后两批。已按现测改正。**为什么值得单记**：这是一份"发布动作清单"里的数字，而它此前**不在任何闸门的扫描范围内**（`doc-consistency` 只管索引版本 / 表格列数 / 粗体配对 / PRD 状态列 / 篇首基线）。
2. **v0.18 §C 把 `src/realm/mcp.ts` 的拒绝分支引成了 `:340`**——该行现在是错误码映射器（`return errorResponse(id, REALM_NOT_CONNECTED, …)`），真正的白名单拒绝分支在本轮实测的 `:191` 与 `:267`。**判定不受影响**（"有读取方"由 grep 到拒绝分支成立），但这是一条与 v0.17→v0.18 同形的**行号漂移**，故在 §C 就地重新定位，不改 v0.18 历史节。

### F. 部署镜像：出货件动过，故本轮重新实构实跑（`zeus:review-v019`）

- **为什么必须重跑**：v0.18 的镜像结论写在 `8b53c8e` 上，其自身记着"上一轮 src 零改动所以未跑"。而 v0.18 之后 Active work 65 改了 `src/http/rsk.ts`、`serve.ts`、`server.ts`——**镜子照的是旧出货件**。本轮先发现这一点，再重建。
- **实测**：`docker build -t zeus:review-v019 .` exit 0（369MB）；按 deployment.md §4.3 起容器（私钥以 `-v <file>:/run/secrets/rsk.pem:ro` 挂载、`ZEUS_RSK_KEY_ID=zeus-rsk-review-2026-09`、`ZEUS_AUDIT_FILE=/data/audit.jsonl`）→ `healthy`。
- **读数**：容器内 `stat -c '%a %U:%G' /data/audit.jsonl` = **`600 node:node`**（启动即建）；`GET /api/roster/keys` 无鉴权即 200，`kid=zeus-rsk-review-2026-09`（取自 env）、`keySource=configured`、`survivesRestart=true`，其 `jwkThumbprint=ymPnJgoI1jGA6BOEi8V_hTfbTIOL08o4pN5fwwfbVdQ` **与 `gen-rsk-key.mjs` 启动前打印的固定值逐字符相同**；只把该端点返回的 `spkiPem` 落成文件、对同容器 `GET /api/roster/public` 跑出货验签器 → **VERIFIED、exit 0**；`docker stop`（SIGTERM）后宿主出现 `kernel-state.json` **456B、mode `-rw-------`（0600）**；`docker start` → 日志 `restored kernel state from /data/kernel-state.json (vassals=0, escalations=0, intents=0)` 且 `healthy`。
- **诚实边界**：本轮跑的是**正向路径**；v0.18 那两条"配置失误撞出来的生产守卫"（`docker cp` 致 EACCES 拒启 / 完全不配钥的生产拒启）**本轮未复跑**，仍停留在 v0.18 的记录里。启动日志枚举对外面时仍是 "healthz, roster public, roster internal + H2 driver API"，未含 `/api/roster/keys`——v0.18 记为"不构成缺陷、不改出货件"，本轮**维持该判断**（它不改变任何判定）。

### G. 功能性 / 完整度 / 可上线（三维判定）

- **功能性：✅ 达成。** 判据未变（一意图 → 按技能扇出 → 规则聚合 → 冲突升级与人工决议 → 补参重派 → 落盘恢复 → 封签发离线可验）。本轮核心路径在真进程 / 真 socket / 自建容器上**全绿且未发现缺陷**：冒烟 35/35 覆盖凭证送达、内核自读域、审计 0600、吊销断流、重启恢复记忆、临时钥真轮换。
- **完整度：M1 ✅、M2 ✅、M3 = 库内制品 ✅ / 真实外部执行 Agent 受调度 ❌。** 与 v0.17 / v0.18 同判，理由**无新增**（v0.18 已把"公钥发布机制已在库内"这条理由消掉）。
- **可上线：❌ 未达成。** 未完成的 8 条非 P0 需求与 §H-2 的仓库外动作**逐条同 v0.18**：A1 真机扇出、A2 私钥托管落点决策 + 指纹带外公告、A3 loom 联调、A4 Jev endpoint/key、A5/R2 bayjf 侧验签展示、E10.2 真实部署、#9/#10 阈值标定（触发条件"≥3 真实执行 Agent 压测"未到）。**本轮没有新增任何"库内可做但没做"的前置项，也没有关闭任何一条——净影响为零。**

### H. MVP 判定（明确回答本轮问题）

1. **产品核心"完全可用"的 MVP = ✅ 达成。** 本轮亲取三条：① 门禁 `npm test` **786 / 83 / 0 失败且 exit 0**（140.47s，load 峰值 514），typecheck/build 各 exit 0，`smoke:core` **35/35 exit 0** 两次；② 需求表机械计数 **P0 26/26**，非 P0 未完成 8 条与上轮同集合；③ 出货件实跑——签名链**五条对照**（其中"篡改 / 陌生钥"两条本轮手工在冒烟产物上补跑）、**六条独立边界断言 6/6**、**部署镜像实构实跑**（healthy / 审计 0600 / 发布字节可验 / SIGTERM 落盘 0600 / 重启恢复）。核心路径未发现缺陷。
2. **可上线交付真实用户 = ❌ 未达成。** 清单见 [pre-launch-checklist.md](pre-launch-checklist.md) §A/§B。**与 v0.18 逐条相同，未收窄也未扩大**：剩下的没有一项能在仓库里闭环。
3. **一句话**：**"核心完全可用"仍为 ✅，且本轮证据是"出货件动过就重拍一次"得来的——镜像层不是继承的；"可上线"仍卡在真实环境里的执行动作与一个治理决策，库内不出活，本轮照实报零净影响。**

### I. 本轮评审限制（如实标注）

- **未复跑**对线上执行 Agent 的 E4.8 验收：维持"记录级证据"，不升格为本轮实测。
- **未验证**云端 CI：`gh` 被权限层拦（连续第三轮）。口径照旧：**推与 CI 结果只能由用户侧确认**，不从"本地全绿"推断"云端绿"。
- **镜像正向路径复跑，但 v0.18 那两条生产守卫（无钥拒启 / EACCES 拒启）本轮未复跑**——它们仍是 v0.18 的记录，不是本轮的。
- **独立边界探针是一次性脚本**，用完即删；它补的是"本轮亲手看过"，不是常驻护栏。
- **负载口径**：load 349 → 514 峰值，`npm test` 140.47s；本轮无超时红，但这不能推断负载影响已消失。
- `#9` 分流阈值与 `#10` 队列档位仍未标定（触发条件"≥3 真实执行 Agent 压测"未到）。
- 本轮**未改动任何出货行为代码**（只改文档）；`src/http/*` 的改动来自 v0.18 之后的 Active work 65，与本轮无关。

## v0.20 销项（2026-09-29，唯一变化是 A1 这条关口关闭；判定不变）

> 用户授权后对线上 pr-helper 跑「真实执行 Agent 注册 + 真机扇出」验收，**15/15、exit 0**，A1 销项。v0.19 各节原文保留不改（其 §G/§H 写于 A1 未关闭时），本节只记关闭事实与归因更正。

- **先前归因被证伪**：v0.12→v0.19 一直把这条记作"A1 真机扇出（凭证与出网许可）"。事实是**判据写错了对象，不是缺凭证**——`scripts/acceptance-real-fanout.mjs` 原判据 `positions≥1`（"分支回了一个立场"）是给**投票型** Agent 的，而 pr-helper 是**执行型**：跑具名技能并回报内容、不投票，故 `positions=0` 是正确结果；`branchVerdictClaims` 迭代 `result.positions`，零立场自然零记忆事件，`events 0→0` 只是它的下游。pr-helper 的 execute 模式返回 `input-required`（凭据代理未实现），而本轮跑通**全程未用到任何凭据**。
- **修法（纯 Zeus 侧，无 src 改动）**：判据可选化——`EXPECT_STANCE=0`（执行型，默认）断言"分支成功且带回内容（artifact 且 `parts≥1`）"并对立场聚合 / 记忆 claim 各打印显式 `SKIP` 附原因，`=1`（投票型）仍断言立场与 claim；注册 / 派发 / 审计 / 离线验签 / 吊销断流 / SIGTERM 落盘两种取值下都照样断言，故取 0 不弱化验收。另修一条真缺陷：runner 原发 `{subject,predicate,prompt}`，而 `deployment-health` 要 `owner`/`repo`（pr-helper 曾回 `input-required "Missing required parameters: owner, repo"`），由新增的 `PARAMS` 原样透传技能参数。
- **实测证据**：`CARD_URL=…/api/a2a/agent-card`（**不传 `TASK_URL`**，内核读卡片声明的 `url` 解析出 `taskUrl`，deferred #29 的修复在真机上再确认）→ 注册 201、名册 active → `PARAMS='{"owner":"jiangfeng","repo":"zeus"}'` 扇出 → 分支 `ok=1/1`、`withContent=1`、`x-zeus-report.summary` 原样回传、`decision={"rule":"majority","positions":[],"conclusion":null,"reason":"no vassal returned a stance; nothing to aggregate"}`（聚合器如实报告"无可聚合"）→ 审计日志 `dispatched` ×2 + `vassal-revoked` → 名册离线验签 VERIFIED → 吊销后公开名册即刻消失 → SIGTERM 后 `orchestrator.intents` 两条落盘（completed 那条含分支与 decision）。
- **范围界定（不夸大）**：pr-helper 在 plan 模式作答，故本项证明的是**真机扇出闭环 + 执行型 Agent 内容回传**，**不含**对 GitHub 的不可逆写操作（凭据代理机制已登记为 deferred #33，不在 A1 出口标准内）。
- **对判定的影响**：M3 的"真实外部执行 Agent 受调度 ❌"一半翻转为 ✅（M3 现只剩 Zeus↔loom 联调）；核心 MVP 维持 ✅，可上线维持 ❌（§A 剩余 A2–A5 + B 系列均为仓库外动作）。活基线 791 / 83、冒烟 36/36 未变。详细批次记录见 handoff Active work 75 与 PRD v0.60。

## v0.21 复核（2026-10-02，评审对象 HEAD `0a867f8`：**核心 MVP ✅ / 可上线 ❌ 维持**；抓到 feature-inventory 的规模普查三个数字互不一致并入库为断言；改了出货件但镜像层因本机到 registry 的网络路径不通而未重拍，限制与落点写在 §F）

> 本轮方法沿用 v0.17 之后的规矩：**上一轮的记录不作依据**，凡判定里含动词的条目重新取证。与往轮的两处方法差别：① **`gh` 本轮可用**（此前几轮记录"被拦"），故 CI 侧不再是空白（§G）；② 镜像层**未能重拍**，因此本轮的"出货件未受影响"这句话**只说得出进程/构建级证据，说不出容器级证据**（§F 逐条列明）。

### A. 验证基线（本机实跑，非转述）

| 项 | 读数 | 备注 |
| --- | --- | --- |
| HEAD / 工作树 | `0a867f8`，`git status --porcelain` 零行 | 本批 3 个 commit 均在本地，`origin/dev..HEAD` = 3 |
| `npm run build` / `npm run typecheck` | 各自 **exit 0** | 先 build 后跑测试（`tests/*` 动态 import `dist/`） |
| `npm test` | **993 绿 / 25 失败 / 1018 总量** | 25 例**逐条按失败原因**复核，全落在三个 Windows 环境性家族：目录 fsync EPERM 17 / chmod 0600 断言 4 / symlink EPERM 4 |
| `npm run smoke:core` | **31/36** | 失败 5 步（0600 chmod ×2 + SIGTERM 持久化连锁 ×3）。**stash 对照**：在未改动的工作树上跑同一条冒烟，失败 5 步逐条相同 → 与本批 diff 无关 |
| `tests/doc-consistency.test.ts` | **10/10** | 含本轮新增第 10 例（§E） |
| `tests/config-surface.test.ts` | 3/3 | 配置面双向对照未回退 |
| 独立边界探针 | **20/20** | 一次性脚本（真进程 + 真 socket + 出货 CLI），跑完即删；内容见 §C/§D |

**"25 例是环境性"这句话本轮不是断言、是量出来的**：逐条读失败原因分类（`EPERM: fsync` / `expected 438 to be 384` 之类 / `EPERM: symlink`），并且 Linux 侧全绿有独立来源（§G 的 CI）。这与 v0.19/v0.20 用 stash 对照得到的结论一致，且本轮多了一层 CI 交叉验证。

### B. 需求覆盖：机械核对，不读叙述

- `docs/prd.md` 需求行 **54 行**（正则 `^\| E[\d.]+ \| .* \| P\d \|`），按单元格机械分类：**P0 26/26 ✅**；P1 ✅13 / 🚧2 / ⬜2，P2 ✅7 / ⬜3，P3 ⬜1。
- 非 P0 未闭合 **8 条**：`E3.4`、`E3.8`、`E4.9`、`E4.10`、`E5.4`、`E8.4`、`E9.4`、`E10.2`——**与 v0.17 / v0.18 / v0.19 / v0.20 同集合**，既无新增也未回退。
- feature-inventory §1 的"✅46 / 🚧2 / ⬜6"与本轮机械计数**逐项相符**。

### C. 装配核对：核"装配"而不是核"注册"

| 主张 | 本轮取证（真进程，非读代码） | 结果 |
| --- | --- | --- |
| 起步路径绑的是文档承诺的默认值，且真的 listen | 本批把 `startServer` 接成单一起步原语；探针在 `ZEUS_PORT=0` 下**只从进程日志**取到 `http://127.0.0.1:57630`（旧代码会打印请求值 `0`），并在该地址上跑通全部端点 | ✅ |
| DAG 路由**已装配**（不是"路由在位"） | `GET /api/intents/<unknown>/dag` 带 bearer → **404 `unknown dag`**；503 只在 `dagRunner` 未注入时出现 | ✅ |
| 公开面无鉴权、内部面要 bearer | `/healthz`、`/api/roster/public`、`/api/roster/keys` → 200；`/api/roster` 无 bearer 401 / 带 bearer 200；`POST /api/intents` 无 bearer 401 | ✅ |
| 公开投影剔除内部字段 | 注册一张真卡后 `snapshot.entries` 恰好 1 条，字段为 `name,description,domain,skills,commitments,status,health,registeredAt`，**无 `cardUrl`/`taskUrl`** | ✅ |
| provenance 仍在（防同名替换） | `attestations[<name>].vassal.cardUrl` = 注册时那张卡的 URL | ✅ |
| `/healthz` 不泄业务信息 | 响应体仅 `{status,version,ts}` | ✅ |

### D. 签名链与离线验签：出货命令复跑（本轮**七条**）

全部经 `scripts/verify-roster.mjs`（出货实现，不是复写的规范化）：

| # | 对照 | 退出码 | 点名原因 |
| --- | --- | --- | --- |
| 1 | 正向：真封出来的信封 + 公钥 | **0** | `VERIFIED … signature, digest binding, freshness and per-entry attestations all check out` |
| 2 | 同一份字节，`--now` 推过 `maxAgeSeconds` | **1** | `snapshot seal past maxAgeSeconds` |
| 3 | 改载荷（`snapshot.entries[0].domain`） | **1** | `snapshotDigest mismatch: snapshot content was altered` |
| 4 | 换 provenance（`attestations[name].vassal.cardUrl`） | **1** | `attestation signature failed for "…"` |
| 5 | 陌生钥 | **1** | `seal signature verification failed` |
| 6 | **只用** `GET /api/roster/keys` 返回的 `keys[0].spkiPem` | **0** | VERIFIED（"发布的钥就是签名那把"） |
| 7 | 负对照：把 JWK 那条记录当 PEM 传 | **2** | `DECODER routines::unsupported` |
| 附 | 深比对 `--card <name>=<file>` | **0** | 逐字段重算卡片摘要通过 |

- **三触点同串**（deferred #7 库内侧的收口条件）：`gen-rsk-key.mjs` 打印的 `jwkThumbprint` = 发布端点 `keys[0].jwkThumbprint` = 验签报告 `jwk=` 行，三处逐字符相同。
- **端点形状校正（本轮实测，已补进文档）**：`/api/roster/keys` 是 **JWKS**——`{issuer, keys:[{kid,kty,crv,x,alg,use,spkiPem,jwkThumbprint,spkiSha256}], keySource, survivesRestart, trust}`；信封是 `{snapshot:{schemaVersion,generatedAt,scope,entries}, attestations, seal}`。此前文档只说"JWKS 形状""载荷带 `schemaVersion`"，没写嵌套位置，集成方只能靠试。

### E. 本轮抓到并已修：feature-inventory 的规模普查三个数字互不一致（已入库为断言）

- **文档写 `75 条路由（3 公开 + 72 bearer）`，实测 `76（3 + 73）`**：A-02 撤销粘性修复（`bb9a38a`）新增的 `POST /api/vassals/:name/reinstate` 没进普查。
- **同一张分组表相加只有 70**（名册与执行 Agent 3≠4、组织编制 9≠13、记忆 12≠10）——**文档与自己的表头都不一致**，而两张表谁对没人知道。
- **`116 处导出`** 既不等于 `src/index.ts` 的 **118 条 export 语句**，也不等于构建产物的 **213** 个运行时导出（量法：`node -e "import('./dist/index.js').then(m=>console.log(Object.keys(m).length))"`）。
- **已修并入库**：`tests/doc-consistency.test.ts` **第 10 例**把三段钉死——① 表头三元组 = `src/http/server.ts` 的注册数（含公开/bearer 拆分）；② 分组表"条数"列之和 = bearer 面；③ `**N 条 export 语句**` = `src/index.ts` 的 `^export` 行数。feature-inventory §2.1 同时写明量法与"该行已被断言钉住"。
- **三段各自缺陷植入（不是只测坏输入）**：把表头改回 75/72 → `expected [ '75','3','72' ] to deeply equal [ '76','3','73' ]`；把记忆行改回 12 → `route groups sum to 75, the bearer face has 73`；把导出改回 116 → `expected '116' to be '118'`。三次都只红该例、还原后 10/10 绿。
- 一处顺带修正：同一文件的 PRD 🚧 两条之一写作「E4.9 凭据委派」，而 PRD 的 E4.9 是签名链（凭据代理归 deferred #33）。

### F. 部署镜像：本机**未**重拍（出货件已变、网络受限），CI 的构建冒烟在推送后闭合并写明覆盖面

- **为什么不继承**：本批改了出货件 `src/http/serve.ts`。按 v0.19 的先例（"出货件动过则镜像层不继承"），这一格必须重拍才谈得上覆盖。
- **实测失败点**：`docker build` 在 `#2 [internal] load metadata for docker.io/library/node:22-slim` 处失败——`failed to fetch oauth token: Post "https://auth.docker.io/token": dial tcp 31.13.96.208:443: connectex: … timed out`；`docker images` **本地零缓存**，没有可离线复用的基础镜像。
- **诊断出的是环境事实、不是代码问题**：本机 `127.0.0.1:7897` 代理**可达 Docker Hub**（`registry-1.docker.io/v2/` → HTTP 401，`auth.docker.io/token` → HTTP 200），而 Docker Desktop 的 `settings-store.json` **没有任何代理配置**。修法是给 Docker Desktop 配代理（用户侧环境动作）；**我未擅自改用户的 Docker 配置**。
- **该项的设计落点是 CI，且推送后已闭合到"构建 + 镜像内两项冒烟"**：`.github/workflows/ci.yml` 的 `image-smoke` job 做三件事——`docker build -t zeus:ci .`、镜像内 `node scripts/gen-rsk-key.mjs /tmp/rsk.key && test -s /tmp/rsk.key`、`docker run --entrypoint node zeus:ci -e "require('./dist/index.js')"`。**本批推送后该 job 绿**（run **37048803811**，HEAD `22de402`，20s）。**它不覆盖容器级运行属性**（healthy 健康检查、`/data` 0600、SIGTERM 落盘、重启 `restored …`），那四项对 `22de402` 仍无证据，最后一次实跑停留在 `6179688`——这句话是本节的边界，别把它读成"镜像层已全量覆盖"。
- **本机能给的替代证据已跑**（不夸大其覆盖面）：`npm run build` exit 0；`dist/http/serve.js` 真进程 + 真 socket 走通核心链路（smoke 31/36，失败项全为 Windows 语义不可表达者，且与改动前逐条相同）；独立探针 20/20（§C/§D）。**容器级属性本轮没有本地证据**。

### G. CI 现测（本轮 `gh` 可用）

- **本批推送后（2026-10-02）**：run **37048803811**（push，HEAD `22de402`）**4/4 job 成功**——`image build + smoke` 20s、`typecheck / build / test (Node 24.x)` 48s、`typecheck / build / test (Node 22.x)` 55s、`wall-clock dependency gate (+2y)` 49s；`git ls-remote origin refs/heads/dev` = `22de4023…`（与本地一致）。
- **本批之前**：run **37027110404**（push，HEAD `b61043d`）同样 4/4 绿；同 HEAD 的 PR 流水线 37027148185 亦绿。
- 三条意义：① 本机那 25 例"环境性失败"在 **Linux 侧全绿**得到独立确认（连续两次推送）；② 镜像构建冒烟在 CI 有落点且本批已绿（覆盖面见 §F）；③ E1 的现行读数是"**`origin/dev..HEAD` = 0，本批 CI 4/4 绿**"。
- **口径不变**：状态只能现测（`gh run list` / `git rev-list --count origin/dev..HEAD`），任何写死的同步状态几分钟后就会过期。

### H. 功能性 / 完整度 / 可上线（三维判定）

- **功能性**：P0 26/26 ✅、全库无已知 P0 未闭合项。"已实现但未接线" **3 → 2**（本批销掉 `startServer()`；余下两条各有明确前置：执行授权票据派发闸门等对端凭据接口（deferred #33），数据二极管按 `dataPolicy` 收缩需先定对外字段契约）。
- **完整度**：三条接入通道执行点在位（出站凭证注入、Skill 三态闸门、MCP 服务端 tools + 客户端裁剪）；签名链、备份恢复、记忆/日记、编制/责任链、TUI 三类页面均在位；CI 六道闸门（typecheck/build/test/smoke/lint/audit/secret/时钟偏置/镜像）齐。
- **可上线**：**❌ 未达成**。剩余项全部是仓库外动作——A2 密钥托管落地与带外公告、A3 生产栈联调、A4 决策后端 key、A5 bayjf 侧 R2、B1–B4 真实部署（卷权限/反代 TLS/进程管理/env 逐行核对）、E2 镜像发 registry；外加不阻塞核心的阈值标定（C1–C3，需 ≥3 真实执行 Agent 压测）。

### I. MVP 判定（明确回答本轮问题）

- **产品核心「完全可用」MVP：✅ 维持**（库内核 + 制品；证据见 §A–§D，其中真机扇出沿用 2026-09-29 的记录，本轮未复跑，见 §J）。
- **可交付真实用户 MVP：❌ 维持**（差的是真实环境里的执行动作，见 §H）。
- **与 v0.20 的差别只有两处**：① 库内"已实现但未接线" 3 → 2；② feature-inventory 的普查缺陷修复并入库为断言。**判定不变，且本轮没有把任何一条外部动作记成完成**（镜像层那格显式记为未重拍）。

### J. 本轮评审限制（如实标注）

- **未跑**：真实执行 Agent 真机扇出（需线上网络与授权；A1 结论沿用记录）、Docker 镜像实构实跑（§F）、Zeus↔loom 生产栈联调（外部条件）、本机 Linux 侧全量测试（由 CI 覆盖，非本机复现）。
- **本机代理 7897 可达外网但没有用于线上验收**——那是需要显式授权的对外动作，不在本轮范围。
- **本机写权限问题已排除**：进入本轮前 `pwsh` 完全不可用（沙箱在工作区根缺 `WRITE_OWNER`），用 `diagnose-windows-sandbox-acl` 的脚本修好并复验（改动仅一条：给当前用户补完全控制，文件内容与所有者未动；恢复命令已留存）。这一条与本项目代码无关，但**它决定了本轮能否取证**，故记账。

## v0.23 复核（2026-10-03，评审对象：Active work 105–110（HEAD `66911d7`，与 origin/dev 同步）：**核心 MVP ✅ / 可上线 ❌ 维持**；本批实现 **E2.6 意图识别**（操作者 HTTP 面 + TUI 命令面）、收口 **deferred #33 执行授权票据**（execute/plan 模式 + 派发闸门 + 真进程验收资产）、裁定 **#18/#19/#21** 三项方向固化、新增 **#40 反思闭环**登记，并补 PRD 需求行 E2.6）

> 本轮方法沿用 v0.17 之后的规矩：**上一轮记录不作依据**，判定里含动词的条目重新取证。本轮在 **Windows 本机**取证（pull 后工作树 = origin/dev = `66911d7`），故全量与冒烟有 Windows 环境性失败，按 Active work 98 起的既定家族分类；Linux/macOS 口径以 CI 与另一会话记录为准。

### A. 验证基线（本机实跑，非转述）

| 项 | 读数 | 备注 |
| --- | --- | --- |
| 基线 HEAD / 工作树 | `66911d7`，工作树干净 | pull 快进 `7bf8569..66911d7`（37 commit，Active work 103–110） |
| `npm install` | 新增 1 依赖 | pull 引入 `undici ^6.29.0`（出站 DNS 守卫的 guardedFetch 用），不装 build 即挂 TS2307 |
| `npm run build` / `npm run typecheck` | 各自 **exit 0** | 先 build 后测试（`tests/*` 与 `scripts/*` 引用 `dist/`） |
| `npm test` | **1099 总量 / 1073 绿 / 26 失败 / 101 文件** | Windows 本机；26 失败逐文件核对仍为既有三族（目录 fsync EPERM 17 + 新文件 1 / chmod 0600 断言 4 / symlink EPERM 4），**无逻辑失败**；基线 1048 → **1099**（105–110 批 +51 测试） |
| `npm run smoke:core` | **31/36**（Windows 本机） | 5 步失败 = 0600 chmod ×2 + SIGTERM 持久化连锁 ×3，与 Active work 98–100 逐条相同家族；macOS 口径 37/37（另一会话记录） |
| `tests/doc-consistency.test.ts` | **11/11** | pull 后新增文档 `design-inbound-a2a.md` / `verify-jev-backend.md` 均已进 handoff「Project documents」索引（第 11 例闸门） |

### B. 需求覆盖：机械核对，不读叙述

- `docs/prd.md` 需求行 **55 行**（`^\| E[\d.]+ \|` 计数），机械分类：**P0 26/26 ✅**。
- **需求行 54 → 55 的增量就是 E2.6 意图识别**（本批 Active work 109/110 实现时 PRD 补的行；v0.22 时代无此行）。
- 非 P0 未闭合 **8 条**：`E3.4`、`E3.8`、`E4.9`、`E4.10`、`E5.4`、`E8.4`、`E9.4`、`E10.2`——**与 v0.17 至 v0.22 同集合**，既无新增也未回退。
- feature-inventory「已实现但未接线」：**0 项**（Active work 107 收口）；路由 **78**（3 公开 + 75 bearer）、export 语句 **120**、TUI 命令 **13** 类——三段计数均为 Active work 109/110 批入库断言的现测值。

### C. 本批实现：E2.6 意图识别（操作者面 + TUI 面）

- **内核**（`src/intent/recognize.ts`，200 行）：本地规则零出域为默认、决策后端（Jev/LLM，模型无关）显式 opt-in；识别结果**恒 plan-only**（fail-closed 422 `{ok:false, reason}` 以视图返回，不抛错——fail-closed 是产品行为不是传输错误）。
- **操作者 HTTP 面**：`POST /api/intents/recognize`（路由 78 即本批新增），`index.ts` 公共导出 +2。
- **TUI 面**：监督台 `i <文本>`（本地规则零出域）/ `im <文本>`（显式咨询决策后端 opt-in）；命令词须为 `i`/`im` 后跟空格（`info` 等长词不误判）；`render.ts` 渲染 skill/置信/后端标签与 miss 的 reason；zh/en 各 +5 键。
- **验证**：15 项新测试（commands 2 / render 4 / client 5 含 422 视图 / controller 4）；真进程验收 `verify:intent-recognize` **7/7** 与 `verify:tui-recognize` **7/7**（本轮 2026-10-03 已在 Windows 本机复跑；tui-recognize 复跑抓出并修掉一条脚本可移植性缺陷，见 §H）。

### D. 本批收口：deferred #33 执行授权票据（剩 ③ 项投递字段）

- **execute/plan 模式**：`FanOutRequest.mode?: 'plan' | 'execute'`（缺省 'plan'）；HTTP 意图面透传 `mode`/`executionDelegation`，未知 mode 400。
- **派发闸门**：`Orchestrator.runBranch` 出站前 `verifyAndConsumeExecutionDelegation`（capability 固定 `'execute'`），无授权/验签失败/过期/重放一律 fail-closed **不发出站请求**，拒绝写审计 `execution-delegation-denied`（入 AUDIT_DECISIONS + TUI token）。
- **真进程验收资产**：`verify:execute-delegation` 9 步（本轮 2026-10-03 已在 Windows 本机复跑 9/9，见 §H），并当场修掉 inject 看不见的缺陷——`serve.ts` 从未装配 `executionDelegationAudit` 桥，真进程签发 201 但审计静默缺 `execution-delegation-issued`；补传后转绿。
- **仍挂触发条件②（pr-helper 凭据代理接口就绪）**：③ 票据投递的 A2A `x-zeus-*` 字段——对端协议未定义，按设计不臆造。

### E. 本批裁定与登记（方向固化，未销项）

- **deferred #18 MCP actor 判定**（design-realm §6.5）：主体 = 会话级 actor（宿主显式声明，缺省 anonymous）；`zeus-realm:` URI 不编码租户；不与签发凭证合并；`tools/call` 与 `resources/read` 共用同一份 realmId 白名单。实现随 E3.4 正式暴露立项。
- **deferred #19 入站 A2A**（design-inbound-a2a v0.1）：Zeus 自发布 agent card（`/.well-known/agent-card.json`，形状与要求执行 Agent 一致）、入站 `tasks/send` 落 H2 意图面、三问暂定答案（上游 fealty 验签 / `realmSource` 显式声明缺省个人域 / 审计责任链延伸）、不做入站 SSE。实现仍挂触发条件（loom 反向派任务等）。
- **deferred #21 历史标识符改名**：维持 **T2/T3/T4 不做、T1 暂不推进**（无"历史名字实际挡住功能"的新证据）。
- **deferred #40 新登记**（执行后反思闭环 / Agent 自我改进）：结论=**不独立立项**——决策级反思已有 E1.3 对抗复核；缺的是"执行后失败归因 → 教训写回"的闭环，触发条件为首个真实执行 Agent 长期运行积累可统计失败样本。建议做法（决定后）：先做只读失败归因摘要纯函数（审计 reason 聚合 + E1.6 回放重建），看有无稳定规律再谈写回。

### F. 部署镜像：本轮未重拍（出货件已大动）

- 本批改了 intent / tui / delegation / outbound-dns / http / state 的 src，出货件变动，按先例容器级结论不继承上一轮。
- 容器级运行属性（healthy、`/data` 0600、SIGTERM 落盘、重启恢复）四项对本批**无新证据**；CI 的 `image-smoke`（构建 + 镜像内两项冒烟）覆盖面不含上述四项。本机本轮未做 docker 实构实跑。

### G. 功能性 / 完整度 / 可上线（三维判定）

- **功能性**：P0 26/26 ✅、无已知 P0 未闭合；本批把 PRD 空白面 E2.6 意图识别从"无行"做到"操作者 + TUI 双面可操作"，执行授权票据收口到只剩对端协议项。
- **完整度**：意图识别、执行委派（execute/plan + 闸门）、出站 DNS 守卫、TUI 三类页面、接入三通道执行点、签名链、备份恢复、审计链均在位；「已实现但未接线」**0 项**。
- **可上线**：**❌ 未达成**。剩余项仍是仓库外动作（真机部署、密钥托管与带外公告、生产栈联调、外部消费方接入）与需真实规模的阈值标定，同 v0.22 §H。

### H. MVP 判定与本轮限制

- **产品核心「完全可用」MVP：✅ 维持**；**可交付真实用户 MVP：❌ 维持**。本批为意图识别面与授权收口，不改变上线判定。
- **未跑（如实记）**：Docker 镜像实构实跑（§F）、真机扇出与生产栈联调（外部条件）、本批 push 后的 CI（由用户决定 push 时点）。
- **补跑（2026-10-03 收尾）**：三个验收脚本已在本机（Windows）复跑——`verify:execute-delegation` **9/9**、`verify:intent-recognize` **7/7**；`verify:tui-recognize` 复跑**当场抓出一条可移植性缺陷**：脚本用 `join(REPO, 'dist/tui/…')` 的裸盘符路径喂给动态 `import()`，Node ESM loader 在 Windows 上拒绝 `c:` scheme（macOS/Linux 的 POSIX 路径恰好被容错），已修为 `pathToFileURL(...).href`（连同注释说明），修后 **7/7**。typecheck/build 复跑 exit 0。**结论升级：v0.23 的判定不再依赖"另一会话记录"，三个验收面均本机实测。**

## v0.27 补证（2026-10-06，评审对象：Active work 131–139：**核心 MVP ✅ / 可上线 ❌ 维持**；自托管六步全部完成、P0 八步试点实跑全过；本轮零需求翻转，产出是真进程取证与 P1 操作者面）

> 本轮定位：v0.26 把可上线剩余项收为"仓库外动作 + 库内 B-44"。Active work 132–139 把自托管设计稿 §7 的六步全部落码，并首次对 P0 八步做真实实跑；这些是**证据增强与操作者可达面**，不翻转任何需求行。方法沿用 v0.9 两问法：查"运行中的进程能不能走到它"，门禁用当前出货件复跑而非转述。

### A. 验证基线（本机实跑）

| 项 | 读数 | 备注 |
| --- | --- | --- |
| `npm test` | **1218 总量 / 1218 绿 / 0 失败 / 112 文件** | 较 v0.26 的 1144/104 +74（watch 三批 + 契约控件批 + P0/P1 面） |
| `npm run smoke:core` | **42/42** | Active work 136 增三步、139 复跑（动了 boot/watch 装配） |
| `tests/doc-consistency.test.ts` | **17/17** | 项数不变；本轮 22 条锚点随行位移复钉 |
| `npm run typecheck` / `lint` / `lint:secrets` | 各自 **exit 0** | watch 路由与审计桥过严格 tsconfig、eslint |

### B. 本批事实（判定相关）

1. **自托管设计稿 §7 六步全部完成**（Active work 132–137）：watch 三源（metrics/realm/connector）接线、execute 型契约派生与越限回落、契约 HTTP 签发面、TUI/Web 契约控件；tick 全程由调用方驱动，内核不持定时器（与 vault CLI 同口径）。
2. **P0 八步试点实跑全过**（Active work 138）：含 production 无钥拒启反证、挂载视图零绝对路径、名册离线验签指纹逐字符同、同 intentId 重放零新派发、execute 票据 9/9、vault 四档 + nonce 跨重启 + 跨位置恢复。跑中现场抓到并修掉两条 inject 测试看不见的装配缺陷：① serve 从未传 oversightAudit——真进程里操作者批准/拒绝/入队零审计痕，boot 现默认桥进审计脊（三个新决策名）；② TUI client 空 body POST 被真 Fastify 400，恒发 JSON body。
3. **P1 `watch` HTTP 操作者面落地**（Active work 139）：五条 bearer 路由（`POST`/`GET /api/watches`、`GET`/`DELETE /api/watches/:id`、`POST /api/watch-tick`），watch 生命周期动作（`watch-registered`/`watch-disabled`/`watch-revoked`）进审计脊，TUI token/文案三处同步；serve 补传 `runWatchTick`。
4. **「已实现但未接线」保持 0 项**（feature-inventory §4）：契约已在第 4+5 步接进真进程与 HTTP 面。P1 唯一剩余是 TUI/Web 的 **watch 专属控件**——与契约那批同形状，HTTP 面先行、界面后补，属增强不属接线缺口。

### C. 对判定的影响（说清楚，不夸大）

- **两个判定都不变**：核心 MVP ✅（六步是 P1/P2 能力增强与操作者面，不是核心缺口）；可上线 ❌（证据增强但仓库外关口集合不变）。
- **可上线剩余 = 仓库外动作**（真实部署与 RSK 带外公告 / loom 联调 / ≥3 真实 Agent 阈值 / 真实生产卷，A2–A5 + B 系列，均不变）**+ 库内 B-44 保留策略批**（v0.26 登记，未闭合）；另加 P1 的小尾巴 TUI/Web watch 控件（不阻塞）。
- **不声称 P1 试点已完成**：P0 的「成功定义」表（连续 14 天真实使用等）仍属使用期事项；本轮证明的是能力可跑 + 面可达，不是长期可靠性。

## v0.30 补证（2026-10-08，评审对象：Active work 145–148（#42 出窗归档实现 + 台账过期核对批 + 产品入口批 + 意图回退批）：**核心 MVP ✅ / 可上线 ❌ 维持，且"可上线 ❌"的库内唯一理由 B-44 已销**——剩余理由全部在仓库外（真机部署、密钥托管、loom 联调、阈值调参、R2 公开）

> 本轮定位：v0.29 之后是四批库内推进——145（deferred #42 出窗归档**实现**：`selectArchivable` 双条件出窗 + 活跃引用/已裁决保护 + `IntentArchive` 追加式 JSONL + 幂等回放三级查找零派发 + replay 归档读取面 + boot/`ZEUS_INTENT_RETENTION` 接线，22 例测试含缺陷植入；**B-44 剩余一半由此闭合**）、146（台账过期核对批：feature-inventory census 补三族漏记变量、上线清单 24→41 行赋值、PRD E3.4 行如实改口）、147（产品入口 `npm run daily`：一句话→意图→扇出→决策写回用户目录，19 例测试）、148（意图识别空候选不再等于失败：显式 `useModel` 且后端在场时把整个技能目录交给模型，上限 30 条，+5 例）。四批均**不翻转任何需求行**（PRD 55 行 / P0 26/26 维持），方法沿用 v0.9 问法。

### A. 验证基线（本机实跑，2026-10-08）

| 项 | 读数 | 备注 |
|---|---|---|
| 全量测试 | **1316 总量 / 1316 绿 / 0 失败 / 119 文件** | Current state 基线（148 批后）；本批后续改口轮复跑 39 例（doc-consistency 17/17 + intent-archive 22/22） |
| 冒烟 | **42/42** | `npm run smoke:core`，148 批后复跑 |
| doc-consistency | **17/17** | 本批三处文档改口后复跑仍全绿（锚点无位移） |
| typecheck / build | 各自 exit 0 | 145 批后实测 |
| 三条验收脚本 | execute-delegation 9/9、intent-recognize 7/7、tui-recognize 7/7 | 145 批后复跑 |
| PRD 逐行计数 | **55 行 / P0 26/26** | 与 v0.29 同集合 |
| feature-inventory §4 | 「已实现但未接线」**0 项** | v0.36 维持 |

### B. 本批新增能力的功能性核对

1. **决策记录出窗归档（deferred #42 实现，B-44 闭合）**：默认 retain/archive——已了结意图超出 1,000 条或 30 天（双条件同时满足）时最老先出窗进 `intent-archive.jsonl`，**永不触碰**仍被 pending 升级引用或已有人类裁决的条目；幂等重放三级查找（内存→在途→归档）命中即回旧结果且零派发；`GET /api/intents/:id/replay` 内存未中读归档（归档不可重建时间线→501，evict→404 带 `evicted:true`）；归档纳入备份清单与原子保存批次（先 append 再落快照，崩溃不孤儿）。**B-44 双线闭合**：分支历史封顶（142）+ 决策记录出窗归档（145），"可上线 ❌ 理由清单里唯一的库内项"销项。三处文档改口（PRD E1.5 / README / audit B-44）随 2026-10-08 收尾轮完成，幂等承诺与 evict 行为一致。
2. **产品入口 `npm run daily`（147）**：进程内装配（无常驻服务、不占端口），9 个旋钮，一句话→意图→扇出→决策页写回目录；不带 `--model` 时指令正文不出本机，`--realm enterprise` 写回用本地驱动钥签发 grant。这是产品定位"给目录即用"的第一个对外可用入口形态。
3. **意图识别空候选回退（148）**：显式 `useModel` 且决策后端在场时，排序器零词法命中改为把整个技能目录（按 id 定序、上限 30 条）交给模型——空候选不再等于失败；fail-closed 语义不变（无显式 `useModel` 仍零出域）。

### C. 对判定的影响（说清楚，不夸大）

- **两个判定都不变**：核心 MVP ✅；可上线 ❌。
- **关键变化**：**"可上线 ❌"的库内唯一理由（B-44 台账只增不减）已销**——142+145 双线闭合（封顶 + 出窗归档），剩余理由**全部**在仓库外：① ~~真机部署 pr-helper 跑验收 #6 标准 A2A 客户端打入站面~~（**v0.32 口径纠正**：pr-helper 侧 #6 早已销项——checklist A1 ① 守护脚本 2026-09-25/27/29 对线上 pr-helper-ten.vercel.app 实跑 exit 0；真正未做的是 **Zeus 门面真机部署（PRD E10.2）+ 标准 A2A 客户端打 Zeus 自己的入站面**，该入站面 deferred #19 于 2026-10-07 落地）；② RSK 托管与公钥带外公告（deferred #7 闸门，R1/R2 前置）；③ ~~Zeus↔loom 真机联调~~（**已于 2026-10-08 销项，v0.31**：隔离真机栈实跑 `acceptance:loom` 18/18 exit 0，见 handoff Active work 154/155）；④ ≥3 真实 Agent 的背压阈值调参（#9）；⑤ bayjf R2 公开。
- **库内可一口气推进项已枯竭**：v0.29 所述"库内 B-44 保留策略批"已由本批做完，v0.29 另列的 #36 `noUncheckedIndexedAccess` 迁移已在 2026-10-02 销项（strict 系四 flag 全开）——本批核实后修正该过期说法；剩余纯库内候选仅台账时效维护，deferred 未销项全部挂外部触发或仓库外。
- **不声称出窗归档已在真实规模验证**：窗口触发量级（1,000 条/30 天）按设计常数生效，真实长跑数据仍待第一个连续 ≥2 周实例（翻转条件语义不变）。

## v0.29 补证（2026-10-07，评审对象：Active work 142–144（B-44 保留策略半修 + 反思与观测批 + 入站 A2A 面 & MCP streamable HTTP 批）：**核心 MVP ✅ / 可上线 ❌ 维持**；库内功能面连续三轮零缺口——PRD 55 行 / P0 26/26、feature-inventory §4「已实现但未接线」0 项；本轮实现 deferred #19 入站 A2A 面与 deferred #18 MCP streamable HTTP 传输层（两处"方向已固化、实现待触发"项按 #6 先例提前落地），库内能一口气推的清单进一步收窄为纯文档/纯本机取证与仓库外动作）

> 本轮定位：v0.28 之后是三批库内推进——Active work 142（B-44 半修：E1.7 并发指标改为有界分支历史，派发边际成本 12.07× → 0.38×）、143（反思与观测批：结构化日志 JSON lines 契约 + deferred #40 只读失败归因 + deferred #28 状态列冲突检测器入库 + deferred #42 出窗归档设计稿）、144（本评审直接取证的对象：deferred #19 入站 A2A 面 + deferred #18 E3.4 MCP streamable HTTP 传输层，两件都是"裁定已固化、实现待触发"项，按 #6 先例（不等触发先做出防护机制）提前落地）。这仍是**能力完备度推进与取证**，不翻转任何需求行（PRD 55 行 / P0 26/26 维持）。方法沿用 v0.9 问法：库内能力逐一核对接线位，新增面用独立测试文件与真进程冒烟背书。

### A. 验证基线（本机实跑，2026-10-07）

| 项 | 读数 | 备注 |
|---|---|---|
| 全量测试 | **1270 总量 / 1270 绿 / 0 失败 / 117 文件** | `npx vitest run`；较 v0.28 的 1223/112 净增 +47/+5（本批 +21：http-realm-mcp 11 + http-inbound-a2a 10；余为 142/143 批累计） |
| 冒烟 | **42/42 复跑** | `npm run smoke:core`，覆盖 serve 启动/拒启日志改动 |
| doc-consistency | **17/17** | 本批全库 20+ 处锚点随行号位移复钉（/mcp、入站 A2A、audit 枚举、tui tokens） |
| typecheck / build / lint / lint:secrets | 各自 exit 0 | lint:secrets 289 文件 clean |
| 三条验收脚本 | **execute-delegation 9/9、intent-recognize 7/7、tui-recognize 7/7** | 本批补跑，确认本批路由/装配改动未破坏既有真进程面 |
| PRD 逐行计数 | **55 行 / P0 26/26** | 与 v0.28 同集合 |
| feature-inventory §4 | 「已实现但未接线」**0 项** | 维持 |

### B. 本批新增能力的功能性核对

1. **入站 A2A 面（deferred #19，提前实现）**：`GET /.well-known/agent-card.json` 公开 Zeus agent card（形状与出站要求执行 Agent 的一致，A2A 超集契约，无自家 fealty）；同路径 `POST` bearer 保护 JSON-RPC `tasks/send` 落 H2 意图面（复用 `POST /api/intents` 的 fanOut 内核路径与同一根审计流）。三问落点：谁能派给我 = 调用方 `x-zeus-caller-card` header 过与注册同源的 fealty 形状闸（`fealtyOathProblem` 由 registry 导出复用，缺卡则 bearer 即驾驶员本人，fail-closed）；落在哪个域 = `realm` 缺省 personal，enterprise 走 DomainGrant 现行规则；谁为结果负责 = 审计责任链延伸（`inbound-task-accepted`/`inbound-task-refused` 入 AUDIT_DECISIONS 单一来源 + TUI 语义 token + 审计查询白名单自动跟随），调用方 taskId 兼作幂等键。**不做**入站 SSE（与出站对称：回执 = tasks/send 响应 + GET /api/intents/:id 结果查询）。测试 10 例覆盖卡片公开、鉴权矩阵、fealty 拒门、skills 校验、realm 缺省、needs-driver → input-required 映射。
2. **MCP streamable HTTP 传输层（deferred #18 裁定落地）**：`GET /mcp` 公开元信息（protocolVersion/capabilities/serverInfo，**零 realm 数据**——不泄挂载状态）+ `POST /mcp` bearer 保护 JSON-RPC 喂同一传输无关 handler（stdio 与 HTTP 共用 `createRealmMcpHandler`，无 SDK 依赖设计约定保持）；会话级 actor 经 `x-zeus-realm-actor` header（§6.5 裁定 1：宿主声明调用方身份，**仅可收窄**宿主预连接白名单，缺省 anonymous）；realmIds 从 boot 连接列表装配（与 stdio 宿主同一来源）。测试 11 例覆盖未装配不挂载、公开元信息无泄漏、401、握手协商、actor 透传、白名单越界 -32002、路径不外泄、工具成功读、method-not-found、坏 JSON 400。
3. **审计与登记纪律**：两条入站 decision 走 AUDIT_DECISIONS 单一来源（`dispatcher.ts` 末尾追加，查询白名单与 TUI token 表同步跟随）；新增环境变量 `ZEUS_PUBLIC_URL`（卡片广告基址）已登记 .env.example / deployment.md / config-surface 闸门。

### C. 对判定的影响（说清楚，不夸大）

- **两个判定都不变**：核心 MVP ✅（新增面是能力完备度与接口可达，不是核心缺口）；可上线 ❌（仓库外关口集合不变）。
- **可上线剩余 = 仓库外动作**：① 真机部署 pr-helper 后跑验收 #6 标准 A2A 客户端（不带 x-zeus-*）真机打入站面——**本批后已有可打的入站端点**，这是第一个能在真机闭合的仓库外动作；② RSK 托管与公钥带外公告（deferred #7 闸门，R1/R2 前置）；③ Zeus↔loom 真机联调（注册卡片 → 派发 plan → 收 SSE 战报；loom 反向派任务给 Zeus 现在有入站面可落）；④ ≥3 真实 Agent 的背压阈值调参（#9 触发条件）；⑤ bayjf R2 公开（签名链闸门）。
- **库内可一口气推进项已近枯竭**：剩余纯库内项仅 #36 `noUncheckedIndexedAccess` 迁移（400 处，语义变更型、价值/风险比一般）与评审刷新本身；deferred 未销项全部挂外部触发或仓库外。
- **不声称入站 A2A 已对接真实上游**：身份闸当前为形状校验 + bearer，真实信任锚（在册名册验签）留待 loom/公开执行 Agent 作为真实调用方出现（deferred #19 触发条件语义不变，本批只是把机制先做出来）。

## v0.28 补证（2026-10-06，评审对象：Active work 140–141：**核心 MVP ✅ / 可上线 ❌ 维持**；P1 三条操作者通道与调用方调度器全部就位，"无人值守"闭环首次在进程外可驱动；本轮零需求翻转、零运行时缺陷，产出是 P1 收尾与真进程取证）

> 本轮定位：v0.27 记录到 P1 的 watch HTTP 面（139）。Active work 140–141 把 P1 退出条件补齐——操作者在 HTTP 之外的 TUI/Web 界面也能读到/操作 watch（140），且到点评估有了一个进程外的调用方来驱动（141）。这仍是**证据增强与可达面**，不翻转任何需求行。方法沿用 v0.9 问法：查"运行中的进程能不能走到它"，调度器行为由真进程 harness（17 场景）背书。

### A. 验证基线（本机实跑）

| 项 | 读数 | 备注 |
| --- | --- | --- |
| `npm test` | **1223 总量 / 1223 绿 / 0 失败 / 112 文件** | 较 v0.27 的 1218/112 +5（watch TUI 控件批；调度器为薄 HTTP 客户端，无自动化测试文件） |
| `npm run smoke:core` | **42/42** | Active work 140 复跑（动了 TUI/serve，冒烟覆盖真进程装配） |
| `tests/doc-consistency.test.ts` | **17/17** | 项数不变；本轮锚点随位移复钉 |
| `npm run watch:tick` 真进程 harness | **17 场景全过** | Active work 141 一次性工装，覆盖退出码与退避 |
| `npm run typecheck` / `lint` / `lint:secrets` | 各自 **exit 0** | 新脚本过 `@ts-check`、eslint |

### B. 本批事实（判定相关）

1. **P1 三通道齐整**（Active work 140）：TUI 新增 `wt`（手动 tick）与 `w<n>`（撤销）两条命令（17 类）、deck watch 台账 section；Web 监督台授权视图加 watch 登记表单、台账表格与「立即评估一次」按钮。零新内核路由、零 UI 私有逻辑——全部消费既有 `/api/watches*` 与 `/api/watch-tick`。watch 内联注册在 TUI 刻意保留走 HTTP/Web（谓词+意图形状对单行命令过宽，与契约批同一口径）。
2. **调用方 watch 评估调度器落地**（Active work 141）：`scripts/run-watch-tick.mjs`（`npm run watch:tick`）两形态——单次（默认，cron 友好，打一轮即退）与 `--watch [--interval S]` 常驻（SIGTERM 在当前一轮后干净退出 0，内核不可达时有界指数退避、`WATCH_MAX_BACKOFF_MS` 封顶 30s）。**安全契约**：`KERNEL_URL` 只接受 loopback（非环回退出 2）、`ZEUS_INTERNAL_TOKEN` 必填（坏 token 401 退出 1），内部 token 不离开本机。验证抓到并修掉一个参数解析缺陷（`--interval 1` 的值被旧解析器当位置参数）。
3. **「无人值守」闭环首次可驱动**：内核仍不持定时器（与 Vault 备份同一明文边界），节律由进程外调度器打 `POST /api/watch-tick` 决定——这不是第二条触发路径，而是 HTTP 面的薄客户端；watch 注册/撤销仍只由操作者经 Web/HTTP 完成。
4. **「已实现但未接线」保持 0 项**（feature-inventory §4）：P1 三通道与调度器全部接线；内核台账只增不减的 **B-44 仍开放**（保留策略批，是当前唯一明确登记的库内可做项）。

### C. 对判定的影响（说清楚，不夸大）

- **两个判定都不变**：核心 MVP ✅（P1 是"无人在场合法意图来源"的增强与可达面，不是核心缺口）；可上线 ❌（证据增强但仓库外关口集合不变）。
- **可上线剩余 = 仓库外动作**（真实部署与 RSK 带外公告 / loom 联调 / ≥3 真实 Agent 阈值 / 真实生产卷，A2–A5 + B 系列，均不变）**+ 库内 B-44 保留策略批**（v0.26 登记，未闭合）。
- **P1 作为能力已完整**（HTTP/TUI/Web + 调用方调度器），但**不声称 P1 试点已通过**：「成功定义」表（连续 14 天真实使用、正文零出域等）仍属使用期事项，本轮证明的是机制可跑 + 面可达 + 有进程外驱动者，不是长期可靠性。


## v0.26 补证（2026-10-05，评审对象：Active work 128–129：**核心 MVP ✅ / 可上线 ❌ 维持；本轮修正 v0.25 的一句结论——"剩余关口全部在仓库外"不再成立**；零运行时改动，产出是四格实测与三条新登记）

> 本轮定位：v0.25 把可上线剩余项归为"仓库外动作"。Active work 129 的实测推翻了这个归因的一半：库内多了一件**可做且必须做**的事（B-44 的保留策略批），另有一条已落地的原语「已实现但未接线」归 1 项。方法沿用 v0.9 两问法第①问的变体：不查"有没有实现"，查"运行中的进程能不能走到它"。

### A. 验证基线（本机实跑）

| 项 | 读数 | 备注 |
| --- | --- | --- |
| `npm test` | **1144 总量 / 1144 绿 / 0 失败 / 104 文件** | 较 v0.25 的 1109/102 +35（契约原语 27 + 文档闸门 6 + 幂等分类等 2） |
| `npm run smoke:core` | **37/37** | Active work 128 复跑（动了快照落盘白名单，那是冒烟覆盖的路径） |
| `tests/doc-consistency.test.ts` | **17/17** | 11 → 17（v0.26 前四批入库的六条闸门） |
| `npm run verify:reliability` | **17/17 exit 0** | 本轮新增工装；四格读数见下，全量在 audit §13 |
| `npm run typecheck` / `lint` / `lint:secrets` | 各自 **exit 0** | 新脚本过严格 tsconfig 与 eslint |

### B. 四格实测（读数全量在 audit §13，此处只留判定相关的）

1. **并发闸在真实限流配置下是真的**：`cap=4/queue=2` 打 16 分支，10/16 被拒且分支原因原文点名两个上限，`maxInFlight=4` 不越界，意图终态 `partial`；无上限对照 16/16 派发。上一轮进程的启动日志自报三处 unbounded——本轮证明配置链路（env → 装配 → 运行 → 拒因 → 读数）整条可依赖。
2. **`escalations` 跨 SIGTERM 重启不丢**：真造出的 pending `intent-conflict` 重启后同 id 仍 pending 且可 approve 回读 `approved`；不配状态文件的对照归零，所以承载它的是持久化本身。v0.25 前该格读数恒为 0 的原因是**造不出 pending 项**，不是队列健壮性。
3. **SSE 断流重连不补历史（实测 lost=1/1）**：`progress.ts` 的"事件不保留"从注释变成测出来的丢帧数；取消请求后 6ms 活动订阅者见终态。操作面含义：断流后的读面必须回读 `GET /api/intents/:id`，只看 SSE 会静默少事件——Web 监督台是否如此，归 #44 的能力↔可驱动面对照。
4. **台账增长有斜率且无上界（B-44）**：≈60KiB RSS/条、2,074B 状态文件/条，且操作者无任何削减入口；状态文件每次退出全量重写、每次启动全量解析。长跑交付的慢性泄漏——这是本轮给"可上线 ❌"新增的**库内可做**理由。

### C. 对判定的影响（说清楚，不夸大）

- **两个判定都不变**：核心 MVP ✅（四格是运行时读数，不是功能缺口；契约原语未接线也不翻转任何需求行）；可上线 ❌（理由集合变大而不是变小）。
- **修正 v0.25 的一句话**："剩余关口全部在仓库外或需授权，库内已无法继续闭环" → 剩余关口 = 仓库外动作（真实部署 / RSK 带外公告 / loom 联调 / ≥3 真实 Agent 阈值，均不变）**+ 库内 B-44 保留策略批**。C-28 与 task-input 生产者为新增的小批，同属库内。
- **「已实现但未接线」0 → 1 项**（feature-inventory v0.20）：有界委托契约。这是本轮刻意保留的诚实标记——原语可执行不等于自主发起可授权，接线要等 `watch`（step 2）与真实谓词来源。

## v0.25 补证（2026-10-04，评审对象：Active work 117（HEAD 为 v0.24 之后的工作树，含出站 lookup 修复）：**核心 MVP ✅ / 可上线 ❌ 维持，但可上线证据首次实质增强**；本轮不是新一轮全量重评，而是补齐 v0.24 §F 挂着的容器级/复跑证据，取证过程中抓到并修复一个影响真实域名部署的生产关键路径缺陷）

> 本轮定位：v0.24 §H 明确标注"未跑 Docker 镜像实构实跑（§F）"，§F 挂着容器级四项"无新证据"。本轮把评审 §F 三项纯库内/本机取证一次做完（签名链验链复跑、容量基线 §7 后同机对照、Docker 容器级四项），其中容器实构实跑抓到一个单测/冒烟/既有集成测试都看不见的真实缺陷并修复。方法仍是本机亲手取证、不采信转述。

### A. 验证基线（本机实跑）

| 项 | 读数 | 备注 |
| --- | --- | --- |
| `npm test` | **1109 总量 / 1109 绿 / 0 失败 / 102 文件** | 较 v0.24 的 1104/102 **+5**（outbound-dns +4、registry +1），文件数不变 |
| `npm run typecheck` / `npm run build` | 各自 **exit 0** | 修复后重编译 |
| `npm run smoke:core` | **37/37** | 未受影响（smoke 连 127.0.0.1，见 §C 为何漏掉本 bug） |
| `tests/doc-consistency.test.ts` | **11/11** | 基线同步篇首/Current state/代码索引/README 两处/checklist 至 1109/102 |
| Docker | `zeus:0.1.0` 多阶段构建 exit 0，容器实跑见 §D | 最终镜像已用含全部修复的代码重建 |

### B. 三项补证（v0.24 §F / 取证缺口）

1. **签名链验链复跑（`verify:roster`）**：冒烟 37 步已覆盖 public 封签信封（VERIFIED + 过期 maxAge 拒绝）、internal roster（含 revoked 行）离线验签、重启后可验、公钥字节与 JWK 指纹三处一致；唯一未覆盖的 **`--card name=PATH` 卡片深比对**（R2 客户端验签工具重算卡片摘要、不匹配即 REJECTED）用一次性真服务脚本（gen-rsk-key → dist 真进程 + 真 socket mock agent → 注册 → bearer 拉 internal roster 存盘 → 拉原始 card → `verify-roster --card`）补跑：**正例 card digests match / VERIFIED；篡改 `x-zeus-fealty.swornTo` 反例 exit 1 MISMATCH REJECTED，双 PASS**。
2. **容量基线 §7 后同机对照（capacity-baseline 升 v0.4）**：§7 内核改动在 `496d16b`。用 `git worktree` 在 §7 前 `1b6582a` 与 HEAD 上**同机相邻交替各跑两次**（直接 `node scripts/bench-capacity.mjs --json`）。结论 **§7 无可测量容量回归**：B 场景吞吐（intents/秒）@8 pre=129/130 vs HEAD=127、@16 pre=214/217 vs HEAD=225、@32 pre=283/332 vs HEAD=263（差异全在 bench ±15% 方差内，pre 两次自身抖 17%）；D 取消吞吐 HEAD 干净值不低于 pre；正确性不变量全部保持（`finishedBranches===total`、mock farm 实收 240 个 tasks/cancel 零丢失零重复）。一次与 docker build 并发的污染跑显著偏低，作废重跑。文档新增跨版本对照方法论（墙钟绝对值跨机不可比、worktree 同机空闲各 ≥2 次、只取比值 + 不变量、污染跑作废）。
3. **Docker 容器级四项（首次全证据，见 §D）**。

### C. 本轮抓到并修复的生产关键路径缺陷：出站 guarded lookup 的 `all:true` 契约缺失

- **现象**：容器首次起 seed 连 `host.docker.internal` 拒启，错误仅为无信息的 `card fetch failed: fetch failed`。容器内用 dist 的 `guardedFetch` 打完整 cause 链定位到 `ERR_INVALID_IP_ADDRESS: Invalid IP address: undefined`。
- **根因**：Node 22 默认启用 autoSelectFamily，undici/net 以 **`options.all=true` 调自定义 connect lookup 并期望回调 `LookupAddress[]` 数组**；`createGuardedLookup`（`src/util/outbound-dns.ts`）无视 options 始终回标量 `(err, address, family)`，net 把标量当数组读 → address=undefined。
- **影响面判定（与上线相关，重点）**：**所有按主机名（域名，而非裸 IP 字面量）连接执行 Agent / seed / MCP 的出站请求，在 Node 22 下全部失败**。真实部署几乎必然用域名，故这是真实部署关键路径缺陷，而非边角。修复前若直接上线，内核将无法注册任何以域名声明的外部执行 Agent。
- **为何三道防线都漏掉**：`smoke:core` 全连 `127.0.0.1`（IP 字面量，net 直接连接、不触发自定义 lookup）；既有集成测试也只连 127.0.0.1；lookup 单测只断言标量回调、从不经过真实 net.connect 的 all:true 路径。**只有容器经主机名连宿主才暴露**——这正是 v0.24 §F"容器级四项无新证据"所代表的覆盖盲区的具体代价。
- **修复**：lookup 遵守 `options.all`（all:true 回全部通过守卫的地址数组、all:false 回首个标量；保持"任一解析地址落私有/保留段即整主机拒绝"的 fail-closed 语义，不挑好地址）。TDD：先写主机名经 mock resolver 解析到 127.0.0.1 的真实 undici 建连回归，确认**变红**（`Invalid IP address: undefined`）再修绿。顺带补可观测性：新增 `describeTransportError()` 走 undici `.cause` 链取首个带 code 的错误（EZEUSOUTBOUND/ECONNREFUSED/ERR_INVALID_IP_ADDRESS），接入 `register()` 与 `healthCheck()` 的 transport catch——此前拒启只显示 "fetch failed"，运维无法区分守卫拦截/无监听/地址错误。新增 5 测试（outbound-dns +4 含主机名真实建连与 all:true 三态、registry +1 cause code 透传）。
- **连带文档修正**：`docs/deployment.md` §2 env 表原"非 IP 字面量主机名一律放行（DNS 重绑定见 deferred）"为过期表述（deferred #35 已在 Active work 104 销项，DNS 解析层守卫已默认装配），改为准确的两层守卫说明；§4.3 新增"容器内连宿主/私网对端必须配 `ZEUS_OUTBOUND_ALLOW_HOSTS`"。

### D. Docker 容器级四项：首次全证据（修复后全 PASS）

多阶段 `zeus:0.1.0`（node:22-slim，runner uid 1000、VOLUME /data、HEALTHCHECK 打 /healthz）。密钥容器内经挂载卷生成（私钥 0600），宿主 mock agent 经 `host.docker.internal` + `ZEUS_VASSAL_SEEDS` 接入，`ZEUS_OUTBOUND_ALLOW_HOSTS=host.docker.internal` 放行。

| 项 | 结果 |
| --- | --- |
| (a) healthy | `Up (healthy)`；seed 注册 a1:active、realm/审计/生产密钥正常、listening；healthz 200；internal roster 无 token 401、带 token 200、seal keyId=docker-accept |
| (b) `/data` 0600 | kernel-state.json / audit.jsonl / rsk.key 均 `-rw-------` |
| (c) SIGTERM 落盘 | `docker stop` 0.179s，日志 `SIGTERM received, draining…` → `kernel state saved`，无 10s 强杀 |
| (d) 重启恢复 | `docker start` 日志 `restored kernel state … (vassals=1…)`、roster 仍 a1:active；**重启后 POST /api/intents 派发 → a1:completed 端到端走通**（直接证明 all:true 修复在容器 + 主机名场景生效）；dispatch 审计落盘 1 条 |
| 生产守卫（附加） | NODE_ENV=production 无 RSK 钥 → exit 1 拒启 |

boot seed/realm 连接不产生审计事件、运行时 dispatch 才审计——设计如此，非缺陷。

### E. MVP 判定（本轮）

- **产品核心「完全可用」MVP：✅ 维持**。P0 26/26 不回退；本批为取证 + 缺陷修复，不翻任何 PRD 需求行状态（仍 55 行 / 非 P0 未闭合 8 条同集合）。
- **可上线交付真实用户：❌ 维持，但证据结构改善**。改善：容器级四项自 v0.19 以来首次在当前出货件上全证据 PASS，且端到端覆盖了"容器经主机名注册外部执行 Agent → 重启恢复 → 派发 completed"这条最接近真实部署的链路；§C 缺陷修复后，域名出站这一真实部署关键路径由"实际会坏且无证据"变为"已修复 + 有主机名真实建连回归锁死 + 容器端到端验证"。仍未达成的仓库外项不变：真实域名/公网部署、RSK 私钥托管与公钥指纹带外公告（deferred #7）、Zeus↔loom 生产栈联调、需 ≥3 真实 Agent 的背压阈值标定（deferred #9）、真实规模（单 Realm >2 万文件 / P50>500ms）取证。
- **方法论结论**：本轮再次验证 v0.4 原判被反复证伪的教训——"库内测试全绿"不覆盖"按产品自己的部署文档跑起来"。容器经主机名连外部对端是 IP 字面量测试的结构性盲区，现已用容器四项 + 主机名建连回归补上；建议把"容器经主机名 seed 注册并端到端派发"纳入 CI image-smoke 的候选（当前 image-smoke 只含构建 + 镜像内两项冒烟，不含跨容器主机名出站）。

### F. 本轮限制（如实记）

- 容器四项在 macOS + Docker Desktop（host.docker.internal → 192.168.65.254）取证；Linux 生产容器编排（compose/k8s、真实域名 + 公网 DNS、TLS）未验。
- mock agent 为本机自造一次性脚本（在 /tmp，未入库），非真实 pr-helper/loom；真实外部执行 Agent 的容器内联调属仓库外项。
- 容量对照为同机 mock 回环，墙钟绝对值机器相关，结论只取"§7 无回归"的比值与不变量；真机并发阈值仍待 deferred #9。
- 本批 +5 测试未在 Windows 复跑（Windows 环境性三族口径沿用 handoff，CI Linux 为准）。
- 未跑：push 后云端 CI（由用户决定 push 时点）、浏览器真机 E2E、真实域名公网部署。

## v0.24 复核（2026-10-04，评审对象：Active work 111–115（HEAD `c7b5778`，与 origin/dev 同步）：**核心 MVP ✅ / 可上线 ❌ 维持**；本批实现 **Web 监督台 v1/v1.1/v1.2**（CORS 传输层 + 四视图 + 派发作战室 + SSE 实时 + DAG 视图 + 意图识别入口，浏览器真机 E2E 全链路）与 **fan-out §7 运行中分支中断原语**（`AbortSignal` 真取消 + `branch-aborted` 审计 + `canceled by the driver` 结算，tui-tokens 补语义 token）；**抓到 1 处文档滞后当日修掉**（feature-inventory 状态行停在 v0.9 未记 113–115 批，升 v0.10，基线 1099/101 → 1104/102））

> 本轮方法沿用 v0.17 之后的规矩：**上一轮记录不作依据**，判定里含动词的条目重新取证。本轮在 **macOS 本机**取证（工作树 = origin/dev = `c7b5778`），全量/冒烟/验收脚本全部本机实跑；Windows 口径引用 handoff 记录（1078 绿 / 26 环境性失败三族）并标注**未在本轮重跑**。

### A. 验证基线（本机实跑，非转述）

| 项 | 读数 | 备注 |
| --- | --- | --- |
| 基线 HEAD / 工作树 | `c7b5778`，工作树干净 | `origin/dev..HEAD` = `0 0`（先核再评） |
| `npm run typecheck` / `npm run build` | 各自 **exit 0** | 先 build 后测试（`tests/*` 与 `scripts/*` 引用 `dist/`） |
| `npm test` | **1104 总量 / 1104 绿 / 0 失败 / 102 文件** | macOS 本机全量实跑；1104/102 与 handoff 活基线一致 |
| `npm run smoke:core` | **37/37 steps passed** | macOS 本机实跑 |
| `tests/doc-consistency.test.ts` | **11/11** | 实跑 |
| `node --check`（web JS） | 通过 | HTML 内联 script 提取后逐段 `node --check`（直接对 HTML 文件会报语法错误，须按 Active work 114 的做法下沉提取） |
| 定向复跑（113–115 批关键面） | **58/58** | `http-cors` + `tui-tokens` + `orchestrator` + `dispatcher` 四文件定向全绿 |

### B. 需求覆盖：机械核对，不读叙述

- `docs/prd.md` 需求行 **55 行**（`^\| E[\d.]+ \|` 计数），机械分类：**P0 26/26 ✅**（feature-inventory §1 断言 + 抽查）。
- 非 P0 未闭合 **8 条**：`E3.4`、`E3.8`、`E4.9`、`E4.10`、`E5.4`、`E8.4`、`E9.4`、`E10.2`——**与 v0.23 同集合**，既无新增也未回退；本批（113–115）未翻任何需求行状态（Web 监督台与 §7 均为既有能力接线/补强，不新增 PRD 行）。
- feature-inventory「已实现但未接线」：**0 项**（维持）；路由 **78** / export 语句 **120** / TUI 命令 **13** 类——三段断言读数未因本批变化（Web 面走 HTTP 端点，不加路由；§7 走既有 `POST cancel`）。

### C. 本批实现（一）：Web 监督台 v1/v1.1/v1.2（Active work 113/114/115 之 Web 侧）

- **CORS 传输层**（`src/http/server.ts` + `serve.ts`）：`corsOrigins?: string[]` 精确 Origin 白名单回显 + `Vary: Origin` + OPTIONS 预检 204（默认关闭，`ZEUS_CORS_ORIGINS` 逗号分隔 trim 装配）。`tests/http-cors.test.ts` 4 例实跑 4/4。
- **单文件 Web 监督台**（`web/supervisor/index.html`）：hash 路由四视图（监控 / 裁决 / 授权 / 连接）；写操作全部二次确认；轮询 10s 开关；内联 SVG favicon；≤760px 响应式。v1.1 加派发表单 → 作战室详情 → SSE 实时增量 → 取消；v1.2 加 DAG 分层视图 + 关键路径徽标 + 意图识别入口（命中预填派发表单）+ SSE 指数退避重连（2s×2^n 上限 30s）。
- **代码级核对（关键主张）**：分支状态渲染修复 `b.state || (b.ok ? 'completed' : 'failed')` 在位；`loadDag` 在 404 分支也触发（非 DAG 意图静默隐藏）；SSE 重连退避与重置逻辑在位。**浏览器真机 E2E 是本批主要证据源，但属于另一会话/本会话外的 GUI 实测——本轮如实标注：未在本轮重跑浏览器 E2E（依赖浏览器自动化环境），以代码级核对 + 测试 + 真进程冒烟覆盖。**

### D. 本批实现（二）：fan-out §7 运行中分支中断原语（Active work 115 内核侧）

- `DispatchRequest.signal?: AbortSignal`（dispatcher.ts 条件透传，exactOptionalPropertyTypes 兼容）；catch 按 `request.signal?.aborted` 区分审计决策 `'branch-aborted'` vs `'dispatch-failed'`，`AUDIT_DECISIONS` 增 `'branch-aborted'`（dispatcher.ts L58 在位）。
- orchestrator `branchSignals = Map<intentId, Map<vassal, AbortController>>` 与 inFlight 分存；`cancelIntent` cancellable 过滤改 `!isTerminalState && ((branch.ok && branch.taskId) || liveSignals?.has(vassal))`；abort 后分支结算 `state:'canceled'` + `reason:'canceled by the driver'`（L518 在位）。
- **验证**：定向 orchestrator + dispatcher 测试 52/52（本轮实跑）；tui-tokens 补 `branch-aborted: 'warning'` 后定向 6/6；全量无回归（1104/102）。

### E. 本批抓到并修复的缺陷（评审范围内核对）

- **SSE hijack 丢 CORS 头（Active work 114 当日修复，代码在位）**：`reply.hijack()` 后 `raw.writeHead` 覆盖全局 onRequest hook 的 CORS 头，`GET /api/intents/:id/events` 被浏览器 CORS 拦。修复：writeHead 前按白名单重查 Origin 补 `Access-Control-Allow-Origin` + `Vary`（server.ts L550–551）。`http-cors.test.ts` 4/4 仍绿。
- **tui-tokens 缺 `branch-aborted` 映射（Active work 115 当日修复）**：`AUDIT_DECISIONS` 新增但 token 未映射，`tests/tui-tokens.test.ts :: maps every audit decision` 红；补映射后定向 6/6（本轮实跑）。
- **本评审（v0.24）抓到 1 处文档滞后并当日修复**：feature-inventory 状态行停在 v0.9（2026-10-03，Active work 110 之后），**未记录 Active work 113–115 任何更新段**，状态行结尾基线 1099/101 落后活基线 1104/102；§2 入口表 Web 监督台行与 §1 计数（55 行 / P0 26/26 / 非 P0 8 条）已由 113 批同步、未被波及。修复：状态行升 **v0.10**，补 113–115 更新段（CORS + 四视图 + §7 + token），基线改 1104/102。doc-consistency 11/11 复跑仍绿。

### F. 部署镜像：本轮未重拍（出货件又动）

- 113–115 批改了 `src/http/server.ts` / `src/dispatch/dispatcher.ts` / `src/orchestrator/orchestrator.ts` / `src/tui/tokens.ts` / `web/supervisor/index.html`，出货件再动，按先例容器级结论不继承上一轮。
- 容器级运行属性（healthy、`/data` 0600、SIGTERM 落盘、重启恢复）四项对本批**无新证据**；CI `image-smoke`（构建 + 镜像内两项冒烟）覆盖面不含上述四项；本机本轮未做 docker 实构实跑（同 v0.23 口径）。

### G. 功能性 / 完整度 / 可上线（三维判定）

- **功能性**：P0 26/26 ✅、无已知 P0 未闭合；操作者从"API 端点 + TUI 命令"扩展出**浏览器 Web 监督台**这一真实操作入口，派发 → 观察（SSE 实时 / DAG）→ 中断（§7 真取消）闭环成型。
- **完整度**：§7 补上运行中分支中断这一最后的能力空白（v1.1 曾如实呈现"取消空操作"边界，v1.2 以 AbortSignal 收口）；「已实现但未接线」维持 **0 项**。
- **可上线**：**❌ 未达成**。剩余项仍是仓库外动作（真机部署、密钥托管与带外公告、生产栈联调、外部消费方接入）与需真实规模的阈值标定，同 v0.23 §G。

### H. MVP 判定与本轮限制

- **产品核心「完全可用」MVP：✅ 维持**；**可交付真实用户 MVP：❌ 维持**。本批为操作者面与运行中中断收口，不改变上线判定。
- **未跑（如实记）**：Docker 镜像实构实跑（§F）、浏览器真机 E2E（依赖 GUI 自动化环境，本机未重跑，以代码级核对 + 测试 + 冒烟覆盖）、Windows 本机全量（本机为 macOS，Windows 数引用 handoff 并标注）、push 后云端 CI（由用户决定 push 时点；最近一次 CI run 37145831862 四 job 全绿为另一会话推送记录）。
- **已跑（本轮实测）**：全量 1104/102 绿、冒烟 37/37、doc-consistency 11/11、typecheck/build exit 0、三条验收脚本（`verify:execute-delegation` **9/9**、`verify:intent-recognize` **7/7**、`verify:tui-recognize` **7/7**）、113–115 批关键面定向 58/58。

## v0.22 复核（2026-10-03，评审对象：Active work 104 本批工作树（基线 HEAD `7499dce`，本批 commit 与新 HEAD 见 handoff）：**核心 MVP ✅ / 可上线 ❌ 维持**；本批关闭 deferred #35（出站 DNS 重绑定守卫）、推进 deferred #33（执行授权票据三项接线），并修掉一条让最近两次 CI 失败的 smoke 类型缺陷）

> 本轮方法沿用 v0.17 之后的规矩：**上一轮记录不作依据**，凡判定里含动词的条目重新取证。本轮在 **macOS 本机**取证（非 Windows），故全量与冒烟无 Windows 环境性失败，读数即全绿，不做环境性分类。

### A. 验证基线（本机实跑，非转述）

| 项 | 读数 | 备注 |
| --- | --- | --- |
| 基线 HEAD / 工作树 | `7499dce` + 本批未提交改动 | 本批 commit 后 HEAD 与 commit 列表记 handoff |
| `npm run build` / `npm run typecheck` | 各自 **exit 0** | 先 build 后测试（`tests/*` 与 `scripts/*` 引用 `dist/`） |
| `npm test` | **1048 绿 / 0 失败 / 97 文件** | 基线 1022 + 本批新增 **26**（outbound-dns 15、http-execution-delegation 9、kernel-execution-delegation-state 2） |
| `npm run smoke:core` | **37/37** | 含 SIGTERM 落盘、重启恢复、重启重连数据域等全部步骤 |
| `tests/doc-consistency.test.ts` | **11/11** | 路由/导出普查断言随本批新端点同步 |

### B. 需求覆盖：机械核对，不读叙述

- `docs/prd.md` 需求行 **54 行**，机械分类：**P0 26/26 ✅**。
- 非 P0 未闭合 **8 条**：`E3.4`、`E3.8`、`E4.9`、`E4.10`、`E5.4`、`E8.4`、`E9.4`、`E10.2`——**与 v0.17 至 v0.21 同集合**，既无新增也未回退。本批关闭/推进的 #35、#33 是 deferred 台账项，不在 PRD 需求行。
- feature-inventory「已实现但未接线」：**仍 1 项**（执行授权票据派发闸门）。本批把与对端无关的三项接好，只剩与对端协议相关的部分，触发条件未变（deferred #33 条件②）。

### C. 本批关闭：deferred #35 出站 DNS 重绑定守卫

- **缺口**：A-12 的同步守卫只识别 IP 字面量，非 IP 主机名在 HTTP 客户端内部才解析，DNS A/AAAA 记录指向私网（或解析后、连接前重绑）即可绕过地址段守卫。
- **实现**（`src/util/outbound-dns.ts`，复用 `outbound-url.ts` 同一 RFC 6890 判定）：一个受守卫的 connect lookup——解析主机名 → 每个结果地址过同一地址段守卫 → 只把**通过**的地址回传给连接器，TCP 连接 pin 到该地址，连接器不再二次解析。解析结果含任一非公开地址即 fail-closed；逃生舱 `ZEUS_OUTBOUND_ALLOW_HOSTS` 语义不变（命中即跳过，含其解析结果）。
- **接线**：三个实际 HTTP 出站面的默认 fetch（`registry/registry.ts`、`dispatch/client.ts`、`mcp/client.ts`）统一改为 `guardedFetch`（经受守卫的 undici Agent）；注入的测试 fetch 不受影响。
- **验证**：15 项测试（拒绝/pin/逃生舱/IPv4·IPv6/回环放行 + 真实回环服务集成）；**缺陷植入**短接守卫 → 私网、元数据地址、混合结果、ULA 四条拒绝用例如期变红，还原后全绿。

### D. 本批推进：deferred #33 执行授权票据·与对端无关的三项接线

- **HTTP 签发端点** `POST /api/execution-delegations`（bearer）：校验 `grantedBy/skill/capabilities`、可选 `vassal/reason/ttlSeconds`，用驱动钥签发，201 返回票据；无 signer 时不挂载。9 项 HTTP 测试（含正常签发、capabilities 去重排序、各类 400、401、无 signer 404）。
- **审计 decision**：AUDIT_DECISIONS 增 `execution-delegation-issued`，`GET /api/audit?decision=` 白名单自动跟随，TUI token 同步（一一映射测试覆盖）。
- **nonce 账本持久化**：`KernelSnapshot` 增 `executionDelegationNonces`（向后兼容可选），collect/apply 接入；`bootKernel` 创建账本挂入组件、onChange 触发状态落盘。2 项快照 round-trip 测试（消费→collect→恢复到新账本仍 isSpent；无账本时省略该字段）。
- **仍留待触发条件②（pr-helper 凭据代理接口就绪）**：execute/plan 模式、Dispatcher 出站派发闸门、票据投递的 A2A 字段——均触及对端未定义协议，按设计不臆造。

### E. 本批顺带修复：一条让最近两次 CI 失败的 smoke 类型缺陷

- **现象**：`gh run list` 显示最近两次 CI（`642eaf8` 的 push 与 PR）均 **failure**，typecheck 30 秒内挂于 `scripts/smoke-core.mjs` 两处 TS7006（`refusedReasons` 链在无类型 `json` 上，`.every`/`.map` 回调参数隐式 any）。这是 Active work 103 引入、上一批未修干净的缺陷，也是此前「PR 有问题」的根因。
- **修法**：给 `refusedReasons` 补 `/** @type {string[]} */`，回调参数即有类型；typecheck 转 exit 0。本批 commit/push 后 CI 应转绿。

### F. 部署镜像：本轮未重拍（出货件已变）

- 本批改了出站、delegation、http、state 的 src，出货件变动，按先例容器级结论不继承上一轮。
- 容器级运行属性（healthy、`/data` 0600、SIGTERM 落盘、重启恢复）四项对本批**无新证据**；CI 的 `image-smoke`（构建 + 镜像内两项冒烟）在本批 push 后闭合，但其覆盖面不含上述四项。本机本轮未做 docker 实构实跑。

### G. 功能性 / 完整度 / 可上线（三维判定）

- **功能性**：P0 26/26 ✅、无已知 P0 未闭合；本批补齐出站解析这一安全面，并把执行授权票据从"仅原语"推进到"可签发、可审计、nonce 可持久化"。
- **完整度**：出站三个面统一受守卫；接入三通道执行点、签名链、备份恢复、记忆/日记、编制/责任链、TUI 三类页面、CI 各闸门均在位。
- **可上线**：**❌ 未达成**。剩余项仍是仓库外动作（真机部署、密钥托管与带外公告、生产栈联调、外部消费方接入）与需真实规模的阈值标定，同 v0.21 §H。

### H. MVP 判定与本轮限制

- **产品核心「完全可用」MVP：✅ 维持**；**可交付真实用户 MVP：❌ 维持**。本批为安全守卫与授权接线，不改变上线判定。
- **未跑**：Docker 镜像实构实跑（§F）、真机扇出与生产栈联调（外部条件）、本批 push 后的 CI（由用户决定 push 时点）。

## v0.18 复核（2026-09-27，评审 deferred #7 那半边入库之后的仓库：**核心 MVP ✅ / 可上线 ❌ 维持**；抓到三条陈述层缺陷并同日修掉（其中一条藏在**已销项**条目里），另有一次配置失误撞出的生产守卫实测，加一条被闸门逮住的、我自己写坏的索引行）

> 本轮方法不变：v0.17 的记录**不作依据**，凡判定里含动词的条目重新取证。评审对象：`dev` HEAD `8b53c8e`，距 v0.17 的 `6f86369` **21 个 commit**。本轮与往轮的一处方法差别：**镜像层重新实跑**（上一轮 src 零改动所以未跑，这一轮 `signing.ts`/`server.ts`/`rsk.ts`/`serve.ts` 都动了，不跑就不能声称部署面未受影响）。
>
> **耗时与负载口径（先说，因为它影响每一条读秒数的结论）**：本轮同机 load average 峰值 **395**（多个并行会话在跑），`npm test` 因此从空闲时的约 15s 涨到 **75–183s**，并且在中途一次跑出 **9 例超时红**（同一条命令重跑 **774 全绿、exit 0**）。红是负载造的，不是代码造的——但这条事实只有"带负载数报耗时 + 重跑取 exit 码"能撑住。

### A. 验证基线（本机实跑，非转述）

| 项 | 结果（2026-09-27 本轮） | 量法 |
|---|---|---|
| 全量测试 | **774 passed / 81 files / 0 失败**，75.4s（同机 load 395） | `npm test; echo $?` → **exit 0**。退出码**不经管道取**：管道之后的 `$?` 属于 `tail`，不是 vitest |
| typecheck / build | 各自 exit 0，`dist/` 完整 | `npm run typecheck`、`npm run build`（按 CI 顺序在 test 之前） |
| 核心链路冒烟 | **32/32**（本轮 +1 步，见 §D） | `npm run smoke:core -- --keep`，两次实跑；产物用后即删 |
| 镜像 | `docker build` exit 0（`zeus:review-v018`，369MB），**实跑见 §F** | 用完只删自己起的容器与标签：实测 `docker images` 无该标签、`docker ps -a` 无该容器，他人镜像与容器未触碰 |
| 远端同步 | `git ls-remote` 实测 `origin/dev` = 本地 HEAD `8b53c8e`，`rev-list --count` = 0 | **云端 CI 是否绿本轮未验证**（`gh run list` 被权限层拦），不写成结论 |

### B. 需求覆盖：机械核对，不读叙述

- **PRD §4 共 54 条需求行。P0 = 26 条，状态列 26 个 ✅，非绿 0 条。** 逐行解析表格第 3/4 列，不读任何正文。
- **非 P0 未完成 8 条**：E3.4 🚧、E3.8 ⬜、E4.9 🚧、E4.10 ⬜、E5.4 ⬜、E8.4 ⬜、E9.4 ⬜、E10.2 ⬜——与 v0.17 同一集合。其中 **E4.9 与 E5.4 的成因已收窄**（deferred #7 的公钥发布半边已入库，见 §F/§G），但状态不变。
- **状态列形状：本轮抓到 1 处并被它变成了一条闸门。** E3.4 的状态单元格是 `🚧 stdio`——限定词漏进了本该只有一个标记的列里。人读它毫无问题，**机械读取会把它当成第三种状态**（本轮解析器第一版正是这么处理的：P1 🚧 少计一条）。已把 `stdio` 移回正文列，并把这条口径**入库为断言**：`tests/doc-consistency.test.ts` 第 5 例，内置校准（同样形状的两行必须 FLAG、干净行必须不 FLAG），全量 **774 / 81 绿**。
- **「状态列 vs 正文」冲突：真表 0 处——但这个 0 是校准过的。** 检测器第一版（14 字窗口 + 词表）在真表上报出 **5 处**，逐条核对**全是假阳性**：三处是过去时陈述（"此前 `bootKernel` 从未接 `onRevoke`"、"企业域写闸门……＝死代码"），两处是条件句（"不可用即拒启"）。把豁免规则从"前 14 字"换成"匹配所在子句含过去/修复标记"后归零。校准样例同时扩到五行（两行必须 FLAG、三行必须干净），本轮实测：`X1`、`X2` 被 FLAG，`X3`、`X4`、`X5` 干净。**为什么要写这么细**：一个只会报 0 的检测器和一个恒绿的断言无法区分，而这条检查的价值全在"它能看见矛盾"。
- **该检测器仍是一次性脚本，已登记 deferred #28**（触发条件与"为什么不现在进 CI"写在条目里：词表进门禁的代价是下一批合理措辞让 CI 红）。形状检查（上一条）能进 CI 是因为它是纯结构判定，不需要语义。

### C. 装配核对：核装配而不是核注册（行号本轮重新定位）

| 面 | 执行点（本轮 grep 实测行号） | 判读 |
|---|---|---|
| A2A 出站凭证 | `src/state/boot.ts:354` `tokenFor: name => registry.tokenFor(name)` | ✅ 在 Dispatcher 构造处。**v0.17 引的是 :353** —— 一行漂移，不影响结论，但说明"引用行号"必须每轮重量 |
| 冲突升级闭环 | `src/state/boot.ts:360` `onConflict: conflictsToDesk(oversight)` | ✅ 在位（v0.17 引 :359） |
| Skill 治理闸门 + 分流候选 | `src/orchestrator/orchestrator.ts:142` 与 `:169`，`:170` 调 `selectTargets` | ✅ 同一 `activeProviders` 被两处复用，拒派语义未被分流改写 |
| MCP 域边界 | `src/realm/mcp.ts:39` 常量、`:340` 白名单外拒绝分支 | ✅ 有读取方 |
| DAG 操作者入口 | `src/http/serve.ts:149` 注入 `dagRunner` → `server.ts:312`/`:317` 运行、`:415` 回读 | ✅ 真进程不会 503（v0.17 引 `server.ts:291`/`:392`，均已漂移） |
| **记忆事件生产者** | `src/state/boot.ts:392` `recordBranchVerdicts(event)` → `:393` `consolidateFinishedMemory(event)` | ✅ 在 `intent-finished` 上**先写 claim 再整理**，出货进程实测 `events=6 facts=1`（deferred #27 那格） |
| **根公钥发布（本轮新增核对）** | `src/http/server.ts:183` 路由（挂在鉴权组**之外**）→ `src/registry/signing.ts:127` `publishRootKey()` | ✅ 装配闭合。**它不是信任锚**这件事由响应自身声明 + 带外固定承担，§5.1 契约 |

### D. 签名链与离线验签：出货命令复跑（本轮五条）

前四条沿用 v0.17 的口径（对象是本轮冒烟真封出来的名册，`schemaVersion=1`、`entries=3`）：

| 情形 | 输入 | 退出码 | 脚本给的原因 |
|---|---|---|---|
| 正向 | 原件 + 正确公钥，`--now` 在窗口内 | **0** | `VERIFIED … signature, digest binding, freshness and per-entry attestations all check out` |
| 时钟对照 | 同一份字节、同一把钥，`--now` 越过 `maxAgeSeconds` | **1** | `REJECTED: snapshot seal past maxAgeSeconds` |
| 载荷篡改 | 改 `snapshot.entries[0].name` | **1** | `REJECTED: snapshotDigest mismatch: snapshot content was altered` |
| 陌生钥 | 另生成一把真钥来验 | **1** | `REJECTED: seal signature verification failed (keyId=…)` |
| **只用端点响应（本轮新增）** | 公钥取自 `GET /api/roster/keys` 的 `spkiPem` 字段本身 | **0** | 同正向 |

第五条补的是"发布出来的字节**可被使用**"这一格——它不是"读得到"的同义词，也不等于"和我磁盘上那份字节相同"（冒烟原先钉的是后者）。同一冒烟里的负对照：把该字段换成 JWK 的 `x` 串（不是 PEM）→ **exit 2** 点名 `DECODER routines::unsupported`，还原后 **exit 0**。这一条也进了资产：`smoke:core` 第 32 步，**32/32**。

### E. 本轮抓到并已修的四条陈述层缺陷

1. **PRD E3.4 状态列混入限定词**（`🚧 stdio`）——见 §B，已移回正文列并加闸门。
2. **已销项条目内部留着与自身标题矛盾的旧判断**：deferred **#23** 标题写着 ✅ 已销项（2026-09-26），正文却仍留着一条"缺口：`src/http/server.ts` 里 `dag`/`criticalPath`/`topolog` 出现 **0 次**，操作员无法提交 DAG 形状意图"。本轮 grep 实测该文件里 `dag` 出现 **32 次**、两条路由在位（`serve.ts:149` → `server.ts:312`/`:415`）。已把该句改写为"原缺口（登记时的判断，2026-09-26 已闭合，保留原文）+ 现状"，并把仍成立的部分（CLI 与 MCP 面无 DAG 入口）留在原处。**类别值得记**：销项时人改的是标题与进展行，登记时写下的判断句不会自动更新——而读者对已闭合条目的戒备心最低，所以这类过期陈述比未闭合项更容易被当成事实继承。
3. **冒烟缺"发布字节可用性"这一格**（§D 第五条）——本轮唯一代码改动，加一步断言 + 一条负对照，32/32。
4. **本轮我自己写出的过期索引行，是被闸门抓的，不是我查出来的**：评审文档自称升到 v0.18 之后，`docs/README.md` 文档地图那行仍声称 **v0.17**，`npm test` 立刻红并点名 `docs/README.md:24`。**同一类错误连续两轮都犯**（Active work 61 那轮是 handoff 的两条索引行）。记这条不是为了认错，而是它给出一个可迁移结论：**凡是"我核对过版本一致性"的陈述，在有一条能重跑的比对之前，可信度等于零**——两轮里我都没查出来，两轮都是断言查出来的。

**另记两条观察，判为不构成缺陷、未改代码**：① `serve.ts` 启动日志枚举对外面时写的是 "healthz, roster public, roster internal + H2 driver API"，未含新增的根公钥端点——日志是给人看"起了什么"的，漏一项会让人以为端点没挂，但改它属于措辞而非行为，且本轮不改出货件（判据：它不改变任何判定）；② SSE（E1.2）不在冒烟链里，但 `tests/http-sse.test.ts:93` 有一例是真 `listen()` + `fetch` + 流读取（断 `text/event-stream`），所以它不是"没人走过"那一类。

### F. 一次配置失误撞出来的生产守卫实测（出货镜像上，本轮新增）

- **怎么撞的**：按 `docker cp` 把密钥送进容器是**错的**做法——它保留宿主 mode 与 uid，镜像以 `USER node`（uid 1000）运行，于是那份 0600 私钥在容器里**读不到**。
- **撞出了什么**：`[zeus-http] refused to start: cannot read RSK key file "/tmp/rsk.pem": EACCES: permission denied`——**拒启，错误点名变量与原因**；另一例是完全没配密钥的容器，得到 `ZEUS_RSK_KEY or ZEUS_RSK_KEY_FILE is required when NODE_ENV=production: refusing to seal the public roster with an ephemeral key (restarts would invalidate every signature)`。这两条正是"生产无可用钥不起服务"这条承诺**第一次在出货镜像上、以非单测方式走到**（此前只有 `tests/rsk-loader.test.ts` 与容器内正向启动）。
- **改对之后实测**：按部署手册的形状 `-v <私钥>:/run/secrets/rsk.pem:ro` 挂载 → 容器 `healthy`；`GET /api/roster/keys` 返回 `kid=zeus-rsk-review-2026-09`（来自 `ZEUS_RSK_KEY_ID`）+ `kty=OKP`，其 `spkiPem` 写成的文件对同容器 `GET /api/roster/public` 的封签跑 `npm run verify:roster` → **VERIFIED、exit 0**；启动日志亦报 `enterprise writes: accepting only driver grants signed by "zeus-rsk-review-2026-09"`；`docker stop`（SIGTERM）后宿主目录出现 `kernel-state.json`，**mode `-rw-------`（0600）**，456B；再 `docker start` → `restored kernel state … (vassals=0, escalations=0, intents=0)` 且 `healthy`。
- **诚实边界**：这两条负向结论**不在原计划内**，是失误撞出来的，所以我只把它们写成"承诺被走到"，不写成"我验证过密钥权限矩阵"。它也产出一条**运维口径**：secret 要走文件挂载，不要走 `docker cp`。
- 审计文件的 0600 本轮**未在镜像内验**（那次运行未设 `ZEUS_AUDIT_FILE`），它由冒烟一步覆盖（真进程实测 mode=600）。**该缺口已于 2026-09-27 在镜像内补测闭合**：`docker run` 设 `ZEUS_AUDIT_FILE=/data/audit.jsonl` + 私钥以文件挂载启动 → 容器内 `stat -c '%a %U:%G' /data/audit.jsonl` 得 `600 node:node`，`ls -la /data` 显示创建者即 uid 1000 的 `node`，启动日志 `[zeus-http] audit log: /data/audit.jsonl (64MiB x 5 kept)`；文件在启动时即建（`jsonlAuditSink` 构造期调 `ensureAuditFile`），故无需派发流量。诚实边界不变：这证明的是**镜像 + `USER node` + 卷**下写出的权限，真实生产卷的宿主侧权限仍是部署动作。

### G. 功能性 / 完整度 / 可上线（三维判定）

- **功能性：✅ 达成。** 判据未变（一意图 → 按技能扇出 → 规则聚合 → 冲突升级与人工决议 → 补参重派 → 落盘恢复 → 封签发离线可验），本轮**多了一格真的**：记忆层在出货进程里有输入有事实（`events=6 facts=1`），根公钥能被第三方**取用并完成验签**（§D 第五条、§F 镜像内）。P0 26/26 的口径本轮带校准重量，状态列形状问题 1 处已修已成闸门。
- **完整度：M1 ✅、M2 ✅、M3 = 库内制品 ✅ / 真实外部执行 Agent 受调度 ❌。** 与 v0.17 同判，**理由少了一条**：#7 的"公钥发布"半边已入库并实测，M3 剩下的外部动作不再包含"发布机制还没有"。
- **可上线：❌ 未达成。** 剩余项全部是**真实环境的执行动作或治理决定**：A1 真机扇出（凭证与出网许可）、A2 私钥托管落点决策 + 指纹带外公告、A3 loom 联调、A4 Jev endpoint/key、A5/R2 bayjf 侧验签展示、E10.2 真实部署、#9/#10 阈值标定（触发条件未到）。**本轮没有新增任何"库内可做但没做"的前置项**（v0.17 新增过一条 #25，已销项）。

### H. MVP 判定（明确回答本轮问题）

1. **产品核心"完全可用"的 MVP = ✅ 达成。** 本轮亲取的三条：① 门禁 `npm test` **774 / 81 / 0 失败且 exit 0**，typecheck/build 各 exit 0，`smoke:core` **32/32** 真进程真 socket；② 需求表机械计数 **P0 26/26**，"列 vs 正文"检测器经五行校准（能 FLAG 也能放过）后报 0；③ 签名链**五条对照**用出货命令行复跑，其中"只用端点响应里的公钥字节即可 VERIFIED"是本轮新增的判别，且其可失效性由一条 exit 2 的负对照撑住。核心路径**本轮未发现缺陷**，发现的三条都在陈述层（§E 1–3），已同日修掉；第 4 条是本轮自己写坏的索引行，由闸门先看见（§E 4）。
2. **可上线交付真实用户 = ❌ 未达成。** 清单见 [pre-launch-checklist.md](pre-launch-checklist.md) §A/§B。与 v0.17 相比这一格**收窄而未清空**：验证资产（#25）、记忆数据源（#27）、公钥发布通道（#7 的半边）三项本轮或已在库内，剩下的没有一项能在仓库里闭环。
3. **一句话**：**"核心完全可用"这一问的答案与上轮相同（✅），且本轮的证据比以前硬——部署镜像与公钥发布这两格第一次是实跑出来的，不是记录继承的；"可上线"仍差真实环境的动作与一个治理决策，库内已经不给不出活来了。**

### I. 本轮评审限制（如实标注）

- **未复跑**对线上执行 Agent 的 E4.8 验收：维持"记录级证据"，不升格为本轮实测。
- **未验证**云端 CI：`gh run list` 被权限层拦（本轮第二次被拦）。口径照旧：**推与 CI 结果只能由用户侧确认，我不从"本地全绿"推断"云端绿"**。本轮只报 `ls-remote` 测到的同步事实。
- **负载造成的红不是代码红**：load 395 时同一条 `npm test` 一度 9 例超时失败，重跑 774 全绿 exit 0。**引用任何"耗时/红"必须带当时的 load**；本轮也顺手澄清一条 CI 侧猜想：`ci.yml` 里 `clock-skew` 是**独立 job、独立 runner**（`runs-on: ubuntu-24.04` × 2 处），不与 `verify` 共享机器，所以本地这种争抢在 CI 上不成立。
- 镜像内**审计文件 0600** 本轮未测（未设 env），由冒烟覆盖；`/api/state` 的持久化盘点本轮未在镜像内复读（v0.12 时代做过）。
- `#9` 分流阈值与 `#10` 队列档位仍未标定（触发条件"≥3 真实执行 Agent 压测"未到）。
- 本轮**为验证目的改动了资产**（冒烟 +1 步、doc-consistency +1 例），未改任何出货行为代码——所以 §A 的镜像结论对本轮全部改动成立。

## v0.17 复核（2026-09-27，把 v0.15/v0.16 的判定重新实跑一遍：**核心 MVP ✅ / 可上线 ❌ 维持**；抓到验证工具自身一条缺陷并同日修掉）

> 本轮方法：v0.15/v0.16 的记录**不作依据**。凡判定里含动词的条目，改在三条路径上重新取证——① 门禁实跑（typecheck → build → test 的新顺序），② 需求表**机械计数**（不读叙述读表格），③ 出货命令行/编译产物**亲手复跑**。取不到证据的一次性标"未复跑"，不改写成"已验"。评审对象：`dev` HEAD `6f86369`（= v0.16 的 `caed8ac` 加一条本轮修复；距 v0.12 的评审对象 `8ddcddc` 已 **57 个 commit**）。

### A. 验证基线（本机实跑，非转述）

| 项 | 结果（2026-09-27 本轮） | 量法 |
|---|---|---|
| 全量测试 | **737 passed / 77 files / 0 失败**，153.9s | `npm test`（= `vitest run`，全文件并发） |
| typecheck | exit 0 | `npm run typecheck` |
| build | exit 0，`dist/` 完整 | `npm run build`（本轮按新顺序在 test 之前跑过一遍） |
| 远端同步 | `origin/dev` = 本地 HEAD（`git ls-remote` + `rev-list --left-right --count` = `0 0`） | **注意**：v0.16 之后那批已推送；**云端 CI 是否绿本轮未验证**（`gh` 访问被权限层拦），不写成结论 |
| 评审对象与上轮的差距 | `caed8ac..HEAD` = 1 commit（本轮的 `--quiet` 修复） | `git rev-list --count` |

### B. 需求覆盖：机械核对，不读叙述

- **P0 = 26 条，状态列 26 个 ✅，非绿 0 条**（脚本解析 PRD §4 表格逐行取优先级与状态列）。
- **状态列与正文自相矛盾 = 0 处**。这条结论**带正向对照**：把同一检测器喂三行样例——"列 ✅ + 正文含未落地措辞"、"列 🚧 + 正文含已关闭措辞"、"干净行"——前两行各报 FLAG、第三行不误报，检测器被证明**看得见冲突**，所以真实表上的"0 flagged"不是"从没红过"。（此前 E4.8 就是列 🚧/正文已关闭打了四年架。）
- **非 P0 未完成 8 条**：P1 的 E3.4 🚧、E4.9 🚧、E5.4 ⬜、E10.2 ⬜；P2 的 E3.8 ⬜、E4.10 ⬜、E9.4 ⬜；P3 的 E8.4 ⬜。全部为**外部条件型或触发条件未到**，不是无人认领的功能缺口（E4.9/E5.4 同一根因：deferred #7 密钥托管；E10.2 是真实部署）。

### C. 三条接入通道 + 本轮新落的三面：核对**装配**而不是核对**注册**

| 面 | 执行点（本轮重新定位的行号，已随 #9/#17/#23 漂移） | 判读 |
|---|---|---|
| A2A 出站凭证 | `src/state/boot.ts:353` `tokenFor: name => registry.tokenFor(name)` | ✅ 在 Dispatcher 构造处，非仅导出 |
| 冲突升级闭环 | `src/state/boot.ts:359` `onConflict: conflictsToDesk(oversight)` | ✅ 接线在位 |
| Skill 治理闸门 | `src/orchestrator/orchestrator.ts:142`；`:169` 同一 `activeProviders` 被 #9 复用为分流候选集 | ✅ 拒派语义未被分流改写 |
| MCP 域边界 | `src/realm/mcp.ts:39` 常量、`:340` 白名单外拒绝分支 | ✅ 有读取方 |
| **#23 DAG 操作者入口** | `src/http/serve.ts:147` `dagRunner: kernel.dagRunner` → `server.ts:291` 运行、`:392` 回读 | ✅ **真进程里不会 503**（此前只核过路由存在；本轮核的是依赖是否被注入） |
| **#9 每 Agent 分流** | `boot.ts:593-594` 读 `ZEUS_MAX_CONCURRENT_PER_VASSAL` → `boot.ts:408` 传入 → `orchestrator.ts:169-183` 调 `selectTargets` | ✅ 通路闭合。**语义澄清**：它启用的是**改派**（把饱和目标指向同技能空闲提供者），不是每 Agent 并发硬上限；`diversion.ts` 头注明确它与全局闸门分离，文档若写成"上限"会被操作员读成后者 |
| **#17 域边界变更** | `server.ts:1527` `POST /api/realms/:id/disconnect`、`:1542` `retarget-tenant` | ✅ 可执行。**但运行时"再挂回来"没有路由**（`app.post('/api/realms/:id/connect'` 计数 0）→ 操作员下线一个域之后只能靠重启 + `ZEUS_REALM_ROOTS` 恢复；本轮记为观察，不判缺陷（#17 的出口标准是"改租户/下线有路径"，已达成） |
| 参数校验口径 | `envInteger(value, name, min)` 第三参是**下界不是默认值** → 未设 `ZEUS_MAX_CONCURRENT_BRANCHES` 即不限并发 | ✅ 与 `.env.example` 的"Unset = unbounded"一致（本轮核对而非假设） |

### D. 签名链与离线验签：用**出货命令**复跑的四条对照

本轮不写 TS、不走测试注入，直接用 `scripts/verify-roster.mjs`（A1 批次交付的入口）判一份用 `dist/` 里的 `sealSnapshot` 真封出来的名册（`schemaVersion=1`、`seal.v=1`、attestation `active`），只持公钥：

| 情形 | 输入 | 退出码 | 脚本给的原因 |
|---|---|---|---|
| 正向 | 原件 + 正确公钥，`--now` 在窗口内 | **0** | `VERIFIED … signature, digest binding, freshness and per-entry attestations all check out` |
| 时钟对照 | **同一份字节、同一把钥**，`--now` 越过 `maxAgeSeconds` | **1** | `REJECTED: snapshot seal past maxAgeSeconds` |
| 载荷篡改 | 改 `snapshot.entries[0].name` 后原样投出 | **1** | `REJECTED: snapshotDigest mismatch: snapshot content was altered` |
| 陌生钥 | 另生成一把真钥来验 | **1** | `REJECTED: seal signature verification failed (keyId=…)` |

第二行是这一节的要害：它证明判定**跟着事实变**，而不是"校验器恒真/恒假"。只有恒真被证伪，前三行的 VERIFIED 才成立。

### E. 本轮抓到并已修：`--quiet` 让深比对**静默不执行**（`fix(scripts) 6f86369`）

- **现象**（复现即在本轮 §D 的命令上）：`--quiet --card pr-helper=<真卡片>` → **exit 1**，原因写着 `no attestation for supplied card(s): pr-helper`，而该 attestation 确实存在（`Object.keys(envelope.attestations)` = `['pr-helper']`）；同一条输入去掉 `--quiet` → **exit 0** 且打印 `deep check pr-helper  card digests match`。
- **根因**：深比对循环写在报告分支 `if (!opts.quiet) { … }` 里面，安静模式把它连同计算一起跳过。
- **危害是双向的**：① 按文档用 `--quiet` 取一行结论的操作员会得到"拒绝"，且理由把排查方向指到"这份名册没盖这个 agent"，而真实原因是**工具自己没跑那项检查**；② 更糟的是若没有底下那条"给了卡片却没被任何 attestation 覆盖即拒绝"的兜底，`--quiet` 会把深比对变成 no-op，**改写过的 fealty 会拿到 exit 0**。兜底救了正确性，但救不了可解释性。
- **为什么 736 项测试没抓到**：A1 的 8 例里**没有任何一例带 `--quiet`**。这是本仓库反复撞到的同一条结构性缺口：**特性开关的组合面只要没有一例穿过，它就没人验过**（与"用例名叫 unreachable 但喂的是 500 状态"同族）。
- **修法与复验**：计算移出打印分支，`--quiet` 只关报告；回归用例做**两侧对照**——安静 + 真卡片 → exit 0 且 stdout 只剩判定行、安静 + 改写过 dataPolicy 的卡片 → exit 1 且原因点名 `card digests do not match`。这两条断言**在修复前不可能同时成立**，所以它们同时充当修复的证据。修后 `npm run typecheck`/`build` exit 0，`tests/verify-roster.test.ts` **9 例全绿**，全量 **737/77**。
- 顺带一条同类观察（**已改文档，未改行为**）：`--now` 若给不带时区的裸时间戳，Node 按本地时区解析，而信封盖的是 UTC——本轮在东八区因此撞到 `REJECTED: seal issued in the future`。失败是响亮且方向安全的（拒绝而非误放行），所以只把"必须带 Z 或显式偏移"写进 `--now` 的 usage 行。

### E2. 本轮抓到的第二条：一个操作旋钮落在全部文档面之外（已补）

本轮把"代码读到的 env"与"文档写到的 env"做了**双向机械对照**（正则扫 `src/**/*.ts` 里的 `env.ZEUS_*` / `process.env.ZEUS_*`，再查 `.env.example` 与 `deployment.md` §2）：**25 个被读的变量里 1 个两处文档都没有——`ZEUS_MAX_CONCURRENT_PER_VASSAL`**；反向（文档写了但代码从不读）**0 个**，这一半是这次对照的正向对照：说明匹配口径对得上，"1 个缺失"不是解析偏差造出来的。

- 它是 #9 分流唯一的操作入口（`boot.ts:593` 读、`boot.ts:408` 传给 orchestrator、`orchestrator.ts:169-183` 调 `selectTargets`），**设了才启用分流**。一个会改变派发行为、又有拒启校验的旋钮，操作员在两份配置面上都找不到，等于该能力只对读过源码的人存在。
- 归因：#9 那批的改动记在设计文档与 PRD，没走"新 env 必须同时进 `.env.example` 与 deployment §2"这一步——该约定此前是靠人记得（v0.31 批次曾为审计/域变量补过 10 行 env，说明这条约定存在但没有闸门）。
- 本轮已补两处，并把三条**容易被误读**的语义写进去：它**不是**每 Agent 并发硬上限（限流是 `ZEUS_MAX_CONCURRENT_BRANCHES`）、必须低于全局上界否则分流永不触发、显式点名的 `vassals` 是硬绑定不被改派（`diversion.ts:101-103` 直接原样返回）。

### F. 五处与现状不符的陈述（本轮改正）
1. **评审文档自己的状态行还写"现行 v0.12"**，而同一文件里已有 v0.15 节与 v0.16 演进日志行 → 已指向 v0.17。上一批（v0.37）刚在 handoff 索引里修过 4 处同类错配，**这份文档自己是漏网的一处**，说明这类漂移不会因"我检查过"而消失，只会因有一条可重跑的比对而消失。
2. **`docs/pre-launch-checklist.md` §E1 写"本地领先，未 push"** → `git ls-remote` 实测 `origin/dev` 与本地 HEAD 相同（`0 0`），该句已过期。（同一句话在 PRD §7 的 v0.45 行末也出现过，那是**历史行**，按约定不改。）
3. **同一文档的门禁计数写 736/77** → 本轮 737/77（+1 是 §E 那条回归用例）。
4. **PRD 的状态行累积到 2018 字符、且粗体标记数是 15（不配对）**——每一版都往头部再抄一遍，而 §7 才是单一事实源；已收短为"现行 + 上一条 + 指向 §7"。
5. **`handoff.md` 变更记录里有一行被重复粘贴**：第 564 行把 deferred #17 那行的正文（989 字符）原样接在 #20 行后面，使该行有 **4 个未转义 `|`**、比表其余行多一列——批量插入时的接缝错位，肉眼读长段落看不出来，只有按"每行管道数"这条机械口径才暴露（同一检测器本轮也用于 §B 的表格）。已截掉重复段，全表回归 3 列一致。

### G. 功能性 / 完整度 / 可上线（三维判定）

- **功能性：✅ 达成。** 一意图 → 按技能扇出多执行 Agent（真 socket）→ 规则聚合（分裂不臆断）→ 冲突升级与人工决议回写 → 补参重派 → 落盘恢复 → 封签发离线可验；三条能力接入通道（MCP / Skill / A2A）的每条都有**被装配的执行点**（§C），本轮新落的 DAG 编排与每 Agent 分流同样闭合到 HTTP 操作面。P0 26/26 且冲突检测器经对照校准。
- **完整度：M1 ✅、M2 ✅（含 S3 DAG 操作者入口、E1.3 复核、#9 分流机制、容量五场景）；M3 = 库内制品 ✅ / 真实外部执行 Agent 受调度 ❌。** M3 的出口标准原文是"两执行 Agent 真机受调度；重启状态不丢"——后半句有实测（v0.11/v0.12 docker 实跑 SIGTERM 保存与重启恢复），前半句仍缺**对线上那一次的可重跑证据**。
- **可上线：❌ 未达成**，且理由与 v0.15/v0.16 同性质：**不是库内功能缺口**，而是真实环境的执行动作（A1 真机扇出、#7 密钥托管与公钥发布、loom 联调、Jev key 核对）+ 一项本轮新确认的流程缺口（见 §H-2）。

### H. MVP 判定（明确回答本轮问题）

1. **产品核心"完全可用"的 MVP = ✅ 达成。** 依据换成本轮亲手取的三条：门禁 737/77 + typecheck/build exit 0；需求表机械计数 P0 26/26 且"列/文冲突"检测器经正负对照后报 0；签名链与离线验签的**四条对照**（含"同一份字节只有时钟不同"这条判别）用出货命令行复跑通过。本轮**未发现任何核心路径缺陷**——唯一发现的缺陷在验证工具自身，已同日修复并补双侧对照用例。
2. **可上线交付真实用户 = ❌ 未达成。** 差项清单见 [pre-launch-checklist.md](pre-launch-checklist.md) §A/§B。本轮**新增一条前置项**：核心链路的"真进程端到端冒烟"**在仓库里没有可重跑资产**——历史上有过多次这样的实跑（v0.30 编译产物 13 项、v0.12 真 socket 7 条、镜像实构实跑），但**每次都是临时手写、跑完即弃**，因此每一轮评审都要靠上一次留下的记录说话。本轮我试图再手写一次时被权限层拦（判为"未被要求的新可执行代码"），于是这条缺口从"没做"变成了"下次也可能做不成"——登记为 deferred **#25**，它是**库内可做**的（一个 `scripts/` 冒烟脚本 + 门禁接线），不需要任何外部凭证。
3. **一句话**：**内核与制品仍是"可演示、可验证、可交付评审"的完全可用 MVP（✅ 维持），"可上线"仍差真实环境的跑起来/联起来/签出去，外加一项本轮新暴露的工程缺口——把这些验收动作从一次性手演变成仓库里可重跑的资产。**

### I. 本轮评审限制（如实标注）

- **未复跑**对线上执行 Agent 的 E4.8 验收：本轮沙箱到线上需代理且属外部执行，维持"记录级证据"，不升格。
- **未做** docker 真机构建/起容器：本轮除 `scripts/verify-roster.mjs` 外零运行时代码改动，镜像层未受影响（v0.11/v0.12 的 PASS 不重复声称）。
- **未验证**云端 CI：`gh run list` 被权限层拦；只报告 `ls-remote` 测到的同步事实，不推断 CI 结果。
- 真进程端到端链路（boot + 真 socket 扇出 + 吊销断流 + 重启恢复 + DAG + 分流 + 域下线）本轮**未能实跑**（脚本被拦），因此 §G/§H 里的"核心链路可用"依据是**库内 737 项测试 + 出货命令行复跑 + 装配点核对**三者合成，其中"真实进程一次走完"这一格由历史记录（v0.12 真 socket 7 条）承担，本轮未刷新——这正是 #25 要消除的那类缺口。
- **同日更新（评审之后，登记后立刻销项）**：#25 已落地为 `scripts/smoke-core.mjs`（`npm run smoke:core`，接进 CI），上一条限制随之不再成立——**核心链路本轮实跑通过，23 步全绿**（其后同一资产已扩到 27 步：新接的日记导出与记忆快照/漂移对账也进了真进程）：真进程起 + 目录挂域 + 真 socket 注册三个执行 Agent + 扇出聚合 + 内核自己读域并把内容送出去 + 四视图不泄凭证 + 审计 0600 落盘并可回读 + 名册离线验签（含"同字节仅 `--now` 过 maxAge 即被拒"的反证）+ 吊销即刻断流 + SIGTERM 落盘 + 重启恢复后仍可验。**这条链路第一次跑就抓到一处真缺陷**：`POST /api/vassals` 不接受 `token`，所以运行时上线的执行 Agent 会被**不带 `Authorization` 地派发**（凭证只有走 `ZEUS_VASSAL_SEEDS` 才存在）——已补 `body.token`（存储后任何视图不回显，2 例 HTTP 测试锁住），并改正 `body.aggregation` 那条会误导形状的 400 文案。闸门的可失效性不是断言出来的：开发过程中它先后在 18/23、20/23、21/23 处红过，每处都对应一个真实差异；把 `dist/` 移走后它退 1 并给出可读原因。**判定不变**（核心 ✅ / 可上线 ❌），但 §H-2 里"这一格只能靠历史记录"那句话已被本轮实测替换。
- 容量与阈值口径未变：mock 回环，`#9` 分流阈值未标定（触发条件"≥3 真实 Agent 压测"未到）。

## v0.15 更新（2026-09-27，本机重跑验证 + #9 启用代码落地，判定维持：核心 MVP ✅ / 可上线 ❌）

> 本轮方法：v0.12 是最近一次"逐条真进程重跑"的复核。本轮在 v0.12 之后又落了两批库内代码（E1.3 规则聚合边界钉桩、#9 背压分流启用代码），并在本机重跑验证基线 + 复核三条接入通道执行点是否仍在位（按 v0.9 立的纪律：含动词的 ✅ 必须 grep 到读取方）。本砂箱仍到不了真实执行 Agent 域，故**不声称复跑了 v0.12 的"对线上真机验收"那条**，只声称复核了库内执行点与全量回归。

### A. 验证基线（本机实跑，非转述）

| 项 | 结果（2026-09-27） | 说明 |
|---|---|---|
| 全量测试 | **736 绿 / 77 文件**（0 失败） | `npx vitest run` exit 0；较 v0.12 的 690/72 增 46 例（E1.3 边界 3 + #9 分流 7 + 其余批次） |
| typecheck | ✅ `tsc --noEmit` exit 0 | |
| build | ✅ `tsc -p tsconfig.build.json` exit 0，dist 完整 | 编译产物可被验收脚本真进程调用 |
| 容量压测 | ✅ 五场景（含 E1.5 闸门档、E10.4） | mock 回环数字，真机性能待 deferred #9/#10 触发 |

### B. 三条接入通道执行点复核（grep 读取方，确认未回退）

| 支柱 | v0.12 主张 | 本轮 grep 结果 | 判定 |
|---|---|---|---|
| **A2A 出站凭证** | 真进程对需 bearer 的执行 Agent 发 `Authorization` | `src/state/boot.ts:353` `tokenFor: name => registry.tokenFor(name)` 仍在 Dispatcher 构造处；`VassalEntry.token?` / `withoutToken` / revoked→undefined 链路未动 | ✅ 执行点在位 |
| **Skill 派发治理** | `activeProviders` 三态闸门在 `fanOut` 路径 | `src/orchestrator/orchestrator.ts:142` 仍存在；#9 在 `:169` 再次取同一 `activeProviders` 作分流候选集，未改变拒派语义 | ✅ 执行点在位（且被复用为分流输入） |
| **MCP 域边界** | `tools/call` 的 `realmId` 必须在预连接白名单 | `src/realm/mcp.ts:39/340` `REALM_NOT_CONNECTED` 白名单分支仍在；`tools/list`=`realm.search`/`realm.read` 不变 | ✅ 执行点在位 |
| **治理闭环** | 冲突经 `onConflict` 进监督台、人工裁决回写、补参重派 | `orchestrator.ts` `onConflict` 接线与 `resumeBranch` 未动；E1.3 `aggregate→detectConflicts→statusFromBranches` 未动 | ✅ 执行点在位 |
| **持久化/恢复** | 快照 tmp+rename 原子落盘、重启恢复 | `kernel-state.ts` 未动；docker SIGTERM 保存路径未动 | ✅ 执行点在位 |
| **签名链** | public/internal 名册封签、production 无钥拒启 | `rsk.ts` 未动；`gen-rsk-key.mjs` 未动 | ✅ 执行点在位（R2 托管/发布仍 deferred #7） |

### C. #9 背压分流对 MVP 判定的影响

- #9 启用代码（本批 `c231dbe`/`d56ca5a`/`89c1ae2`）属**增强**，不是核心 MVP 阻塞项。v0.4 把背压列在"软阻塞/增强"、deferred #9 触发条件明确"≥3 真实 Agent 压测"才定阈值——核心 MVP 不依赖它。
- 它提升的是"多 Agent 饱和时的可运营性"，不改变"核心闭环能否走通"的判定。故 MVP 判定不因此改变，仅说明内核在真实多 Agent 负载下更稳。

### D. 功能性 / 完整度 / 可上线 三维判定

- **功能性（库内）**：✅ 达成。一意图扇出多 Agent → 聚合（unanimous/majority/weighted，分裂 `conclusion:null` 不臆断）→ 冲突升级监督台 → 人工裁决回写 / 补参重派 → 持久化 / 签名发布，在库内可完整走通；出站凭证、Skill 治理、MCP 域边界三条接入通道均有读取方执行点且守卫可被真实触发。
- **完整度（里程碑）**：M1 内核基座 ✅；M2 并发决策内核 ✅（含 #9 分流、E1.3 judge、S3 DAG、决策后端）；M3 真机闭环 = **库内制品 ✅ / 真实执行 Agent 执行 ❌**（E4.8 对线上那一次仍是 v0.12 的"记录"，本轮未复跑；docker 实构实跑在 v0.11 已 PASS）。
- **可上线（交付真实用户）**：❌ 未达成。库内已无 P0 功能缺口，但下列为**真实环境执行动作**，无法在仓库内闭环：
  1. **真实执行 Agent 注册 + 扇出验收**：起一个 Zeus 实例、注册 pr-helper（或 loom）为执行 Agent、跑一次真机扇出（E4.8 真机证据待补，v0.12 记为记录）。
  2. **deferred #7 R2**：生产 RSK 密钥托管 / 轮换 / 公钥对 bayjf 发布（bayjf 名册对外公开前）。
  3. **Zeus↔loom 真机联调**：需 loom endpoint / agent-card（用户侧提供）。
  4. **Jev endpoint / key 真机核对**：启用模型裁决时。
  5. **deferred #18**：MCP 暴露侧 actor 判定（等 E3.4 真实执行 Agent）。
  6. **deferred #19**：入站 A2A 面（外部 Agent 调进 Zeus）——核心 MVP 是出站协作，此项不阻塞核心，但影响"Zeus 作为执行 Agent 入他人网格"。
  7. **deferred #17**：运行时域挂/卸可执行路径（运营品质，非核心阻塞）。

### E. MVP 判定（明确回答本轮问题）

- **产品核心完全可用的 MVP：✅ 达成（与 v0.12 一致，本机重跑复核确认执行点未回退、全量 736 绿 / build 过）。**"给目录即用 + 能带凭证与一个外部 Agent 协作 + 治理面说得住"三件事在库内同时成立；这三者已被 v0.12 在真进程/真 socket/真容器上复现，本轮确认代码未回退。
- **可上线（production-ready）MVP：❌ 未达成。** 差的不是代码功能缺口，而是 §D 列出的真实环境执行动作（真实执行 Agent 注册与扇出验证、RSK 密钥发布、跨实例联调、模型裁决 key 核对）。这些无法在本仓库内完成，需真实环境 + 真实凭证 + 授权。
- **一句话（v0.15）**：**内核级"产品核心完全可用的 MVP"已达成且经本机重跑复核未回退；"可上线交付真实用户"仍差真实环境里的跑起来、联起来、签出去——这与 v0.12 判定一致，性质未变。**

### F. 本轮评审限制（如实标注）

- 未复跑 v0.12 的"对线上真机验收"——本砂箱到不了真实执行 Agent 域，该证据维持为"另一会话记录"，不升格为本轮独立证据。
- 未执行 `docker build/run` 真机构（v0.11 已 PASS，本轮零 docker 改动）。
- 容量数字仍属 mock 回环口径（deferred #9/#10 触发条件未到，阈值未标定）。
- #9 分流的阈值（`w_r`/`w_l`/`LATENCY_NORMALIZER`）未标定，不进入核心 MVP 判定。

## v0.12 独立复核（2026-09-25，把 v0.10/v0.11 的 ✅ 逐条亲手重跑：判定维持 ✅，但抓到一条"文档说 502、实现给 400"）

> **本轮方法**：v0.10/v0.11 的 ✅ 是**同一台机器上另一个会话写下的记录**。本轮不采信记录本身——凡判定里含动词的几条（带着凭证派发 / 吊销即刻断流 / 白名单即边界 / 镜像能起能存能恢复），改在**编译产物真进程、真 socket、真容器**上由本评审亲手重跑，并逐条标证据分级。基线（全部本轮实测，非转述）：**690 测试 / 72 文件、0 失败**（`npx vitest run`）、`npm run typecheck` 与 `npm run build` 各自 exit 0、`git rev-list --left-right --count origin/dev...HEAD` = `0  0`、HEAD `8ddcddc` 云端 CI 两 run（`36127445154` / `36127475079`）均 completed/success（`gh run list --branch dev`）。

### A. 逐条重跑（证据分级：实测 = 本评审亲手复现；记录 = 采信他方但未复跑）

| v0.10 / v0.11 的主张 | 分级 | 本轮重跑结果 |
|---|---|---|
| 出站凭证：要 bearer 的真实执行 Agent 派发得出去 | **实测**（`dist/http/serve.js` 真进程 + 本地真 socket 回环执行 Agent） | 执行 Agent 侧日志实收 `Authorization: Bearer sekrit-8f2c` ✅ |
| token 绝不回显 | **实测** | `GET /api/roster`、`/api/roster/public`、`/api/state` 三处 grep 该 token **0 命中** ✅ |
| 吊销即刻断流 | **实测** | 吊销后再派发，执行 Agent 侧 auth 行数 `2 -> 2`（零新增） ✅ |
| 重启后凭证仍在 | **实测** | **去掉 seed 环境变量**重启、仅靠状态文件恢复：vassals=1 且再次带上同一 token ✅ |
| Skill 上派发路径（卸载真夺权） | **实测** | 三态成立：未注册 → pass-through；注册但无 active 版本 → 不派发并审计 `refused-skill-uninstalled`；显式 `request.vassals` 旁路**按设计保留**（操作者故意覆盖） |
| MCP 服务端有 tools、白名单即域边界 | **实测**（真 stdio JSON-RPC 握手） | `initialize` capabilities 含 `tools`；`tools/list` = `realm.search` / `realm.read`；两者真实执行；未授权 realm → `-32002`，路径穿越 → `-32003` / `-32602`；响应不含绝对路径 ✅ |
| docker 实构实跑 | **实测**（自建 `zeus-review-0.1.0`，369MB） | build 过 → 起容器 → HEALTHCHECK `healthy` → `/data/kernel-state.json` 与 `/data/audit.jsonl` 均 `-rw-------`（0600）→ SIGTERM 保存 → 重启日志 `restored kernel state … intents=1` 且 `realm … type=personal writable` ✅ |
| E4.8 对线上 pr-helper 验收 PASS | **记录**（本轮未复跑：对线上执行被权限层拦） | 可核到的支撑是代码级：端点修正 `f1e12fc`、把线上路由镜像进 mock 的测试 `48eb537`、PRD/handoff 留了完整命令。**采信为"另一会话在本机走代理实跑过一次"，但不升格为本评审的独立证据**——这正是 v0.5 那条纪律的适用场景：含动词的"已 Y"要标出处 |

### B. 本轮唯一新增的代码级发现：卡片不可达返回 400 而非文档承诺的 502，且丢失 URL

两处文档写着 `POST /api/vassals` **"卡片不可达 502"**：本文 `:16`（v0.3 历史块）与 `handoff.md:130`。（本评审初稿一度写成"三处、含 PRD `E5.5`"，复核后剔除：`grep -n 502 docs/prd.md` 只有两条，都是连接器的握手/上游失败，与执行 Agent 卡片无关。）真进程实测只对了一半：

| 输入 | 实测响应 | 判定 |
|---|---|---|
| `cardUrl` 指向**连不上**的 host（`http://127.0.0.1:9/…`，连接层失败） | `400 {"error":"invalid_request","detail":"fetch failed"}` | **错**：给了 4xx，且没说是哪个 URL |
| `cardUrl` 指向**能连上但返 404** 的 host | `502 {"error":"bad_gateway","detail":"card fetch failed: 404 http://127.0.0.1:8855/nope.json"}` | 对 |
| body 缺 `cardUrl` | `400 body.cardUrl is required` | 对 |

- **成因（代码级，已定位）**：`src/registry/registry.ts:65-66` 的 `await this.fetchImpl(cardUrl)` 外包无 try/catch，而 `card fetch failed: <status> <url>` 只在 `!response.ok` 时抛；连接层失败由 undici 抛出、消息是裸的 `fetch failed` 且不含 URL，于是 `src/http/server.ts:249` 的 `/^card fetch failed/` 不命中，落到 catch-all 的 `400 invalid_request`。
- **同一份文件里已有正确写法可抄**：连接器调用面（`src/http/server.ts:1317-1319`）是"按类型映射，未识别的抛出默认 502"，即**默认落在网关码上、把 400 留给真的是请求体错的情形**。执行 Agent 注册这条路由用的是消息正则，方向反了。
- **为什么算缺陷而不是口味**：文档教操作员"不可达 = 502"，他实际看到 400 就会去查**自己的请求体**，而该查的是网络/域名/端口——错误码把排查方向指反了，detail 里连是哪个 URL 都丢了。修法约 3 行（fetch 包一层、错误里带 URL）+ 1 测试。
- **为什么 690 项测试全绿仍漏了它**：本轮 grep 确认**没有任何测试让 `fetchImpl` 抛异常**——`tests/registry.test.ts:136` 和 `tests/http-vassals.test.ts:117` 两支失败路径都是"返回一个坏状态的 Response"，即测试世界里的"不可达"其实是"可达但 5xx"。**连接层失败这一支从单元层就没有入口**，所以它不属于 v0.8 记的"两半各自绿"，而是"只测了三种失败里的一种"。
- **这条的证据学意义**：v0.10/v0.11 的记录在我重跑的范围内全部成立，但**复核的价值恰恰不在改判，而在抓到记录里没人试过的那条路径**。
- **✅ 同日已修（本轮复核之后）**：`register()` 现把 fetch 包起来，抛 `CardFetchError`（**新类型，消息里带上 URL**），非 2xx 也归同一个类型；`src/http/server.ts` 的路由改为**按错误身份分类**而不是按消息正则——transport → 502，卡片内容被拒（无 fealty / 版本不支持 / 形状不对）→ 仍是 400。补两支测试（`tests/registry.test.ts` 连接层抛异常、`tests/http-vassals.test.ts` 502 且 detail 含 URL），基线 **692 测试 / 72 文件**、typecheck/build exit 0。
  - **可失效性**：把 try/catch 摘掉后恰好 **2 例红**（正是这两支新用例），而旧的那支名叫 `returns 502 when the card URL is unreachable` 的用例**仍然绿**——它喂的是 500 状态而非连接失败，**用例名与它实际覆盖的路径不一致，这正是缺陷藏了这么久的形状**。改回后 `cmp` 验字节一致。
  - **真进程复跑（编译产物，非注入）**：连接层不可达 → `502 {"error":"bad_gateway","detail":"card fetch failed: fetch failed (http://127.0.0.1:9/…)"}`；可达但 404 → `502 … 404 <url>`；有效卡片 → **201** 且出现在 internal 名册；body 缺 `cardUrl` → 400。四条全部实测。

### C. 判定（明确回答本轮问题）

- **产品核心完全可用的 MVP：✅ 维持**。本轮把依据从"另一会话的记录"换成"本评审亲手复跑"：上表 8 条里 7 条实测复现，覆盖三条接入通道各自的支柱 + 部署形态 + 持久化与重启恢复。
- **不随之升格的部分（如实标注）**：① E4.8 对线上那一次仍是**记录**，不是本次证据；② §B 的错误码缺陷**同日已修并复跑**（transport → 502 带 URL），它本就是操作性问题、不影响核心可用性；③ 仓库外仍差 Zeus↔loom 真机联调、Jev endpoint/key 核对、RSK 托管与公钥发布（#7）、#18 MCP actor 判定。
- **本轮新登记两条结构性缺口**（登记而非半做，见 deferred-items）：**#19 入站 A2A 面**——外部 Agent 调不进 Zeus（`src/http` 无 `/.well-known/agent-card.json`、无任何 `tasks/*` 路由）；v0.9 §A 已判定过，但从未进 deferred 清单，属于"评审说过、没人接"的失物。**#20 `ZEUS_JUDGE_THRESHOLD` 与 boot 参数校验口径不一致**——非数字被静默忽略（`src/state/boot.ts:537-540`）而并发类参数非法即拒启，`deployment.md:35` 已标注，统一它=推翻 `tests/boot-decision.test.ts:70-76` 钉住的契约，等决定。
- **一句话（v0.12）**：**判定不变，变的是依据的性质——"能带凭证协作、能治理、能部署、能恢复"这四句现在被同一份评审在真 socket 与真容器上重跑过；被重跑戳到的只有一条：文档承诺 502、实现返回 400。**

## v0.11 现行评审（2026-09-25，E4.8 首次真机验收 PASS + docker 实构实跑 PASS）

> 本轮把 v0.10 §F 剩余仓库外动作里**能由本机直接执行的两条**实际跑掉。MVP 判定维持 v0.10 的 ✅（库内达成），且"离可上线"再近一步。基线不变（690 测试 / 72 文件；本轮零测试改动，只有脚本一行端点修正 + 文档）。

### §F 剩余动作销项（逐条对照 v0.10）

| v0.10 §F 项 | 本批结果 | 证据 |
|---|---|---|
| E4.8 对线上跑一次验收（纯执行） | **PASS（首次真机验收）**。执行前修掉一处脚本失配：`acceptance-standard-a2a.mjs` 发 RPC 到 `/api/a2a/tasks`，线上 pr-helper 的 JSON-RPC 面在 `/api/a2a/agent-card`（GET=卡片、POST=RPC，`vercel.json` rewrite 证实），404 → 修正端点。验收：agent card 发现（pr-helper、5 技能）+ `tasks/send` 被接受（task 生命周期启动，input-required）、exit 0。**E4.8 → ✅，M3 推进到"首执行 Agent 真机受调度"只剩 loom 联调 + 起实例注册扇出** | 命令：`NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7897 BASE_URL=https://pr-helper-ten.vercel.app node scripts/acceptance-standard-a2a.mjs`，exit 0 |
| docker 实构实跑 | **PASS**。`docker build -t zeus:0.1.0 .` 镜像生成；镜像内 `gen-rsk-key.mjs` 生成 RSK 密钥；deployment.md §4.3 参数起容器（health check healthy）；带 token `GET /api/state` 返回完整内核状态（persistence/audit/counts/driverGrants，含快照恢复）；验证后容器清理 | `docker ps` 显示 healthy；`curl /api/state` HTTP 200 完整 JSON |
| Zeus↔loom 真机联调 | 仍待外部条件 | 需要 loom 的 endpoint / agent-card（用户侧提供） |
| Jev endpoint/key 核对 | 仍待用户确认 | — |
| RSK 托管与公钥发布（deferred #7） | 仍待决策 | — |
| deferred #18 MCP actor 判定 | 未触发（等 E3.4 真执行 Agent） | 与"tools 白名单"同落点 |

**一条阻塞归因再更正（重要）**：v0.5 起把 E4.8 归为"纯执行、非工程"是对的，但 Active work 40 曾记录"本沙箱到不了那个域（TCP :443 不可达）→ 只能由用户自己关"。**本轮证伪：直连超时是没走代理**——本机系统代理 `127.0.0.1:7897` 可达，Node 22 的 `NODE_USE_ENV_PROXY=1` 让全局 fetch 走代理即通。教训同 v0.5：**"到不了"先查通道，再下"外部阻塞"的结论**。

### F. MVP 判定（v0.11）

- **维持 ✅（库内达成），且"可上线"的剩余清单收窄**：给目录即用、带凭证协作真执行 Agent（E4.8 已线上验收）、治理面说得住、部署形态（docker）实构实跑——四条都实际验证过。
- **仍未执行**：Zeus↔loom 真机联调（需 loom endpoint/card）、Jev endpoint/key 核对（需用户）、RSK 托管与公钥发布（deferred #7，需决策）、deferred #18（等 E3.4）。
- **一句话（v0.11）**：**库里装完、镜像跑通、线上第一次被标准客户端调通；离"可上线"只剩把 Zeus 实例真机注册两个执行 Agent 扇一次、给 Jev 配 key、把 RSK 公钥发布出去。**

## v0.10 现行评审（2026-09-25，能力接入三原语执行点一批收口后重判 MVP：❌ → ✅ 库内达成）

> 本轮把 v0.9 §E 第 2-4 条（当时判 ❌ 所挂的三条**库内执行点**）全部写成代码并验证。基线：**690 测试 / 72 文件**，`npx tsc --noEmit` + `npm run build` exit 0（2026-09-25 全量实跑）。本批 4 组代码 commit + docs 尚未推送。

### §E 2-4 销项（逐条对照 v0.9 的"缺的那一句代码"）

| v0.9 §E 序 | 缺口 | 本批落地 | 证据 |
|---|---|---|---|
| 2 | 执行 Agent 出站凭证：`bootKernel` 不传 `tokenFor`、全库无"每执行 Agent 一 token"概念 | `VassalEntry.token?` + `registry.tokenFor(name)`（revoked/未知 → undefined，吊销即刻断流）+ `withoutToken()` 剥 token（get/list/listAll 四视图绝不回显）+ seed 语法 `ZEUS_VASSAL_SEEDS="cardUrl\|token"`（`\|` 不在 RFC 3986 合法 URL 字符集、无歧义；空 token/空 URL 拒启）+ boot 接线 Dispatcher `tokenFor`；export/import 持久化 token（状态文件=派发凭证存储，0600 已保障） | `tests/vassal-token.test.ts` 8 项：存储+四视图不回显、tokenFor 语义、吊销断流、重启后 tokenFor 仍在、seed 解析拒错、boot 端到端（带 token 发 `Bearer` / 纯 URL 种子不发 Authorization） |
| 3 | Skill 注册中心不在派发路径：卸载不夺权、hardening 只写不读、providedBy 逐字采信 | `SkillGovernor.activeProviders(skillId)` 三态——**未注册 → `undefined`（pass-through，卡片广告是唯一来源的历史行为保留）**；**注册但无 active 版本 → `[]`（=uninstalled/deprecated 全灭，是拒绝不是放行）**；`fanOut` auto 路径过闸门：`[]`→refused `skill-uninstalled` 不派发、过滤后 0 命中→refused `no-active-provider`；refusal 写进 `FanOutResult.refused` 并触发 `onRefusal` 审计桥（decision 扩 `refused-skill-uninstalled`/`refused-no-active-provider`，realm 用请求真实域）；**显式 `request.vassals` 是一等旁路**（driver 故意覆盖）；注册 spec 的 `providedBy` 收窄 auto 目标 | `tests/skill-governor.test.ts` 8 项：activeProviders 三态语义 + boot 端到端五例（卡目录 pass-through、uninstall 拒+审计、spec 收窄至 providedBy、spec 与注册执行 Agent 无交集拒、显式 vassals 旁路） |
| 4 | MCP 服务端只有 resources、客户端 `tools/call` 0 命中、能力清单无人读取 | **服务端**（`src/realm/mcp.ts`）：`initialize` capabilities 增 `tools:{listChanged:false}`；`tools/list` 暴露 `realm.search`/`realm.read`（带 inputSchema）；`tools/call` 校验 name/arguments 且 **realmId 必须在宿主预连接白名单内**（白名单=域边界，非"写死 personal"，未连接 realm → REALM_NOT_CONNECTED）、走 store.search/read 并延续"响应与错误消息绝不含绝对路径"不变量。**客户端**（`src/mcp/client.ts` + `connectors.ts`）：`McpClient.callTool(name, args)`；`ConnectorRegistry.callTool(id, name, args)` **以握手发现且经声明边界裁剪后的 `capabilities.tools` 为唯一可调集合**（未连接/已吊销/不在清单内一律拒绝）；HTTP 面 `POST /api/connectors/:id/tools/:name/call`（body.arguments 校验、上游失败 502、本地错误 400/404） | `tests/realm-mcp.test.ts` 15 项（tools/list、tools/call 成功/白名单外/坏参数/未知工具，旧"无 tools"断言改写）；`tests/mcp-connectors.test.ts` 11 项（callTool 边界：发现可调、边界裁掉不可调、revoked/未连接拒）；`tests/http-connectors.test.ts` 12 项（HTTP call 路由 200/400/404/400） |

**可失效性验证**：Skill 闸门三态用 uninstall/spec 交叉用例覆盖拒绝分支；MCP 白名单用未连接 realm 拒绝、工具边界用"上游广告但声明裁剪掉"的工具拒绝——守卫都能被真实触发。对照组（既有 665 项 + 本批其余）全绿。

### F. MVP 判定（v0.10，明确回答本轮问题）

- **产品核心完全可用的 MVP：✅ 库内达成。** v0.9 把 ❌ 挂着的三条库内执行点（出站凭证、Skill 上派发路径、MCP tools+调用面）本批全部闭环，§E"1–5 做完"的三件事——**给目录即用 + 能和一个真实外部 Agent 协作 + 治理面说得住**——在库内同时成立：
  - 协作：要 bearer 的真执行 Agent 现在能被 Zeus 带着凭证派发出去（E4.8 的"跑了也在认证失败"变成"能跑"，剩"对线上跑一次"是执行不是工程）；
  - Skill：卸载真夺权、加固真被读、auto 目标真由注册中心决定（显式 vassals 仍是一等旁路）；
  - MCP：服务端有 tools 且以白名单为域边界，客户端调用面真实存在、能力清单有消费者。
- **仍未执行的是仓库外动作（性质是执行与外部环境，不是代码缺口）**：E4.8 对线上跑一次验收（`BASE_URL=https://pr-helper-ten.vercel.app node scripts/acceptance-standard-a2a.mjs`）、Zeus↔loom 真机联调、docker 实构实跑、Jev endpoint/key 核对、RSK 托管与公钥发布（deferred #7）、deferred #18 MCP actor 判定（等 E3.4 真执行 Agent，与"tools 白名单"同一落点的自然延伸）。
- **一句话**：**"用户的资料和它的可恢复性"+"与真实外部 Agent 协作的门"两条都在库里装完了；离"可上线"只剩在真实环境里跑起来、联起来、签出去。**

## v0.9 现行评审（2026-09-25，deferred #13/#14 收口后重判：**新增一类阻塞——"缺执行点"不是"缺环境"**）

> **本轮方法 changed**：不再只核对 PRD 勾选与测试数量，而是把三条产品支柱各自的**"操作者能不能走到它"**当问题问，并把首跑路径在编译产物上真跑一遍（A/B 对照，非注入式）。基线：`e74ba8d`+`2a524ee`+两个 docs commit（HEAD `f4727f1`），**658 测试 / 70 文件**、`npm run typecheck` 与 `npm run build` exit 0、`npm audit --omit=dev` **0 漏洞**（生产依赖只有 fastify 一项）；src 80 文件 14 461 行、tests 70 文件 13 164 行、HTTP 路由 67 条
>
> **结论一句话（v0.9）**：**产品核心"完全可用"的 MVP 判定 = ❌ 未达到，且未达到的原因变了。** v0.4–v0.8 反复说"库内已无 P0 功能缺口，只剩仓库外的真机/凭证/发布动作"——**这句话本轮第三次被证伪**：能力接入三原语里 **MCP 与 Skill 两条支柱缺的是库内的执行点（代码），不是环境**。具体说：一个真实用户今天**无法让 Zeus 带着凭证去调任何外部执行 Agent**，**无法让外部 Agent 调进 Zeus**，**卸载一个 Skill 也停不掉任何一次派发**。同时首跑路径上有两个当场实测出来的阻断（见 §C-1/C-2）。
>
> **但也别读反了**：**个人数据底座这一侧是真达标的**——给目录、检索、记忆、日记、备份与恢复协议（含今天补上的内核状态文件）、签名且一次性的企业写凭证、审计链、持久化与重启恢复，全部有 HTTP/CLI 入口且被实测走通过。缺的是**协作那一半的门没装完**。

### A. 三条支柱逐条判定（"实现了" 与 "摸得到" 是两件事）

| 支柱 | 代码里有 | 操作者能走到的最远处 | 判定 |
|---|---|---|---|
| **MCP** | ① 客户端 `src/mcp/client.ts`；② 服务端 `src/realm/mcp.ts` + stdio 宿主 `mcp-stdio.ts` | 服务端**实测可跑**：`initialize`→`resources/list`→`resources/read` 全通（`zeus-realm://<id>/manifest\|search\|item`，越界 path 被拒、绝不吐绝对路径）。但它 **只有 resources、没有 tools**（`mcp.ts:122` 明写 "resources only, no tools"），且**只支持 personal + readOnly**（`mcp-stdio.ts` 里 type 是写死的 `'personal'`）→ 企业域/租户/写都进不去。**没有鉴权**（deferred #18）。客户端侧 `tools/list` 能拿，**`tools/call` 全仓库 0 处命中**（含 tests）→ 连接器是"声明+发现"，任何工具都不会被执行；`record.capabilities` 只有一处赋值（`connectors.ts:80`）、**无人读取**，§7 的边界裁剪裁的是一份没有消费者的清单 | **REACHABLE: partial**——只读个人域可演示；"接外部系统"名不副实 |
| **Skill** | `SkillRegistry`（多版本/install/uninstall/deprecate/harden）+ `POST /api/skills*` 全套路由 + `resolveTeam` | **派发路径不看注册中心**：`Orchestrator.fanOut` 用 `lookup.findBySkill(skill)`（`orchestrator.ts:103-106`）→ `entry.card.skills.some(...)`（`registry.ts:140`），即**目标选择只读执行 Agent 卡片自报的技能**；`resolveTeam` 全仓库唯一调用点是一条查询路由 `POST /api/skills/team`（`server.ts:1127`）。后果是可证伪的：**`POST /api/skills/:id/uninstall` 停不掉任何一次真实派发**，`harden` 写的 `hardening/permissions` 在 `src/skills/` 之外没有读取者（grep 全库确认）→ 加固是只写元数据。另：`providedBy` 从请求体逐字抄入（`server.ts:1052`）且**不与名册交叉核对**，"提供者身份只能经认证获得"这句话被另一条路由绕开 | **REACHABLE: partial**——登记/检索/生命周期可操作；**它不治理任何东西** |
| **A2A** | 卡片拉取 + fealty 校验 + JSON-RPC/SSE 客户端 + 封签名册 | 上线一个执行 Agent：`POST /api/vassals {cardUrl}` 或 `ZEUS_VASSAL_SEEDS`，需 `x-zeus-fealty{swornTo:'zeus',version:'1'}` + 字段形状校验（`registry.ts:59-75`，今天加的 `151ab3b`）。**但 oaths 是未签名的**（`registry.ts` 里没有任何 verify/signature 路径），签名方向是反的——Zeus 封签**自己的**名册给 bayjf 验。**致命的一条**：`bootKernel` 构造 Dispatcher 时只传 `audit/now/fetchImpl`（`boot.ts` 的 `new Dispatcher(...)`），**从不传 `tokenFor`**，而 `client.ts:67` 是 `if (token) headers.Authorization = ...` → **跑起来的进程对任何执行 Agent 都不发 Authorization**，需要 bearer 的真执行 Agent（pr-helper 就是，`scripts/acceptance-standard-a2a.mjs:18` 明确要 `TOKEN=`）在 Zeus 里**根本派发不出去**。且**没有入站面**：src/http 里没有 `/.well-known/agent-card.json`、没有任何 `tasks/*` 路由，外部 Agent 只能被动应答 | **REACHABLE: partial**——对不需要认证的本地 mock 可用；**对真实世界的一个执行 Agent 不可用** |

**这一节的意思**：产品哲学第 3 条"一切能力必须能落到 MCP / Skill / A2A"当前**没有一条落到可运营的深度**。这不是文档口径松紧问题——能力接入三原语各缺一个执行点，且三个都在库内可写的范围内。

> 一条**公平的反证**（评审不该只报坏消息）：`realmId` 是按 realpath 派生的确定性哈希（`store.ts:118`，实测同一目录两次连接得到同一 id），所以 MCP stdio 进程与 HTTP 内核**说的是同一套 realm 标识**——两扇门之间的寻址天然对齐，缺的只是各自的能力与鉴权，不是"对不上号"。

### B. 里程碑重判（对 PRD §5 的出口标准逐条）

| 里程碑 | 出口标准 | v0.9 判定 |
|---|---|---|
| M1 内核基座 | E3.1–3.3、E4.1–4.7、E5.1–5.2、E6.1、E10.1/10.3 | ✅ 达成（P0 实测 25 ✅ / 1 🚧，未闭合那条是 E4.8） |
| M2 并发决策内核 | E1.1–1.6、E2.1/2.2/2.4、E10.4 | 🚧 **降级为部分达成**：内核与容量真达成，但 **E2.4 的"一意图映射到所需技能并选 Agent"实际走的是卡片自报技能**，注册中心不在路径上 → 出口标准的"技能"这一半是虚的（见 §A-Skill） |
| M3 真机闭环 | E4.8、E10.2、Zeus↔loom、E5.3 | ❌ 仍未达成，**且原因比"没人跑一次验收"更硬**：即便去跑，也会先撞上 §A-A2A 的"不发凭证"——**E4.8 的一部分阻塞从"缺执行"变成了"缺代码"** |
| M4 Realm 开放 | 标准 MCP client 可读 Realm；bayjf 公开验签 | 🚧 只读到一半：个人域只读 stdio **实测可被标准 JSON-RPC 客户端读**（本轮手工验过 initialize 协商与三类 resources 读取），但无鉴权、无企业域/租户、无 `tools/write`、无 streamable HTTP（E3.4 仍 🚧）；bayjf R2 未做（E5.4 ⬜） |
| M5 情感与成长 | 备份与恢复协议恢复演练通过；Skill 可安装/传授 | 🚧 **两条一条真一条虚**：备份与恢复协议演练今天**真过了**（真 CLI 子进程：备份→删→退出码 2→恢复→字节级 sha256 相同→用恢复文件起内核）；"Skill 可安装/传授"有 API 与台账，但**装了不授权、卸了不夺权**（§A-Skill） |

### C. 首跑路径实测（编译产物真进程，非读代码）

**C-1 🔴 文档默认配置下，核心动作直接失败。** `.env.example` 同时给 `ZEUS_STATE_FILE=./data/kernel-state.json` 与 `ZEUS_AUDIT_FILE=./data/audit.jsonl`（第 14/19 行），而**没有任何人在写审计前建目录**：`jsonlAuditSink` 直接 `appendFileSync(path, line)`（`audit.ts:48`），只有状态文件那次 save 才 `mkdir`（`kernel-state.ts`）。A/B 实测（同一台机器、同一构建、只切换这一个变量）：

| 配置 | `POST /api/intents`（指定一个不存在的执行 Agent）返回的 branch.reason |
|---|---|
| 带 `ZEUS_AUDIT_FILE`（新目录，`data/` 不存在） | **`ENOENT: no such file or directory, open '.../data/audit.jsonl'`** |
| 不带 `ZEUS_AUDIT_FILE` | `no registered vassal provides this skill`（这才是正确答案） |

两个缺陷叠在一起：① 审计目录不会自动创建 → 按文档配置就报错；② **审计写盘失败被当作"派发失败的原因"报给操作员**（错误归因：文件系统问题伪装成执行 Agent 问题）。附带一条：审计文件用 `appendFileSync` 未指定 mode → **0644 世界可读**，而同一天之前我们刚把状态文件固定成 0600（它里面是 token 与记忆明文）；审计行含 realm/主体/决策明细，这个不一致没有理由。

**C-2 🔴 我今天写进 deployment.md 的备份示例，按原样跑不通。** 评审自查：`docs/deployment.md:207,211`（commit `476353d`，本批）把内核状态文件写成 `kernel.json`，并用 `$ZEUS_DATA_DIR` / `$ZEUS_BACKUP_DIR` 两个仓库里**不存在**的变量；真实默认名是 `kernel-state.json`（`.env.example:14`、`Dockerfile:19`）。因为白名单语义是"点名而读不出即拒绝"，**照文档敲会直接失败**（这正是我们故意设计的行为——错的是文档）。`deployment.md` §2 的 env 表**少了 10 行**（复测口径：代码读 24 个 `ZEUS_*`，§2 表内只有 14 个）：`ZEUS_VASSAL_SEEDS` + 决策三件（`ZEUS_DECISION_BASE_URL/API_KEY/MODEL`）+ OpenAI 兼容三件（`ZEUS_LLM_*`）+ judge 三件（`ZEUS_JUDGE_ENABLED/THRESHOLD/ALLOW_UNCALIBRATED`）；`.env.example` 对全部 24 个是齐的，缺的是给人读的那张表。**订正**：本轮子审计曾把 `ZEUS_VASSAL_SEEDS` 也算进漏项，实测该词在 deployment.md 出现 1 次——**不成立，已剔除**；`.env.example` 对全部 25 个变量的覆盖是完整的。

**C-3 🟠 同一个环境变量，两套互不兼容的语法。** `ZEUS_REALM_ROOTS`：内核按 **逗号**切（`boot.ts:564-566`），stdio MCP 按 **`[:;]`** 切（`mcp-stdio.ts:92-99`）。把 `.env.example` 里那份逗号值喂给 MCP 宿主，会被当成**一个**怪路径 → connect 失败 → 进程 exit 1（该行为实测确认其存在，非推测）。

**C-4 🟠 `.env` 在裸机上根本不生效。** 全仓库无 `dotenv` 依赖、`src/` 内无任何读 `.env` 的代码；只有 `docker --env-file` 与 systemd `EnvironmentFile=` 会解析它。而 `.env.example:2` 写的是"Copy to .env and adjust"——裸机用户照做会以为配好了，实际一个变量都没读进去。

**C-5 🟠 域只能启动时挂，永远不能卸。** connect 只发生在 `bootKernel`（`boot.ts` 的 realmRoots 循环 + 快照重连）；`store.ts` 的重连漂移检查明写 `disconnect is not offered in this build`。**运行时挂载/下线一个目录 = 无路径**（deferred #17 已登记，但它在"能不能日常运营"上的分量比登记时写的更重：改一次目录布局要重启，而重启时旧快照里的 root 若已挪走会**直接拒启**）。

**C-6 🟡 realmId 对操作员不可见。** 启动日志打了决策/并发/审计/状态四类，**唯独不报连了哪些域、id 是什么**；`GET /api/state` 只有计数。唯一能拿到 realmId 的地方是 `GET /api/domains`——而这要求操作员已经知道 bearer 面存在。**新用户的第一句话"我的域叫什么"没有答案。**

**C-7 ✅ 好消息（如实记）**：`/healthz` 与 `Dockerfile` 的 HEALTHCHECK 路径一致且真返回 200；零 env 起进程不崩（RSK 缺省走临时钥 + 响亮告警，`NODE_ENV=production` 才拒启）；Vault CLI 的 README/deployment 示例与实际 flag 名逐字对得上（`--files` 那条错是 C-2 的**文件名**错，不是 flag 错）；今天新加的写凭证面在真进程里 13 项断言全过。

**C-8 🟡 同一个仓库里，"被悄悄忽略的配置值"有两套相反的处理**。`ZEUS_MAX_CONCURRENT_BRANCHES` / `ZEUS_BRANCH_QUEUE_LIMIT` / `ZEUS_AUDIT_MAX_BYTES` 非法 → **拒启**（E1.5 的理由写得很清楚：被悄悄忽略的上限读起来像保护存在）。而 `ZEUS_JUDGE_THRESHOLD='high'` → **静默退回默认阈值**，且有一条测试 `ignores a non-numeric threshold` 把这个行为**钉成契约**（`tests/boot-decision.test.ts:70-76`）。同一类失效，两种答案。本轮**没有擅自统一它**——改法是推翻一条已锁定的测试契约，属于决策不属于修 bug；已在 `deployment.md` 的该行显式标注这处不一致。

**C-9 ✅ 本轮同时修掉的（原样复跑证据见 handoff Active work 46）**：C-1（审计目录自动创建、写出 0600、轮转后重新收紧、sink 抛错**不再**进入派发结果、不可用的审计路径改为**拒启并点名变量**）、C-3（`ZEUS_REALM_ROOTS` 两扇门统一为逗号；Windows 盘符会被冒号切坏是选它的理由）、C-4（`.env` 谁来解析写进文件头）、C-6（启动日志逐条打印 realm id/类型/租户/可写性）、`ZEUS_VASSAL_SEEDS` 拉不到卡片时改为一行可读的拒启信息而不是栈回溯、deployment.md §2 补齐缺的 10 行 env。**MVP 判定不因这些改变**——它们把"能不能起来"从 ❌ 变成 ✅，但 §A 的能力接入三原语执行点缺口一条都没补，所以 §F 的结论仍是 ❌。



### D. 文档比代码强的地方（本轮新增，逐条给行号）

| 位置 | 现在的说法 | 实况 |
|---|---|---|
| `docs/prd.md:119` E7.1 ✅ | "基于 MCP 的外部系统接入（resources/tools/prompts）" | **`tools/call` 全库不存在**，工具清单只被列出来、从不被调用 |
| `docs/prd.md:120` | "连接后只暴露声明边界内的工具" | 边界确实在裁（`connectors.ts:70-76`），但**裁完没人消费** → 该句隐含的"暴露"动作没有发生 |
| `docs/prd.md:64` E2.3 | 行标题"卸载**断权**"；正文其实写得很准（"resolveTeam 即刻显示 missing、默认查询不可见"） | 正文成立，**标题 over-claim**：注册中心不在派发路径上，所以卸载改变的是"组队查询的答案"，不是"这次派派发得出去"。要么改标题，要么让 `fanOut` 过一次 registry |
| `docs/prd.md:65` E2.4 ✅ | "一意图映射到所需技能并选 Agent" | 选 Agent 读的是**卡片自报技能**（`registry.ts:140`），不是技能注册中心（§A-Skill）；`resolveTeam` 不gate任何派发 |
| `docs/prd.md:66` E2.5 | "刻意不暴露 `grantProvider`，提供者身份只能经认证获得" | **字面成立但可达等价**：`POST /api/skills` 的 `providedBy` 由请求体逐字写入（`server.ts:1052`、`types.ts:51-52` 明确允许），而 `providersOf` 读的就是它（`registry.ts:266-273`）→ 不经过任何带教认证就能成为"提供者"。**这不是安全洞**（整条面同为操作者 bearer），但它让"只能经认证获得"变成了一句可以绕的话——要么禁掉该字段，要么改措辞 |
| `docs/design-realm.md:84` / `prd.md:157` M4 | "标准 MCP 客户端经授权读 Realm" | 能读，但**无授权层**（#18）、无企业域/租户、无 streamable HTTP；"经授权"三字目前不成立 |
| `docs/product-portrait.md:39` | A2A "可互操作、可委托、可协作" | 委托是单向且**不带认证**的；协作面没有入站协议入口 |
| `docs/product-portrait.md:141` / M3 | pr-helper "真机全链路闭环" | 从未跑过（E4.8 🚧、E10.2 ⬜），且当前代码即使跑也会在认证这一步失败（§A-A2A） |

**v0.9 的纪律追加**：本轮能力接入三原语审计里，**"某个 ✅ 需求的关键动词有没有执行点"这一问法**一次性产出了 4 个装饰性检查（connector 边界、skill 卸载夺权、hardening、providedBy 认证）。凡 PRD 打 ✅ 的句子含"阻止/只暴露/即刻断权/经授权"这类**动词**，评审必须 grep 到那个动词的读取方，否则判 ❌。

### E. 达到"产品核心完全可用"的最小集（按解锁面排序，全部库内可做）

| 序 | 要做的事 | 现在缺的那一句代码 | 解锁 |
|---|---|---|---|
| 1 | ~~审计目录自动创建 + 审计失败不得改变派发结果 + 审计文件 0600~~ **✅ 已做**（同日 `bda5013`，证据见 §C-9 与 handoff Active work 46） | 构造期建目录建文件；运行期只计数不抛 + `audit.degraded` 上报；0600 且轮转后重新收紧 | C-1 已消灭（A/B 复跑：`no registered vassal provides this skill`） |
| 2 | **执行 Agent 凭证注入（出站认证）** | `bootKernel` 的 `new Dispatcher(...)` 少一个 `tokenFor`；全库没有"每个执行 Agent 一个 token"这个概念 | M3/E4.8 从"没人跑"变成"能跑"；这是**当前最硬的一条** |
| 3 | **让 Skill 注册中心上派发路径（或明确它不上）** | 要么 `fanOut` 的目标解析过一次 `resolveTeam`/registry 状态，要么把 E2.3/E2.4 的 ✅ 与措辞改成"目录与组队查询" | 能力接入三原语的 Skill 支柱有执行点，或文档不再这么宣称 |
| 4 | **MCP 服务端补 `tools` + 鉴权/主体** | `mcp.ts:122` 现在明写不含 tools；#18 的 actor 判定 | M4"经授权读 Realm"、E7 的真实接入 |
| 5 | ~~修文档首跑面~~ **✅ 已做**：状态文件名（`737c733`）、§2 env 补 10 行、`.env` 解析方写清、roots 分隔符统一、realm 挂载可见 | C-2/C-3/C-4/C-6 | 一个不读源码的人能配起来 |
| 6 | 运行时的域挂/卸（#17）与 realmId 可见性（C-6） | `disconnect` / 启动日志与 `/api/state` 增域清单 | 日常运营不再"改目录=重启=可能拒启" |

1–5 做完，我才认为"给目录即用 + 能和一个真实外部 Agent 协作 + 治理面说得住"这三件事同时成立，即**产品核心完全可用的 MVP**。6 是运营品质，可靠后可并行。

### F. MVP 判定（v0.9，明确回答本轮问题）

- **产品核心完全可用的 MVP：❌ 未达到。**
- 与 v0.8 的差别不是"又少了几个功能"，而是**阻塞性质被改判**：v0.4 起一直写"库内已无 P0 功能缺口，只剩仓库外动作"——本轮 grep + 真进程实测证明**能力接入三原语中两条缺的是库内执行点**（MCP 无 tools/无鉴权、Skill 不在派发路径上），外加一条**库内缺失的出站认证**。这些都是可以今天写代码关掉的事，不该记在"等真机"的账上。
- **已达到的部分（也说清楚，别把好消息读没了）**：个人数据底座 = 给目录→检索→记忆→日记→**连内核状态文件都能按图恢复**（今天 #13）→企业写入需要**签名且一次性**的凭证（今天 #14）→全链路审计与重启恢复。这部分 658 项测试、真 CLI 毁库演练、真进程冒烟三层证据齐。
- **一句话**：**"用户的资料和它的可恢复性"已经 MVP；"多 Agent 协作"这个产品核心定义里的另一半，今天还不能算 MVP——它的门在库里没装完。**

### G. 本轮评审的限制（如实标注）

- 未执行 `docker build/run`（C-1/C-2 是裸机 dist 实跑，不代表容器内路径）。
- 未用官方 MCP SDK 客户端连过 stdio 服务（本轮是手工 JSON-RPC 逐条发；协议版本协商与三类 resources 读取实测通过，SDK 兼容性未验）。
- 未连接任何真实外部执行 Agent（沙箱网络到不了 `pr-helper-ten.vercel.app`，见 v0.5）——§A-A2A 的结论来自代码路径 grep + 真进程请求，不来自真机失败样本。
- 未跑 `npm audit` 的 dev 依赖面（生产依赖 0 漏洞）；容量口径仍沿用 capacity-baseline v0.3 的 mock 回环限制。
- 本轮三条子审计里有一条（首跑路径）先给出的两个结论与我实测不符（"MCP 产物不存在"、"serve.ts 有静态控制台挂载"），**已按实测否决，未采信**；采信的部分全部经过我本人复验或 A/B 复现。

## v0.4 现行评审（2026-09-24；结论仍成立，E4.8/M3 归因被上方 v0.5 更正、剩余关口清单被上方 v0.6 更新、§C 分类与基线被上方 v0.7 更新；**"库内已无功能缺口"这句被上方 v0.9 改判**）



> 原 §1–§8 为 2026-09-22 v0.1 首次评审快照（结论已被后续批次超越），原样保留于文末；v0.2/v0.3 为当时批注。**当前功能性 / 完整度 / 可上线性结论以 v0.9 节为准。**

### A. 验证基线（本机实跑，非转述）

| 项 | 结果（2026-09-24） | 说明 |
|---|---|---|
| 全量测试 | **436/436 绿（52 文件）** | `npx vitest run` exit 0（v0.1 为 124/16，v0.3 为 217/31） |
| typecheck | ✅ `tsc --noEmit` exit 0 | |
| build | ✅ `tsc -p tsconfig.build.json` exit 0，dist 完整 | |
| 容量压测 | ✅ 四场景全过 | A 扇出宽度 / B 并发意图 / **C H2 门面全链路** / **D 高并发取消传播**；数据见 `docs/capacity-baseline.md` v0.2 |
| 运行入口 | `npm start`（dist/http/serve.js） | env 装配见下；H1 + internal + H2 驱动 API |
| 部署制品 | **Dockerfile（多阶段/非 root/healthcheck/volume/SIGTERM）+ `docs/deployment.md` + `scripts/gen-rsk-key.mjs`** | 静态核查与接线核查通过；**本批未执行 `docker build/run`，真机镜像验证仍属仓库外关口** |
| 持久化接线 | `ZEUS_STATE_FILE`：启动恢复 + SIGINT/SIGTERM 优雅保存；`ZEUS_VASSAL_SEEDS` / `ZEUS_REALM_ROOTS` 启动装配 | serve.ts 实证 |
| 生产密钥 | `ZEUS_RSK_KEY` / `ZEUS_RSK_KEY_FILE`；**NODE_ENV=production 无钥拒启**；gen-rsk-key 零依赖生成 Ed25519（私钥 0600、拒覆盖） | 密钥实际托管/轮换/公钥发布在仓库外 |

### B. 自 v0.3 以来的库内增量（2026-09-22 → 09-24，据 handoff）

- 记忆体系 P0/P1/P2、Vault（打包/便携恢复/错图拒绝，见 L1 测试）；
- E1.6 离线决策回放器、E1.3 独立 judge 对抗评审、boot 决策后端 env 装配（Jev 优先 / OpenAI 兼容 fallback / 无 key 降级 rules-only）；
- E3.5 Realm 写路径（操作者授权门，库内）、E10.4 容量基线（本批扩为四场景）；
- E8.3 Diary（叙事日志）、E9.3 Org（部门/编制/问责），及 Diary/Org 的持久化与 HTTP 暴露；
- **签名链 v1.1（本批）**：internal 名册快照与 public 同样封签——attestation 扩 `active|revoked` 两态，revoked 行获**永久吊销 attestation（无硬过期，新鲜度由 seal maxAge 绑定）**，验签要求状态精确匹配（防提升/掩盖吊销），缺 source / 状态矛盾 fail-loud；H1 `GET /api/roster` 改发封签信封（`Cache-Control: no-store`）；
- 部署制品面（Dockerfile / deployment.md / gen-rsk-key）在库内就绪（具体落地批次见 git 历史）。
- 测试规模 217（v0.3）→ 436（v0.4）→ 532（v0.5/v0.6 期间）→ **587（v0.7，66 个测试文件）**。

### C. 功能性现状：剩余项分两类——仓库外执行，与库内可推进但需决策

内核（fan-out/join、幂等、取消、规则聚合、冲突检测、完整 DAG）、Skill 注册中心与组队、Realm（读 + 授权写 + digest + 穿越防护）、执行 Agent 联邦（注册/fealty/派发/任务产物回传/升级/二极管/吊销/审计）、HTTP 门面（public/internal 双投影 + 双份封签 + H2 驱动 API + H3 SSE）、监督台（升级/人工裁决回写/补参重派）、决策后端（模型无关 + Jev/LLM + 降级 + judge + replay）、可观测、持久化、记忆/Vault/Diary/Org 均在库内落地并有测试。

逐条核对 PRD 剩余 🚧/⬜。**v0.4 在这里写的是"无一项能在库内继续闭环"——这句被证伪了两次**：v0.6 之后 E3.6 与 E6.4 又都在库内落了地（v0.7）。准确的表述是**两类**：下表"真机 / 密钥 / 外部凭证"三行确实无法在库内推进；而当时列为"库内可做但需决策"的 E9.1/E9.2（Mentor 带教与上岗）**在同一天也确实做完了**（v0.8）——这反过来验证了两类划分是对的：卡住它的从来不是环境，是"要不要现在做"的判断。目前仍在第二类的是：E8.4（传承，P3）、#13（状态文件进备份与恢复协议）、#17/#18（企业域边界的两条运维尾巴）。把这两类混在一句"全在仓库外"里，会让人以为项目已经没有可写代码的地方，这是评审自身的失效模式，记在此处以防再犯。剩余项分类如下：

| 类别 | 剩余项（PRD 编号） | 关口 / 触发条件 |
|---|---|---|
| 真机 / 部署 | E4.8、E10.2、Zeus↔loom 联调、协议第 6 项守护测试、Docker 镜像实构实跑 | 需真实环境与执行 Agent 部署 |
| 密钥 / 发布 | E4.9 生产 RSK 的 R2（托管/轮换/公钥发布）、E5.4 bayjf R2 | deferred #7（bayjf 公开前） |
| 连接 / 企业域 | E3.4 stdio MCP、E3.5 剩余的 MCP `tools/write` 与签发（签名）凭证；~~E3.6 多租户~~ ✅、~~E6.4 双域授权~~ ✅（v0.7 收口）；企业域运维尾巴 deferred **#17**（改租户无路径）/ **#18**（MCP 侧无 actor） | E3.4/E3.5 半边随 read-realm 执行 Agent；#17/#18 需决策 |
| 触发型容量/安全 | E1.5、E4.10 背压与有界队列；E3.8 检索升级；E9.4 外部 Agent 沙箱 | deferred #9（≥3 真执行 Agent）/ #10（单 Realm >2 万文件或 P50>500ms）/ #5 |
| P2/P3 与外部凭证 | E8.4 传承（#3，P3）、Jev 真实 endpoint/key；E9.1/E9.2 上岗已 ✅（v0.8），真机侧仍差"由真实执行 Agent 当 Mentor 完成一次带教并通过"（与 E4.8 同批） | 真机 / 外部凭证 |

### D. 完整度（里程碑重判）

| 里程碑 | v0.1 判定 | v0.4 判定 |
|---|---|---|
| **M1 内核基座** | ✅ 达成 | ✅ 达成 |
| **M2 并发决策内核** | 🚧 核心达成、缺 E2.2/E10.4 | ✅ **达成**（E2.2 已补、E10.4 四场景基线已出；完整 DAG、模型无关决策、judge、replay 超出原 M2 范围） |
| **M3 真机闭环** | ⬜ 未启动 | 🚧 **制品就绪、真机未验**：部署/持久化/密钥/优雅关闭在库内齐备，但从未 `docker build/run`、无真机执行 Agent、无真机联调 |

### E. 可上线性：v0.1 五硬阻塞现状重判

| v0.1 硬阻塞 | 库内/制品侧（v0.4） | 仓库外残留 |
|---|---|---|
| 1 无部署形态 | ✅ Dockerfile（多阶段、node:22-slim、非 root、生产依赖、/data 卷、HEALTHCHECK、SIGTERM 优雅保存）+ deployment.md + env 装配 | 真机 `docker build/run` 冒烟、托管/反代/TLS |
| 2 状态全在内存（E5.3） | ✅ kernel-state（registry/升级队列/意图/请求，tmp+rename 原子落盘）+ 启动恢复 + Realm/Diary/Org 持久化 + SIGTERM 保存 | 真机备份策略与卷挂载验证 |
| 3 E2.2 Skill 注册中心 | ✅ `src/skills/`（多版本/弃用/检索/组队，歧义不静默） | — |
| 4 E6.2 决议反馈闭环 | ✅ 冲突入监督台、人工裁决回写重算、approve-resume 一键补参重派 | — |
| 5 签名链生产密钥（E4.9） | 🚧 **工具/接线就绪**：gen-rsk-key、env 注入、production 无钥拒启、双份封签（v1.1 含 internal） | R2：密钥实际托管/轮换、公钥对 bayjf 发布（#7） |

**上线前剩余关口（均为仓库外动作，库内无法替代）**：① `docker build/run` 真机冒烟；② 部署 pr-helper 等真机执行 Agent 并跑协议第 6 项纯客户端守护测试；③ Zeus↔loom 真机联调；④ RSK 实际生成托管与公钥发布；⑤ ~~push 本批 commit → 云端 CI 首绿（需授权）~~ **✅ 已销项（2026-09-25，v0.6）**：三次 push 均触发云端 CI，Node 20.x / 22.x 双矩阵全绿；⑥ 若启用模型裁决，配置并真机核对 Jev endpoint/key；⑦ deferred #9 触发后做背压真机标定。

### F. MVP 判定（v0.4）

- **库内内核级 MVP（可演示 + 制品就绪）**：✅ **达成**。M1/M2 全绿，436 测试、tsc/build 过、四场景容量基线、生产级 Dockerfile 与部署文档齐备；单意图多 Agent 并发 → 聚合 → 冲突升级 → 决策/重派 → 持久化/恢复 → 封签发布在库内可完整走通。
- **产品级可上线 MVP（交付真实用户）**：❌ **未达成，但阻塞性质已变**：v0.1 时是"缺 P0 功能（E2.2/E6.2/持久化/部署/密钥）"，v0.4 时这些在**代码与制品侧全部有了对应实现**；剩余的是**只能在真实环境由人执行的验收与发布动作**（真机部署/联调、密钥托管发布、外部凭证；当时列的第五项"CI"已于 v0.6 销项）。**库内已无 P0 功能缺口可继续闭环。**
- **一句话（v0.4 升级）**：Zeus 的"内核"达到了 MVP，Zeus 的"可部署制品"也已在库内齐备；Zeus 的"上线"只差在真实环境里把它**跑起来、联起来、签出去**——这三步无法在仓库内完成。

### G. v0.4 评审限制（如实标注）

- 未执行 `docker build/run`：Dockerfile 与 serve.ts 为静态/接线核查，镜像能否一次构建成功未实证。
- 容量数字为 mock 回环（口径与限制见 capacity-baseline v0.2 §8），非真机性能。
- Jev 决策后端无真实 endpoint/key，未真机核对（代码注释与 fallback 已标注）。
- 未跑 `npm audit`；真机执行 Agent 行为无法在本机验证。

---

## 1. 验证基线（v0.1 原始快照，2026-09-22；现行基线见上方 v0.4-A）

| 项 | 结果 | 说明 |
|---|---|---|
| 全量测试 | **124/124 绿（16 文件）** | 首轮并行出现 1 例超时（acceptance-script「无 BASE_URL 退出 1」，5s 窗口不足）；单独重跑 3/3 过，第二轮全量 124/124 过。**判定为并行负载抖动，非功能缺陷**（脚本手动复现 exit 1 + [FAIL] 正确） |
| typecheck | ✅ `tsc --noEmit` exit 0 | |
| build | ✅ `tsc -p tsconfig.build.json` exit 0，dist/ 完整（含 .d.ts/.map） | |
| 运行入口 | `npm start`（node dist/http/serve.js）可用 | 仅 H1 三端点（healthz / roster public 签名快照 / internal bearer） |
| 部署产物 | **无** Dockerfile / launchd / systemd / Procfile / 编排脚本 | 仅 `scripts/acceptance-standard-a2a.mjs`（验收脚本，非部署） |
| 推送状态 | dev 领先 origin/dev 8 commit，未 push | 需用户授权 |

## 2. 功能性评审（PRD v0.3 逐条核对）

### P0 需求覆盖总览：26 条 → 13 ✅ / 11 🚧 / 2 ⬜

| Epic | P0 项 | ✅ | 🚧 | ⬜ | 核心结论 |
|---|---|---|---|---|---|
| E1 并发决策内核 | 1.1–1.6（6 条） | 1 | 5 | 0 | **核心闭环成立**：fan-out/join、合并流、幂等、cancel 传播、规则聚合、冲突检测+onConflict 全部库内落地（26 项测试）；缺项均为"增强形态"（完整 DAG、LLM 裁决、决议反馈、背压） |
| E2 Skill 技能体系 | 2.1/2.2/2.4（3 条） | 0 | 2 | 1 | **最弱 Epic**：仅 Agent Card 携带 skills 字段 + findBySkill 选人；独立 Skill 规格、注册中心（E2.2 ⬜）、多技能组合全缺 |
| E3 Realm 数据域 | 3.1–3.3（3 条） | 3 | 0 | 0 | 数据主权底座完整（connect/manifest/search/read + digest + 穿越防护） |
| E4 执行 Agent 联邦 | 4.1–4.8（8 条） | 7 | 1 | 0 | 协议闭环最扎实：注册/fealty/派发/任务产物回传/升级/二极管/吊销/审计全绿；仅 E4.8 真机执行从未跑过一次（**v0.5 更正：原因不是"待部署"——pr-helper 早已上线每天在用**） |
| E5 HTTP 门面 | 5.1/5.2（2 条） | 2 | 0 | 0 | public/internal 双投影 + 签名快照 + 鉴权齐备 |
| E6 监督台 | 6.1/6.2（2 条） | 1 | 0 | 1 | 升级队列 approve/reject 已落地；**冲突决议反馈到聚合（E6.2）未做**——冲突已能进监督台，但决策结果不回写决策 |
| E10 平台工程 | 10.1/10.3（2 条） | 2 | 0 | 0 | CI 矩阵 + 库公共入口 + 构建产物齐备 |

**P1/P2 快照**：E1.7 可观测 ⬜、E2.3 安装/加固 ⬜、E3.4 MCP 正式暴露 🚧(stdio)、E3.5 write ⬜、E4.9 签名链生产 ⚠️（纯函数+H1 已接，**生产 RSK 密钥与 R1/R2 接线未做**）、E5.3 持久化 ⬜、E5.5 H2 ⬜、E8 情感层全部 ⬜、E9 企业层全部 ⬜。

### 与设计文档一致性抽查

- design-fan-out §7 边界（不做 DAG/持久化/硬 abort/SSE/LLM 裁决/背压）与 PRD 状态一致 ✅
- design-vassal-protocol §7 六项验收：1–5 库内达成，**第 6 项（纯标准客户端真机）待部署** 🚧
- design-http-transport §5 H1 验收全部通过（含"内核 grep 不到 fastify"硬约束）✅
- design-decision-backend v0.2（模型无关决策层）：**纯设计，src/decision/ 不存在**——不构成 MVP 阻塞（它是增强，非 P0 路径）
- handoff「124 绿」记录与本机实跑一致 ✅（抖动除外）

## 3. 完整度评审（里程碑视角）

| 里程碑 | 出口标准 | 状态 | 判定 |
|---|---|---|---|
| **M1 内核基座** | E3.1–3.3、E4.1–4.7、E5.1–5.2、E6.1、E10.1/10.3 | **全部库内落地**，测试验证通过 | ✅ **达成** |
| **M2 并发决策内核** | E1.1–1.6、E2.1/2.2/2.4、E10.4 | E1 核心落地、E2.1/2.4 部分、**E2.2 ⬜**、E10.4 容量基线未做 | 🚧 **核心达成，两项缺口** |
| **M3 真机闭环** | E4.8、E10.2、Zeus↔loom 联调、E5.3 | **全部未做**：无部署编排、无真机、无持久化 | ⬜ **未启动** |

## 4. 可上线性评审（上线阻塞项，按严重度）

### 🔴 硬阻塞（缺任一即不可上线）

1. **无部署形态**：无 Dockerfile / 服务管理 / 编排；`npm start` 仅裸进程。连"跑起来"都没有标准姿势。
2. **状态全为实例内存**（E5.3）：registry / 在途任务 / 升级队列 / 幂等表重启即失。重启 = 治理闭环空洞（吊销目录、升级队列丢失），违反 design-http-transport §2.2 对长驻形态的论证前提。
3. **E2.2 Skill 注册中心缺失**：PRD 明示 P0，产品核心叙事（"按技能组队"）的登记面缺失；目前组队只能靠 findBySkill 全选 + 显式名单。
4. **E6.2 决议反馈闭环缺失**：冲突能升级、操作者能 approve/reject，但**决议不回写聚合、无补参重派**——决策闭环断在最后一环。
5. **签名链生产密钥未落地**（E4.9）：public 名册封签目前用临时内存钥（serve.ts stderr 告警）；对外可信发布（bayjf 签名公开名册）前置缺失。

### 🟡 软阻塞（上线前建议，容忍度低）

6. **E4.8 真机验收未执行**：协议第 6 项守护测试（纯标准 A2A 客户端真机调用执行 Agent）从未真机跑过——超集协议"不是闭墙"的承诺无真机证据。
7. **Zeus↔loom / pr-helper 真机联调未做**：所有测试基于 mock/fixture，无一次真实 HTTP 双向。
8. **E1.7 可观测缺失**：无在途任务数/延迟/失败率指标，上线后无法回答"系统健康吗"。
9. **dev 领先 8 commit 未 push**：CI（GitHub Actions）从未真实触发过——本地按 CI 序列跑过，但云端无一次绿。

### 🟢 非阻塞（增强项，可后置）

- 决策后端抽象层（Jev/LLM）——设计已定，工程切片可后置；
- E8 情感层 / E9 企业层 / E7 MCP 连接器——P1/P2，明确不在 MVP；
- 完整 DAG / LLM 裁决 / 背压 / SSE 服务端——PRD 已列为后续。

## 5. MVP 判定

**定义**（按 PRD 里程碑语义 + product-portrait 核心定位"一意图扇出多 Agent 并行、聚合为可追溯决策"）：

- **库内内核级 MVP（可演示）**：✅ **已达成**——M1 全部 + M2 核心（E1.1–1.6 落地、冲突经 onConflict 进监督台、124 测试绿、typecheck/build 过）。单意图多 Agent 并发 + 聚合 + 冲突升级 + 决策（approve/reject）在库内可完整走通。
- **产品级可上线 MVP（可交付真实用户）**：❌ **未达成**——M3 真机闭环整条缺失（部署/真机/持久化）+ 两个 P0 缺口（E2.2、E6.2）+ 签名链生产密钥 + 可观测。当前产物是一个**测试充分、设计严谨的内核库**，不是可运行服务。

**一句话**：Zeus 的"内核"达到了 MVP，Zeus 的"产品"没有。

## 6. 达到可上线 MVP 的最小路径（建议排序）

| 序 | 工作 | 解锁 |
|---|---|---|
| 1 | **E2.2 Skill 注册中心**（登记/检索/版本化，库内 + 测试） | 补齐 P0 唯一 ⬜ |
| 2 | **E6.2 决议反馈闭环**（approve 决议回写聚合、补参重派骨架） | 决策闭环最后一环 |
| 3 | **E5.3 持久化最小版**（registry + 在途 + 升级队列 + 幂等表 JSON/文件落地） | 重启不丢，治理闭环无空洞 |
| 4 | **部署形态**（Dockerfile + env 装配 + 健康检查接线） | "能跑起来"的标准姿势 |
| 5 | **E4.8/E10.2 真机闭环**（部署 pr-helper → 真机跑验收 #6 → loom 联调） | 超集协议真机证据 |
| 6 | **E4.9 生产 RSK 密钥方案**（KMS/文件 + 轮换） | public 名册可信发布 |
| 7 | **push dev → CI 首绿**（需用户授权） | 云端回归防线生效 |

完成 1–4 后即为"可部署的 MVP 内核"；完成 5–6 后为"可信可上线的 MVP"。

## 7. 评审证据与限制

- 证据：PRD v0.3 全文逐条、product-portrait v0.4、handoff 2026-09-22 全文、10 份 design-*.md、src/ 25 个 TS 文件（约 2700 行）、tests/ 16 文件 5320 行、package.json、实跑验证输出。
- 限制：① 未运行 HTTP 进程级端到端冒烟（仅靠 7 项 inject 测试证据）；② 未执行压测（E10.4 本身未做）；③ 未审查依赖漏洞（npm audit 未跑）；④ 真机行为（执行 Agent 部署）无法在本机验证。以上均如实标注，不掩盖。

## 8. 演进日志

| 版本 | 日期 | 变更 |
|---|---|---|
| v0.29 | 2026-10-07 | **库内能力完备度推进轮，判定维持**（对象 Active work 142–144）：deferred #19 入站 A2A 面（`/.well-known/agent-card.json` 公开卡片 + bearer 保护 JSON-RPC tasks/send 落 H2 意图面、x-zeus-caller-card fealty 形状闸 fail-closed、inbound-task-* 入审计单一来源）与 deferred #18 MCP streamable HTTP 传输层（GET /mcp 公开元信息零泄漏 + POST /mcp bearer 保护喂同一传输无关 handler、x-zeus-realm-actor 会话级 actor 仅可收窄）按 #6 先例提前实现；基线 **1270/117**、冒烟 42/42、doc-consistency 17/17、三条验收脚本 9/9·7/7·7/7；核心 MVP ✅ / 可上线 ❌ 维持；库内可一口气推进项收窄为 #36 迁移与评审本身 |
| v0.20 | 2026-09-29 | **仅销项 A1，判定不变**：对线上 pr-helper 实跑真实执行 Agent 注册 + 真机扇出 **15/15 exit 0**。先前"A1 真机扇出（凭证与出网许可）"归因**被证伪**——原判据 `positions≥1` 是给投票型 Agent 的，pr-helper 是执行型（回报内容、不投票），`positions=0` 是正确结果，本轮**全程未用到任何凭据**。修法：判据可选化（`EXPECT_STANCE=0/1`，执行型断言"带回内容"、立场与 claim 显式 SKIP）+ `PARAMS` 透传技能参数（顺带修掉 runner 发错 owner/repo 的缺陷）。M3 的"真实外部执行 Agent 受调度 ❌"翻转为 ✅（M3 现只剩 Zeus↔loom 联调）。范围界定：pr-helper 在 plan 模式作答，证明的是真机扇出闭环与内容回传，不含对 GitHub 的不可逆写。活基线 791/83、冒烟 36/36 未变 |
| v0.1 | 2026-09-22 | 首次项目级评审：功能性/完整度/可上线三维度 + MVP 判定（内核级达成、产品级未达成）+ 阻塞项与最小路径 |
| v0.2 | 2026-09-22 | 六切片批次后销项批注：E2.2/E6.2 硬阻塞销项、E5.3/E1.7 大幅缓解（库内落地、装配/HTTP 待接线）、S3 DAG 与决策后端落地；产品级 MVP 判定不变（部署形态/生产密钥/真机/push 仍阻塞）；基线升至 166 测试 / 22 文件 |
| v0.3 | 2026-09-22 | A 批次（G1/G4/G5/G6）销项批注：执行 Agent 上线入口、Realm 连接持久化与 boot 恢复、approve-resume 补参重派、H3 服务端 SSE；基线升至 217 测试 / 31 文件；产品级 MVP 仍未达成 |
| v0.4 | 2026-09-24 | 刷新为现行评审（436 测试 / 52 文件，tsc/build 过，容量四场景）：库内增量含记忆/Vault/replay/judge/E3.5/Diary/Org、签名链 v1.1 internal 封签、容量场景 C/D；核查到 Dockerfile + deployment.md + RSK 密钥工具 + 持久化/优雅关闭接线，v0.1 五硬阻塞在代码/制品侧均已有对应物；**重判：M1/M2 达成、M3 制品就绪真机未验，库内已无 P0 功能缺口，产品级上线仅剩仓库外真机/凭证/发布动作** |
| v0.5 | 2026-09-25 | **仅更正阻塞归因，MVP 判定不变**：v0.3/v0.4 把 E4.8 写成"待 pr-helper 部署"并被本批报告原样转述——事实是 **pr-helper 早已部署在生产且每天使用**（`pr-helper-ten.vercel.app`，其 `vercel.json`/`api/a2a/agent-card.ts` 已核实）。E4.8 仍 🚧，真实卡点是"从没人对线上跑过一次这条验收"（两边记录均无）。连带重估 M3：**差的是执行，不是工程**。评审所在沙箱到不了该域，故只声称核实了部署事实、不声称验证过端点；并记一条纪律——引用"待 X/已 Y"状态句前先跑命令核实，防止过期陈述被后续每份报告继承 |
| v0.6 | 2026-09-25 | **仅销项，判定不变**："push dev → 云端 CI 首绿（需授权）"这条自 v0.1 挂到 v0.5 的关口关闭——三次 push 均在 GitHub 侧出结论、**Node 20.x / 22.x 双矩阵全绿**（run 36024156638 = 472/56、36045209815 = 512/60、36061395015 = **532/61**），本地与 origin/dev 完全同步。基线由 v0.4-A 的 436/52 快照刷新为 **532/61 + tsc/build exit 0 + 容量五场景**（capacity-baseline v0.3）。新登记 deferred **#16**（`ubuntu-latest` 2026-10-19 自动换构建机，无需谁批准）。**剩余关口的性质变了**：不再有任何"等授权/等确认"项，清单全部是需要真实环境、真实凭证或真实执行 Agent 的执行项 |
| v0.7 | 2026-09-25 | **两项库内收口 + 评审自我更正**：E3.6 企业域三级租户 ✅（`TenantScope` org/部门/成员、层级为结构性边界不可授权放宽、个人域不是租户、租户随快照持久化）与 E6.4 双域授权与审计呈现 ✅（`DomainGrant` 只管个人↔企业这一条边、企业→个人永远拒、`decideRealmAccess` 唯一判定、nonce 一次性、`resolveRealmSource` 让**内核自己进 Realm 取数并核对声明**、`/api/domains*` 运维面）；**P0 仅剩 E4.8**。**更正 §C**：v0.4 的"无一项能在库内继续闭环"被证伪两次，改为"仓库外执行类"vs"库内可做但需决策类"两类，并点名这是评审文档自身的失效模式。基线 436（v0.4）→ 532（v0.5/v0.6）→ **587 测试 / 66 文件**；真实进程冒烟在本批抓到一个"测试全绿但签发面实际不可用"的缺陷（要求调用方自带 nonce），登记 #17/#18 两条诚实尾巴。MVP 判定不变 |
| v0.8 | 2026-09-25 | **E9.1 / E9.2 上岗门收口 + 一条测试结构性缺口**：新组合层 `src/onboarding/` 用四道门（编制名册 / 在册未吊销执行 Agent / `decideRealmAccess` / E2.5 certified）决定上岗，**资格现算不缓存**，签字后吊销执行 Agent 或撤出名册会自动失效；三条严格化（出勤不算能力、空要求必须显式豁免并写理由、豁免与租户范围不得越界）；`composeBriefing` 从已有事实装配首日上下文并把**答不上来的写进 `gaps`**（`totalFacts` 与命中分开报、`canWrite` 只表域边界并单列 `writeNeedsGrant`、内容取稳定 digest）；`first-task` 过门后真走一次 `fanOut`，审计链加 4 个 `commission-*`，上岗记录进快照。**v0.7 的两类划分当场得到验证**：被列作"库内可做、等判断"的同一批里同日做完。**结构性缺口单记**：`fix(registry)` 修掉"卡片缺 `dataRealms` 等 oath 字段能注册、派发时才 TypeError"——它在 620 项全绿下活了四天，因为测注册的不派发、测派发的不调 `register()`，两半各自绿；自此对跨模块契约改动加一条口径：**只有 inject 测试不算已验证**。基线 **620 测试 / 68 文件**，四次缺陷植入全部被接住（2 / 3 / 2 / 4 例红）。MVP 判定不变 |
| v0.12 | 2026-09-25 | **独立复核 v0.10/v0.11 的 ✅（不采信记录，逐条亲手重跑）**。基线本轮实测：**690 测试 / 72 文件 / 0 失败**、typecheck+build exit 0、`origin/dev...HEAD` = `0  0`、HEAD `8ddcddc` 云端两 run（`36127445154`/`36127475079`）全绿。7/8 条在**编译产物真进程 + 真 socket + 自建 docker 容器**上复现：执行 Agent 实收 `Bearer sekrit-8f2c`、token 在 `/api/roster`·`/api/roster/public`·`/api/state` 三视图 0 命中、吊销后 auth 行数 `2 -> 2`、**去掉 seed env 重启仅靠状态文件仍带上同一 token**、Skill 三态闸门、MCP `tools/list`+`tools/call`（未授权 realm `-32002`、穿越 `-32003`/`-32602`）、镜像 369MB healthy 且 `/data` 两文件 0600 + SIGTERM 保存 + 重启 `restored … intents=1`。**E4.8 那一次对线上的验收记为"记录"不升格为本次证据**（本轮对线上执行被权限层拦）。**抓到一条新缺陷**：`POST /api/vassals` 遇**连接层不可达**返回 `400 invalid_request "fetch failed"`（丢 URL），而两处文档承诺 502——成因是 `registry.ts:65` 的 fetch 无 try/catch、`server.ts:249` 的正则只匹配 `!response.ok` 才抛的那条消息；且 grep 确认 **690 项测试里没有任何一支让 `fetchImpl` 抛异常**（测试世界的"不可达"其实是"可达但 5xx"）。**补登记两条此前无人接的结构性缺口**：deferred **#19** 入站 A2A 面（v0.9 判定过、清单里没有）、**#20** `ZEUS_JUDGE_THRESHOLD` 静默忽略与 boot 其余参数"非法拒启"口径不一致。**MVP 判定维持 ✅，性质变化：依据从"另一会话的记录"变成"本评审亲手复跑"** |
| v0.11 | 2026-09-25 | **E4.8 首次真机验收 PASS + docker 实构实跑 PASS**。零测试改动；脚本一行端点修正（RPC 面在 `/api/a2a/agent-card` 非 `/api/a2a/tasks`）。验收证据：卡片发现（5 技能）+ `tasks/send` 接受（input-required）+ exit 0；docker：build + keygen + run（healthy）+ `GET /api/state` 200。**顺带更正一条归因**：v0.5 起"本沙箱到不了那个域"被证伪——直连超时是没走本机系统代理（`127.0.0.1:7897` + `NODE_USE_ENV_PROXY=1`）。MVP 维持 ✅；剩余：loom 联调 / Jev key / RSK 托管 / #18（等 E3.4） |
| v0.10 | 2026-09-25 | **能力接入三原语执行点收口后重判 MVP：❌ → ✅（库内达成）**。基线 **690 测试 / 72 文件**、`tsc --noEmit` + build exit 0。§E 第 2-4 条逐条落地：① **执行 Agent 出站凭证**（`VassalEntry.token?`/`tokenFor`/`withoutToken` 四视图剥 token/seed `url\|token` 语法与拒错/boot 接线 Dispatcher/吊销断流/快照持久化，8 测试）；② **Skill 上派发路径**（`SkillGovernor.activeProviders` 三态：未注册 pass-through、无 active 拒绝不派发；`refused-skill-uninstalled`/`refused-no-active-provider` 审计进脊、realm 用真实域；注册 spec `providedBy` 收窄 auto 目标；显式 vassals 一等旁路，8 测试）；③ **MCP 补 tools + 客户端调用面**（服务端 `realm.search`/`realm.read` 只读工具、realmId 白名单=域边界、不泄绝对路径、initialize 广告 tools；客户端 `McpClient.callTool` + `ConnectorRegistry.callTool` 只调握手发现且经声明裁剪的工具 + `POST /api/connectors/:id/tools/:name/call`；realm-mcp 15 / mcp-connectors 11 / http-connectors 12）。**判定依据**：§E"1–5 做完"的三件事在库内同时成立——给目录即用、能带凭证协作真执行 Agent、Skill/MCP 治理有执行点且守卫可被触发。剩余均为仓库外执行（E4.8 真机验收、loom 联调、docker 实构实跑、Jev key、RSK 托管、#18 actor 判定待 E3.4） |
| v0.9 | 2026-09-25 | **重判 MVP：改问"操作者摸不摸得到"，于是阻塞性质被改判**。基线 **658 测试 / 70 文件**、typecheck/build exit 0、`npm audit --omit=dev` 0 漏洞（生产依赖仅 fastify）；src 80 文件 14 461 行、67 条 HTTP 路由。能力接入三原语逐条 grep + 真进程实测：① **MCP** 服务端**实测可跑**（手工 JSON-RPC 走通 `initialize`/`resources/list`/`resources/read`，越界 path 被拒、不吐绝对路径），但**只有 resources 没有 tools**、只支持 personal+readOnly（type 在 stdio 宿主里写死）、无鉴权；客户端侧 **`tools/call` 全库 0 命中** → 连接器是"声明+发现"，被边界裁剪的能力清单**无人读取**（`connectors.ts:80` 是唯一赋值点）；② **Skill 注册中心不在派发路径上**（`fanOut`→`findBySkill`→卡片自报技能，`resolveTeam` 唯一调用点是查询路由）→ **卸载不夺权**、`hardening` 只写不读、`providedBy` 逐字采信绕过认证；③ **A2A 无入站面、oath 未签名，且 `bootKernel` 构造 Dispatcher 从不传 `tokenFor`** → 真进程对任何执行 Agent 都不发 Authorization，**需要 bearer 的真执行 Agent 根本派发不出去**。**首跑实测另抓出 6 条**：C-1 按 `.env.example` 默认配置**每条派发分支的 reason 变成 `ENOENT .../audit.jsonl`**（A/B 对照证明：审计 sink 不建目录，且写盘失败被误归因为执行 Agent 失败；审计文件另为 0644 而状态文件 0600）、C-2 **我自己当天写进 deployment.md 的备份示例文件名是错的**（`kernel.json` vs 真实 `kernel-state.json`；另 §2 表少 10 行（代码读 24 个 ZEUS_*、表内只有 14 个，复测后定数）——子审计多算的一条经实测剔除）、C-3 `ZEUS_REALM_ROOTS` 两套互不兼容分隔符、C-4 `.env` 裸机不生效（无 dotenv）而示例注释让你照抄、C-5 域只能启动挂不能卸、C-6 realmId 操作员不可见。**判定：产品核心完全可用 MVP ❌**，且 v0.4 起那句"库内已无 P0 功能缺口、只剩仓库外动作"**第三次被证伪**——能力接入三原语里两条缺的是**库内执行点**。新立评审纪律一条：**凡 ✅ 句里含动词（阻止/只暴露/即刻断权/经授权），必须 grep 到该动词的读取方，否则判 ❌**。同时如实记已达到的部分：个人数据底座（给目录→检索→记忆→日记→备份与恢复协议含内核状态文件→签名且一次性企业写凭证→审计→重启恢复）三层证据齐备。§E 给出 6 步最小集（全部库内可做）。子审计中两条与我实测不符的结论（"MCP 产物不存在"、"serve.ts 挂了静态控制台"）未采信 |
| v0.13 | 2026-09-26 | **仅销项一条运维决定，不重跑判定**：deferred **#16** 关闭——CI 的 `runs-on` 由浮动标签 `ubuntu-latest` 钉为 **`ubuntu-24.04`**（原标签 2026-10-19 起自动指向 Ubuntu 26.04，会在无人批准的情况下换掉整台构建机）。改的是 `.github/workflows/ci.yml` 一行加注释，代码、测试与 Node 矩阵（#15）均未动，故**未重跑全量基线**。MVP 判定不变 |
| v0.14 | 2026-09-26 | **验证面本身变了（配置层，代码与用例零改动）**：deferred **#15** 销项，选 B——`engines.node: ">=22.0.0"` + `.npmrc` 的 `engine-strict=true` + `.nvmrc` 22 + CI 矩阵 `[20.x, 22.x]` → **`[22.x, 24.x]`**。因此**此后所有评审证据的运行时口径要改写**：v0.6 起的"Node 20.x / 22.x 双矩阵全绿"现在是 **22.x / 24.x**（v0.13 起 runner 亦钉 `ubuntu-24.04`）。证据强度未变（三档 704 绿与 22/24 真进程冒烟出自我上一批实测，本批未重跑），**变的是"我们声明支持什么"**——Node 20 自 2026-03-24 起零发布，不再被声明支持。MVP 判定不变；**22/24 双矩阵的云端首绿已发生**：推送后 run 36254582377 在 runner 标签 `ubuntu-24.04` 上 22.x / 24.x 双作业均 success，#16 钉的镜像同批生效（无迁移注解） |
| v0.15 | 2026-09-27 | **本机重跑复核（未复跑真机验收）**：全量 **736 测试 / 77 文件 / 0 失败**、`tsc --noEmit` 与 build exit 0；grep 复核三条接入通道执行点未回退（出站 `tokenFor` 接线 boot:353、Skill `activeProviders` 三态闸门 orchestrator:142、MCP `REALM_NOT_CONNECTED` 白名单 mcp:39/340、治理闭环与持久化/签名链执行点均在位）。本批新增 #9 背压分流启用代码（属增强，非核心 MVP 阻塞）。**判定维持 v0.12**：产品核心完全可用 MVP ✅（库内达成、执行点未回退）；可上线 MVP ❌（差真实环境执行动作——真实执行 Agent 注册与扇出验收 E4.8、deferred #7 R2 密钥托管/发布、Zeus↔loom 联调、Jev key 核对、#18 MCP actor、#19 入站 A2A、#17 运行时域挂卸）。本轮未复跑"对线上真机验收"（砂箱到不了真实执行 Agent 域，该证据维持 v0.12 的"记录"分级），未执行 docker build/run（v0.11 已 PASS） |
| v0.16 | 2026-09-27 | **项目级评审复核 + 上线前 Checklist 起草**。本轮用 grep 重新核验四条核心执行点无回退：`boot.ts:353` tokenFor 接线、`orchestrator.ts:142`+`:169`（`:169` 现亦喂 #9 分流候选集，未改拒派语义）、`mcp.ts:39/340` REALM_NOT_CONNECTED 白名单、`audit.ts:81-82` 审计目录自动创建 + 0600、`boot.ts:359`→`orchestrator.ts:240` 冲突升级闭环。功能性（库内）✅、完整度 M1/M2 ✅（含 #9 分流、E1.3 judge、S3 DAG、决策后端）、M3 制品 ✅/真机 ❌。**判定维持 v0.15**：产品核心完全可用 MVP ✅；可上线 MVP ❌。产出 [pre-launch-checklist.md](pre-launch-checklist.md) 按"是否阻塞上线"分 A（硬阻塞：真实执行 Agent 注册与扇出 E4.8 / RSK 托管发布 #7 / loom 联调 / Jev key）/B（部署运营就绪）/C（阈值标定，挂 ≥3 真 Agent 压测）/D（非阻塞决策 #18/#19/#5/#3/#4/#21）/E（发布动作，含本次 #9 提交需 push + 云端绿）/F（每次上线必跑验证门）六层。**本次 #9 三笔提交仍本地未 push** |
| v0.17 | 2026-09-27 | **重跑 v0.15/v0.16 的判定**（评审对象 HEAD `6f86369`；距 v0.12 的 `8ddcddc` 已 57 个 commit）：门禁实跑 **737 测试 / 77 文件 / 0 失败**、typecheck/build exit 0；P0 逐行机械计数 **26/26 ✅**，且"状态列 vs 正文"冲突检测器**先用三行样例做正负对照**（两行植入冲突各自 FLAG、干净行不误报）之后才敢报 0；签名链与离线验签改用**出货命令行**复跑四条对照——正向 VERIFIED／**同一份字节只 `--now` 过 maxAge 即被拒**／改载荷点名摘要／陌生钥点名签名，第二条是对"校验器恒真"的否证。**抓到并已修一条工具自身的缺陷**：`--quiet` 把深比对连同计算一起跳过，安静模式下真卡片 exit 1 且理由写成"该 agent 没有 attestation"（而它确实有），同一条输入去掉 `--quiet` 就 VERIFIED；若无"给了卡片却没被覆盖即拒"的兜底，改写过的 fealty 会在安静模式下 exit 0。**736 项测试没抓到它，因为 8 例里没有一例带 `--quiet`**——特性开关的组合面没穿过就等于没人验过（与"用例名叫 unreachable 而喂的是 500 状态"同族）。修复 `6f86369` 配双侧对照回归用例（安静+真卡片→0 且只剩判定行；安静+篡改卡片→1 且点名摘要不匹配），这两条断言在修复前不可能同时成立。另核到 **#23 的 DAG 已注入 HTTP 依赖**（`serve.ts:147`，真进程里不会 503）、**#9 的 `maxConcurrentPerVassal` 语义是改派而非每 Agent 并发硬上限**、**`envInteger` 第三参是下界不是默认值**（未设即不限并发，与 `.env.example` 一致）。改正五处文档自身腐烂：本文头部"现行 v0.12"、checklist §E1"本地领先未 push"（`git ls-remote` 实测 `0 0` 已同步）、checklist §F"736/77"、PRD 状态行累积 2018 字符且粗体标记不配对（已收短，历史只留 §7）、**handoff 变更记录第 564 行被重复贴上 deferred #17 的 989 字符正文造成幻列**（"每行管道数"这条机械口径才暴露得出）。**判定不变**：核心 MVP ✅（本轮未发现任何核心路径缺陷，唯一缺陷在验证工具自身且已修），可上线 ❌。**新增一条前置项并登记 deferred #25**：真进程端到端冒烟历史上每次都临时手写、跑完即弃，本轮再手写被权限层拦，说明"把验收动作变成仓库里可重跑的资产"是库内可做且该做的一步。**另加 §E2**：配置面双向机械对照跑出一条真实缺口——`ZEUS_MAX_CONCURRENT_PER_VASSAL` 被 `boot.ts:593` 读、是 #9 分流唯一操作入口，却两处文档面都没有（25 读点、缺 1、**反向 0** 作为口径自证），本轮补进 `.env.example` 与 deployment §2 并澄清三条易误读语义，对照本身登记 deferred **#26** |
