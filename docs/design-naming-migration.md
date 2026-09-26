# 命名迁移方案：把历史标识符换成工程术语的代价与路径

> 状态：**现行 v0.1（2026-09-25，方案，未开工）**。本文件只写"要怎么改、代价是什么、怎么回滚"；**实施进度一律记在 [handoff.md](../handoff.md)**（AGENTS.md 的文档分层约定）。
> 触发：用户口径「文档只要专业术语」已完成（见 [terminology.md](terminology.md) 的判定三档），剩下的问题是**代码标识符、环境变量、协议字段、已落盘数据格式**要不要一起改。
> 前置结论（先给判断，再给理由）：**建议只做第 1 档的一部分，第 2–4 档不做**；把预算花在"给签名快照补 version 字段"这件真缺口上。理由见 §5。

## 1. 范围：四档，代价完全不同

| 档 | 对象 | 谁受影响 | 破坏性 |
|---|---|---|---|
| **T1 纯内部标识符** | 类名/函数名/目录名：`VassalRegistry`、`VassalEntry`、`bootKernel`、`src/vault/`、`OversightDesk` 等 | 只有读代码的人；`src` + `tests` 约 **4,000+** 处引用 | 无（只要不改下面三档） |
| **T2 已落盘数据格式** | 状态文件 JSON 键（`registry` / `realms` / `commissions` / `mentorships` / `domainGrants` / `writeGrantNonces`）、审计 JSONL 的 `decision` 取值、备份清单与加密包、**签名名册的载荷键** | 用户机器上已存在的状态文件与备份包；已发布给外部的签名名册；任何离线验签脚本 | **有**：旧数据必须仍可读，历史签名仍可验 |
| **T3 配置与环境变量** | 8 个（全部经 `grep src` 核实确被读取）：`ZEUS_VASSAL_SEEDS`、`ZEUS_REALM_ROOTS`、`ZEUS_REALM_ENTERPRISE`、`ZEUS_VAULT_PASSPHRASE`、`ZEUS_RSK_KEY`、`ZEUS_RSK_KEY_FILE`、`ZEUS_RSK_KEY_ID`、`ZEUS_INTERNAL_TOKEN`（后 4 个名字本身不含隐喻，列在此处是为了给出完整的对外配置面） | 现有 `.env`、systemd `EnvironmentFile=`、`docker run --env-file`、`docs/deployment.md` 全部示例 | **有**：静默失配最危险——名字写错时进程照样起得来，只是少挂了域/少注册了执行 Agent |
| **T4 线上协议与 HTTP 面** | 卡片头 `x-zeus-fealty`（及 `x-zeus-report` / `x-zeus-escalation` / `x-zeus-run`）、路由 `/api/vassals`、`/api/realm/write-grants`、响应字段 `Position.vassal`、`Entry.vassal` | **已部署的对端**：生产上的 pr-helper 按 `x-zeus-fealty` 声明归属；loom 侧已有自己的 A2A 实现 | **有，且跨仓库**：本仓库单方面改，对端立刻失配 |

## 2. 现状事实（本轮逐个 grep/读码核实，非转述）

- **状态文件有版本闸门，且是硬拒**：`src/state/kernel-state.ts:38` `KERNEL_STATE_VERSION = 1`；`:178-179` 对 `version !== 1` 直接 `throw KernelStateError('unsupported kernel state version')`。**没有 v0→v1 的迁移分支可参照**，因为还没需要过。
- **备份格式已经做过一次同类迁移，可当模板**：`src/vault/types.ts:9` `VAULT_VERSION = 2`，v1 的图**读入时归一化、写出不兼容**。这条先例证明"双读单写"在本仓库是可实现的，但也说明它的成本是一整轮的兼容代码 + 专门测试。
- **协议版本协商的容器已存在**：`src/a2a/types.ts:5` `SUPPORTED_FEALTY_VERSIONS = ['1']` 是**数组**，注册时对不在数组内的版本 fail-loud。也就是说"同时接受两代声明形态"在架构上是现成的，不需要新发明。
- **签名快照没有任何版本字段**：`SignedRosterSnapshot = { snapshot, attestations, seal }`（`src/registry/signing.ts:164-168`），`RosterSnapshot = { generatedAt, scope, entries }`（`src/registry/roster.ts:40-44`），全仓库 `signing.ts` 里 grep `version` **零命中**。含义：一旦 T2 改了载荷键，**离线验签方无法区分新旧形状**，也就无法安全灰度。这条与改名无关，本身就是可验证性缺口。
- **审计取值里带历史名的**：`vassal-revoked`、`driver-grant-issued`、`driver-resolved`、`driver-write`、`realm-write`、`realm-type-mismatch`、`commission-granted|waived|withdrawn|refused`、`commissioned`。这些是**已经写进用户磁盘 JSONL 的历史记录**，改词汇等于让历史与现在说两种话；`GET /api/audit?decision=...` 的过滤器也会跟着分叉。
- **`Position.vassal` 出现在 HTTP 响应里**（`src/orchestrator/types.ts:28-33`），改名即改响应结构，属于 T4。（注意：名册投影 `RosterEntry` 用的是 `name`，**没有** `vassal` 字段，所以名册响应不在此列。）

