# Deferred Items

缓做/低优事项登记表。每条挂起项必须带**触发条件**；触发条件满足后移回 `handoff.md` Active work 并标注重启日期。

> **编号只增不复用**：已销项的条目保留原文与编号（标 ✅ 已销项），新条目一律用下一个未用过的号。这条规则是补出来的教训——`#15` 被登记过**两次**（一次"DAG 操作者入口"、一次"支持矩阵与 engines 声明"），前者被后者静默覆盖，直到 2026-09-26 做一次"能力 vs 可操作面"对账时才被发现，见 **#23**。一份登记表如果能让条目无声消失，它就不是登记簿。

## 架构决策待定（非缓做，但需先决定）

（#1 执行 Agent 协议形态已决定：A2A 超集，2026-09-21，见 [design-vassal-protocol.md](design-vassal-protocol.md)——已销项）

### #41 企业形态：隔离实例 vs 同实例多租户
- 议题：一家公司用 zeus 时，是**每个客户（或每个团队）一套进程**（隔离实例），还是**一套进程内跑多个租户**（同实例多租户）。这条决定会决定认证面、状态文件形状、备份清单粒度和运维模型，所以必须显式记，不能靠"以后再说"默认成某一边。
- **现状（代码级，2026-10-05 测）**：租户**模型**已在库内——三级范围（org/部门/成员）与跨域一次性授权判定见 `src/realm/authorization.ts:74-74 #decideRealmAccess`（#6 销项时落地）。但进程**只有一套身份**：H2 全操作面的挂载条件是单个 `ZEUS_INTERNAL_TOKEN`（注入 `src/http/serve.ts:191-191 #internalToken`，比较 `src/http/server.ts:313-313 #internalToken`），一份状态文件、一份审计文件。实测该面共 **78 条路由**，其中 3 条公开、**75 条共用同一个 bearer**。也就是：今天的实际隔离档位就是"一实例一租户"，租户范围只在**数据域内**收窄可见性，不区分"哪个客户在调这个进程"。
- **A 隔离实例（当前倾向）**：
  - 代价：部署数量随客户数线性增长（每客户一套密钥、状态卷、备份计划、`ZEUS_*` 配置）；没有跨客户统一盘点/升级看板；版本要滚动 N 次；客户数上去之后运维是主要成本。
  - 收益：设计约束 4（个人域与企业域不互通）由**进程边界**保证，而不是由一段判定代码保证——判定代码出 bug 也越不过去；跨租户串数据这类事故的最坏情况被限制在单个进程内；一个客户的正文、名册、审计不会落在另一个客户的卷上；现有配置面**零改动**。
  - 附带收益："自带 Agent 进公司"这条差异化主张在 A 下不需要额外解释——用户那套实例本来就没接企业域。
- **B 同实例多租户**：
  - 代价：**认证面先重做**（单一 bearer 变成 per-tenant principal，H1/H2/H3 三张面都要按主体裁剪），78 条路由逐条决定租户可见性；状态快照、审计 JSONL、备份清单都要按租户分片并证明跨片不可读；`GET /api/audit`、`/api/domains`、`/api/roster` 这类"全量视图"端点全部要加范围。风险形状变了：**一次判定 bug 就是跨客户事故**，而这正是约束 4 明确禁止的失败模式。
  - 收益：单套部署、集中运维；跨租户计量与 #4 计费模型直接可得。
- **触发条件**：出现第一个明确要求共享一套部署的企业用户，且其合规允许"同一进程内可被观察到其他租户存在"；或每实例运维成本成为签约障碍（上线周期被部署次数而不是功能卡住）。触发前不动路由面。
- **翻转条件（改判的信号）**：若 #18（MCP 暴露侧 actor 判定）在 A 形态下也无法廉价收口，说明"主体"这件事迟早要在内核里做，那就不如一次做完 B；反之若真实企业需求都只要求"部门级隔离 + 各自目录"，A 加一层实例编排即可，B 的全部代价都是白付。
- **联动**：#18 与 #17（数据域边界的显式变更操作）在本条两种形态下的工作量不同；#4 只在 B 或"多实例计量层"立项时才有意义；`watch`/委托契约两个原语的形状**与本条无关**（见 [design-self-host-loop.md](design-self-host-loop.md)），所以 [verify-self-host-pilot.md](verify-self-host-pilot.md) 的 P0 不等本条。

### #42 决策记录的保留默认值（审计 B-44 剩下的那一半）
- 议题：内核长跑之后仍在线性增长的，只剩**用户自己的决策记录**——意图结果与原始请求（实测字节占比 **75% / 25%**，合计 ≈2,074B/条）、监督台里已裁决的条目、memory 事件。派生观测面（分支历史）已经在 2026-10-06 封顶并挪到读路径（见 [audit-2026-09.md](audit-2026-09.md) §13.4），这些没有。
- **为什么不"顺手封顶"**：删掉一条已存意图会同时删掉三样承诺——① `intentId` 幂等重放（重提交将**重新派发**而不是返回旧结果；对 execute 意图等于把一次外部写再做一遍）；② `GET /api/intents/:id/replay` 的可追溯性（"可复核"是产品承诺，不是缓存命中）；③ 已裁决升级项所指向的意图（approve-resume 依赖 `findIntentForBranchRun` 在存留集合里找）。这些是用户数据与承诺，不是可丢弃的中间结果。
- **三条候选与代价**：
  - **A 不删（现状）**：代价=无限增长；外推数字只当算术看，不当实测（3,000 条 ≈ 6.2MB 状态文件 + ≈180MiB RSS，且状态文件每次退出全量重写、每次启动全量解析）。
  - **B 按条数或时间封顶**（保留被 open 升级项引用与"曾被人裁决"的条目）：代价=幂等承诺从"永久"降级为"窗口内"，必须在 PRD、README 与审计措辞上一起改口，否则文档在承诺一个实现不再兑现的东西。
  - **C 出窗归档而非删除**（把出窗意图写进只读归档，状态文件不再携带，replay 从归档读）：代价=要新增归档读取面并把归档纳入备份清单，工程量最大，但**唯一不改承诺**的一条。
- **当前倾向**：**C**。理由=设计约束 1（数据主权在用户）与"可追溯、可复核"是产品支柱；B 只作为用户显式开启的省空间开关存在，A 作为默认直到出现真实规模证据。
- **触发条件**：出现第一个连续运行 ≥2 周且有真实使用的实例（自托管试点 P0 之后即满足），或实测到状态文件 > 50MB / 重启恢复 > 2s / `GET /api/intents/:id` 因集合膨胀而变慢。
- **翻转条件**：若试点用户明确表示"旧决策不需要留、机器空间优先"，则 B 升为默认，并按 B 的代价条目同步改口三处文档。
- **联动**：#13（内核状态已在备份清单覆盖内，删记录等于缩小可恢复面）、**#40**（执行后反思闭环要读历史决策，删掉就没有训练数据）、#41（隔离实例形态下每个实例的历史独立，封顶策略可按实例不同；同实例多租户下"谁的历史留多久"会变成租户属性）。
- **2026-10-07 设计稿已出（Active work 143），实现仍待触发条件**：[design-intent-retention.md](design-intent-retention.md) 落定方案 C 全文——append-only JSONL 至 `<stateDir>/intent-archive.jsonl`，出窗窗口=条数 1,000 与 30 天双条件先到先出，**被 open 升级项引用或曾被裁决的条目不出窗**；读取面=决策回放 / 幂等重放 / `findIntentForBranchRun` 查状态文件未中查归档；归档纳入备份清单与 #13 原子保存批次；B 开关仅用户显式省空间时启用且 PRD/README/审计三处文档同步改口幂等承诺；§6 给验收口径（含缺陷植入对照）。触发条件未到（连续运行 ≥2 周真实实例或状态文件 >50MB / 恢复 >2s / 读变慢），本批只落稿不落码。

## 缓做项

### #43 分支超时用例的墙钟余量
- 议题：`tests/orchestrator.test.ts:168` 「records a timed-out branch as failed without losing the others」用真实计时器判超时——慢分支 `delay(40)`、`branchTimeoutMs: 8`，余量 32ms。本机负载起来后事件循环被别的 worker 占满，deadline 回调晚于 40ms 才跑，分支先落地并返回 ok，`timedOut` 变成 undefined，用例红。**不是逻辑缺陷**：同一文件相邻那条（`:181` "disarms the branch deadline"）已经用 `vi.useFakeTimers()` 把时钟做成确定的。
- **为什么不顺手改**：改法是把这条也换成假时钟（或注入 `now`），属于测试仪器改造，与本批的产品缺口无关；且它一年只红在"本机同时跑两个全量"这种场景，CI 单机顺序跑未见红。
- **触发条件**：CI 或任何一次全量里这条真的红了一次以上（不是本次这种并行负载下的偶发），或下一次有人动 `Orchestrator` 的超时/取消路径（那时它必须做成确定的才能守住改动）。
- **代价**：红的时候像回归，每次都要人重跑一遍才能排除——这正是 2026-10-08 那次三次全量里命中一次的读数来源（当日记录见 handoff Active work 148）。

### #2 备份清单加密与托管方案 ✅ 已销项（2026-09-23）
- 原议题：纯本地密钥 vs 可恢复托管的取舍；密钥丢失 = 数据永久丢失。
- **触发条件**：Realm 数据层与备份机制进入实施阶段。
- **销项结论**：触发条件已满足（Vault E8.1/E8.2 + E3.7 已落地）；方案在 [design-vault.md](design-vault.md) v0.1 §9 决定为**纯本地、密钥分离**（AES-256-GCM，scrypt 口令或 raw key，信封不含密钥），**KMS 托管/自动云备份明确列为非目标**；CLI（`src/vault/cli.ts`）只提供用户/外部脚本触发的 build/check/backup/restore。密钥丢失无后门是显式接受的产品语义。传承场景（dead-man's switch、法律框架）仍归 #3，不随本条销项。

### #3 传承（Inheritance）
- 继承协议、密钥托管（dead-man's switch）、法律框架。
- **触发条件**：备份清单备份的情感闭环得到验证；产品进入 P3。

### #4 企业版计费模型
- 按「部门/编制」还是按席位计费。
- **触发条件**：企业 Realm 多租户进入实施，且有首批意向企业用户。
- **进展（2026-09-25）**：前半条**已经满足**——E3.6 三级租户（org/部门/成员）与 E6.4 授权粒度已在库内落地，"按部门计量"所需的边界与可审计授权记录现在都存在（`GET /api/domains` 给出台账，`/api/audit?decision=domain-*` 给出穿越记录）。后半条（首批意向企业用户）未到，故本条仍缓做；届时不必再从模型层起步。

### #5 外部 Agent 信任分级与沙箱
- 第三方 Agent 接入的信任分级、权限沙箱边界。
- **触发条件**：A2A 协作层需要接入第一个本矩阵之外的外部 Agent。

### #6 个人/企业双数据域授权粒度 ✅ 已销项（2026-09-25）
- 原议题：同一员工同时持有两个 Realm 时的数据二极管授权界面与审计呈现。
- **触发条件回顾**：写的是"首个双重身份用户出现"。2026-09-25 决定**不等用户先到就把机制做出来**，理由是反向的代价更高：没有授权面时，个人域与企业域的边界只能靠"调用方自己声明 realm 类型"，而内核从没进过任何 Realm，所以那句声明**永远无法被核对**——一个不可核对的边界就是一道装饰性的边界。
- **销项结论**：`src/realm/authorization.ts`（`DomainGrant` + `decideRealmAccess` 单一判定 + `DomainGrantRegistry` 的 nonce 一次性与快照持久化）、`src/realm/source.ts`（内核代取内容并核对声明、放行/拒绝同一审计流审计）、操作者面 `/api/domains*` 与 `GET /api/audit?decision=domain-*`，设计见 design-realm §7。**个人域→企业域**已可显式授权并留痕，**企业域→个人域**在类型层面就没有可表达的凭证。
- **仍不在本条范围内**（不因销项而消失）：MCP 暴露侧的 actor 判定 → **#18**；改租户边界的显式操作 → **#17**。

### #7 fealty 签名链
- Agent Card / fealty 的发布与吊销是否需要签名链，防止伪造名册条目。
- **触发条件**：bayjf 名册对外公开前。
- **进展（2026-09-24 更新）**：设计定稿 v0.1，见 [design-fealty-signing.md](design-fealty-signing.md)（v1 Zeus 单签：Ed25519 + RFC 8785，条目 attestation + 快照 seal，TTL 硬过期；v2 执行 Agent 自签交叉背书）。**v1 纯函数已库内实现**（`src/registry/signing.ts`，`tests/signing.test.ts` 24 项：覆盖设计稿 §8.1 八条验收 + 签名链 v1.1 两态封签 5 项）。**R1 已完整接线**：H1 `GET /api/roster/public` 与 bearer `GET /api/roster`（internal，含 revoked 行）均实时投影并 sealSnapshot 封签、离线可验——签名链 **v1.1（2026-09-24）** 把 attestation 扩为 `active|revoked` 两态，revoked attestation 证永久吊销事实、不带硬过期（快照新鲜度仍由 seal maxAge 绑定），验签要求状态与条目精确匹配（防提升/掩盖）、缺 source 或状态矛盾 fail-loud（public 封签 commit 3190a11）；**生产密钥已硬化**：`src/http/rsk.ts` 支持内联/文件注入，production 无密钥拒启（commit 4d99f43），生成脚本 `scripts/gen-rsk-key.mjs`。本条**仍未销项**：只剩 **R2（bayjf 构建期客户端公钥验签展示）+ 生产 RSK 托管/轮换与公钥发布的部署动作**，触发条件「bayjf 名册对外公开前」未到点。
- **进展（2026-09-27）**：**「公钥发布」的库内侧已闭合**——`GET /api/roster/keys`（公开面，JWKS 形状 + `spkiPem` + RFC 7638 指纹 + SPKI DER 摘要；导不出公钥的后端返回 501 而非空数组）+ 契约与"它不是信任锚"记入 design-fealty-signing v0.2 §5.1、§9-3 销项；**人工轮换与托管运行手册**写进 §5.4（含"为什么库里不做自动轮换"：自动换钥留下的窗口在验签方一侧与名册被替换不可区分）。冒烟加 3 步把"发布的钥就是签名那把"钉成断言（含指纹独立复算）。本条**仍未销项**：只剩 **R2（bayjf 构建期客户端公钥验签展示）+ 托管选型决策与带外公告这个真实动作**，触发条件「bayjf 名册对外公开前」未到点。**原本要用户决策的一件事已决策（2026-09-27）**：私钥落在哪儿——选定 **容器 / systemd 的 secret 挂载 + 私钥文件 0600**（三档比较见 §5.4 表，落地口径写进 deployment.md §3「本项目选型」；企业 KMS/HSM 的触发条件是出现受治理的第二信任方）。故本条剩下的**全部是仓库外动作**：真实部署的 secret 后端落钥、`jwkThumbprint` 带外公告、bayjf 侧验签展示。
- **进展（2026-09-27，第二批）**：**"要带外固定的那串"现在三个触点都能看见**——出钥时 `gen-rsk-key.mjs` 打印 `jwkThumbprint`/`spkiSha256`，发布时端点给同一函数算出的值，验签时 `verify-roster` 报告显示本次实际接受那把钥的指纹；冒烟第 33 步断言三处逐字符同串（单变量反证：让 keygen 少打印即 FAIL，其余 32 步不受影响）。**这使 §5.4 步骤 1（拿到要公告的值）与步骤 6（验签方完成比对）第一次不必自己算哈希**，并顺带补上此前在全库**零测试覆盖**的 keygen 脚本（4 例，含 0600 与拒绝覆盖）。剩余项＝公告动作与 R2 展示（**托管选型决策已于 2026-09-27 完成，见上一条**）。

