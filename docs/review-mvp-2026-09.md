# Zeus 项目级评审：功能性 / 完整度 / 可上线（MVP 判定）

> 状态：**现行（评审报告 v0.9，2026-09-25，deferred #13/#14 收口后重判 MVP）**。评审对象：Zeus 仓库 `dev` 分支 HEAD `f4727f1`（v0.4 起点 HEAD `a7e4ce9`；v0.5/v0.6 为纯文档更正与销项，v0.7/v0.8 含代码；**v0.9 把"操作者能不能摸到三纲"当问题重问，并据此改判阻塞性质——判定以 v0.9 为准，其下各节为历史**）。
> 评审方法：PRD 逐条核对（代码 + 测试证据）、全量验证实跑（vitest / tsc / build）、容量压测实跑（四场景）、部署/运行入口与制品面检查（Dockerfile / serve.ts / RSK 工具）。**v0.9 追加两问法**：① 每条支柱不查"有没有实现"，查"操作者从文档出发能不能走到它"（grep 到动词的**读取方**才算执行点）；② 首跑路径在**编译产物真进程**上按 `.env.example` 原样跑，并做 A/B 对照定位因果。
> **结论一句话（v0.4，v0.6 更新其剩余关口清单）**：**库内"内核 + 可部署制品"级 MVP 已达成——v0.1 所列 5 个硬阻塞在代码/制品侧均已有对应实现；产品级"可上线 MVP"仍未达成，但剩余关口已全部是仓库外验收动作（真机 docker build/run、真机封臣部署与 loom 联调、RSK 实际托管/公钥发布、Jev key。**push 后云端 CI 这条已于 2026-09-25 销项，见下方 v0.6**），库内已无 P0 功能缺口。**

> **【2026-09-22 六切片批次后 · 销项更新 v0.2】** 下列为评审 v0.1 之后的库内进展（全量 **166 测试绿 / 22 文件**，typecheck/build 过；以下为现状，原 §1–§7 快照保留不改）：
> - 硬阻塞 **#3 E2.2 Skill 注册中心 → ✅ 销项**：`src/skills/`（多版本共存、deprecate 标记、按名/域/标签检索、registerFromCard、resolveTeam 多技能组队且歧义不静默选边，10 测试）。E2.4 组队解析一并 ✅。
> - 硬阻塞 **#4 E6.2 决议反馈闭环 → ✅ 销项**：冲突经 onConflict 入监督台（幂等）、decideConflict 校验立场、applyConflictResolution 纯函数回写聚合决策并重算状态（6 测试）。E6.3 补参重派**骨架**（resumeBranch）已落地，"approve 一键自动重派"的装配/HTTP 闭环随 H2（E6.3 仍 🚧）。
> - 硬阻塞 **#2 E5.3 持久化 → 🚧 大幅缓解但未全销**：`src/state/kernel-state.ts` 把封臣注册表（含已吊销）、升级队列（重建幂等索引）、编排意图结果+原始请求原子落盘（tmp+rename）并可恢复，重启后幂等重放与 resumeBranch 可用（6 测试）。**未做**：Realm 连接状态未纳入快照、文件存储未接入进程启动装配/H2——长驻服务"重启自动恢复"仍需接线。
> - 软阻塞 **#8 E1.7 可观测 → 🚧 库内已落地**：`ConcurrencyMetrics`（在途数/并发峰值/队列深度/完成失败超时/各封臣延迟 p50·p95/失败率，5 测试）；HTTP 指标端点随 H2。
> - 非阻塞增强：**完整 DAG（S3）→ ✅**（`src/orchestrator/dag*.ts`，拓扑分层/关键路径/部分失败跳过，6 测试）；**决策后端工程切片 → ✅**（`src/decision/`，模型无关端口 + Jev/LLM 适配器 + 降级，9 测试；Jev 真实 endpoint/envelope 待有 key 真机核对）。
> - **仍未销项（故产品级可上线 MVP 判定不变：仍未达成）**：硬阻塞 #1 部署形态、#5 生产 RSK 密钥；软阻塞 #6 E4.8 真机验收、#7 真机联调、#9 push + 云端 CI 首绿（需授权）；以及 E5.3 的启动装配接线与 Realm 持久化、E10.4 容量压测。

> **【2026-09-22 A 批次（G1/G4/G5/G6）后 · 销项更新 v0.3】** 评审 v0.2 之后的库内进展（全量 **217 测试绿 / 31 文件**，tsc 过；以下为现状，原 §1–§7 快照保留不改）：
> - **G1 封臣上线入口（致命缺口）→ ✅ 销项**：`POST /api/vassals`（拉 card + fealty 校验注册，卡片不可达 502）、`DELETE /api/vassals/:name`（吊销，未知/已吊销 404）；`ZEUS_VASSAL_SEEDS` 支持启动 seed，已在状态快照中的 URL 跳过不重复拉取。长驻服务不再以空 registry 启动。
> - **G4 Realm 连接持久化 → ✅ 销项**：KernelSnapshot 增 `realms`（连接参数 root/realmId/type/readOnly，向后兼容可选字段）；`bootKernel` 装配 FsRealmStore，重启自动 reconnect 重建检索索引；`ZEUS_REALM_ROOTS` 支持启动连接；已持久化 root 不可达时 fail-loud 拒启，不静默丢域。
> - **G6 E6.3 一键补参重派 → ✅ 销项**：`POST /api/escalations/:id/approve-resume` 携带 params，approve 后经新增 `Orchestrator.findIntentForBranchRun` 定位意图并自动 `resumeBranch` 重派、重算整意图。
> - **G5 H3 服务端 SSE → ✅ 销项**：编排器发出 branch-started/branch-ended/intent-finished 进度事件到新增 `ProgressHub`；`GET /api/intents/:id/events` 输出 SSE（15s keepalive ping、已完成意图回放单事件后关闭、无 hub 时未知意图 404）；hijack 后 `flushHeaders` 保证客户端即时收到响应头。
> - **产品级可上线 MVP 判定仍为：未达成**。剩余关口全部在仓库外或需授权，库内已无法继续闭环：E4.8 真机验收（pr-helper 部署）、Zeus↔loom 真机联调、push dev→云端 CI 首绿（需授权）、E10.4 容量压测基线、Jev 真实 endpoint/key 核对。

## v0.5 更正（2026-09-25，唯一变化是 E4.8/M3 的阻塞归因）

> v0.4 的功能性/完整度/MVP 判定结论**不变**；本节只修一处被 v0.1→v0.4 一路转述、从未被核实的错误陈述。