## 3. 每档的迁移机制（若决定做，就按这个做）

### T1 内部标识符

1. 一次一个概念、一个 commit：`rename(registry): vassal -> executor agent` 之类；`git mv` 目录后**立刻**跑 `npm run typecheck`，让编译器把引用面全列出来，再逐处修。
2. 门禁按 `.github/workflows/ci.yml` 原样：`npm run typecheck` → `npm test` → `npm run build`，之后**必须**补一轮真进程冒烟（编译产物起服务 + 打一次真实 HTTP 请求），因为 T1 会顺手改到 `deps` 字段名，inject 测试结构上看不见装配断裂。
3. **禁止越界**：T1 的 commit 里不得同时改路由字符串、env 名、快照键、审计取值。这条是硬规则，否则一个 commit 里混了两档，回滚就把不相关的东西一起滚掉。

### T2 数据格式

- 模式：**双读单写**（读旧键 + 新键，写只写新键），并**提升版本号**：`KERNEL_STATE_VERSION` 1→2，`load()` 接受 `{1,2}`，`save()` 只写 2。
- 迁移时机：**启动加载时归一化，不就地改写用户文件**；只有下次正常保存才写新键。理由：读一次就把用户文件改掉，会让"读操作可重入、失败不留痕"这一条不再成立。
- 审计取值：保留历史行原样（不许回写文件），新行写新值；`GET /api/audit?decision=` 对旧值做**别名解析**（`vassal-revoked` → 同时匹配新值），否则历史不可查。
- 备份清单/加密包：沿用 VAULT v1→v2 的做法，读入归一化、写出不兼容，并在 `check` 的退出码语义上不加新档位（漂移=2、不可达=3 是对外契约）。

### T3 环境变量

- 双读 + **优先级明确**：新旧同在时，新名生效并在 stderr 打一行"旧名已弃用，将在 vX 移除"。
- **不得静默忽略**：这是本仓库已知的失效模式（`ZEUS_JUDGE_THRESHOLD` 静默忽略那条至今还没统一，见 deferred #20）；弃用期至少要覆盖"用户没看日志就重启一次"的场景，因此**移除需要一次显式批准的 commit**，不随改名批次自动发生。
- `docs/deployment.md` 的 env 表、`.env.example`、Dockerfile 里的固定项、systemd 示例**必须在同一 commit 内改完**，否则文档教的是旧名而代码读新名。

### T4 协议与 HTTP

- 卡片头：注册侧同时接受 `x-zeus-fealty`（v1）与 `x-zeus-attestation`（v2），命中任一即可，且把命中的代次记进审计；`SUPPORTED_FEALTY_VERSIONS` 扩为 `['1','2']`。**对端可以不改**——这是唯一能让已部署 pr-helper 不在改动当天失配的路径。
- 路由：新增 `/api/agents`，旧 `/api/vassals` 保留为**别名**（同一 handler、同一鉴权、响应同构），并在响应头加 `Deprecation`；移除旧别名同 T3 需要单独批准。
- 响应字段 `Position.vassal`：**同时输出 `vassal` 与 `agent` 两个键**直到外部消费者确认切换。注意这一条会直接改变签名载荷（名册 `entries[].…` 若含该字段），因此与下面的前置阻塞绑定。