### #8 结果回传成本口径
- `x-zeus-report.cost` 的单位与结算口径，跨执行 Agent 可比性。
- **触发条件**：企业版计费立项时（联动 #4）。

### #9 执行 Agent 背压降级顺序
- 执行 Agent 饱和时 Zeus 任务队列向其他执行 Agent/队列分流的降级顺序。
- **进展（2026-09-25）**：**闸门本身已落地**——`Orchestrator` 的 `maxConcurrentBranches` + `branchQueueLimit`（进程内在途分支上界、FIFO 等待、满则拒绝并把原因记进分支结果），见 handoff Active work 39 与 tests/orchestrator-backpressure.test.ts；`GET /api/metrics` 的 `queueDepth` 从此是真实值。**本条仍未销项**：剩下的问题是"该把溢出分流给谁"——拒绝顺序 / 按可靠度或延迟重排候选 / 有界排队 vs 立即降级的策略选择，需要真实执行 Agent 的行为数据才能定，凭空拍一个顺序没有依据。
- **策略已制定（2026-09-27，设计稿 v0.1）**：分流机制与信号已落到 [design-backpressure.md](design-backpressure.md)——① 饱和信号 = per-vassal 实时在途计数（当前 `ConcurrencyMetrics` 只有全局 `inFlight`/`queueDepth`，缺该 primitive，策略已点名启用改动）；② 同技能候选集 = `activeProviders(skill)` 过滤 active/healthy/非饱和；③ 候选重排 = 可靠度 `(1-failureRate)` × 延迟 `p50Ms` 加权评分降序（数据来自 `perVassal` 历史，纯函数可单测）；④ 显式 `request.vassals` 硬钉不分流，自动选靶可分流、无候选回退既有排队→拒绝且拒绝原因带 tried 状态审计。复用现有 `ConcurrencyMetrics.perVassal` 与 `SkillGovernor.activeProviders` 三态，不引入跨实例协调。**仍未销项**：启用代码（`PerVassalLoad` + `selectTargets` 纯函数 + 选靶处接线）与阈值调参（`cap(v)`/`queueLimit`/评分权重 `w_r,w_l`/`LATENCY_NORMALIZER`）仍挂原触发条件——需 ≥3 真实 Agent 压测才能定数，凭空拍阈值无依据。
- **触发条件**：≥3 个执行 Agent 在线压测（同一台机器上的 mock 不算：mock 的延迟分布与失败模式是编的，只会把一个猜测变成锁定的猜测）。
- **启用代码已落地（2026-09-27，设计稿 v0.2）**：`PerVassalLoad`（`ConcurrencyMetrics.inFlightByVassal` + 访问器）与 `selectTargets` 纯函数（`src/orchestrator/diversion.ts`）已接入编排器选靶路径；`maxConcurrentPerVassal` 独立可配（关键修正：必须低于全局 `maxConcurrentBranches` 否则分流永不触发），`branch-diverted` 事件入审计链，全局拒绝原因带 tried 候选审计；7 例单测全绿。机制可闭环，**仅阈值（`w_r`/`w_l`/`LATENCY_NORMALIZER`/`cap(v)`）调参仍挂上述触发条件**——不凭空拍数。

### #10 Realm 检索后端升级（倒排 / 向量）
- P0 检索为纯文件系统扫描（design-realm.md §6.2），后端接口可替换；倒排索引或向量检索的立项条件。
- **触发条件**：单 Realm 文件数 > 2 万，或 P50 检索 > 500ms，或语义检索成为明确需求（且本地 embedding 可行、数据不出域）。

### #11 测试超时根治（全局 testTimeout / 低并发池） ✅ 已销项（2026-09-25）
- 原议题：仓库无 vitest 配置文件，所有用例吃 5s 默认超时；scrypt 全量打包、RSA-2048 keygen 这类 CPU 密集用例在并行 fork 争抢下会飘红（成因见 handoff Active work 38）。
- **销项结论**：新增 `vitest.config.ts` 设全局 `testTimeout` / `hookTimeout` = 20s，并删掉三处逐套件 20s 补丁。根治过程中发现放宽救不了那一例：RSA-2048 同步 keygen 在满载下冲破 20s，改为生成 EC 密钥（同样证明"不是 Ed25519"，成本约 1ms），见 commit `db98a3b`。

### #12 CI action 版本升级（Node 20 弃用注解） ✅ 已销项（2026-09-25）
- 原议题：首次真机 CI（run 36024156638）注解提示 `actions/checkout@v4` / `actions/setup-node@v4` 仍 target Node 20、被强制跑在 Node 24；另有 `ubuntu-latest` 将于 2026-10-19 迁 Ubuntu 26。
- **销项结论**：两者升到当前 major `@v7`（查过 release notes：setup-node v5/v6 的破坏性变更集中在自动缓存与非 npm 管理器，本仓库显式 `cache: npm`；checkout v7 只阻断 `pull_request_target`/`workflow_run` 的 fork 检出，本 workflow 用 push/pull_request）。**测试矩阵保持 20.x/22.x**：本机开发 shell 实测是 Node 20.20.2，此时删掉 20 会砍掉唯一与本地一致的覆盖；矩阵该不该换成 22/24、要不要声明 `engines`，留作下面 #15 的立项问题。

### #15 支持矩阵与 engines 声明 ✅ 已销项（2026-09-26，选 B）
- **决定（选项 B：声明与生产对齐）**：`package.json` 写 `"engines": { "node": ">=22.0.0" }`；新增 **`.npmrc`**（`engine-strict=true`，带注释说明"不加这条时 engines 只是警告"）让声明可执行；新增 **`.nvmrc`**（`22`）让"该用哪个版本"机器可读；CI 矩阵由 `[20.x, 22.x]` 换为 **`[22.x, 24.x]`**；Docker 保持 `node:22-slim`（与 22 档同线）。**代价已接受**：本机 shell 仍在 **20.20.2**，此后 `npm ci` / `npm install` 会以 **EBADENGINE 硬失败**（实测），切到 22 即恢复（`fnm use 22`，本机已装 22.23.1）；已装依赖下 `npm run` 不受影响（Node 20 上 `npm run typecheck` 仍 exit 0，实测）。Node 20 不再被声明支持——它自 **2026-03-24** 起不再有任何发布。
- **改后验证**：`npm ci --dry-run` 在 **Node 20 上 EBADENGINE 硬失败**、在 **22.23.1 与 24.20.0 上无任何 engine 报错**（即 `engine-strict` 下传递依赖也全部兼容）；YAML 解析得 `runs-on=ubuntu-24.04`、`matrix=["22.x","24.x"]`；三档 704 绿与 22/24 真进程冒烟见下面的"进展"（决策依据，非本批重跑）。
- **不在本条内**：v26 何时进矩阵（当前线 `lts:false`，等进 LTS 再考虑替换 22）；runner 镜像归 #16（同日已销项）。
- **原缺口（销项前）**：CI 测 20.x/22.x，但 Node 20 上游已 EOL（2026-04），仓库 `package.json` **没有 `engines`**，Dockerfile 跑 node:22-slim，本机 dev 在 20.20.2——四处不一致，且没有任何地方写明"这个库支持哪些 Node"。
- **触发条件（回顾）**：写的是"决定结束对 Node 20 的验证时（例如本地 shell 升到 22+）"。**本批是不等触发条件就做的**：本地 shell 仍是 20.20.2，但拿到的实测（下面"进展"）把"该不该继续声明支持 20"变成了一个有数据的问题——一个自 2026-03-24 起不再有任何发布的运行时，继续在 CI 里给它发通行证是在凭空承担安全口径。
- **进展（2026-09-26 实测，本批决策依据）**：
  - **现状四处不一致（逐个实测）**：本机 shell `node -v` = **20.20.2**；CI 矩阵 **20.x / 22.x**；Dockerfile **node:22-slim**；`package.json` **无 `engines`**，且无 `.nvmrc` / `.npmrc`（即"该用哪个版本"机器不可读）。
  - **上游（实测 `nodejs.org/dist/index.json`）**：**v20 最后一次发布是 v20.20.2 / 2026-03-24**，其后半年零发布（与上面记的 2026-04 EOL 一致）；v22 最新 **v22.23.3（2026-09-23）**、v24 最新 **v24.21.0（2026-09-07）**，两条线仍在发；**v26 已在发**（v26.10.0 / 2026-09-21，`lts: false`＝当前线，未进 LTS）。
  - **依赖面（实测 `node_modules` 各包 `engines`）**：fastify 5.12.5 **没有** engines 字段（npm 不会替我们拦任何东西）；vitest 3.2.7 `^18.0.0 || ^20.0.0 || >=22.0.0`；typescript 5.9.3 `>=14.17`；`@types/node` 22.20.4（**类型基线实际是 22**，与矩阵里的 20 不一致）。
  - **三档实测（本机 fnm，按 CI 顺序 typecheck → build → test）**：**20.20.2 / 22.23.1 / 24.20.0 三档全部 704 passed / 73 文件，typecheck 与 build exit 0**；另在 **22 与 24 上各跑一次真进程冒烟**（`dist/http/serve.js` 起服务，`/healthz` 200、`GET /api/state` 200）。结论：**"代码不支持 24"这个担心不存在**——本条是纯粹的"我们声明什么、测什么"，不是兼容性工程。
  - **下限不是随手挑的**：`docs/deployment.md` 给裸机用户的 `node --env-file=` 需要 **≥20.6**，所以任何写法的下限都不该低于 20.6。
  - **`engines` 默认只是装饰（本条最该拍的一道）**：实测把 `engines.node` 写成 `>=22.0.0` 后在 Node 20 上 `npm ci --dry-run` 只给 **warn EBADENGINE 且 exit 0**；加上 `.npmrc` 的 `engine-strict=true` 后同一命令**硬失败 EBADENGINE**（Node 22 上无 engine 报错）。与"只写不读的清单"同一种失效，按设计约束第 2 条（每个概念必须可执行）必须连带决定。
  - **三个选项（代价已标明）**：
    - **A 只声明、不换挡**：矩阵仍 20.x/22.x，`engines.node: ">=20.6.0"`（+ 可选 `engine-strict`）。代价：声明支持一个已停止发布的运行时，安全口径由我们自己承担。
    - **B 声明与生产对齐（推荐）**：`engines.node: ">=22.0.0"`，矩阵换 **22.x / 24.x**（与 Docker 的 22 同线、并 coverage 到 24），`.nvmrc` 写 22 让"该用哪个版本"机器可读，`engine-strict=true` 让声明可执行。代价：**本机 shell 现在是 20.20.2，需切成 22**（fnm 已装 22.23.1；不切则 `npm ci` 直接失败——这正是它可执行的证据）。
    - **C 全覆盖**：矩阵 **20.x / 22.x / 24.x**，`engines.node: ">=20.6.0"`。代价：CI job 由 2 变 3（时间约 ×1.5），且继续给已停止发布的 20 发通行证。
  - **不在本条内**：v26 何时进矩阵——等它进 LTS 再考虑替换 22，现在不加（当前线 `lts: false`）。runner 镜像归 **#16**（已于同日销项，钉 `ubuntu-24.04`），两条互不重叠。

### #13 内核状态文件纳入备份清单（非 Realm 条目源）✅ 已销项（2026-09-25）
- **原缺口**：`ZEUS_STATE_FILE` 里现在有执行 Agent 名册（含已吊销）、记忆事实+provenance、部门编制、Skill 目录与加固、带教台账、MCP 连接器声明（**含上游 bearer token**）。备份清单却盖不到它：唯一条目源是 `inventoryFromRealm`。**"备份是第一公民"当时只覆盖 Realm 目录**，用户最容易丢的恰恰是这份。
- **触发条件回顾**：写的是①真实丢失事故/灾备演练要求 ②E8.4 传承立项 ③下次 `VAULT_VERSION` 升版顺手并入。2026-09-25 决定**不等触发条件**：这一条是"设计哲学第 1 条尚未执行"的登记，而不是一个可选增强；且当年列出的三个阻塞点在 E3.6/E6.4 之后已经各自有了落点（`MapSource` 需要 `tenant`，而 `tenant` 已经是 Realm 的一等事实）。
- **销项结论**（设计见 [design-vault.md](design-vault.md) v0.2）：
  1. `TreasureMap.source: MapSource`（`{kind:'realm',…,tenant?}` | `{kind:'files',label,root,files[]}`），`VAULT_VERSION` 1→2，**v1 图读入归一化、写出不兼容**；
  2. L0 的现盘视图从 `RealmStore` 解耦成 `LiveSource` 端口（`realmLiveSource` / `fileLiveSource` / `liveSourceFor`），这是"盖非 Realm 源"的前置；
  3. `inventoryFromFiles`：**显式白名单，绝不目录遍历**，七类硬拒（缺失 / 绝对路径 / `..` 逃逸 / 非普通文件 / 软链 / 二进制 / 超过 64 MiB）；
  4. CLI `build|backup --files-root <dir> --files a.json,b.json`、Realm 侧 `--tenant`；`check|restore` 不再接受挂载参数——图自己声明源与 scope。