- **错在哪**：v0.3/v0.4 都把"E4.8 真机验收"的阻塞写成 **"pr-helper 部署"**（"剩余关口全部在仓库外…E4.8 真机验收（pr-helper 部署）"）。**事实：pr-helper 早已部署在生产并每天被使用**（`https://pr-helper-ten.vercel.app`）。核实依据读自 `../pr-helper` 仓库：`vercel.json:9` 将 `/.well-known/agent-card.json` rewrite 到 `/api/a2a/agent-card`；`api/a2a/agent-card.ts` 引入 `handleJsonRpc` + `createTaskStore`；`docs/verification-report.md:40` 记 Production 域；`handoff.md:211` 说明该域签发 GitHub OAuth 会话。
- **正确说法**：E4.8 仍 🚧，但**卡点是"没人对线上执行过一次这条验收"，不是"待部署"**。zeus 与 pr-helper 两边的记录里都没有任何一次线上 A2A 验证。关闭动作：`BASE_URL=https://pr-helper-ten.vercel.app node scripts/acceptance-standard-a2a.mjs`（默认 `deployment-health`，只读）。
- **对 M3 的连带重估**：M3（真机闭环）此前被判为"制品就绪、真机未验"，语气像是要等外部工程。**实际只差执行**：封臣在生产、Zeus 侧制品（Docker / 持久化 / 注册入口 / H2 驾驶面 / 签名名册）齐备，需要的是跑一次验收 + 起一个 Zeus 实例注册它 + 一次真机扇出。
- **不可由评审者自行完成的部分**：本次评审所在的沙箱到不了该域（本地 DNS 解析到 `199.96.59.95`、TCP :443 不可达；`pr-helper.pages.dev` 只回 SPA 外壳，A2A 函数在 Vercel 侧），**故本条不声称"已验证"**，只声称"已核实该服务的部署事实与代码存在性"。
- **纪律**：本文档链条显示一个可复现的失效模式——**一条过期陈述会被后续每份报告原样继承**（v0.1 写下"待部署"，v0.3/v0.4/PRD/README/handoff 全部沿用）。此后引用任何"待 X / 已 Y"状态句，先跑一条命令核实。

## v0.6 销项（2026-09-25，唯一变化是"push + 云端 CI"这条关口关闭）

> v0.4 的功能性/完整度判定与 v0.5 的归因更正**均不变**；本节只关闭一条从 v0.1 挂到 v0.5 的关口。

- **关闭的关口**：v0.1 起的每一步评审都把"push dev → 云端 CI 首绿（需授权）"列为剩余动作，且历史上只写过"workflow 已备、本地按 CI 序列实跑全绿"。现状：**三次 push 均在 GitHub 侧拿到结论，Node 20.x / 22.x 双矩阵全绿** —— run 36024156638（472/56 文件）、36045209815（512/60）、36061395015（**532/61**，26s/22s），无 flaky 复现。`git rev-list --left-right --count origin/dev...HEAD` = `0 0`。
- **基线随之刷新（v0.4-A 表保留为 2026-09-24 快照）**：现行本机 + 云端基线 = **532 测试 / 61 文件、`tsc --noEmit` 与 build exit 0**，容量侧为**五场景**（原四场景 + E1.5 闸门档），数据与口径见 capacity-baseline v0.3。
- **新增一条 runner 层风险**：每次 run 都重复注解 `ubuntu-latest` 将于 **2026-10-19** 自动迁 Ubuntu 26 —— 换构建机不需要我们改代码，也不需要任何人批准。登记 deferred **#16**（到期前决定钉版还是接受迁移后复验）。
- **对判定的影响（说清楚，不夸大）**：这条关口从来不是功能缺口，所以 **MVP 判定不变**；变的是剩余关口的**性质**——v0.6 之后，清单里**没有任何一条是"等授权/等确认"**，全部是需要真实环境、真实凭证或真实封臣的执行项（真机 docker build/run、对线上跑一次 E4.8 验收、Zeus↔loom 联调、RSK 托管与公钥发布、Jev endpoint/key 核对）。

## v0.8 更新（2026-09-25，E9.1 / E9.2 上岗门收口，并记一条测试结构性缺口）

- **关闭两项 P2**：E9.1 首日岗位简报 ✅、E9.2 上岗即用流程 ✅（设计与边界见 [design-onboarding](design-onboarding.md)）。做法是一个**只负责拒绝的组合层** `src/onboarding/`：四道门各自的证据来自拥有它的模块（编制 E9.3 / 封臣目录 / 域判定 E3.6+E6.4 / 认证 E2.5），**资格每次现算不缓存**——签字之后吊销封臣或撤出名册，资格自己就没了。
- **v0.7 的两类划分当场得到验证**：那批被标为"库内可做、等的是判断不是环境"的工作，同日真的做完了。剩余项随之收窄：库内可推进 = E8.4（传承，P3）、#13、#17、#18；仓库外 = E4.8（**P0 唯一未闭合项**）、E10.2/真机 docker、RSK 托管与公钥发布、Jev key、以及"由真实封臣当一次 Mentor"。
- **一条结构性缺口值得单记（不是本批引入的）**：`fix(registry) 151ab3b` 修的是"fealty 缺字段的卡片能注册、派发时才以 TypeError 崩"。它之所以在 620 项测试全绿的状态下活了四天（`src/registry/registry.ts` 自 2026-09-21 起就这样）：：测注册的 fixture 从不派发，测派发的用例注入 port 从不调 `register()`——两半各自绿，串起来才炸。这不是断言不够多，是**测试里缺少把两个模块串起来的真实路径**；同日两次冒烟（E6.4 签发 nonce、E9.2 卡片 oath）都是真实进程先发现的。评审口径据此加一条：涉及跨模块契约的改动，只看 inject 测试不足以判"已验证"。
- **基线**：**620 测试 / 68 文件**，`tsc --noEmit` 与 build exit 0；门的可失效性做了四次缺陷植入（2 / 3 / 2 / 4 例红），每次改回后 diff 校验字节一致。
- **判定不变**：库内内核级 MVP ✅；产品级可上线 MVP ❌——差的仍是真实环境里跑起来、联起来、签出去。

## v0.7 更新（2026-09-25，E3.6 / E6.4 在库内收口，并更正一处评审自身的判断）

- **关闭两项**：E3.6 企业域三级租户 ✅、E6.4 双域授权与审计呈现 ✅（设计在 design-realm §7，验收细节在 PRD 对应行）。**P0 侧未闭合项仍只有 E4.8**（对线上跑一次验收，纯执行）。
- **这批补的是"可核验性"而不是功能面**：此前 `realmHits` 由调用方自报、内核从不进任何 Realm，所以"声明 personal 域却携带企业域内容"这类越界**没有任何执行点可以拒绝**——边界写在文档里，不在代码里。现在内核自己按 realmId 取数、核对真实域类型与声明是否一致，判定住在唯一函数 `decideRealmAccess` 里，放行与拒绝同脊审计。
- **更正本文档自己的一个判断**：§C 在 v0.4 写"PRD 剩余项无一项能在库内继续闭环"，**这句被后续批次证伪两次**（E3.6/E6.4 正是库内做的）。已改为两类划分：**仓库外执行类**（真机、密钥托管、外部凭证）与**库内可做但需拍板类**（E9.1/E9.2 带教上岗、E8.4 传承、#13、#17、#18）。这与 v0.5 记的"过期陈述被逐份继承"是同一种失效模式，只是这次失效的是评审本身。
- **基线刷新**：本机与云端同口径 **587 测试 / 66 文件**，容量侧五场景（含 E1.5 闸门档）。真实进程冒烟覆盖了本批（挂载租户、访问探针、签发、重启恢复），并**在冒烟中抓到一个"587 项测试全绿但功能实际不可用"的缺陷**（签发接口要求调用方自带 nonce，而我的测试每次都传了 nonce）——这是"仅 inject 测试不足"的新证据。
- **判定不变**：库内内核级 MVP ✅；**产品级可上线 MVP ❌**，差的仍是真实环境里的跑起来、联起来、签出去。
- **本批留下两条诚实的尾巴**（登记而非半做）：**#17** 改租户 / 下线 Realm 无可执行路径；**#18** MCP 资源读取侧没有 actor 概念，故 §7 的规则在那条路径上暂无执行点。