## 4. 前置阻塞（开工之前必须有人点头的东西）

1. **对端协调**：`x-zeus-fealty` 的生产方在**另一个仓库**（pr-helper，已部署在 `pr-helper-ten.vercel.app`）。本方案 T4 的"服务端双读"可以不依赖对端，但**任何要求对端升级的动作都需要对方工程排期**——在此之前不得移除 v1 路径。
2. **已发布物**：任何已经发给外部（bayjf）的签名名册，其载荷键一旦变化，历史件就需按旧形状验证。**在 T2 补上签名 version 字段之前，不得改任何被签名的载荷键**。
3. **用户机器上的数据**：本机 `data/kernel-state.json`、`data/audit.jsonl`、历史备份包。迁移方案必须包含"**用改前的备份能否在改后恢复**"这一条实测。
4. **文档一致性**：PRD / design-* / deployment / README 的示例命令与 env 表要同批改，否则会出现"文档 502、实现 400"这一类已被抓过的错配（见评审 v0.12 §B）。

## 5. 建议：改到哪一层为止

**推荐：T1 选择性做 + 补签名 version 字段；T2/T3/T4 不做。**

理由，按分量排：

1. **改名买不到任何能力**。改名的全部收益是"外部读者不再把 `vault` 读成 HashiCorp Vault、把 `driver` 读成设备驱动"——这个收益**已经由 README 的标识符说明 + terminology 的判定表拿到**，零风险。继续往 T2–T4 走，是在为一个已经兑现的收益再付一次不可逆的成本。
2. **它要烧掉的正是这个产品的卖点**。Zeus 的立身之处是"你的数据丢不了、找得回、签名能长期验证"。T2 动的恰好是备份格式、状态格式与签名载荷；T4 动的恰好是已经部署在对端的协议。用可信性资产去换命名整洁，方向是反的。
3. **T4 会让"标准客户端"这条承诺变复杂**。现在只有一条协议代次；双读之后，验收脚本、离线验签客户端、对端文档都要讨论"哪一代"。这是长期的复杂度，不是一次性的。
4. **真正该修的缺口顺手就能修**：签名快照**没有 version 字段**（§2）。它不依赖改名就有价值——补上它，将来无论谁想改载荷，才有安全灰度的可能。这件事应当单独立项先做。

若仍要继续推进 T1，建议**只挑"名字真的误导"的**（`commission`、`noul`、`driver-*` 审计取值不在此列，它们属 T2），而不是把 `vassal`/`realm` 全库铲平——后两者一旦牵进 T2 的载荷与键名，收益/成本比立刻转负。

## 6. 每批的门禁与回滚

- **门禁**（每批全跑，口径抄 `.github/workflows/ci.yml`，不改路径）：`npm run typecheck` → `npm test` → `npm run build` → 云端 CI 双矩阵（Node 20.x / 22.x）→ **真进程冒烟**（编译产物起服务，打最小自然请求，覆盖被改到的每一条对外路径）→ **缺陷植入**（每批至少一次：把守卫去掉，证明有测试会变红；改回后 `cmp` 验字节一致）。
- **T2/T4 额外一条**：改前备份 → 改后用新代码读旧文件 / 验旧签名 / 从旧加密包恢复，三条都要实测通过才算完成。
- **回滚**：每档一个 commit 段，`git revert` 即可回代码；**但 T2 一旦被旧代码写过的新文件，旧代码读不了**（这是单向门）。因此 T2 落地前必须先做一次真实的状态文件/备份包快照，并把"回滚需要同时回滚数据"写进 handoff。T3/T4 的双读设计本身就是可回滚的。

## 7. 不做什么（写清楚，避免下次重新讨论）

- 不改任何协议头、路由、状态键、备份格式、签名载荷、环境变量名（T2–T4 全部**不做**，除非有新证据说明某处真的挡住了功能）。
- 不为了改名去动审计历史行的取值。
- 不在改名 commit 里顺手做别的事。
- 保留：**术语表 + README 标识符说明**作为对外沟通层，这也是本方案建议的唯一"改名"落点。