- **顺带修掉两个真实缺陷**（都不是"接线"能发现的）：
  - **误报**：带租户 scope 的企业 Realm，图里丢掉 `tenant`、校验时又无 scope 重连，被 catch-all 吞成 `root unreachable`——唯一的"数据还在吗"工具对健康语料库喊狼来了。现在 scope 随图走，且报告必带 `unreachableReason`。
  - **containment 用错了 root**：白名单包含性判定拿"未解析的 root"比"已 realpath 的文件"，在 macOS（`/var → /private/var`）上会拒绝**每一个**白名单文件；实测由 `tests/vault-files.test.ts` 先红后绿。
- **验收**：`kernel.json` 毁库演练走真 CLI（`backup`→`check` 0→删除→`check` 2→`restore`→字节级 sha256 相同→用恢复出的文件 `bootKernel` 且 `restoredFromSnapshot: true`），另有 `dist/vault/cli.js` 真实进程冒烟逐条核对退出码。测试 `tests/vault-files.test.ts` 12 项。
- **不因本条销项而消失**：二进制备份、目录通配、内置默认名单——仍是非目标（design-vault §9）；**E8.4 传承**（#3）仍需要"图 + 密钥分渠道交接"的法律与叙事层，本条只给了它可交付的物证。

### #14 驱动凭证的签发与校验时钟 ✅ 已销项（2026-09-25）
- **原缺口**：E3.5 的 `DriverWriteGrant` 只有**校验**端（形状/绑定域/有效期），没有任何签发路径，也没有签名——`verifyDriverWriteGrant` 信的是"拿到的 JSON 就是操作者给的"。且 `FsRealmStore.write` 内部用 `new Date()` 判过期，端口层没有注入时钟，测试里"仍然有效"的凭证只能写成 `expiresAt: '2099-…'`。
- **触发条件回顾**：写的是"MCP `tools/write` 暴露立项时一并定"。2026-09-25 决定提前做，理由与 #13 同类：一个**任何能摸到 `write()` 的代码都能自己伪造**的授权检查不是授权检查；等 MCP 暴露时才补，等于先把门装歪再拆。
- **销项结论**（设计见 [design-realm.md](design-realm.md) §7.7）：`issueDriverWriteGrant`（内核铸 nonce、盖时间戳、用 RSK 的 Ed25519 签 JCS，复用 `registry/signing.ts`）、`verifyDriverWriteGrant` 改 async 并按 形状→realm 绑定→验签→有效期 判定（`unsigned`/`unknown-key`/`bad-signature`/`no-expiry`）、`DriverGrantLedger` 在落盘前消费 nonce 且随内核快照持久化（`writeGrantNonces`）、`FsRealmStoreOptions.now` 注入时钟。操作者面 `POST /api/realm/write-grants`、日记写凭证透传（缺授权 403）、审计事件流 `driver-grant-issued`/`realm-write`、`GET /api/state` 报 `driverGrants.authority`。
- **不因本条销项而消失**：**MCP `tools/write` 暴露仍未做**（E3.4/E3.5 剩余半边），其 actor 判定归 **#18**；单 owner 部署下签发方=验签方，因此这条链目前证明的是"凭证出自签发路径"，不是"第三方操作者签的字"（外部操作者只需把公钥加进 `acceptedKeyIds`，判定与账本都不用动）。

### #16 CI runner 镜像钉版 ✅ 已销项（2026-09-26）
- **决定**：钉 `ubuntu-24.04`，不接受自动迁移。`.github/workflows/ci.yml:12` 的 `runs-on` 由浮动标签 `ubuntu-latest` 改为 `ubuntu-24.04`，并在同一处写下为什么要钉（2026-10-19 起该标签指向 Ubuntu 26.04，actions/runner-images#14748）。**代价已记账**：此后升镜像是手动动作，注释里写明"要有意地换、换完复验"。Node 矩阵（20.x/22.x）**不在本条范围内**，仍归 #15。
- **事实（销项前）**：`.github/workflows/ci.yml` 的 `runs-on` 是浮动标签 `ubuntu-latest`。2026-09-25 的每一次 run（36024156638 / 36045209815 / 36061395015）都带同一条注解：该标签将于 **2026-10-19** 起指向 Ubuntu 26.04（actions/runner-images#14748）。迁移不需要我们改任何代码，但它会**在没人批准的情况下换掉整台构建机**——系统库、预装 Node、npm 与工具链版本一起变。
- **为什么单列（不并进 #12）**：#12 管的是"action 自己跑在哪个 Node 运行时上"，已随 `@v7` 升级销项；runner 的 **OS 层**从来没人决定过。本项目刚拿到连续三次云端 CI 结论，此时最大的非代码回归面就是这条浮动标签。
- **触发条件**：① 2026-10-19 之前做一次决定——钉 `ubuntu-24.04`（换确定性，代价是要记得升），或接受迁移并在切换后立刻复验一次全绿；② 任何一次 run 出现与本仓库代码无关的环境类失败（apt/预装工具/Node 解析）。
- **与 #15 的边界**：#15 决定"测哪些 Node"，本条决定"在谁的机器上测"。

### #17 数据域边界的显式变更操作（disconnect / 改租户）✅ 已销项（2026-09-26）
- **原缺口**：`FsRealmStore` 只有 `connect`，没有 `disconnect`；同一 root 带不同 tenant 重连会被拒（`would change its tenant scope`）。效果：调整企业域租户级没有可执行路径——只能改 env 重启，而重启时快照里存的仍是旧 tenant，照样撞漂移检查；唯一"办法"是手改 `kernel.json` 或删状态文件。
- **做了什么**：在 `RealmStore` 接口与 `FsRealmStore` 上新增两个显式操作（未走 `connect`，故不会触发那条漂移拒绝）：
  - `disconnect(realmId)`：从 `realms`/`roots` 内存表移除该挂载；`connections()` 随即不再列出它，下一轮快照即不再持久化。未知 realm 抛 `RealmNotConnectedError`（fail-loud，不是静默 no-op）。
  - `retargetTenant(realmId, from, to)`：仅企业域可调用（个人域无租户概念，直接 `RealmError`）；**比较交换**——`from` 必须与当前挂载租户一致（大小写不敏感），否则以 `tenant drift ... (compare-swap)` 拒绝并中止，绝不静默移动边界；通过后更新内存 `manifest.tenant`，持久化随下次快照落盘。
- **操作员面**：`POST /api/realms/:id/disconnect` 与 `POST /api/realms/:id/retarget-tenant`（body `{from,to}`），均走 `requireBearer`；未知 realm 404、漂移 409、个人域 400、缺参 400；两条动作各写一条 `realm-disconnected` / `realm-tenant-retargeted` 审计（`AuditDecision` 已扩）。
- **与启动漂移检查的关系（重要）**：`retargetTenant` 改的是运行态内存。若操作员**不随之更新 `ZEUS_REALM_ENTERPRISE`**，下次启动 boot 会用 env 里的旧 tenant 重连同一 root，与快照里的新 tenant 撞上那条漂移拒绝 → **启动失败（fail-loud）**。这是预期行为：运行时改边界必须让 env 与之对齐，否则重启即暴露不一致。把启动期的租户变更识别为"显式声明的迁移而非静默漂移"是更大的改造，留作后续（本次只交付运行时显式操作）。
- **验证**：新增 `tests/realm-operations.test.ts` **8 例**（disconnect 移除 / 未知域拒绝 / 同 root 重连无残留租户；retarget 成功 / 漂移拒绝且不变 / 个人域拒绝 / 缺参拒绝 / 大小写不敏感比较交换）+ `tests/http-realms.test.ts` **7 例**（disconnect 后 `/api/domains` 不再列出、未知 404、无 token 401、retarget 成功并反映、漂移 409 且租户不变、个人域 400、缺参 400，均验审计落点）。全量 **726 绿 / 76 文件**、typecheck/build exit 0。
- **未做**：CLI 面同样没有这两个操作（MCP 暴露侧 actor 判定仍归 #18，disconnect/retarget 是否要在 MCP server 上暴露待 #18 一并定）；启动期的"显式声明迁移"识别未做（见上）。

### #18 MCP 暴露侧的主体（actor）判定
- **缺口**：`createRealmMcpHandler` 的隔离单位仍是"宿主给这个 server 预连接了哪些 `realmIds`"，handler 内部没有主体概念——因此 design-realm §7.2 的租户/域规则在 **MCP 读取路径（`resources/read` 与 v0.10 新增的 `tools/call`）上没有执行点**，只在 `realmSource`（内核代取）与访问探针上生效。
- **为什么不在本批一起做**：接一个假 actor 进去只能证明"这段代码能被调用"，证不了真实执行 Agent 会带什么身份形态（会话级？条目级？），那是猜。
- **触发条件**：E3.4 正式 MCP 暴露立项（首个 read-realm 执行 Agent 出现）时一并定：主体身份如何随 MCP 会话传入（stdio 环境 / header / OAuth subject）、`zeus-realm:` URI 是否编码租户、以及与 #14 的**签发（签名）凭证**合并考虑；同时定 `tools/call` 是否与 `resources/read` 共用同一份 realmId 白名单。
- **裁定（2026-10-03，方向固化，未销项）**：四问定案写入 [design-realm.md](design-realm.md) §6.5——① 主体 = 会话级 actor（宿主显式声明，缺省 anonymous）；② `zeus-realm:` URI 不编码租户；③ 不与签发凭证合并（读取路径边界 = 宿主白名单，写路径已有签名且一次性的 DriverWriteGrant）；④ `tools/call` 与 `resources/read` 共用同一份 realmId 白名单（现状固化）。实现仍随 E3.4 正式暴露立项。
- **2026-10-07 传输层先落地（Active work 144，按 #6 先例"方向已固化、不等触发先做"）**：E3.4 MCP streamable HTTP 传输层已实现——`GET /mcp` 公开元信息（protocolVersion/capabilities/serverInfo，**零 realm 数据**）+ `POST /mcp` bearer 保护 JSON-RPC 喂同一传输无关 `createRealmMcpHandler`（stdio 与 HTTP 共用，零 SDK 依赖约定保持）；`x-zeus-realm-actor` header 实现 §6.5 裁定 ①（会话级 actor，effectiveRealmIds = 宿主白名单 ∩ actor.realmIds，**仅可收窄**，缺省 anonymous）；realmIds 从 boot 连接列表装配（与 stdio 宿主同一来源）。`tests/http-realm-mcp.test.ts` 11 例全绿。**正式立项触发（首个 read-realm 执行 Agent 出现）不变**，本批只做机制、不做对端。

### #19 入站 A2A 面（外部 Agent 调不进 Zeus）
- **缺口**：Zeus 只有**出站** A2A（拉卡片、`tasks/send`、SSE 回读、`tasks/cancel`）。`src/http` 里既没有 `/.well-known/agent-card.json`，也没有任何 `tasks/*` 路由——即**别的 Agent 无法把任务派给 Zeus**，也不存在一张可供别人校验的 Zeus 卡片。v0.9 §A 判过这条（"没有入站面"），但**当时没进本清单**，于是 2026-09-25 复核才发现它是"评审说过、没人接"的失物。
- **为什么仍然缓做**：入站面一开，就要同时回答"谁能派给我""派进来的东西落在哪个域""谁为结果负责"——这三问的答案取决于第一个真实的上游调用者（loom 或 bayjf），现在做只会得到一个没人用的空壳。且它不在 MVP 的核心叙事里：产品核心是"一个意图扇出多 Agent 并聚合"，出站已覆盖。
- **触发条件**：① Zeus↔loom 真机联调时 loom 需要**反向**派任务给 Zeus；② bayjf 想让公开签名目录上的其它执行 Agent 调用 Zeus 的聚合能力；③ 出现"多 Zeus 实例协作"的需求。
- **建议做法（决定后）**：发一张 Zeus 自己的 agent card（形状与 fealty 与我们要求执行 Agent 的一致，吃自己的狗粮），入站 `tasks/send` 落到 H2 的意图面并复用同一根审计事件流。
- **裁定（2026-10-03，方向固化，未销项）**：入站 A2A 面设计裁定见 [design-inbound-a2a.md](design-inbound-a2a.md) v0.1——Zeus 发布自己的 agent card（`/.well-known/agent-card.json`，形状与要求执行 Agent 一致）、入站 `tasks/send` 落 H2 意图面、三问暂定答案（上游 fealty 验签 / `realmSource` 显式声明缺省个人域 / 审计责任链延伸）、不做入站 SSE。实现仍挂触发条件①②③。
- **2026-10-07 机制先落地（Active work 144，按 #6 先例）**：入站面已实现——`GET /.well-known/agent-card.json`（公开 Zeus 卡片，形状与出站一致、无自家 fealty）+ 同路径 `POST`（requireBearer，JSON-RPC `tasks/send` 落 H2 意图面，复用 fanOut 内核路径与审计流）；`x-zeus-caller-card` 过与注册同源的 fealty 形状闸（`fealtyOathProblem` 由 registry 导出复用；无卡则 bearer 即驾驶员本人，fail-closed 403+审计）；`realm` 缺省 personal；调用方 taskId 兼作幂等键；审计 `inbound-task-accepted`/`inbound-task-refused` 入 AUDIT_DECISIONS 单一来源；回标准 A2A 收据 `{kind: "task", id, contextId, status}`；不做入站 SSE（与出站对称）。`tests/http-inbound-a2a.test.ts` 10 例全绿。**真实信任锚（在册名册验签）仍留待 loom/公开执行 Agent 作为真实上游出现**——触发条件①②③语义不变。