## v0.9 现行评审（2026-09-25，deferred #13/#14 收口后重判：**新增一类阻塞——"缺执行点"不是"缺环境"**）

> **本轮方法 changed**：不再只核对 PRD 勾选与测试数量，而是把三条产品支柱各自的**"操作者能不能走到它"**当问题问，并把首跑路径在编译产物上真跑一遍（A/B 对照，非注入式）。基线：`e74ba8d`+`2a524ee`+两个 docs commit（HEAD `f4727f1`），**658 测试 / 70 文件**、`npm run typecheck` 与 `npm run build` exit 0、`npm audit --omit=dev` **0 漏洞**（生产依赖只有 fastify 一项）；src 80 文件 14 461 行、tests 70 文件 13 164 行、HTTP 路由 67 条
>
> **结论一句话（v0.9）**：**产品核心"完全可用"的 MVP 判定 = ❌ 未达到，且未达到的原因变了。** v0.4–v0.8 反复说"库内已无 P0 功能缺口，只剩仓库外的真机/凭证/发布动作"——**这句话本轮第三次被证伪**：立国三纲里 **MCP 与 Skill 两条支柱缺的是库内的执行点（代码），不是环境**。具体说：一个真实用户今天**无法让 Zeus 带着凭证去调任何外部封臣**，**无法让外部 Agent 调进 Zeus**，**卸载一个 Skill 也停不掉任何一次派发**。同时首跑路径上有两个当场实测出来的阻断（见 §C-1/C-2）。
>
> **但也别读反了**：**个人数据底座这一侧是真达标的**——给目录、检索、记忆、日记、藏宝图（含今天补上的内核状态文件）、签名且一次性的企业写凭证、审计脊、持久化与重启恢复，全部有 HTTP/CLI 入口且被实测走通过。缺的是**协作那一半的门没装完**。

### A. 三条支柱逐条判定（"实现了" 与 "摸得到" 是两件事）

| 支柱 | 代码里有 | 操作者能走到的最远处 | 判定 |
|---|---|---|---|
| **MCP** | ① 客户端 `src/mcp/client.ts`；② 服务端 `src/realm/mcp.ts` + stdio 宿主 `mcp-stdio.ts` | 服务端**实测可跑**：`initialize`→`resources/list`→`resources/read` 全通（`zeus-realm://<id>/manifest\|search\|item`，越界 path 被拒、绝不吐绝对路径）。但它 **只有 resources、没有 tools**（`mcp.ts:122` 明写 "resources only, no tools"），且**只支持 personal + readOnly**（`mcp-stdio.ts` 里 type 是写死的 `'personal'`）→ 企业域/租户/写都进不去。**没有鉴权**（deferred #18）。客户端侧 `tools/list` 能拿，**`tools/call` 全仓库 0 处命中**（含 tests）→ 连接器是"声明+发现"，任何工具都不会被执行；`record.capabilities` 只有一处赋值（`connectors.ts:80`）、**无人读取**，§7 的边界裁剪裁的是一份没有消费者的清单 | **REACHABLE: partial**——只读个人域可演示；"接外部系统"名不副实 |
| **Skill** | `SkillRegistry`（多版本/install/uninstall/deprecate/harden）+ `POST /api/skills*` 全套路由 + `resolveTeam` | **派发路径不看注册中心**：`Orchestrator.fanOut` 用 `lookup.findBySkill(skill)`（`orchestrator.ts:103-106`）→ `entry.card.skills.some(...)`（`registry.ts:140`），即**目标选择只读封臣卡片自报的技能**；`resolveTeam` 全仓库唯一调用点是一条查询路由 `POST /api/skills/team`（`server.ts:1127`）。后果是可证伪的：**`POST /api/skills/:id/uninstall` 停不掉任何一次真实派发**，`harden` 写的 `hardening/permissions` 在 `src/skills/` 之外没有读取者（grep 全库确认）→ 加固是只写元数据。另：`providedBy` 从请求体逐字抄入（`server.ts:1052`）且**不与名册交叉核对**，"提供者身份只能经认证获得"这句话被另一条路由绕开 | **REACHABLE: partial**——登记/检索/生命周期可操作；**它不治理任何东西** |
| **A2A** | 卡片拉取 + fealty 校验 + JSON-RPC/SSE 客户端 + 封签名册 | 上线一个封臣：`POST /api/vassals {cardUrl}` 或 `ZEUS_VASSAL_SEEDS`，需 `x-zeus-fealty{swornTo:'zeus',version:'1'}` + 字段形状校验（`registry.ts:59-75`，今天加的 `151ab3b`）。**但 oaths 是未签名的**（`registry.ts` 里没有任何 verify/signature 路径），签名方向是反的——Zeus 封签**自己的**名册给 bayjf 验。**致命的一条**：`bootKernel` 构造 Dispatcher 时只传 `audit/now/fetchImpl`（`boot.ts` 的 `new Dispatcher(...)`），**从不传 `tokenFor`**，而 `client.ts:67` 是 `if (token) headers.Authorization = ...` → **跑起来的进程对任何封臣都不发 Authorization**，需要 bearer 的真封臣（pr-helper 就是，`scripts/acceptance-standard-a2a.mjs:18` 明确要 `TOKEN=`）在 Zeus 里**根本派发不出去**。且**没有入站面**：src/http 里没有 `/.well-known/agent-card.json`、没有任何 `tasks/*` 路由，外部 Agent 只能被动应答 | **REACHABLE: partial**——对不需要认证的本地 mock 可用；**对真实世界的一个封臣不可用** |

**这一节的意思**：产品哲学第 3 条"一切能力必须能落到 MCP / Skill / A2A"当前**没有一条落到可运营的深度**。这不是文档口径松紧问题——三纲各缺一个执行点，且三个都在库内可写的范围内。

> 一条**公平的反证**（评审不该只报坏消息）：`realmId` 是按 realpath 派生的确定性哈希（`store.ts:118`，实测同一目录两次连接得到同一 id），所以 MCP stdio 进程与 HTTP 内核**说的是同一套 realm 标识**——两扇门之间的寻址天然对齐，缺的只是各自的能力与鉴权，不是"对不上号"。

### B. 里程碑重判（对 PRD §5 的出口标准逐条）

| 里程碑 | 出口标准 | v0.9 判定 |
|---|---|---|
| M1 内核基座 | E3.1–3.3、E4.1–4.7、E5.1–5.2、E6.1、E10.1/10.3 | ✅ 达成（P0 实测 25 ✅ / 1 🚧，未闭合那条是 E4.8） |
| M2 并发决策内核 | E1.1–1.6、E2.1/2.2/2.4、E10.4 | 🚧 **降级为部分达成**：内核与容量真达成，但 **E2.4 的"一意图映射到所需技能并选 Agent"实际走的是卡片自报技能**，注册中心不在路径上 → 出口标准的"技能"这一半是虚的（见 §A-Skill） |
| M3 真机闭环 | E4.8、E10.2、Zeus↔loom、E5.3 | ❌ 仍未达成，**且原因比"没人跑一次验收"更硬**：即便去跑，也会先撞上 §A-A2A 的"不发凭证"——**E4.8 的一部分阻塞从"缺执行"变成了"缺代码"** |
| M4 Realm 开放 | 标准 MCP client 可读 Realm；bayjf 公开验签 | 🚧 只读到一半：个人域只读 stdio **实测可被标准 JSON-RPC 客户端读**（本轮手工验过 initialize 协商与三类 resources 读取），但无鉴权、无企业域/租户、无 `tools/write`、无 streamable HTTP（E3.4 仍 🚧）；bayjf R2 未做（E5.4 ⬜） |
| M5 情感与成长 | 藏宝图恢复演练通过；Skill 可安装/传授 | 🚧 **两条一条真一条虚**：藏宝图演练今天**真过了**（真 CLI 子进程：备份→删→退出码 2→恢复→字节级 sha256 相同→用恢复文件起内核）；"Skill 可安装/传授"有 API 与台账，但**装了不授权、卸了不夺权**（§A-Skill） |

### C. 首跑路径实测（编译产物真进程，非读代码）

**C-1 🔴 文档默认配置下，核心动作直接失败。** `.env.example` 同时给 `ZEUS_STATE_FILE=./data/kernel-state.json` 与 `ZEUS_AUDIT_FILE=./data/audit.jsonl`（第 14/19 行），而**没有任何人在写审计前建目录**：`jsonlAuditSink` 直接 `appendFileSync(path, line)`（`audit.ts:48`），只有状态文件那次 save 才 `mkdir`（`kernel-state.ts`）。A/B 实测（同一台机器、同一构建、只切换这一个变量）：

| 配置 | `POST /api/intents`（指定一个不存在的封臣）返回的 branch.reason |
|---|---|
| 带 `ZEUS_AUDIT_FILE`（新目录，`data/` 不存在） | **`ENOENT: no such file or directory, open '.../data/audit.jsonl'`** |
| 不带 `ZEUS_AUDIT_FILE` | `no registered vassal provides this skill`（这才是正确答案） |

两个缺陷叠在一起：① 审计目录不会自动创建 → 按文档配置就报错；② **审计写盘失败被当作"派发失败的原因"报给操作员**（错误归因：文件系统问题伪装成封臣问题）。附带一条：审计文件用 `appendFileSync` 未指定 mode → **0644 世界可读**，而同一天之前我们刚把状态文件固定成 0600（它里面是 token 与记忆明文）；审计行含 realm/主体/决策明细，这个不一致没有理由。

**C-2 🔴 我今天写进 deployment.md 的备份示例，按原样跑不通。** 评审自查：`docs/deployment.md:207,211`（commit `476353d`，本批）把内核状态文件写成 `kernel.json`，并用 `$ZEUS_DATA_DIR` / `$ZEUS_BACKUP_DIR` 两个仓库里**不存在**的变量；真实默认名是 `kernel-state.json`（`.env.example:14`、`Dockerfile:19`）。因为白名单语义是"点名而读不出即拒绝"，**照文档敲会直接失败**（这正是我们故意设计的行为——错的是文档）。`deployment.md` §2 的 env 表**少了 10 行**（复测口径：代码读 24 个 `ZEUS_*`，§2 表内只有 14 个）：`ZEUS_VASSAL_SEEDS` + 决策三件（`ZEUS_DECISION_BASE_URL/API_KEY/MODEL`）+ OpenAI 兼容三件（`ZEUS_LLM_*`）+ judge 三件（`ZEUS_JUDGE_ENABLED/THRESHOLD/ALLOW_UNCALIBRATED`）；`.env.example` 对全部 24 个是齐的，缺的是给人读的那张表。**订正**：本轮子审计曾把 `ZEUS_VASSAL_SEEDS` 也算进漏项，实测该词在 deployment.md 出现 1 次——**不成立，已剔除**；`.env.example` 对全部 25 个变量的覆盖是完整的。

**C-3 🟠 同一个环境变量，两套互不兼容的语法。** `ZEUS_REALM_ROOTS`：内核按 **逗号**切（`boot.ts:564-566`），stdio MCP 按 **`[:;]`** 切（`mcp-stdio.ts:92-99`）。把 `.env.example` 里那份逗号值喂给 MCP 宿主，会被当成**一个**怪路径 → connect 失败 → 进程 exit 1（该行为实测确认其存在，非推测）。

**C-4 🟠 `.env` 在裸机上根本不生效。** 全仓库无 `dotenv` 依赖、`src/` 内无任何读 `.env` 的代码；只有 `docker --env-file` 与 systemd `EnvironmentFile=` 会解析它。而 `.env.example:2` 写的是"Copy to .env and adjust"——裸机用户照做会以为配好了，实际一个变量都没读进去。

**C-5 🟠 域只能启动时挂，永远不能卸。** connect 只发生在 `bootKernel`（`boot.ts` 的 realmRoots 循环 + 快照重连）；`store.ts` 的重连漂移检查明写 `disconnect is not offered in this build`。**运行时挂载/下线一个目录 = 无路径**（deferred #17 已登记，但它在"能不能日常运营"上的分量比登记时写的更重：改一次目录布局要重启，而重启时旧快照里的 root 若已挪走会**直接拒启**）。

**C-6 🟡 realmId 对操作员不可见。** 启动日志打了决策/并发/审计/状态四类，**唯独不报连了哪些域、id 是什么**；`GET /api/state` 只有计数。唯一能拿到 realmId 的地方是 `GET /api/domains`——而这要求操作员已经知道 bearer 面存在。**新用户的第一句话"我的域叫什么"没有答案。**

**C-7 ✅ 好消息（如实记）**：`/healthz` 与 `Dockerfile` 的 HEALTHCHECK 路径一致且真返回 200；零 env 起进程不崩（RSK 缺省走临时钥 + 响亮告警，`NODE_ENV=production` 才拒启）；Vault CLI 的 README/deployment 示例与实际 flag 名逐字对得上（`--files` 那条错是 C-2 的**文件名**错，不是 flag 错）；今天新加的写凭证面在真进程里 13 项断言全过。