### #20 `ZEUS_JUDGE_THRESHOLD` 与其他 boot 参数的校验口径不一致 ✅ 已销项（2026-09-26）
- **原缺口**：`src/state/boot.ts` 对非数字阈值走 `Number.isFinite` 判断，不通过就**静默不写 config**、退回内置默认；而 E1.5 的并发/队列参数（`ZEUS_MAX_CONCURRENT_BRANCHES` 等）是**非法值直接拒启**。同一类"操作员把 env 写错"的失效，进程给两种答案。
- **决定（fail-loud）**：统一为拒启。新增 `envNumber`（与 `envInteger` 同形，允许小数以容纳 0..1 阈值），`resolveDecisionConfig` 对非数字/负数阈值抛 `KernelBootError`——与并发参数同一条 fail-loud 路径，启动即 loud 失败，不再静默退回默认。
- **推翻的契约**：`tests/boot-decision.test.ts` 原 `ignores a non-numeric threshold` 把这个静默行为钉成契约；改为 `rejects a non-numeric threshold ... toThrow(/ZEUS_JUDGE_THRESHOLD/)`。这是口径决策不是 bug 修复，故单独成 commit、与代码同批。
- **同步**：`docs/deployment.md` 该变量表行的 ⚠️ 不一致标注改为"非数字值拒启（与其余 boot 参数一致）"；`docs/design-naming-migration.md` 引用的"已知失效模式"改为已销项口吻；评审 §C-8 描述已不再成立（但保留为历史记录）。typecheck/test 通过。
- **未做**：尚未把"boot 参数一律 fail-loud"扩成一条覆盖所有现存例外的总原则文档；本批只统一了阈值这一处（其余参数本就已拒启，无例外要改）。

### #21 历史标识符改名（代码 / 环境变量 / 协议字段 / 数据格式）
- **现状**：对外文档已全量改用工程术语，但代码与环境变量里仍是历史名（`vassal` / `fealty` / `realm` / `vault` / `kernel` / `commission` / `driver-*` 审计取值 / `ZEUS_VASSAL_SEEDS` / `x-zeus-fealty`）。**方案、代价四档与逐档机制已写全**：见 [design-naming-migration.md](design-naming-migration.md)。
- **本轮结论（2026-09-25）**：**T2 数据格式、T3 环境变量、T4 协议字段与路由全部不做**。理由不是"太难"，是**收益已经拿到手**：外部误读的风险由 README 的标识符说明 + 术语表解决；而 T2/T4 要烧掉的正是"备份可恢复、签名可长期验证、对端已部署"这三项可信性资产。T1（纯内部标识符）可选，但只挑"名字真的误导"的。
- **触发条件**：① 某个历史名字**实际挡住了功能**（例如新人/对端因名字误解而接错），而不是"看起来不专业"；② 出现必须新增协议代次的真实需求，此时顺路把 T4 的双读一起做；③ #22 的 version 字段落地后，若仍有改载荷的需求。
- **硬约束（若开工）**：一个 commit 只动一档；T2 必须双读单写且提升版本号 + 实测"改前备份能在改后恢复"；T4 必须先服务端双读、**在对端确认切换前不得移除 v1 路径**。
- **裁定（2026-10-03，确认原结论，未销项）**：维持 **T2/T3/T4 不做、T1 暂不推进**——无"历史名字实际挡住功能"的新证据（触发条件①不满足）；方案与门禁维持 [design-naming-migration.md](design-naming-migration.md)。本条从"待用户决定"转为"已裁定"。

### #22 签名名册没有 schema version 字段 ✅ 已销项（2026-09-25）
- **原缺口**：验签方无法判断自己拿到的是哪一代载荷。**登记时我写的是"没有任何版本字段"，这句不准确**：信封里一直有 `seal.v = 1` 与 `attestation.v = 1`（`ENVELOPE_VERSION`，`signing.ts:125/155/192/250`），只是**验签路径从不检查它**——一个不被校验的版本字段是装饰性的，和 #18 那条"只写不读的清单"同一种失效。而真正会变形状的**载荷**（`RosterSnapshot.entries[]`）确实没有任何形状标记。
- **做了什么**：① 载荷加 `schemaVersion`（`ROSTER_SCHEMA_VERSION = 1`，两个投影函数写入），位置在 `seal.snapshotDigest` 覆盖的对象内部，所以**不需要改签名输入就被签名保护**；② 验签前置三道版本闸（在任何密码学之前）：未知 `schemaVersion` / 未知 `seal.v` / 未知 `attestation.v` 各自返回点名的拒绝原因；③ **向后兼容**：缺 `schemaVersion` 的旧件读作 1（旧件本就不含该字段，摘要与签名自洽，仍能验）。
- **验证**：`tests/signing.test.ts` 新增 4 项——两个投影都盖章、**旧形状仍可验签**（正向对照，防止"只在坏输入上测过的校验器永远可能是错的"）、`schemaVersion 99` 在**重新签名过**的情况下仍被拒（即拒绝只可能来自闸门而非摘要/签名）、`seal.v=2`/缺失与 `attestation.v=2` 各自被点名拒绝。全量 **696 绿 / 72 文件**、typecheck/build exit 0；真进程实测 `GET /api/roster` 与 `/api/roster/public` 的信封里 `"schemaVersion":1` 且 `seal.v` 不变。
- **与 #21 的关系**：这条做完后，**将来若真要改载荷，才有安全灰度的可能**（双读按 `schemaVersion` 分流）。#21 的结论不变：仍不建议改 T2/T3/T4。

### #23 DAG 分析没有操作者入口 ✅ 已销项（2026-09-26）
- **决定（选项即建议做法）**：把 `src/orchestrator/dag.ts` + `dag-runner.ts` 已落地的图能力接到 H2 操作者面，沿依赖边从平铺扇出升级为分层执行。实现与建议做法的差异：依赖边**编码在节点 `dependsOn` 上**（不是另给 `edges` 列表）——功能等价，少一份需要保持同步的字段。
- **能力已在**：`src/orchestrator/dag.ts` + `dag-runner.ts`（拓扑分层 `topologicalLayers`、关键路径 `criticalPath`、`validateDag`、部分失败跳过），`tests/dag.test.ts` **6 例**，且都从 `src/index.ts` 导出。
- **落地（2026-09-26）**：
  - `POST /api/intents` 接受可选 `dag:{nodes}`（每节点 `id` / `skill` / 可选 `vassals` / `params` / `dependsOn` / `aggregation`，顶层 `branchTimeoutMs`）；与 `body.skill` **互斥**，否则 400。结构校验（字段形状）在 `parseDagSpec`、图校验（环 / 缺失依赖 / 重复 id）在 `validateDag`（均返回 **400** 并点名环或未知节点）。提交即回 **分层计划 + 关键路径 + 每节点状态**。
  - `GET /api/intents/:id/dag` 按 `dagId` 回读 `layers` / `criticalPath` / `state` / 每节点状态。
  - **复用内核**：`DagRunner` 改为可接收一个**已存在的 Orchestrator**（boot 传入主 orchestrator），所以 DAG 的每个节点意图走的是**同一个** orchestrator——共享幂等表、随内核快照持久化、`GET /api/intents/:id`（节点 id 为 `${dagId}::${node}`）仍可读。不重复造一个隔离的执行器。
  - 部分失败的跳过语义在 `DagRunner` 内保持不变（依赖未完成的节点 `skipped`，独立分支继续），与 `refused-*` 同样写进审计事件流。
- **验证**：新增 `tests/http-dag.test.ts` **7 例**（`npx vitest run` 全量 **711 绿 / 74 文件**，typecheck/build exit 0）；其中"两阶段意图 + 节点意图可追溯"用**真进程 inject 冒烟**（真实 HTTP + 真实 orchestrator + dispatcher 管线，不是只测纯函数），覆盖你定的"只有 inject 测试不算已验证"口径。**未做**：CLI 与 MCP 面同样没有 DAG 入口（触发条件②/③未到，且 MCP 暴露侧 actor 判定仍归 #18）；DAG spec/result 在内存，不随内核快照持久化（重启后 `GET /api/intents/:id/dag` 失忆，节点意图仍在）。
- **原登记背景（保留）**：该条曾因编号复用（`#15` 被"支持矩阵与 engines 声明"覆盖）在文件里消失，本文件顶部已立"编号只增不复用"规则。
- **原缺口（登记时的判断，2026-09-26 已闭合——保留原文只为追溯，读到这里请以本条 ✅ 标题为准）**：`src/http/server.ts` 里 `dag` / `criticalPath` / `topolog` **出现 0 次**，CLI 与 MCP 面同样没有。也就是说**操作员今天无法提交一个 DAG 形状的意图，也无法读回它的分层与关键路径**——只能当库函数用。这条与 #21 无关，是"内核有、操作者看不见"那一类的又一个实例。**现状**：HTTP 两面已有（`POST /api/intents` 的 `dag:{nodes}` 与 `GET /api/intents/:id/dag`，2026-09-27 实测 server.ts 内 `dag` 出现 32 次），仍缺的是 CLI 与 MCP 面（上面那条"未做"未变）。
- **为什么现在才记**：它**本来就登记过**。`handoff.md` 顶部状态段写着"C（状态文件进备份与恢复协议）与 F（DAG 操作者入口）经实测是设计变更，登记 deferred #13/#15/#14 而非半做"，Active work 39 的"没做的两项"那条也把 F（S3 DAG 操作者入口）判为"需要先出设计稿"——三个号对应 C/F/另登记项，#13 归 C、#14 归 `DriverWriteGrant`，剩下 **#15 就是 DAG**。但 `#15` 后来被**"支持矩阵与 engines 声明"复用**，DAG 那条就在文件里消失了（此处按句子内容引用而不按行号：行号会随文件增长漂移，这本身就是这条失物能藏住的原因之一）。已在本文件顶部补"编号只增不复用"规则，防它再发生。
- **触发条件（回顾）**：① 出现一个真实的**多阶段依赖**意图（"B 必须等 A"）时派发从平铺扇出升级为分层执行；② 多阶段编排的关键路径/瓶颈分析；③ 按 DAG 排程做取消或重试。本条不等触发条件——库内"内核有、操作面无"的缺口本身就是可闭环的工作，且前几批一直在补这类。

### #24 墙钟依赖的测试与脚本没有可执行闸门 ✅ 已销项（2026-09-26）
- **原缺口**：`tests/verify-roster.test.ts` 的 fixture 用固定时刻封签（`maxAgeSeconds: 3600`）却不传 `--now`，于是"验得过"依赖真实时间——当天窗口一过 4 例全红而实现一行未改（已在那个文件内修掉：`run()` 缺省注入 `--now`）。但**同类形状没有任何东西挡**：只要新测试再写一次"固定过去时刻 + 让生产代码读墙上时钟"，它就在未来某天自动变红，或更糟——自动变绿。
- **做了什么（可执行闸门）**：新增 `scripts/clock-skew-setup.mjs`（把 JS 时钟整体拨前 2 年，偏移可用 `ZEUS_CLOCK_SKEW_DAYS` 覆盖）+ `vitest.clock-skew.config.ts`（仅比 `vitest.config.ts` 多挂这个 setup），并在 CI 加 `clock-skew` 作业：真实时钟下 `npm ci` + typecheck + build，再用偏置配置跑**全量测试**。凡测试或生产路径偷偷读真实墙钟，这一道作业就红——从"某天自己变红"变成"引入当天即红"。
- **为什么是 JS 级偏移而不是 `sudo date -s`**：GitHub 托管 runner 不给 `CAP_SYS_TIME`，系统级拨钟多半 `Operation not permitted`；且拨动 OS 时钟会让 `npm ci` 访问 npm registry 的 TLS 证书校验跟着错位、连带安装失败。本仓库的墙钟风险**全在 JS 内**（每个生产 `new Date()` 都躲在可注入的 `now` 之后），所以拨 JS 时钟是忠实且无特权的等价代理。**已知边界**：拨钟只覆盖 vitest 进程内代码；`verify-roster.test.ts` 之类 spawn 的子进程跑在真实时钟下，不在本闸门覆盖（若某脚本将来长出依赖墙钟的逻辑，再评估 OS 级拨钟或给子进程也注入偏置）。
- **验证（实证，不是假设）**：本地以 +2 年偏置跑全量，**726 绿 / 76 文件**——证明当前测试集对墙钟零静默依赖；CI 这道作业即此结论的回归护栏。typecheck/build exit 0。
- **触发条件已满足**：本批次即在把闸门立起来的同时确认无残留墙钟依赖；若未来出现"无人改代码却变红/变绿"的时间用例，此作业会第一时间报警。

### #25 核心链路的真进程端到端冒烟没有可重跑资产 ✅ 已销项（2026-09-27）
- **缺口**：本文档反复用到的那类最强证据——**起真进程、走真 socket，把「给一个目录 → 挂域 → 带凭证注册执行 Agent → 扇出 → 聚合 → 审计落盘 → 封签名册离线可验 → 吊销断流 → 重启恢复」一次走完**——历史上做过很多次（v0.30「编译产物真进程冒烟 13 项」、v0.12「真 socket 7 条复核」、镜像实构实跑），但**每次都是评审会话临时手写、跑完即弃**，仓库里只留下结论没有留下脚本。后果在 v0.17 评审时显形：想再手写一次时被权限层拦（判为「未被要求的新可执行代码」），于是那一格证据只能回退到「历史记录」而不是「本轮实测」。
- **为什么值得做**：设计约束第 2 条要求「每个概念必须可执行」，而「核心链路可用」正是最该可执行的一句。它同时是 pre-launch checklist §F 回归护栏里唯一没有命令的那一项（其余四项都有命令）。

- **销项（2026-09-27，同轮）**：`scripts/smoke-core.mjs` + `npm run smoke:core` 落地并接进 CI（build/test 之后一步），**23 步全绿**。它第一次跑就抓到一条真缺口：`POST /api/vassals` 只收 `cardUrl`/`taskUrl`，**运行时上线的执行 Agent 拿不到出站凭证**——派发静默不带 `Authorization`。已补 `body.token`（存储后任何视图不回显，`tests/http-vassals.test.ts` 2 例锁住），并顺带把 `body.aggregation` 的 400 文案改成点名形状（原文案读起来像要字符串，实际要 `{kind}`）。可失效性记录：开发过程中它先在 18/23、20/23、21/23 处失败（错误 payload 形状、凭证没上路、把 revoked 行读错视图），且把 `dist/` 移走后退 1 并给出可读原因——**它不是一条只会绿的闸门**。
- **建议做法**：新增 `scripts/smoke-core.mjs`（零依赖、只用回环、mock 执行 Agent 由脚本自己起）；断言逐条打印 + 退出码非 0 即失败；密钥与令牌一律临时目录内自造，**不读 `data/` 下任何真实凭证**；接进 CI 作为 build 之后的一步（本地 runner 需要能监听端口，GH runner 可以）。
- **触发条件**：① 下一次项目级评审（本轮已经付过一次代价）；② `src/http` 装配路径或派发主链路有改动，需要判断「编译产物是否还能整体跑通」；③ 上线前回归（checklist §F 目前只能靠人手工跑）。