**C-8 🟡 同一个仓库里，"被悄悄忽略的配置值"有两套相反的处理**。`ZEUS_MAX_CONCURRENT_BRANCHES` / `ZEUS_BRANCH_QUEUE_LIMIT` / `ZEUS_AUDIT_MAX_BYTES` 非法 → **拒启**（E1.5 的理由写得很清楚：被悄悄忽略的上限读起来像保护存在）。而 `ZEUS_JUDGE_THRESHOLD='high'` → **静默退回默认阈值**，且有一条测试 `ignores a non-numeric threshold` 把这个行为**钉成契约**（`tests/boot-decision.test.ts:70-76`）。同一类失效，两种答案。本轮**没有擅自统一它**——改法是推翻一条已锁定的测试契约，属于拍板不属于修 bug；已在 `deployment.md` 的该行显式标注这处不一致。

**C-9 ✅ 本轮同时修掉的（原样复跑证据见 handoff Active work 46）**：C-1（审计目录自动创建、写出 0600、轮转后重新收紧、sink 抛错**不再**进入派发结果、不可用的审计路径改为**拒启并点名变量**）、C-3（`ZEUS_REALM_ROOTS` 两扇门统一为逗号；Windows 盘符会被冒号切坏是选它的理由）、C-4（`.env` 谁来解析写进文件头）、C-6（启动日志逐条打印 realm id/类型/租户/可写性）、`ZEUS_VASSAL_SEEDS` 拉不到卡片时改为一行可读的拒启信息而不是栈回溯、deployment.md §2 补齐缺的 10 行 env。**MVP 判定不因这些改变**——它们把"能不能起来"从 ❌ 变成 ✅，但 §A 的三纲执行点缺口一条都没补，所以 §F 的结论仍是 ❌。



### D. 文档比代码强的地方（本轮新增，逐条给行号）

| 位置 | 现在的说法 | 实况 |
|---|---|---|
| `docs/prd.md:119` E7.1 ✅ | "基于 MCP 的外部系统接入（resources/tools/prompts）" | **`tools/call` 全库不存在**，工具清单只被列出来、从不被调用 |
| `docs/prd.md:120` | "连接后只暴露声明边界内的工具" | 边界确实在裁（`connectors.ts:70-76`），但**裁完没人消费** → 该句隐含的"暴露"动作没有发生 |
| `docs/prd.md:64` E2.3 | 行标题"卸载**断权**"；正文其实写得很准（"resolveTeam 即刻显示 missing、默认查询不可见"） | 正文成立，**标题 over-claim**：注册中心不在派发路径上，所以卸载改变的是"组队查询的答案"，不是"这次派派发得出去"。要么改标题，要么让 `fanOut` 过一次 registry |
| `docs/prd.md:65` E2.4 ✅ | "一意图映射到所需技能并选 Agent" | 选 Agent 读的是**卡片自报技能**（`registry.ts:140`），不是技能注册中心（§A-Skill）；`resolveTeam` 不gate任何派发 |
| `docs/prd.md:66` E2.5 | "刻意不暴露 `grantProvider`，提供者身份只能经认证获得" | **字面成立但可达等价**：`POST /api/skills` 的 `providedBy` 由请求体逐字写入（`server.ts:1052`、`types.ts:51-52` 明确允许），而 `providersOf` 读的就是它（`registry.ts:266-273`）→ 不经过任何带教认证就能成为"提供者"。**这不是安全洞**（整条面同为驾驶员 bearer），但它让"只能经认证获得"变成了一句可以绕的话——要么禁掉该字段，要么改措辞 |
| `docs/design-realm.md:84` / `prd.md:157` M4 | "标准 MCP 客户端经授权读 Realm" | 能读，但**无授权层**（#18）、无企业域/租户、无 streamable HTTP；"经授权"三字目前不成立 |
| `docs/product-portrait.md:39` | A2A "可互操作、可委托、可协作" | 委托是单向且**不带认证**的；协作面没有入站协议入口 |
| `docs/product-portrait.md:141` / M3 | pr-helper "真机全链路闭环" | 从未跑过（E4.8 🚧、E10.2 ⬜），且当前代码即使跑也会在认证这一步失败（§A-A2A） |

**v0.9 的纪律追加**：本轮三纲审计里，**"某个 ✅ 需求的关键动词有没有执行点"这一问法**一次性产出了 4 个装饰性检查（connector 边界、skill 卸载夺权、hardening、providedBy 认证）。凡 PRD 打 ✅ 的句子含"阻止/只暴露/即刻断权/经授权"这类**动词**，评审必须 grep 到那个动词的读取方，否则判 ❌。

### E. 达到"产品核心完全可用"的最小集（按解锁面排序，全部库内可做）

| 序 | 要做的事 | 现在缺的那一句代码 | 解锁 |
|---|---|---|---|
| 1 | ~~审计目录自动创建 + 审计失败不得改变派发结果 + 审计文件 0600~~ **✅ 已做**（同日 `bda5013`，证据见 §C-9 与 handoff Active work 46） | 构造期建目录建文件；运行期只计数不抛 + `audit.degraded` 上报；0600 且轮转后重新收紧 | C-1 已消灭（A/B 复跑：`no registered vassal provides this skill`） |
| 2 | **封臣凭证注入（出站认证）** | `bootKernel` 的 `new Dispatcher(...)` 少一个 `tokenFor`；全库没有"每个封臣一个 token"这个概念 | M3/E4.8 从"没人跑"变成"能跑"；这是**当前最硬的一条** |
| 3 | **让 Skill 注册中心上派发路径（或明确它不上）** | 要么 `fanOut` 的目标解析过一次 `resolveTeam`/registry 状态，要么把 E2.3/E2.4 的 ✅ 与措辞改成"目录与组队查询" | 三纲的 Skill 支柱有执行点，或文档不再这么宣称 |
| 4 | **MCP 服务端补 `tools` + 鉴权/主体** | `mcp.ts:122` 现在明写不含 tools；#18 的 actor 判定 | M4"经授权读 Realm"、E7 的真实接入 |
| 5 | ~~修文档首跑面~~ **✅ 已做**：状态文件名（`737c733`）、§2 env 补 10 行、`.env` 解析方写清、roots 分隔符统一、realm 挂载可见 | C-2/C-3/C-4/C-6 | 一个不读源码的人能配起来 |
| 6 | 运行时的域挂/卸（#17）与 realmId 可见性（C-6） | `disconnect` / 启动日志与 `/api/state` 增域清单 | 日常运营不再"改目录=重启=可能拒启" |

1–5 做完，我才认为"给目录即用 + 能和一个真实外部 Agent 协作 + 治理面说得住"这三件事同时成立，即**产品核心完全可用的 MVP**。6 是运营品质，可靠后可并行。

### F. MVP 判定（v0.9，明确回答本轮问题）

- **产品核心完全可用的 MVP：❌ 未达到。**
- 与 v0.8 的差别不是"又少了几个功能"，而是**阻塞性质被改判**：v0.4 起一直写"库内已无 P0 功能缺口，只剩仓库外动作"——本轮 grep + 真进程实测证明**三纲中两条缺的是库内执行点**（MCP 无 tools/无鉴权、Skill 不在派发路径上），外加一条**库内缺失的出站认证**。这些都是可以今天写代码关掉的事，不该记在"等真机"的账上。
- **已达到的部分（也说清楚，别把好消息读没了）**：个人数据底座 = 给目录→检索→记忆→日记→**连内核状态文件都能按图恢复**（今天 #13）→企业写入需要**签名且一次性**的凭证（今天 #14）→全链路审计与重启恢复。这部分 658 项测试、真 CLI 毁库演练、真进程冒烟三层证据齐。
- **一句话**：**"用户的资料和它的可恢复性"已经 MVP；"多 Agent 协作"这个产品核心定义里的另一半，今天还不能算 MVP——它的门在库里没装完。**

### G. 本轮评审的限制（如实标注）

- 未执行 `docker build/run`（C-1/C-2 是裸机 dist 实跑，不代表容器内路径）。
- 未用官方 MCP SDK 客户端连过 stdio 服务（本轮是手工 JSON-RPC 逐条发；协议版本协商与三类 resources 读取实测通过，SDK 兼容性未验）。
- 未连接任何真实外部封臣（沙箱网络到不了 `pr-helper-ten.vercel.app`，见 v0.5）——§A-A2A 的结论来自代码路径 grep + 真进程请求，不来自真机失败样本。
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
- E3.5 Realm 写路径（驾驶员授权门，库内）、E10.4 容量基线（本批扩为四场景）；
- E8.3 Diary（叙事日志）、E9.3 Org（部门/编制/问责），及 Diary/Org 的持久化与 HTTP 暴露；
- **签名链 v1.1（本批）**：internal 名册快照与 public 同样封签——attestation 扩 `active|revoked` 两态，revoked 行获**永久吊销 attestation（无硬过期，新鲜度由 seal maxAge 绑定）**，验签要求状态精确匹配（防提升/掩盖吊销），缺 source / 状态矛盾 fail-loud；H1 `GET /api/roster` 改发封签信封（`Cache-Control: no-store`）；
- 部署制品面（Dockerfile / deployment.md / gen-rsk-key）在库内就绪（具体落地批次见 git 历史）。
- 测试规模 217（v0.3）→ 436（v0.4）→ 532（v0.5/v0.6 期间）→ **587（v0.7，66 个测试文件）**。

### C. 功能性现状：剩余项分两类——仓库外执行，与库内可推进但需拍板

内核（fan-out/join、幂等、取消、规则聚合、冲突检测、完整 DAG）、Skill 注册中心与组队、Realm（读 + 授权写 + digest + 穿越防护）、封臣联邦（注册/fealty/派发/战报/升级/二极管/吊销/审计）、HTTP 门面（public/internal 双投影 + 双份封签 + H2 驱动 API + H3 SSE）、监督台（升级/拍板回写/补参重派）、决策后端（模型无关 + Jev/LLM + 降级 + judge + replay）、可观测、持久化、记忆/Vault/Diary/Org 均在库内落地并有测试。

逐条核对 PRD 剩余 🚧/⬜。**v0.4 在这里写的是"无一项能在库内继续闭环"——这句被证伪了两次**：v0.6 之后 E3.6 与 E6.4 又都在库内落了地（v0.7）。准确的表述是**两类**：下表"真机 / 密钥 / 外部凭证"三行确实无法在库内推进；而当时列为"库内可做但需拍板"的 E9.1/E9.2（Mentor 带教与上岗）**在同一天也确实做完了**（v0.8）——这反过来验证了两类划分是对的：卡住它的从来不是环境，是"要不要现在做"的判断。目前仍在第二类的是：E8.4（传承，P3）、#13（状态文件进藏宝图）、#17/#18（企业域边界的两条运维尾巴）。把这两类混在一句"全在仓库外"里，会让人以为项目已经没有可写代码的地方，这是评审自身的失效模式，记在此处以防再犯。剩余项分类如下：

| 类别 | 剩余项（PRD 编号） | 关口 / 触发条件 |
|---|---|---|
| 真机 / 部署 | E4.8、E10.2、Zeus↔loom 联调、协议第 6 项守护测试、Docker 镜像实构实跑 | 需真实环境与封臣部署 |
| 密钥 / 发布 | E4.9 生产 RSK 的 R2（托管/轮换/公钥发布）、E5.4 bayjf R2 | deferred #7（bayjf 公开前） |
| 连接 / 企业域 | E3.4 stdio MCP、E3.5 剩余的 MCP `tools/write` 与签发（签名）凭证；~~E3.6 多租户~~ ✅、~~E6.4 双域授权~~ ✅（v0.7 收口）；企业域运维尾巴 deferred **#17**（改租户无路径）/ **#18**（MCP 侧无 actor） | E3.4/E3.5 半边随 read-realm 封臣；#17/#18 需拍板 |
| 触发型容量/安全 | E1.5、E4.10 背压与有界队列；E3.8 检索升级；E9.4 外部 Agent 沙箱 | deferred #9（≥3 真封臣）/ #10（单 Realm >2 万文件或 P50>500ms）/ #5 |
| P2/P3 与外部凭证 | E8.4 传承（#3，P3）、Jev 真实 endpoint/key；E9.1/E9.2 上岗已 ✅（v0.8），真机侧仍差"由真实封臣当 Mentor 完成一次带教并通过"（与 E4.8 同批） | 真机 / 外部凭证 |

### D. 完整度（里程碑重判）

| 里程碑 | v0.1 判定 | v0.4 判定 |
|---|---|---|
| **M1 内核基座** | ✅ 达成 | ✅ 达成 |
| **M2 并发决策内核** | 🚧 核心达成、缺 E2.2/E10.4 | ✅ **达成**（E2.2 已补、E10.4 四场景基线已出；完整 DAG、模型无关决策、judge、replay 超出原 M2 范围） |
| **M3 真机闭环** | ⬜ 未启动 | 🚧 **制品就绪、真机未验**：部署/持久化/密钥/优雅关闭在库内齐备，但从未 `docker build/run`、无真机封臣、无真机联调 |

### E. 可上线性：v0.1 五硬阻塞现状重判

| v0.1 硬阻塞 | 库内/制品侧（v0.4） | 仓库外残留 |
|---|---|---|
| 1 无部署形态 | ✅ Dockerfile（多阶段、node:22-slim、非 root、生产依赖、/data 卷、HEALTHCHECK、SIGTERM 优雅保存）+ deployment.md + env 装配 | 真机 `docker build/run` 冒烟、托管/反代/TLS |
| 2 状态全在内存（E5.3） | ✅ kernel-state（registry/升级队列/意图/请求，tmp+rename 原子落盘）+ 启动恢复 + Realm/Diary/Org 持久化 + SIGTERM 保存 | 真机备份策略与卷挂载验证 |
| 3 E2.2 Skill 注册中心 | ✅ `src/skills/`（多版本/弃用/检索/组队，歧义不静默） | — |
| 4 E6.2 决议反馈闭环 | ✅ 冲突入监督台、拍板回写重算、approve-resume 一键补参重派 | — |
| 5 签名链生产密钥（E4.9） | 🚧 **工具/接线就绪**：gen-rsk-key、env 注入、production 无钥拒启、双份封签（v1.1 含 internal） | R2：密钥实际托管/轮换、公钥对 bayjf 发布（#7） |