### #26 配置面双向对照没有闸门（本轮由评审手工跑出一次）✅ 已销项（2026-09-27）
- **现状**：2026-09-27 评审 v0.17 做过一次双向对照——代码里 `env.ZEUS_*` / `process.env.ZEUS_*` 读到 **25 个**变量，`.env.example` 与 `docs/deployment.md` §2 **两处都缺的有 1 个**：`ZEUS_MAX_CONCURRENT_PER_VASSAL`（#9 分流的唯一操作入口，本轮已补进两处）；**反向 0 个**（文档写了而代码不读），这一半说明匹配口径对得上，"缺 1 个"不是解析偏差造出来的。真正的问题是**这次对照存在于评审会话里，不存在于仓库里**：下一批加 env 时同样会漏，而"新 env 必须同时进两处文档"这条约定目前只靠人记得（v0.31 批次就补过一次 10 行）。
- **销项（2026-09-27，同轮）**：`tests/config-surface.test.ts` 三条断言落地——① 正向对照（两边集合非空，防空集合假通过）② 代码读到的每个变量必须在两处文档之一出现 ③ 文档里出现的每个变量必须真被读（含 `DYNAMIC_READS` 豁免表，新增条目必须写理由）。**它第一跑就抓到 `ZEUS_CLOCK_SKEW_DAYS`（#24 的 CI 旋钮）两处文档都没有**，已补进 deployment §2 并标明它是 CI-only、故不进 `.env.example`。
- **建议做法**：一条测试（`tests/config-surface.test.ts`）——扫 `src/**/*.ts` 取 `ZEUS_[A-Z0-9_]+` 读点，与 `.env.example`、`deployment.md` §2 做双向差集，任一方向非空即失败；对动态读法（`env[name]`）留显式豁免表并注明原因。**双向很关键**：漏文档只是操作员看不见一个旋钮；而文档里留着早已被删掉的变量更阴——它教操作员去设一个什么都不影响的东西。
- **触发条件**：① 任何新增或改名 `ZEUS_*` 环境变量的批次；② 下一次项目级评审（本轮已手工跑过一次，下次不该再手工）；③ 出现"照文档设了却没生效"的报障。

### #27 运行进程内没有记忆事件的生产者（E8.5/E8.3 在实跑中是空转的）✅ 已销项（2026-09-27）

- **销项（同日，按 §8 的 P1 落地）**：`src/memory/producer.ts`（每个不同 `(作者, 立场)` 一条 claim；object 只放立场、超 512 截断；`claimSubject` 显式优先、缺省派生自 skill+问题而**绝不用 intentId**）+ `boot.ts` 在 `intent-finished` 处装配（**先写 claim，再 consolidate**，同一次意图当场成事实）。写入一律走 `appendFromRealm`，realm 已被下线时丢弃并审计 `memory-claim-skipped`。契约全文与四问答案见 [design-memory-consolidation.md](design-memory-consolidation.md) §8（文档升 v0.5）。
- **可失效性（不是断言，是量出来的）**：`smoke:core` 新增的那一步**要求快照非空**。本改动之前它打印 `events=0 factGroups=1`、日记 `entries=0`；之后打印 **`events=6 facts=1`、日记 `entries=1`**——同一条断言在缺陷存在时是红的，这才是它有效的证明。另 10 例单测覆盖：claim 形状（过 `isClaimContent`）、派生 subject 可重复、显式 subject/predicate 优先、重放不增条数、超长截断、空立场跳过、**realm 未挂载时不写且上报审计**（这条是"并非无条件就写"的反向对照）、**未指名 realm 的意图不进记忆**。
- **顺带修掉一条同形状的漂移**：`GET /api/audit?decision=` 的白名单此前在 server 侧手工维护，**已有 5 个决策值查不到**（`refused-skill-uninstalled`/`refused-no-active-provider`/`branch-diverted`/`realm-disconnected`/`realm-tenant-retargeted`）；现在 `AuditDecision` 类型由 `AUDIT_DECISIONS` 数组派生，单一来源，加值不会再漏。
- **E8.5 状态列回到 ✅**（正文注明运行时生产者已就位）。

- **发现方式**：把 `GET /api/memory/snapshot` 与 `GET /api/diary/export` 接进核心链路冒烟后**第一次真机实跑**：派发三条分支、审计落盘 13 行之后，`snapshot.state.events.length = 0`、`factGroups = 1`（空组）、日记 `entries = []`。
- **代码级证据**（本轮复跑，非引用）：`MemoryEvent` 的构造只出现在 `src/memory/` 内部；`grep -rn "\.append(" src` 在 memory 模块之外**零命中**（audit sink 是另一个对象）。HTTP 面对 memory 只有读（`read`/`facts`/`replay`/`searchRecall`/`exportState`）与擦除（`retract`/`forget-subject`）；`boot.ts` 只用 `consolidateRealm`/`authorsOfFacts`/`recordCorrections`/`reliabilityScore`。**没有任何一方把执行 Agent 的回报变成事件**。
- **后果**：E8.5 的"事件→事实→混合检索→遗忘权→漂移对账"整条链在**库里**成立（752 项测试覆盖），在**出货进程里**输入恒为空；连带 E8.3 的日记恒空。这不属于"能力没有入口"（#23/#25 那一类），而是更深一层：**能力没有数据源**。
- **需要决定的是设计而不是代码**：事件的产生点应在哪一层——① Dispatcher 收到 task 回报时按 report-back 落 observation/claim；② 裁决/纠偏落 decision 事件（`recordCorrections` 已在，但它只改可靠度、不产生事件）；③ 域内容变化落 observation。三者的 `eventId` 幂等与去重、realm 归属（跨域拒绝那条不变量要同样成立）、以及"哪些内容进事件、哪些留在审计链"都需要定契约，不能顺手接一根线。
- **触发条件**：① 任何要把记忆/日记面真正用起来的部署（现在开着会静默产出空事实源，比报错更糟）；② E8.5 升 P0 或 bayjf 名册需要事实来源时；③ 出现"为什么日记是空的"报障——本轮冒烟已给出可复现证据。
- **提案已出（2026-09-27）**：见 [design-memory-consolidation.md](design-memory-consolidation.md) **§8**——边界判据（陈述进记忆、动作进审计链）、四条触点与后果（建议只做 P1「分支结论→claim」，因为消费端 `boot.ts:388-392` 起那条链已接好，缺的只是输入），以及**四个不定就写不出代码的决策问题**：`subject` 由谁给、`predicate` 粒度、第三方结论文本能否常驻状态文件与备份、要不要开关。落地时按 §8.4 第 3 条给 `smoke:core` 加一步「事件数必须非零」的断言，把恒空转变成会红的闸门。
- **口径**：在它落地前，`E8.5` 状态列应为 🚧（库内能力已验收、运行面无生产者），`E8.3` 保持 ✅ 但正文注明输入依赖本条。

### #28 「状态列 vs 正文」冲突检测器还是一次性脚本（评审 v0.18 本轮手工跑出）
- **现状**：本轮把 PRD §4 的 54 行需求做了两种机械读取——① 状态列形状（**已入库为断言**：`tests/doc-consistency.test.ts` 第 5 例，内置"必 FLAG 两行 / 必干净一行"的校准）；② 状态列与正文是否互相打脸（**未入库**，判定规则写在 [review-mvp-2026-09.md](review-mvp-2026-09.md) §B）。
- **为什么本轮没把它写成断言**：② 的规则要求子句级语义。本轮第一次跑（14 字窗口 + 词表）在真表上报出 **5 处**，逐条核对全是过去时陈述（"此前 `bootKernel` 从未接 `onRevoke`"）或条件句（"不可用即拒启"），把窗口换成"所在子句含过去/修复标记即豁免"后才归零。词表进 CI 的代价是**下一批合理措辞会让门禁红**，而这条检查的价值恰恰依赖它不被人为放宽——所以先留口径在文档里，由评审每轮带校准样例跑。
- **触发条件**：① 出现第二次"列与正文打脸"造成的实际误判（例如有人按 🚧 列去排优先级、而该项早已关闭）；或 ② PRD 需求行数量增长到手工一轮读取成本明显高于维护词表的成本（当前 54 行）。
- **缓做原因**：这是**判定精度**问题不是缺口——E4.8 那类矛盾在 2026-09-26 已清零，本轮重新量也是 0；用一个会假阳性的闸门换"自动化"这个名字，不如把口径写清、把校准做在跑的那一刻。
- **2026-09-27 复量 → 结论：不接进 CI。** 按条目自身触发条件重量：① 未见第二次"列与正文打脸"造成的误判；② `docs/prd.md` 需求行仍为 **54 行**（`^\| E[\d.]+ \|` 计数），未增长。又复跑一次词表判定（✅ 行正文含 `未实现/尚未/还没有`、⬜/🚧 行正文含 `已落地/已交付`）→ 真表报出 **2 处，逐条核对全是假阳性**：E3.4（🚧，正文"stdio 壳已落地"＝部分落地，列与正文其实一致）、E8.3（✅，正文"运行时输入依赖 deferred #27……还没有记忆事件生产者"＝已登记的依赖注记，正是 deferred #27 明文允许的 ✅ 形态）。**词表版在真表上的假阳性由 v1 的 5/54 变成本次 2/54，同一类子句语义没被词表收住**——这就是"结构判定（①，已在 `tests/doc-consistency.test.ts` 第 5 例）零假阳性可进 CI、语义判定（②）不能"的实测理由。维持口径：不进 CI，由评审每轮带校准样例跑。
- **2026-10-07 检测器入库为可复跑脚本（Active work 143）**：`scripts/check-prd-status-body.mjs` 落盘——词表**严格复刻**本条两次实测口径（✅ 行含 `未实现|尚未|还没有`；⬜/🚧 行含 `已落地|已交付`；刻意不含"未做/仍未做"族，E1.3/E1.4 的透明部分完成标注会误伤）+ 豁免子句表（此前/已修/已登记/已更正/已销项/deferred #\d+…）+ `--verbose`；exit 0=无候选、exit 1=有候选需人工核对。**当前真表实测：55 行需求 / 0 候选 / 1 豁免（E8.3 过去时陈述），与 deferred 记录一致**；校准样例（E3.4/E8.3/E4.8）写进脚本头注释。**仍不接 CI**——词表版假阳性 2/54 的实测结论不变，语义判定继续由评审每轮带校准跑。

### #29 内核按约定推导任务端点，不读卡片自己声明的 `url` ✅ 已销项（2026-09-27，触发条件未到点即提前激活）
- 原议题：`defaultTaskUrl`（`registry.ts`）把卡片 URL 按字符串约定改写为任务端点（`…/api/a2a/agent-card` → `…/api/a2a/tasks`、`…/.well-known/agent(-card).json` → `/api/a2a/tasks`），**从不读卡片的 `url` 字段**。但 `url` 就是 A2A 语义里该 Agent 的 RPC 端点——二者冲突时内核按约定赢。线上 pr-helper 正是这种形态（`url` 即卡片路径，GET=卡片、POST=JSON-RPC），于是注册 201 成功、派发时 `subscribe failed: HTTP 404`。
- **触发条件（回顾）**：① 出现第二个把 JSON-RPC 面放在卡片路径上的真实 Agent；② 有部署因"卡片 `url` 与约定不一致"而派发失败、且无法用 `taskUrl` 覆盖。两条均**未满足**（pr-helper 是第一个，且可用 `TASK_URL` 覆盖）。
- **提前激活的理由**：修的是"内核读错来源"这一层——卡片的 `url` 是协议自己声明的一致性来源，约定只是启发式。既然 pr-helper 已证伪"约定总是对的"，继续让内核默认猜端点，等于把每个真实 Agent 的接线成本推给操作者去配 `TASK_URL`，而这类失配在线上表现为 404 报错、不是配置缺失。改动面已全量测绘（仅 3 个路径严格的桩 + 2 处断言），风险不再需要第二条触发条件来担保。
- **销项结论**：`register()` 的端点解析改为固定优先级 **显式覆盖 > 卡片声明 `url` > 约定兜底**（`src/registry/registry.ts`：新增 `declaredTaskUrl`，`defaultTaskUrl` 降为兜底）。卡片 `url` 为空 / 非 http(s) / 不可解析时判为"未声明"并回落约定——**旧卡片不会因 `url` 是无效值而在边界新失败**。
- **迁移口径**：既有快照在 `importState` 时**保留存下的 `taskUrl`**，不会在升级瞬间翻转；只有新注册/重注册才走新优先级。`POST /api/vassals` 的 `taskUrl` 覆盖保留为一等显式覆盖（给"声明也不对"的卡片兜底），验收 runner 的 `TASK_URL` 旋钮同样保留。
- **对照用例**：`tests/registry.test.ts` 新增「task endpoint resolution」三例（声明优先于约定 / 显式覆盖胜过声明 / 声明不可用回落约定），并改写既有断言（pr-helper 卡 `url` 即卡片路径，注册后 `taskUrl` = 该声明值）；路径严格的桩（`scripts/smoke-core.mjs`、`tests/kernel-memory-p1.test.ts`、`tests/governance-flow.test.ts`）改为声明真实服务端点。门禁 789 测试 / 83 文件 / 0 失败，`smoke:core` 36/36。
- **同源记录**：v0.10 修过一次同一端点失配（改的是 `scripts/acceptance-standard-a2a.mjs`），当时只修了客户端脚本、内核派发侧未动——本条记的正是"修了看得见的那一半"。