**上线前剩余关口（均为仓库外动作，库内无法替代）**：① `docker build/run` 真机冒烟；② 部署 pr-helper 等真机封臣并跑协议第 6 项纯客户端守护测试；③ Zeus↔loom 真机联调；④ RSK 实际生成托管与公钥发布；⑤ ~~push 本批 commit → 云端 CI 首绿（需授权）~~ **✅ 已销项（2026-09-25，v0.6）**：三次 push 均触发云端 CI，Node 20.x / 22.x 双矩阵全绿；⑥ 若启用模型裁决，配置并真机核对 Jev endpoint/key；⑦ deferred #9 触发后做背压真机标定。

### F. MVP 判定（v0.4）

- **库内内核级 MVP（可演示 + 制品就绪）**：✅ **达成**。M1/M2 全绿，436 测试、tsc/build 过、四场景容量基线、生产级 Dockerfile 与部署文档齐备；单意图多 Agent 并发 → 聚合 → 冲突升级 → 拍板/重派 → 持久化/恢复 → 封签发布在库内可完整走通。
- **产品级可上线 MVP（交付真实用户）**：❌ **未达成，但阻塞性质已变**：v0.1 时是"缺 P0 功能（E2.2/E6.2/持久化/部署/密钥）"，v0.4 时这些在**代码与制品侧全部有了对应实现**；剩余的是**只能在真实环境由人执行的验收与发布动作**（真机部署/联调、密钥托管发布、外部凭证；当时列的第五项"CI"已于 v0.6 销项）。**库内已无 P0 功能缺口可继续闭环。**
- **一句话（v0.4 升级）**：Zeus 的"内核"达到了 MVP，Zeus 的"可部署制品"也已在库内齐备；Zeus 的"上线"只差在真实环境里把它**跑起来、联起来、签出去**——这三步无法在仓库内完成。

### G. v0.4 评审限制（如实标注）

- 未执行 `docker build/run`：Dockerfile 与 serve.ts 为静态/接线核查，镜像能否一次构建成功未实证。
- 容量数字为 mock 回环（口径与限制见 capacity-baseline v0.2 §8），非真机性能。
- Jev 决策后端无真实 endpoint/key，未真机核对（代码注释与 fallback 已标注）。
- 未跑 `npm audit`；真机封臣行为无法在本机验证。

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
| E4 封臣联邦 | 4.1–4.8（8 条） | 7 | 1 | 0 | 协议闭环最扎实：注册/fealty/派发/战报/升级/二极管/吊销/审计全绿；仅 E4.8 真机执行从未跑过一次（**v0.5 更正：原因不是"待部署"——pr-helper 早已上线每天在用**） |
| E5 HTTP 门面 | 5.1/5.2（2 条） | 2 | 0 | 0 | public/internal 双投影 + 签名快照 + 鉴权齐备 |
| E6 监督台 | 6.1/6.2（2 条） | 1 | 0 | 1 | 升级队列 approve/reject 已落地；**冲突决议反馈到聚合（E6.2）未做**——冲突已能进监督台，但拍板结果不回写决策 |
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
4. **E6.2 决议反馈闭环缺失**：冲突能升级、驾驶员能 approve/reject，但**决议不回写聚合、无补参重派**——决策闭环断在最后一环。
5. **签名链生产密钥未落地**（E4.9）：public 名册封签目前用临时内存钥（serve.ts stderr 告警）；对外可信发布（bayjf 封神榜）前置缺失。

### 🟡 软阻塞（上线前建议，容忍度低）

6. **E4.8 真机验收未执行**：协议第 6 项守护测试（纯标准 A2A 客户端真机调用封臣）从未真机跑过——超集协议"不是闭墙"的承诺无真机证据。
7. **Zeus↔loom / pr-helper 真机联调未做**：所有测试基于 mock/fixture，无一次真实 HTTP 双向。
8. **E1.7 可观测缺失**：无在途任务数/延迟/失败率指标，上线后无法回答"系统健康吗"。
9. **dev 领先 8 commit 未 push**：CI（GitHub Actions）从未真实触发过——本地按 CI 序列跑过，但云端无一次绿。

### 🟢 非阻塞（增强项，可后置）

- 决策后端抽象层（Jev/LLM）——设计已定，工程切片可后置；
- E8 情感层 / E9 企业层 / E7 MCP 连接器——P1/P2，明确不在 MVP；
- 完整 DAG / LLM 裁决 / 背压 / SSE 服务端——PRD 已列为后续。

## 5. MVP 判定

**定义**（按 PRD 里程碑语义 + product-portrait 核心定位"一意图扇出多 Agent 并行、聚合为可追溯决策"）：

- **库内内核级 MVP（可演示）**：✅ **已达成**——M1 全部 + M2 核心（E1.1–1.6 落地、冲突经 onConflict 进监督台、124 测试绿、typecheck/build 过）。单意图多 Agent 并发 + 聚合 + 冲突升级 + 拍板（approve/reject）在库内可完整走通。
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
- 限制：① 未运行 HTTP 进程级端到端冒烟（仅靠 7 项 inject 测试证据）；② 未执行压测（E10.4 本身未做）；③ 未审查依赖漏洞（npm audit 未跑）；④ 真机行为（封臣部署）无法在本机验证。以上均如实标注，不掩盖。

## 8. 演进日志