### #30 连接器权限词汇无法绑定"名字不合词法"的工具 ✅ 已销项（2026-09-30）
，词表不放宽。`validateSkillSpecShape` 与 `validatePermissionClaims` 两处复用同一判定。② 绑定仍为**精确、大小写敏感**的字符串相等（`withinBoundary` 本就是 `mcp:${name}` 原样比对，无需改），与上游 `tools/list` 一一对应。③ 防改名静默失权：连接握手后，声明了但上游清单没有的 `mcp:<工具名>` 产生新审计动作 `boundary-unmatched`（`ConnectorAuditEntry.action` 扩枚举，含未发现工具名列表），声明早于连接不报错、但改名/下线在连接时可见。④ 测试 +4（skills-validation 2：原名工具名合法/空与控制字符非法且非 mcp 作用域仍封闭；mcp-connectors 2：原名三件套经握手精确裁剪且未授权工具拒调、失配工具发 `boundary-unmatched` 审计且命中工具仍可用），活基线 850/90 → **854/90**。⑤ 文档：mcp-integration §2.1 与缺口表更新。**仍不在本条文内**：对真实外部 MCP 服务的 connect（E7 至今只用自造上游夹具，真实实连仍待外部服务端出现）；按能力指纹而非名字授权未做（当前以审计告警兜底改名问题）。
- **缺口**：工具级边界的写法是 `mcp:<工具名>`，而整个声明串要先过 Skill 的封闭词法（`src/skills/validate-spec.ts:15-17`：`^[a-z][a-z-]*(:[a-z][a-z-]*)?$`，作用域只允许 `realm`/`execute`/`network`/`credential`/`mcp`）。于是**上游工具名里带下划线、点、大写的，一条都声明不进去**——2026-09-28 直接对 `validatePermissionClaims` 实测：`mcp:search` 通过，而 `mcp:search_docs`、`mcp:Search`、`mcp:search.x`、`mcp:` **四条全部判 invalid**（经 HTTP 面表现为 400）。真实 MCP 生态里 `fetch_html`、`notion.search` 这类命名很常见。
- **后果**：想给这类工具开最小权限，只能退到裸 `mcp`——而裸 `mcp` 的语义是"放行该连接器握手发现到的**全部**工具"（`src/mcp/connectors.ts:85-91`）。也就是"要么全给，要么给不了"，与"每条能力都要落到权限声明里"的设计约束相反。
- **为什么本批只登记不修**：修法有两种（放宽词法，或把声明改成"引用上游原样字符串"），这是**契约决定**不是补漏；且当前没有任何真实连接器因此接不上——本库至今没有对真实外部 MCP 服务跑过一次 `connect`（E7 的实连仍待外部服务端出现）。用一个自造上游去证明"放宽后能用"，证的只是我自己写的假设。
- **触发条件**：① 第一个真实外部 MCP 服务的工具名不合现有词法（实测撞上，而非推测）；② 有部署要求"按工具名单独授权"而被迫声明裸 `mcp`。
- **建议做法（决定后）**：把 `mcp:` 后的取值域从"受词法约束的名字"改为"握手能力清单里的原样字符串"（校验只查前缀与非空，其余按上游原样比对）。代价要一并记账：声明与上游名字硬绑定，**上游改名即静默失去授权**，所以要么同时把"已声明但清单里没有"做成启动告警，要么改成按能力指纹而非名字授权。

### #31 MCP 面把未声明的查询参数静默丢掉（`?tags=` 是实例） ✅ 已销项（2026-09-30）
- **销项结论**：触发条件②（真实误读）以 A1 真机批次的取证形式满足——`?tags=` 返回未过滤全量且不报错已被明确记录为会误导集成方的静默降级。修法按 fail-loud 收口（`src/realm/mcp.ts`，resource URI 与 `tools/call` 两通道同口径）：① `tags` 不再丢弃，下传到存储层由 P0 文件系统后端显式抛 `UnsupportedQueryError` → JSON-RPC `-32602`（"tag search is not supported in P0"），客户端看得到限制而非拿到错结果；② 任何资源模板/参数 schema 未声明的参数名（URI 上除 `text/since/limit/tags` 外、`arguments` 上除 `realmId/text/since/limit/tags` 外）一律按名拒绝为 `-32602 unsupported search parameter: <name>`；③ `realm.search` 的 `inputSchema` 补声明 `tags`（注明 P0 后端不支持），资源模板补 `&tags={tags}`。tests/realm-mcp.test.ts 新增两例（URI 侧 tags/未知参/合法参、tools 侧 tags/未知键/非法 tags），15 → 17 例。文档同步 docs/mcp-integration.md §1.4 与 §3（原"静默忽略"改为"显式 -32602"）。**不在本条文内**：标签检索真正立项（倒排/向量后端）仍走 design-realm §6.2 / 单 Realm >2 万文件或 P50>500ms 的阈值，本条只修"静默丢参"这一失效形状。
- **缺口**：`resources/read` 的 search URI 只解析 `text`/`since`/`limit`（`src/realm/mcp.ts:304-319`），**其余查询参数被忽略且不报错**。2026-09-28 实测：`zeus-realm://<realmId>/search?tags=important` 返回**未过滤的全量命中**。更关键的是——存储层那条"P0 不支持标签检索"的拒绝路径（`src/realm/store.ts:151-153` 抛 `UnsupportedQueryError`）在 MCP 面上**永远走不到**，因为参数根本没往下传。
- **后果**：一个按 `?tags=` 写的客户端会拿到"看起来成功"的错误结果，并以为过滤生效。这是**静默降级**，与 #20 修掉的那类"env 写错就静默退默认"同一种失效形状。
- **为什么本批只登记不修**：两种修法（未知参数一律拒成 `-32602`，或接通 `tags` 并显式返回"不支持"）都是对外契约的口径决定，不该由一次文档批次顺手定。本轮做的是把它写成明文行为，让集成方看得见——见 [mcp-integration.md](mcp-integration.md) §1.4 与 §3。
- **触发条件**：① 标签检索立项（design-realm §6.2 的检索升级阈值，或 E3 侧新增能力）；② 出现一次真实误读——客户端传了过滤参数而结果不对。
- **与既有条目的边界**：**#18** 管"谁是主体（actor）判定"，本条管"参数丢失"，两者不相干；`tools/call` 侧的非法 `limit` **是**会报错的（实测 `-32602`），所以本条只关于"未在资源模板里声明的参数名"。

### #32 现行叙述层仍留着叙事隐喻（措辞清扫的残余范围没有边界文件清单） ✅ 已销项（2026-09-30）
- **销项结论（2026-09-30）**：触发条件③满足——「现行面无隐喻」从手工 grep 升级为可复跑闸门（`tests/doc-consistency.test.ts` 第 9 例）。按登记的四现行面边界清扫：`docs/pre-launch-checklist.md` 叙事隐喻 7→执行 Agent（含「真实执行 Agent 注册」「作为执行 Agent 入他人网格」等）、2→操作者（「DAG 操作者入口」→操作者入口）、4→确定/决定（选型已确定/上线窗口前决定/待决定）；`docs/README.md` 场景表 D 行→「D 待决定」；`docs/prd.md` 现行需求行 E1.1→操作者入口。清扫后逐词复跑量法，四现行面 + portrait 演进日志前现行段对 12 个禁用叙事隐喻词计数全部为 0（清单见 terminology.md）。**未动**：handoff 与各文档的历史行/演进日志（文档状态约定）、代码标识符与协议字段（`vassal`/`fealty`/`x-zeus-*`/`/api/vassals` 等，代价四档见 terminology）、`src/tui/` 消息资源（内部界面，非对外文档面）。新闸门扫描面 = 根 README + docs/README + checklist 全文、PRD 现行 E 行、portrait 演进日志之前；带正控（植入三个叙事隐喻样本必被抓，实测 fail 后还原 9/9 绿）。活基线 826/89 → 827/89（+1 即该闸门）。
- **缺口**：术语清扫（Active work 28–30）**没留下"哪些现行文件仍未扫"的边界清单**，于是没人知道残余有多大。2026-09-28 现测（只数现行叙述所在的文件；计数=含该词的行数）：`docs/pre-launch-checklist.md` 叙事隐喻 3、2、4；`docs/product-portrait.md` 叙事隐喻 3、2、2、1、1；`docs/prd.md` 的**现行需求行**叙事隐喻 1（0）；`docs/README.md` 1；`README.md` 全为 0。**量法可复跑**：按 terminology.md 禁用词清单逐词 grep（PRD 只数需求行用 `grep '^| E' docs/prd.md`）。
- **两条测量陷阱，记下来免得下轮再踩**：① **`handoff.md` 不计入残余**——它含这些词的行绝大多数是「Recent changes / Active work」的历史行，按文档状态约定历史行不改，把它的出现数当"待改量"会误导（本轮量得 叙事隐喻 188 处）。② **登记项会污染自己的读数**——本条正文一旦写下这些词，全文计数就 +1（实测：写完本条前后 handoff 的叙事隐喻计数 +1）。所以任何"残余还有多少"的结论都必须**按文件、按现行段落量**，不能全库 `grep -r` 一把梭。
- **为什么登记不修**：这三档词里每一条都要逐条判"是现行叙述、是历史日志、还是代码标识符/协议字段"，批量替换会改错语义（AGENTS.md 明文禁例：把"越界"当"越权"换掉就是错的；判定表在 [terminology.md](terminology.md)）。把一次跨文件措辞改造混进本批（MCP 契约文档）会让 diff 不可审。
- **触发条件**：① 下一次要把 portrait / checklist 给外部读者看；② 出现一次真实误解——对端或新人按"执行 Agent / 操作者"的字面去理解产品关系；③ 决定把"历史行与现行行分层改写"做成可复跑的检查（与 #28 同一类工具化问题）。
- **建议做法（决定后）**：只改四个现行面（checklist、portrait、prd 的现行需求行、docs/README 那一处"待决策"），`handoff.md` 的历史行不动；改前后各跑一次上面的量法做逐词对照，并复跑 `tests/doc-consistency.test.ts`（粗体配对与列数在措辞替换里最容易破）。

### #33 执行型 Agent 的凭据代理机制（execute 模式无法落地不可逆操作）
- **缺口**：2026-09-29 对线上 pr-helper 跑真机扇出（A1）时在真机上确认——pr-helper 的 execute 模式返回 `input-required`（"Credential delegation is not implemented yet"），即执行 Agent 期待由 Zeus 侧代理外部系统凭据（如 GitHub token），而 Zeus 当前**没有凭据代理机制**：出站派发不带调用方凭据，`VassalEntry` 只保存 Agent 自己的 bearer。结果是执行型 Agent 的**不可逆操作**（merge / production rollback 等）在工程上无路径发起；plan 模式不受影响（本轮 15/15 即 plan 模式）。
- **为什么登记不做**：这是独立立项而非 A1 范围——① 机制本身有设计分叉：内核托管凭据（secret 存储、最小权限、审计）还是操作者一次性授权（短时生效、单次使用），属架构决定；② 设计约束要求"跨域读写显式、签名、一次性授权"，凭据代理必须与之一致，不能先做再补口径。
- **触发条件**：① 第一个需要 Zeus 发起不可逆外部写操作的真实场景（不是演练）；② pr-helper 侧凭据代理接口就绪，需要 Zeus 对接。
- **建议做法（决定后）**：优先"操作者签发的一次性短时授权"而非常驻凭据托管——凭据不落内核状态文件，授权记录进审计；同时保留 plan 模式为默认（现状），execute 必须带显式授权且不可逆技能仍由执行 Agent 升级到操作者。验收：无授权 → execute 拒绝且不发起任何外部写；授权一次 → 仅一次外部写成功、审计含授权与写操作两条记录。
- **进展（2026-09-30，**未销项**）**：采纳上述"一次性短时授权"路线，先落**与对端解耦的纯函数安全原语** `src/delegation/execution-delegation.ts`（设计见 [design-execution-delegation.md](design-execution-delegation.md) v0.1，8 项单测）：`issueExecutionDelegation`（Ed25519 签名、绑定 grantedBy/skill/可选 vassal/capabilities 白名单、默认 TTL 5 分钟硬上限 1 小时、随机/可注入 nonce）+ `verifyAndConsumeExecutionDelegation`（形状→vassal/skill/capability 绑定→签名/keyId/信任锚 fail-closed→过期→单次消费的固定顺序；**任何失败都在消费 nonce 前返回，不烧合法重试**）+ 有界可持久化的 `ExecutionDelegationNonceLedger`。明确**不托管长期外部凭据**。**仍挂触发条件②**（pr-helper 凭据代理接口就绪）的五项接线：execute/plan 模式、Dispatcher 出站前闸门、票据投递的 A2A `x-zeus-*` 字段、HTTP 签发端点 + 新增审计 decision、nonce 账本接入 bootKernel 持久化——这些都会撞对端未定义协议，故按设计文档 §5 不臆造、留待对接。
- **进展（2026-10-03，**未销项**）**：上列五项接线中**与对端无关的两项已接**——④ `POST /api/execution-delegations` 签发端点（bearer，校验 + 驱动钥签发，无 signer 不挂载）+ 新增审计 decision `execution-delegation-issued`（AUDIT_DECISIONS、审计查询白名单、TUI token 跟随）；⑤ nonce 账本接入 `KernelSnapshot.executionDelegationNonces`（collect/apply，bootKernel 创建账本挂组件、onChange 落盘）。新增 11 项测试（HTTP 9 + 快照 2）。**仍挂触发条件②**的三项：execute/plan 模式、Dispatcher 出站前闸门、票据投递的 A2A `x-zeus-*` 字段——仍撞对端未定义协议，不臆造。
- **进展（2026-10-03，**未销项**）**：上一条的「nonce 持久化」**实测只完成了一半，同日修复**——`collectKernelState` 收了 `executionDelegationNonces`，但 `FileKernelStateStore.save()` 逐字段构造快照时漏掉这一项（只写了 `writeGrantNonces`），而 boot 的落盘路径是 `target.save(collectKernelState(components))`（`src/state/boot.ts:553`），故 spent nonce **从未写入磁盘**，重启后账本为空、重放窗口照旧开着——正是这笔账存在要闭合的那个窗口。根因是原有两条用例只走 `collect`/`apply` 的内存往返，落盘这一跳零覆盖。修复：`save()` 补写该字段（+1 行），新增走真实 `FileKernelStateStore` 的 save→load→apply 回归用例（去掉该行此用例必红，已缺陷植入验证）；同批删掉随之暴露的死分支 `src/http/server.ts` 的 `if (deps.signer)`（signer 必填，永不为空），并把两个为 PR #71 CI 红所写的类型错用例改回可达断言。活基线 1048 → 1049。
- **进展（2026-10-03 第三批，**未销项**）**：上列"仍挂触发条件②"的三项中**与对端无关的两项已接**——① **execute/plan 模式**：`FanOutRequest` 新增 `mode?: 'plan' | 'execute'`（缺省 'plan'）；② **派发闸门**：`Orchestrator.runBranch` 出站前调 `verifyAndConsumeExecutionDelegation`（capability 固定 `'execute'`，票据 capabilities 须覆盖该能力），无授权/验签失败/过期/重放一律 fail-closed **不发出站请求**，拒绝写审计 `execution-delegation-denied`（AUDIT_DECISIONS + TUI token 同步）；HTTP 意图面透传 `mode`/`executionDelegation`（未知 mode 400）。验收口径实测（orchestrator 闸门 7 例 + HTTP 端到端 4 例）：无票据 → 分支 `execute refused: missing` 且 dispatcher 零调用；合法票据 → 单次派发 + nonce 消费；重放 → `replayed` 拒发；无信任锚（未装配 driverSigner）→ `no-trust-anchor` 拒发。**唯一仍挂触发条件②**：③ 票据投递的 A2A `x-zeus-*` 字段（对端协议未定义，不臆造）。活基线 1049/97 → **1060/99**。
- **进展（2026-10-03 第四批，**未销项**）**：新增真进程验收资产 `scripts/verify-execute-delegation.mjs`（`npm run verify:execute-delegation`，9 步，dist 出货实现 + 真 socket 执行 Agent + 真签发端点：execute 无票据拒发零出站 / 签发端点 201 / 带票 execute 单次派发且 agent 实收 / 同票重放拒发 / 审计链 denied=2 issued=1）。**真进程当场抓到并已修一条 inject 测试看不见的缺陷**：`HttpDeps.executionDelegationAudit` 在 server.ts 定义并调用，但 serve.ts 装配 startServer 参数时**从未传该桥**——真进程里签发端点 201 成功、审计链却静默无 `execution-delegation-issued`（单测 harness 直接构造 HttpDeps 字面量，覆盖不到进程入口，deferred #25 纪律）；serve.ts 补 `executionDelegationAudit: kernel.executionDelegationAudit` 后 issued=1 转绿。**仍挂触发条件②**：③ 票据投递的 A2A `x-zeus-*` 字段（对端协议未定义，不臆造）。

### #34 监督台 Web UI（内核 API 之上的只读监控 + 裁决薄层）
- **缺口**：Zeus 当前无任何图形界面（零 HTML / 前端资产），使用者只能通过 HTTP JSON API（curl / 程序调用）、TypeScript 库或 CLI 操作，默认使用者是开发者 / 运维。产品定位中的两个承诺在真实负载下无法只靠 API 兑现：① "人保留决策权"——并行多 Agent 扇出时，在 JSON 里看分歧、处理 escalation、做 approve/reject 不具可操作性；② 信任与数据主权需要可见——审计时间线、名册/吊销状态、备份状态、跨域授权记录需要可视化才能提供"可验证的安全感"。无 UI 也使产品画像中的个人用户与企业采购方不可达。
- **为什么登记不做**：① 当前关口（A2–A5、B 系列、Zeus↔loom 联调）全部在仓库外，扇出 / 升级 / 授权的交互形态尚未在真实多 Agent 环境定型，此时做 UI 必然返工；② 护城河是运行时内核而非界面，过早投入稀释精力；③ "无官方 UI"客观上强制所有能力走 API，保证内核可被任意客户端（IDE 插件、CLI、Web、企业内网门户）复用；先做官方 UI 容易使其成为唯一入口并诱导在界面层加入私有旁路，违反三条接入通道约束。
- **触发条件**：① M3 收尾——Zeus↔loom 联调通过、≥2–3 个真实执行 Agent 在册受调度（与 #9 / C 系列"≥3 真实 Agent 压测"同口径）；② 识别出第一个非技术使用者（个人或企业真实场景），UI 需求由真实使用验证而非猜测。
- **进展（2026-09-30，**未销项**，触发条件①②均未满足）**：方案 D 终端监督台在第一版三类页面上推进——① 只读监控：除内核状态/并发指标/名额外，新增**扇出/决策时间线**，消费现有 `GET /api/audit?limit=N`（零新增内核端点），25 个 audit decision 一一映射语义 token，审计面未挂载/无权限时显式降级为"不可用"而非空白；`src/tui/client.ts` 加 `timeline(limit)`。② escalation 裁决（approve/reject/resolve+立场）与 ③ 授权吊销（名册 DELETE + y/N 确认）前一批已在。TUI 测试 25 → 34（新增 `tests/tui-client.test.ts` 4 例、render 时间线 3 例、audit token 2 例），全库活基线 827/89 → **836/90**。仍**不触发 Web 立项**：方案 A（Web v1）及其 token 机器可读源/CSS 生成物继续等 M3 收尾（Zeus↔loom 联调 + ≥2–3 真实执行 Agent 在册）与首个非技术使用者。
- **进展（2026-09-30 第二批，**未销项**）**：方案 D 只读监控再补**数据域与跨域授权台账**——`GET /api/domains` 现有的挂载域（个人/企业、租户、只读、条目数）与 personal→enterprise 授权清单渲染成一屏，与时间线的 `domain-*` 审计事件互补（事件是流水、台账是当前态）；面未挂载（Realm 未装配）时显式降级。`src/tui/client.ts` 加 `DomainsView`/`domains()`，快照并发拉取且列为附加面（失败降级 null，不拖垮 roster/escalations 权威面）。**真机抓到一条真缺陷并修复**：`/api/domains` 的 `tenant` 是结构化 `{org,department?,member?}`（与内核 `formatTenant` 同口径），TUI 初版类型误写成字符串导致渲染成 `[object Object]`；改为按段 `/` 拼接（`acme/eng`），双域临时服务真机复验通过。新增 render 2 例 + client 2 例，TUI 测试 34 → 38，全库活基线 836/90 → **840/90**（文件数不变）。授权的**签发/吊销写操作仍走 curl/API**（#34 第一版授权类页面的"操作"部分待 Web v1，TUI 先只读）。
- **进展（2026-09-30 第三批，**未销项**）**：方案 D 把第三类页面的**写操作**补齐——跨域授权可在 TUI 直接签发与吊销，仍只调现有 `POST/DELETE /api/domains/grants`（无新内核端点）。命令：`g<企业域#> <subject> <r|w> [签发者]`（只能对企业域，个人域在客户端拒绝且不发请求）签发、`k<授权#>` 吊销，均 y/N 二次确认、写后重绘；数据域块给域与授权台账加 `#编号` 与命令提示。**标识符大小写保真**：解析器动词大小写折叠但 subject/grantedBy 原样透传（修掉初版整行 lowercase 会破坏机器名的问题）。端到端真机验证（真实 HTTP client + 队列 IO 驱动 createDeck 打 :6404）：`g2 loom r` → 台账 +1，`k1` → 归 0，审计留 `domain-grant-issued`/`-revoked` 两条（注：管道喂 stdin 会因 readline 时序丢行，故真机走控制器注入而非 cli 管道，写逻辑另有单测覆盖）。测试 +10：commands 3（解析/大小写/错误分支）、controller 5（签发确认门、个人域拒绝、拒签不写、吊销按台账号、标识符大小写）、client 2（POST 体/4xx、DELETE 编码），TUI 测试 38 → 48，活基线 840/90 → **850/90**。至此方案 D 第一版三类页面（只读监控/裁决/授权）在终端全部可操作。
- **进展（2026-10-03，**未销项**）**：**方案 A（Web v1）经用户以 owner 身份拍板提前激活并落地**（触发条件①未满足但用户决定优先，与 TUI 同口径：UI 仅消费现有 HTTP API、零新增内核端点、无界面私有逻辑）。产物 `web/supervisor/index.html`（单文件自包含、原生 JS、hash 路由三视图）：① 只读监控——内核状态（/api/state）/ 并发指标（/api/metrics，含 perVassal 延迟）/ 名册（/api/roster）/ 扇出·决策时间线（/api/audit）/ 数据域与跨域授权台账（/api/domains）；② escalation 裁决——队列列表 + approve / reject（task-input）与 resolve+立场（intent-conflict），备注进审计；③ 跨域授权——签发（POST /api/domains/grants，只能选企业域）与吊销（DELETE，y/N 二次确认）。连接配置（API base + bearer token）存 localStorage，首访未配置落连接引导页。**为让浏览器跨域消费现有 API，补了一个最小可选传输层配置**：`HttpDeps.corsOrigins`（精确 Origin 白名单匹配 + OPTIONS 预检 204，无通配回显、无 credentials），serve.ts 从 `ZEUS_CORS_ORIGINS`（逗号分隔）读入，**默认空 = 行为不变**；4 项测试（未配置无头 / 白名单回显 + Vary / 非白名单不放行 / 预检 204）。**浏览器真机 E2E 通过**（computer-use 驱动 Chrome + 真服务 + 真 socket agent）：连接测试 → 监控视图真实数据（内核状态/指标/perVassal/名册/时间线/数据域）→ 裁决/授权空态与表单渲染全部验证。启动：`ZEUS_CORS_ORIGINS=http://127.0.0.1:5173 node dist/http/serve.js` + `python -m http.server 5173 --directory web`，浏览器打开 `http://127.0.0.1:5173/supervisor/index.html`。
- **建议做法（决定后）**：第一版只做三类页面——扇出 / 决策时间线的只读监控、escalation 队列裁决（approve / reject / resolve / 补参）、授权签发与吊销操作；配置、备份、技能管理等继续走 CLI / API。UI 仅消费现有 HTTP API、内核零改动，不引入界面私有逻辑；定位是"监督台"（人是决策者），不是全能控制台。验收：UI 每个写操作都能在审计日志回读且与直接调 API 等价；无新增内核端点或私有通道。
- **进展（2026-10-04，**未销项**）**：**Web v1.1 / v1.2 / v1.3 一批批推进，全部零内核改动、纯消费现有 HTTP API**——v1.1（Active work 114）：派发意图表单（POST /api/intents 自动跳转作战室）+ 意图作战室详情（意图/决策/分支三板块）+ SSE 实时事件流（branch-ended/intent-finished 增量渲染、settled note 去冗余）+ 取消派发（confirm 二次确认；内核 `cancelIntent` 对 running 分支当时恒空操作，UI 诚实提示能力边界）；并修复传输层真 bug——SSE `reply.hijack()` 后 writeHead 覆盖 onRequest hook 的 CORS 头，浏览器事件流被拦，按 `corsOrigins` 白名单在 writeHead 补 ACAO+Vary。v1.2（Active work 115）：意图识别入口（POST /api/intents/recognize 命中→[以此派发]预填、未命中 reason 呈现）+ DAG 作战室视图（分层/关键路径/节点状态着色，根意图 404 分支也触发 loadDag）+ 派发 loading 态 + SSE 断线指数退避重连 + 分支状态渲染修复（§7 cancelled 不再误显示失败）。v1.3（Active work 118）：审计时间线过滤条（afDecision 动态下拉 / afVassal 服务端 / afKeyword 前端即时 / afCount 计数+空态）、并发趋势面板（SVG 双线 40 点环形 3s 采样、峰值/采样计数）、侧栏待决徽标全局刷新（非裁决视图 10s 轮询）、意图历史回写（打开详情 rememberIntent completed/failed，localStorage 持久化）。浏览器真机 E2E 每批全链路验证（过滤三态 / 派发期间趋势在途 1 / 派发闭环 recent 回写 / 徽标无 console 错误）。**仍不销项**：触发条件②（首个非技术使用者）与①（Zeus↔loom 联调 + ≥2–3 真实执行 Agent 在册）仍未满足；UI 仍坚持"监督台"定位，配置/备份/技能管理继续走 CLI/API。
- **进展（2026-10-04 第二批，**未销项**）**：**Web v1.4（Active work 119）再补六个监督台本职只读/治理面，仍零内核改动、零新路由、全消费已挂载 HTTP API**——作战室决策回放（replay text）与结果责任链（accountability：执行 Agent→部门 lead→裁决 driver、未安置单列）、组织编制视图（org/chart）、目录视图（skills + connectors 只读，连接器令牌只显 hasToken 不回显）、名册吊销/恢复按钮（DELETE/reinstate，confirm 二次确认）、内核状态决策后端徽章（rules-only 或 kind/model + 仲裁/judge 门限）；浏览器真机 E2E 六子项全过（含吊销→恢复闭环、令牌 no-leak）。**仍不销项**：触发条件①（Zeus↔loom 联调 + ≥2–3 真实执行 Agent 在册）与②（首个非技术使用者）均未满足；目录仅只读可见，连接器 connect、技能注册、配置与备份仍按"监督台不是全能控制台"的定位走 CLI/API。

### #35 出站 URL 守卫未覆盖 DNS 重绑定（已销项）
- **缺口**：2026-10-01 修 A-12（注册与连接器接口的 SSRF 面）时，出站 URL 守卫（HTTP 面与 A2A 出站共用）对**非 IP 字面量主机名一律放行**——它只判字面 IP 是否落在非全球可达地址段。因此把主机名做成 A 记录指向私网（DNS 重绑定）仍可绕过守卫，指到 `169.254.169.254` 一类内网端点。守卫默认拒绝 RFC 6890 特殊用途段（RFC1918、`169.254/16`、CGNAT、多播/保留段、IPv6 ULA/link-local、IPv4 映射/兼容/NAT64 编码），环回 `127/8` 与 `::1` 按本地优先放行；逃生舱 `ZEUS_OUTBOUND_ALLOW_HOSTS`。
- **为什么登记不做**：完整防护（连接前解析、校验解析结果、连接时再核对实际对端地址以防 TOCTOU）需要一个自持 resolver + socket 层钩子，成本与风险超出本次 A 级修复范围；且本地优先部署里出站目标多为可信内网与环回，威胁模型需先明确。
- **触发条件**：① 部署形态出现"Zeus 与被注册/被连接的 Agent 不在同一信任域"；② 安全评审要求出站面达到"解析即校验"口径。
- **建议做法（决定后）**：解析主机名 → 逐个结果地址过同一地址段守卫 → 连接后核对实际 peer 地址（防解析-连接间隙重绑）；逃生舱语义保持不变（`ZEUS_OUTBOUND_ALLOW_HOSTS` 命中即跳过检查，含解析结果）。
- **销项（2026-10-03，已销项）**：按建议做法在 `src/util/outbound-dns.ts` 落地——受守卫的 connect lookup 解析主机名 → 逐地址过同一 RFC 6890 守卫 → 只回传通过地址，TCP 连接 pin 到该地址（连接器不再二次解析，闭合解析-连接间隙），含任一非公开地址即 fail-closed；三个出站面默认 fetch（`registry/registry.ts`、`dispatch/client.ts`、`mcp/client.ts`）统一走 `guardedFetch`（undici Agent），逃生舱语义不变。15 项测试（缺陷植入 4 红）。触发条件②（"解析即校验"口径）提前满足。