| 版本 | 日期 | 变更 |
|---|---|---|
| v0.1 | 2026-09-22 | 首次项目级评审：功能性/完整度/可上线三维度 + MVP 判定（内核级达成、产品级未达成）+ 阻塞项与最小路径 |
| v0.2 | 2026-09-22 | 六切片批次后销项批注：E2.2/E6.2 硬阻塞销项、E5.3/E1.7 大幅缓解（库内落地、装配/HTTP 待接线）、S3 DAG 与决策后端落地；产品级 MVP 判定不变（部署形态/生产密钥/真机/push 仍阻塞）；基线升至 166 测试 / 22 文件 |
| v0.3 | 2026-09-22 | A 批次（G1/G4/G5/G6）销项批注：封臣上线入口、Realm 连接持久化与 boot 恢复、approve-resume 补参重派、H3 服务端 SSE；基线升至 217 测试 / 31 文件；产品级 MVP 仍未达成 |
| v0.4 | 2026-09-24 | 刷新为现行评审（436 测试 / 52 文件，tsc/build 过，容量四场景）：库内增量含记忆/Vault/replay/judge/E3.5/Diary/Org、签名链 v1.1 internal 封签、容量场景 C/D；核查到 Dockerfile + deployment.md + RSK 密钥工具 + 持久化/优雅关闭接线，v0.1 五硬阻塞在代码/制品侧均已有对应物；**重判：M1/M2 达成、M3 制品就绪真机未验，库内已无 P0 功能缺口，产品级上线仅剩仓库外真机/凭证/发布动作** |
| v0.5 | 2026-09-25 | **仅更正阻塞归因，MVP 判定不变**：v0.3/v0.4 把 E4.8 写成"待 pr-helper 部署"并被本批报告原样转述——事实是 **pr-helper 早已部署在生产且每天使用**（`pr-helper-ten.vercel.app`，其 `vercel.json`/`api/a2a/agent-card.ts` 已核实）。E4.8 仍 🚧，真实卡点是"从没人对线上跑过一次这条验收"（两边记录均无）。连带重估 M3：**差的是执行，不是工程**。评审所在沙箱到不了该域，故只声称核实了部署事实、不声称验证过端点；并记一条纪律——引用"待 X/已 Y"状态句前先跑命令核实，防止过期陈述被后续每份报告继承 |
| v0.6 | 2026-09-25 | **仅销项，判定不变**："push dev → 云端 CI 首绿（需授权）"这条自 v0.1 挂到 v0.5 的关口关闭——三次 push 均在 GitHub 侧出结论、**Node 20.x / 22.x 双矩阵全绿**（run 36024156638 = 472/56、36045209815 = 512/60、36061395015 = **532/61**），本地与 origin/dev 完全同步。基线由 v0.4-A 的 436/52 快照刷新为 **532/61 + tsc/build exit 0 + 容量五场景**（capacity-baseline v0.3）。新登记 deferred **#16**（`ubuntu-latest` 2026-10-19 自动换构建机，无需谁批准）。**剩余关口的性质变了**：不再有任何"等授权/等确认"项，清单全部是需要真实环境、真实凭证或真实封臣的执行项 |
| v0.7 | 2026-09-25 | **两项库内收口 + 评审自我更正**：E3.6 企业域三级租户 ✅（`TenantScope` org/部门/成员、层级为结构性边界不可授权放宽、个人域不是租户、租户随快照持久化）与 E6.4 双域授权与审计呈现 ✅（`DomainGrant` 只管个人↔企业这一条边、企业→个人永远拒、`decideRealmAccess` 唯一判定、nonce 一次性、`resolveRealmSource` 让**内核自己进 Realm 取数并核对声明**、`/api/domains*` 运维面）；**P0 仅剩 E4.8**。**更正 §C**：v0.4 的"无一项能在库内继续闭环"被证伪两次，改为"仓库外执行类"vs"库内可做但需拍板类"两类，并点名这是评审文档自身的失效模式。基线 436（v0.4）→ 532（v0.5/v0.6）→ **587 测试 / 66 文件**；真实进程冒烟在本批抓到一个"测试全绿但签发面实际不可用"的缺陷（要求调用方自带 nonce），登记 #17/#18 两条诚实尾巴。MVP 判定不变 |
| v0.8 | 2026-09-25 | **E9.1 / E9.2 上岗门收口 + 一条测试结构性缺口**：新组合层 `src/onboarding/` 用四道门（编制名册 / 在册未吊销封臣 / `decideRealmAccess` / E2.5 certified）决定上岗，**资格现算不缓存**，签字后吊销封臣或撤出名册会自动失效；三条严格化（出勤不算能力、空要求必须显式豁免并写理由、豁免与租户范围不得越界）；`composeBriefing` 从已有事实装配首日上下文并把**答不上来的写进 `gaps`**（`totalFacts` 与命中分开报、`canWrite` 只表域边界并单列 `writeNeedsGrant`、内容取稳定 digest）；`first-task` 过门后真走一次 `fanOut`，审计脊加 4 个 `commission-*`，上岗记录进快照。**v0.7 的两类划分当场得到验证**：被列作"库内可做、等判断"的同一批里同日做完。**结构性缺口单记**：`fix(registry)` 修掉"卡片缺 `dataRealms` 等 oath 字段能注册、派发时才 TypeError"——它在 620 项全绿下活了四天，因为测注册的不派发、测派发的不调 `register()`，两半各自绿；自此对跨模块契约改动加一条口径：**只有 inject 测试不算已验证**。基线 **620 测试 / 68 文件**，四次缺陷植入全部被接住（2 / 3 / 2 / 4 例红）。MVP 判定不变 |
| v0.9 | 2026-09-25 | **重判 MVP：改问"操作者摸不摸得到"，于是阻塞性质被改判**。基线 **658 测试 / 70 文件**、typecheck/build exit 0、`npm audit --omit=dev` 0 漏洞（生产依赖仅 fastify）；src 80 文件 14 461 行、67 条 HTTP 路由。三纲逐条 grep + 真进程实测：① **MCP** 服务端**实测可跑**（手工 JSON-RPC 走通 `initialize`/`resources/list`/`resources/read`，越界 path 被拒、不吐绝对路径），但**只有 resources 没有 tools**、只支持 personal+readOnly（type 在 stdio 宿主里写死）、无鉴权；客户端侧 **`tools/call` 全库 0 命中** → 连接器是"声明+发现"，被边界裁剪的能力清单**无人读取**（`connectors.ts:80` 是唯一赋值点）；② **Skill 注册中心不在派发路径上**（`fanOut`→`findBySkill`→卡片自报技能，`resolveTeam` 唯一调用点是查询路由）→ **卸载不夺权**、`hardening` 只写不读、`providedBy` 逐字采信绕过认证；③ **A2A 无入站面、oath 未签名，且 `bootKernel` 构造 Dispatcher 从不传 `tokenFor`** → 真进程对任何封臣都不发 Authorization，**需要 bearer 的真封臣根本派发不出去**。**首跑实测另抓出 6 条**：C-1 按 `.env.example` 默认配置**每条派发分支的 reason 变成 `ENOENT .../audit.jsonl`**（A/B 对照证明：审计 sink 不建目录，且写盘失败被误归因为封臣失败；审计文件另为 0644 而状态文件 0600）、C-2 **我自己当天写进 deployment.md 的备份示例文件名是错的**（`kernel.json` vs 真实 `kernel-state.json`；另 §2 表少 10 行（代码读 24 个 ZEUS_*、表内只有 14 个，复测后定数）——子审计多算的一条经实测剔除）、C-3 `ZEUS_REALM_ROOTS` 两套互不兼容分隔符、C-4 `.env` 裸机不生效（无 dotenv）而示例注释让你照抄、C-5 域只能启动挂不能卸、C-6 realmId 操作员不可见。**判定：产品核心完全可用 MVP ❌**，且 v0.4 起那句"库内已无 P0 功能缺口、只剩仓库外动作"**第三次被证伪**——三纲里两条缺的是**库内执行点**。新立评审纪律一条：**凡 ✅ 句里含动词（阻止/只暴露/即刻断权/经授权），必须 grep 到该动词的读取方，否则判 ❌**。同时如实记已达到的部分：个人数据底座（给目录→检索→记忆→日记→藏宝图含内核状态文件→签名且一次性企业写凭证→审计→重启恢复）三层证据齐备。§E 给出 6 步最小集（全部库内可做）。子审计中两条与我实测不符的结论（"MCP 产物不存在"、"serve.ts 挂了静态控制台"）未采信 |