### #36 TypeScript 严格性还有一项未启用（`noUncheckedIndexedAccess`）✅ 已销项（2026-10-02）
- **缺口**：b46 修 §4.6「严格性有缺口」时只启用了 `noUnusedLocals`（暴露并清掉 18 处真死代码），其余三项仍在 `tsconfig.json` 之外。同仓实测规模：`noUncheckedIndexedAccess` **400** 处、`exactOptionalPropertyTypes` **40** 处、`noUnusedParameters` **7** 处（量法 `npx tsc --noEmit --<flag>`；**flag 必须带 `--` 前缀**，否则被当成文件参数，会报出假的"1 条错误"）。
- **为什么登记不做**：三项都是**语义变更**型迁移——数组下标由 `T` 变 `T | undefined`、可选属性由"可缺省"变为"不可显式传 `undefined`"、未用参数需改名为 `_x` 或删除。一处 flag 改动牵动大量调用面，与 A/B 级"行为缺陷"不是同一类工作；塞进某一个原子修复会让 diff 不可审。
- **触发条件**：① 下一次大范围重构（集中改 `listAll`/遍历路径）时顺手迁移；② 出现一次由"下标越界返回 `undefined` 未被处理"或"可选属性被显式传 `undefined`"造成的真实缺陷。
- **建议做法（决定后）**：按 flag 逐个原子迁移（`noUnusedParameters` 7 处最小 → `exactOptionalPropertyTypes` 40 处 → `noUncheckedIndexedAccess` 400 处），每步单独提交并跑全量门禁；迁移前先确认 `tsconfig.build.json` 的 `include: ["src"]` 面受不受影响，或一并收口。
- **进展（2026-10-02，最小档已迁移，本条仍未销项）**：`noUnusedParameters` 已启用并清零——实测 8 处（登记 7 处 + `bench-capacity.mjs` 的 `startMockFarm(count,…)` 参数，后者是 deferred #37 后半段把 scripts 纳入检查后新暴露的），全部按 `_` 前缀改名收口（公共导出 `createTraceSink` 的 `backend`/`model`、`recomputeResult` 的 `now` 保留签名只改名，测试 mock 回调同法）。启用后 `npm run typecheck` 与 `npm run build` exit 0、`npm test` 1012 / 94 全绿、`smoke:core` 36/36。**中档量法刷新**：`exactOptionalPropertyTypes` 现量 **41 处**（登记 40 + scripts 纳入检查后新浮出 1），`noUncheckedIndexedAccess` 仍为 400 档；两档待触发条件。
- **销项（2026-10-02，末档迁移完成，本条已销项）**：`noUncheckedIndexedAccess` 实测 **434 处**（登记 400 + scripts 纳入检查后新浮出 34）全部清零并正式启用（`tsconfig.json` 开启 `noUncheckedIndexedAccess: true`，`npx tsc --noEmit` 0 错）——`strict` 系四 flag（`strict` / `exactOptionalPropertyTypes` / `noUncheckedIndexedAccess` / `noUnusedLocals+Parameters`）全开，三档全部销项。按模块分七批（A util/oversight/dispatch 37 → B orchestrator 34 → C memory 53 → D realm/skills/tui 82 → E diary/org/tui/vault 80 → F doc-consistency/http/audit/registry/conflict 61 → G decision/scripts/state 53），错误计数 434→397→341→282→200→114→53→0 递减验证，src 与 tests 分组共 12 个原子 commit。**手法统一两种，零运行时行为变化**：长度守卫/正则捕获组/`indexOf` 结构保证处 `!` 断言（带注释）；循环体元素与缺失语义等价处 `?? ''`/`?? 0`/`?? 1` 兜底。**`scripts/*.mjs` 纯 JS 不能用 `!`**——统一 `??` 兜底或 JSDoc 标注（`scan-secrets.mjs` `PATTERNS` 补 `@type {Array<[RegExp,string]>}` 消 TS2769）。**关键教训**：scripts 测试动态 import `dist/` 编译产物，本地直跑挂 `publishRootKey is not a function`，`npm run build` 后 10/10 绿（与 Active work 93 同根）。**Windows 本机门禁如实记**：`npm test` 990 绿 / 25 失败全为环境性（目录 fsync EPERM 17 / chmod 0600 断言 4 / symlink EPERM 4，逐类 stash 对照验证与改动无关），`smoke:core` 31/36（0600 chmod ×2 + SIGTERM 持久化连锁 ×3，Windows 信号语义差异）；typecheck/build exit 0、doc-consistency 9/9，活基线数字 1015/94/36 以 CI 口径为准。

### #37 `scripts/*.mjs` 未纳入类型检查 ✅ 已销项（2026-10-02）
- **缺口**：`tsconfig.json` 的 `include` 覆盖 `src`、`tests` 与两个 vitest 配置；7 个 `scripts/*.mjs`（验收 / 压测 / 冒烟 / 密钥生成 / 时钟偏移 / 代理设置等）不受任何静态检查。实测开启 `allowJs + checkJs` 后 scripts 报 **216** 条诊断（量法：仓库根临时建 standalone probe tsconfig，`allowJs:true, checkJs:true`，`include` 加 `scripts`，`tsc -p` 跑完即删；两个 vitest 配置的对应诊断数为 0，已并入 b46 的 `include`）。
- **为什么登记不做**：216 条里相当部分是 JS 惯用法噪声（隐式 `any` 参数、可选链前的收窄），先要定"检查到什么档"——只保真机脚本（`gen-rsk-key`/`smoke-core`）还是全部——属工程口径决定，不是补漏。
- **触发条件**：① 某个 script 因类型错误在真机跑挂而单测看不见；② 决定把验收 / 冒烟脚本提升为"受检资产"。
- **建议做法（决定后）**：先给 `scripts/gen-rsk-key.mjs` 与 `scripts/smoke-core.mjs` 两个出货级脚本加 `// @ts-check` + JSDoc，再评估其余五个是否跟进。
- **进展（2026-10-01，按建议做法的前半段执行，本条仍未销项）**：两个出货级脚本已受检——`tsconfig.json` 开 `allowJs` 并把这两个文件列入 `include`，`checkJs` 保持关闭（按文件 opt-in，不是仓库级开关）。实测：出货级两脚本在 `allowJs+checkJs` probe 下由 **53 条**诊断降到 **0**（`gen-rsk-key.mjs` 原本就是 0，53 条全在 `smoke-core.mjs`），全部以标注收口而非放宽代码——`boundPort()` 处理 `address()` 的 null / 管道形态、环境表类型化使 `delete` 继承变量成为合法操作、`verifyRoster` 点名 `execFileSync` 抛出的形状，其余是 JSON 回调的参数与返回标注。**缺陷植入**：把 keygen 的输出路径强转为 number，检查器在该文件报 3 条；还原后归 0。行为不变：`npm run smoke:core` 仍 36/36、`npm test` 1012 / 94 全绿。
- **销项（2026-10-02，后半段收口，本条已销项）**：其余五个 `scripts/*.mjs`（`acceptance-real-fanout` / `acceptance-standard-a2a` / `bench-capacity` / `clock-skew-setup` / `verify-roster`）全部纳入受检——按同一口径（`// @ts-check` opt-in + `include` 列入 + JSDoc 标注收口），五个文件在 probe 下由 **163 条**诊断降到 **0**（verify-roster 50、acceptance-real-fanout 35、acceptance-standard-a2a 4、bench-capacity 72、clock-skew-setup 2；全量 216 = 前半段 53 + 后半段 163 对账闭合）。收口全部为标注而非放宽代码：`opts`/`PARAMS` 等无类型对象补 typedef 或内联类型、`server.address()` 断言 AddressInfo 取 port、JSON 载荷回调参数显式标 `@type {any}`（协议载荷无静态 schema，标注是诚实口径）、catch 的 `unknown` 走 instanceof/形状断言收窄。**缺陷植入**：把 `usage` 的 `@param {string}` 强改为 number，verify-roster 报 19 条；还原后归 0。行为不变：`npm run smoke:core` 仍 36/36、`npm test` 1012 / 94 全绿、`npm run typecheck` 在 include 覆盖全部 7 个脚本后 exit 0。

### #38 CI 静态质量闸门缺位（lint / 依赖漏洞扫描 / secret 扫描）✅ 已销项（2026-10-02）
- **缺口**：`package.json` 无 `lint` 脚本，`.github/workflows/ci.yml` 只跑 typecheck / build / test / clock-skew / smoke。当前没有 lint（风格与常见错误）、依赖漏洞扫描、secret 扫描三道基础设施级闸门。
- **为什么登记不做**：三道都**要先选型并新增依赖**（ESLint 配置面、`npm audit`/OSV 策略、gitleaks 之类），属工具决定；在一个没有 lint 基线的仓库里一次性接入，会把全部历史风格问题倒进 CI。
- **触发条件**：① 首次外部贡献者提交（需要客观风格底线）；② 出现一次依赖链漏洞或误提交密钥的真实事件。
- **建议做法（决定后）**：三道各自独立提交；lint 先"只报 error 级、不阻断 warning"，漏洞扫描先只对生产依赖，secret 扫描先只扫变更集。
- **销项（2026-10-02，三道全部落地，本条已销项）**：① **ESLint 基线**（eslint@10 flat config + typescript-eslint@8 recommended，devDeps 新增）——只留 error 级：recommended 中与 tsconfig 重复的 `no-unused-vars` 关掉，`no-explicit-any` 基线关掉（24 处既有协议载荷 `any` 是 deferred #37 已登记的诚实口径，待专项迁移再开）；跑通后仅两类违规（24 any + 1 prefer-const + 1 @ts-ignore 改 @ts-expect-error），全部按此策略收口，`npm run lint` exit 0。② **生产依赖漏洞扫描**：`lint:audit` = `npm audit --omit=dev`，官方 registry 实测 0 漏洞（本机 npmmirror 镜像不支持 audit 端点，CI 用官方 registry 不受影响）。③ **secret 扫描**：零依赖 `scripts/scan-secrets.mjs`（10 组保守模式：私钥头/GitHub PAT/gho/npm/Slack/AWS/Anthropic/Google/OpenAI），默认扫全部 tracked、`--diff <base>` 只扫变更集，命中 exit 1 带 file:line；全量 247 文件 clean，负向植入（tracked 文件加假 `ghp_` token）命中且 exit 1；脚本按 #37 口径纳入 `@ts-check` + tsconfig include。CI 三步已接入 verify job（Lint / Production dependency audit / Secret scan），三个原子 commit（ESLint 基线 / audit+secrets / CI 集成）。

### #39 CI 未覆盖的构建与线上验收闸门（部署镜像构建冒烟、`acceptance:fanout`）✅ 已销项（2026-10-02）
- **缺口**：`npm run smoke:core` 已在 CI 覆盖"编译产物真进程 + 真 socket 核心链"，但 **Docker 镜像构建**只在评审轮手工实构实跑（Dockerfile 改动无 CI 验证），**`acceptance:fanout`** 需线上真实外部执行 Agent（`CARD_URL=https://pr-helper-ten.vercel.app/...`）与出网许可，不适合当每次推送的 pass/fail 门。
- **为什么登记不做**：镜像构建冒烟要在 CI 里跑 `docker build`（runner 能力与成本）；线上验收依赖外部服务可用性与代理，属**外部条件**而非库内缺口。
- **触发条件**：① Dockerfile 改动引入一次镜像构建失败、到上线才发现；② CI 环境提供可用的外部 Agent 或带 Docker 的 runner。
- **建议做法（决定后）**：镜像冒烟先行（CI 加一步 `docker build`，不 push 镜像）；线上验收保持"评审轮手工跑 + 记录"，不入门禁。
- **销项（2026-10-02，镜像冒烟落地，本条已销项）**：CI 新增独立 `image-smoke` job（ubuntu-24.04，docker build 不 push + 两条运行时冒烟：镜像内零依赖密钥脚本 `gen-rsk-key.mjs` 可生成密钥、编译产物 `require('./dist/index.js')` 可加载）——Dockerfile 或产物变更从此在每次推送时验证。本地实构实跑两条冒烟命令通过后清理镜像。`acceptance:fanout` 线上验收按建议保持"评审轮手工跑 + 记录"，不入门禁。

### #40 执行后反思闭环（Agent 自我改进）
- **缺口**：决策级反思已有对应物（E1.3 对抗式 LLM-as-judge 复核 + S2 仲裁，独立主体复核避免同后端自评），复盘数据底座已齐（E4.7 审计链 + E1.6 离线决策回放 + E8.3 Diary）；缺的是**执行后的闭环**——分支失败归因 → 教训写回（记忆/规则/阈值）→ 影响后续派发。目前失败只进审计与分支 reason，不会反过来改行为。
- **为什么登记不做**：设计写回逻辑需要真实执行 Agent 的失败样本分布。凭空设计会重蹈 #9 的教训（mock 的失败模式是编的，只会把一个猜测变成锁定的猜测）；且可上线 MVP 判定仍未达成（真机联调/密钥托管在外），反思/自我改进是 P2 之后的增强，现在立项违反优先级。
- **触发条件**：① 首个真实执行 Agent 长期运行、积累可统计的失败样本（同 #9 的 ≥3 真实 Agent 压测数据面）；② 同一类失败反复发生、操作者只能靠人工翻审计的报障出现。
- **建议做法（决定后）**：先做一个**只读的失败归因摘要纯函数**（从审计 reason 聚合 + E1.6 回放重建，只读、可验证、可回滚——design constraint 2），看聚合结果是否真有可写回的稳定规律，再谈写回；写回面必须可审计（写什么、何时写、可否吊销）。
- **2026-10-07 第一段（只读归因）已落地（Active work 143）**：`src/reflection/failure-attribution.ts` —— `attributeFailures(entries: AuditEntry[])` 纯函数：按失败类目（dispatch/abort/refused-skill/refused-policy/refused-unknown/refused-revoked/delegation/ack）× 执行 Agent 聚合，输出 totals / byCategory / byVassal（rate + sampleReasons 上限 5）/ patterns（稳定或提示性两档，`writebackCandidate` 为真才值得进写回设计——本模块只读、永不写回）；`participantsToEntries()` 把决策回放参与方映射为审计条目并入同一聚合（对齐 `src/orchestrator/replay.ts:62-101` 的 `ReplayParticipant`/`replayDecision`）。测试 `tests/failure-attribution.test.ts` 10 例绿。**写回面仍待触发条件**（首个真实执行 Agent 长期运行的失败样本分布，本条触发条件 ①）。
