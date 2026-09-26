# Deferred Items

缓做/低优事项登记表。每条挂起项必须带**触发条件**；触发条件满足后移回 `handoff.md` Active work 并标注重启日期。

> **编号只增不复用**：已销项的条目保留原文与编号（标 ✅ 已销项），新条目一律用下一个未用过的号。这条规则是补出来的教训——`#15` 被登记过**两次**（一次"DAG 驾驶员入口"、一次"支持矩阵与 engines 声明"），前者被后者静默覆盖，直到 2026-09-26 做一次"能力 vs 可操作面"对账时才被发现，见 **#23**。一份登记表如果能让条目无声消失，它就不是登记簿。

## 架构决策待定（非缓做，但需先决定）

（#1 执行 Agent 协议形态已决定：A2A 超集，2026-09-21，见 [design-vassal-protocol.md](design-vassal-protocol.md)——已销项）

## 缓做项

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

### #8 结果回传成本口径
- `x-zeus-report.cost` 的单位与结算口径，跨执行 Agent 可比性。
- **触发条件**：企业版计费立项时（联动 #4）。

### #9 执行 Agent 背压降级顺序
- 执行 Agent 饱和时 Zeus 任务队列向其他执行 Agent/队列分流的降级顺序。
- **进展（2026-09-25）**：**闸门本身已落地**——`Orchestrator` 的 `maxConcurrentBranches` + `branchQueueLimit`（进程内在途分支上界、FIFO 等待、满则拒绝并把原因记进分支结果），见 handoff Active work 39 与 tests/orchestrator-backpressure.test.ts；`GET /api/metrics` 的 `queueDepth` 从此是真实值。**本条仍未销项**：剩下的问题是"该把溢出分流给谁"——拒绝顺序 / 按可靠度或延迟重排候选 / 有界排队 vs 立即降级的策略选择，需要真实执行 Agent 的行为数据才能定，凭空拍一个顺序没有依据。
- **触发条件**：≥3 个执行 Agent 在线压测（同一台机器上的 mock 不算：mock 的延迟分布与失败模式是编的，只会把一个猜测变成锁定的猜测）。

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
- **改后验证**：`npm ci --dry-run` 在 **Node 20 上 EBADENGINE 硬失败**、在 **22.23.1 与 24.20.0 上无任何 engine 报错**（即 `engine-strict` 下传递依赖也全部兼容）；YAML 解析得 `runs-on=ubuntu-24.04`、`matrix=["22.x","24.x"]`；三档 704 绿与 22/24 真进程冒烟见下面的"进展"（拍板依据，非本批重跑）。
- **不在本条内**：v26 何时进矩阵（当前线 `lts:false`，等进 LTS 再考虑替换 22）；runner 镜像归 #16（同日已销项）。
- **原缺口（销项前）**：CI 测 20.x/22.x，但 Node 20 上游已 EOL（2026-04），仓库 `package.json` **没有 `engines`**，Dockerfile 跑 node:22-slim，本机 dev 在 20.20.2——四处不一致，且没有任何地方写明"这个库支持哪些 Node"。
- **触发条件（回顾）**：写的是"决定结束对 Node 20 的验证时（例如本地 shell 升到 22+）"。**本批是不等触发条件就做的**：本地 shell 仍是 20.20.2，但拿到的实测（下面"进展"）把"该不该继续声明支持 20"变成了一个有数据的问题——一个自 2026-03-24 起不再有任何发布的运行时，继续在 CI 里给它发通行证是在凭空承担安全口径。
- **进展（2026-09-26 实测，本批拍板依据）**：
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

### #19 入站 A2A 面（外部 Agent 调不进 Zeus）
- **缺口**：Zeus 只有**出站** A2A（拉卡片、`tasks/send`、SSE 回读、`tasks/cancel`）。`src/http` 里既没有 `/.well-known/agent-card.json`，也没有任何 `tasks/*` 路由——即**别的 Agent 无法把任务派给 Zeus**，也不存在一张可供别人校验的 Zeus 卡片。v0.9 §A 判过这条（"没有入站面"），但**当时没进本清单**，于是 2026-09-25 复核才发现它是"评审说过、没人接"的失物。
- **为什么仍然缓做**：入站面一开，就要同时回答"谁能派给我""派进来的东西落在哪个域""谁为结果负责"——这三问的答案取决于第一个真实的上游调用者（loom 或 bayjf），现在做只会得到一个没人用的空壳。且它不在 MVP 的核心叙事里：产品核心是"一个意图扇出多 Agent 并聚合"，出站已覆盖。
- **触发条件**：① Zeus↔loom 真机联调时 loom 需要**反向**派任务给 Zeus；② bayjf 想让公开签名目录上的其它执行 Agent 调用 Zeus 的聚合能力；③ 出现"多 Zeus 实例协作"的需求。
- **建议做法（决定后）**：发一张 Zeus 自己的 agent card（形状与 fealty 与我们要求执行 Agent 的一致，吃自己的狗粮），入站 `tasks/send` 落到 H2 的意图面并复用同一根审计事件流。

### #20 `ZEUS_JUDGE_THRESHOLD` 与其他 boot 参数的校验口径不一致
- **缺口**：`src/state/boot.ts:537-539` 对非数字阈值走 `Number.isFinite` 判断，不通过就**静默不写 config**、退回内置默认；而 E1.5 的并发/队列参数（`ZEUS_MAX_CONCURRENT_BRANCHES` 等）是**非法值直接拒启**。同一个"操作员把 env 写错"的失效模式，进程给两种答案。
- **为什么不顺手统一**：`tests/boot-decision.test.ts:70-76` 已把"忽略非数字阈值"钉成契约（用例名就叫 `ignores a non-numeric threshold`）。统一成拒启=**推翻一条已锁测试**，这是口径决定而不是 bug 修复，等决定。
- **现状处置**：`docs/deployment.md:35` 已在该变量的表行里明写这条不一致并指向评审 §C-8，操作员看得见。
- **触发条件**：① 决定"boot 参数一律 fail-loud"并批量改（含此条与所有现存例外）；② judge 上真机、阈值成为必须掐准的旋钮（此时配错的代价从"不敏感"变成"事故"）。

### #21 历史标识符改名（代码 / 环境变量 / 协议字段 / 数据格式）
- **现状**：对外文档已全量改用工程术语，但代码与环境变量里仍是历史名（`vassal` / `fealty` / `realm` / `vault` / `kernel` / `commission` / `driver-*` 审计取值 / `ZEUS_VASSAL_SEEDS` / `x-zeus-fealty`）。**方案、代价四档与逐档机制已写全**：见 [design-naming-migration.md](design-naming-migration.md)。
- **本轮结论（2026-09-25）**：**T2 数据格式、T3 环境变量、T4 协议字段与路由全部不做**。理由不是"太难"，是**收益已经拿到手**：外部误读的风险由 README 的标识符说明 + 术语表解决；而 T2/T4 要烧掉的正是"备份可恢复、签名可长期验证、对端已部署"这三项可信性资产。T1（纯内部标识符）可选，但只挑"名字真的误导"的。
- **触发条件**：① 某个历史名字**实际挡住了功能**（例如新人/对端因名字误解而接错），而不是"看起来不专业"；② 出现必须新增协议代次的真实需求，此时顺路把 T4 的双读一起做；③ #22 的 version 字段落地后，若仍有改载荷的需求。
- **硬约束（若开工）**：一个 commit 只动一档；T2 必须双读单写且提升版本号 + 实测"改前备份能在改后恢复"；T4 必须先服务端双读、**在对端确认切换前不得移除 v1 路径**。

### #22 签名名册没有 schema version 字段 ✅ 已销项（2026-09-25）
- **原缺口**：验签方无法判断自己拿到的是哪一代载荷。**登记时我写的是"没有任何版本字段"，这句不准确**：信封里一直有 `seal.v = 1` 与 `attestation.v = 1`（`ENVELOPE_VERSION`，`signing.ts:125/155/192/250`），只是**验签路径从不检查它**——一个不被校验的版本字段是装饰性的，和 #18 那条"只写不读的清单"同一种失效。而真正会变形状的**载荷**（`RosterSnapshot.entries[]`）确实没有任何形状标记。
- **做了什么**：① 载荷加 `schemaVersion`（`ROSTER_SCHEMA_VERSION = 1`，两个投影函数写入），位置在 `seal.snapshotDigest` 覆盖的对象内部，所以**不需要改签名输入就被签名保护**；② 验签前置三道版本闸（在任何密码学之前）：未知 `schemaVersion` / 未知 `seal.v` / 未知 `attestation.v` 各自返回点名的拒绝原因；③ **向后兼容**：缺 `schemaVersion` 的旧件读作 1（旧件本就不含该字段，摘要与签名自洽，仍能验）。
- **验证**：`tests/signing.test.ts` 新增 4 项——两个投影都盖章、**旧形状仍可验签**（正向对照，防止"只在坏输入上测过的校验器永远可能是错的"）、`schemaVersion 99` 在**重新签名过**的情况下仍被拒（即拒绝只可能来自闸门而非摘要/签名）、`seal.v=2`/缺失与 `attestation.v=2` 各自被点名拒绝。全量 **696 绿 / 72 文件**、typecheck/build exit 0；真进程实测 `GET /api/roster` 与 `/api/roster/public` 的信封里 `"schemaVersion":1` 且 `seal.v` 不变。
- **与 #21 的关系**：这条做完后，**将来若真要改载荷，才有安全灰度的可能**（双读按 `schemaVersion` 分流）。#21 的结论不变：仍不建议改 T2/T3/T4。

### #23 DAG 分析没有驾驶员入口 ✅ 已销项（2026-09-26）
- **决定（选项即建议做法）**：把 `src/orchestrator/dag.ts` + `dag-runner.ts` 已落地的图能力接到 H2 驾驶员面，沿依赖边从平铺扇出升级为分层执行。实现与建议做法的差异：依赖边**编码在节点 `dependsOn` 上**（不是另给 `edges` 列表）——功能等价，少一份需要保持同步的字段。
- **能力已在**：`src/orchestrator/dag.ts` + `dag-runner.ts`（拓扑分层 `topologicalLayers`、关键路径 `criticalPath`、`validateDag`、部分失败跳过），`tests/dag.test.ts` **6 例**，且都从 `src/index.ts` 导出。
- **落地（2026-09-26）**：
  - `POST /api/intents` 接受可选 `dag:{nodes}`（每节点 `id` / `skill` / 可选 `vassals` / `params` / `dependsOn` / `aggregation`，顶层 `branchTimeoutMs`）；与 `body.skill` **互斥**，否则 400。结构校验（字段形状）在 `parseDagSpec`、图校验（环 / 缺失依赖 / 重复 id）在 `validateDag`（均返回 **400** 并点名环或未知节点）。提交即回 **分层计划 + 关键路径 + 每节点状态**。
  - `GET /api/intents/:id/dag` 按 `dagId` 回读 `layers` / `criticalPath` / `state` / 每节点状态。
  - **复用内核**：`DagRunner` 改为可接收一个**已存在的 Orchestrator**（boot 传入主 orchestrator），所以 DAG 的每个节点意图走的是**同一个** orchestrator——共享幂等表、随内核快照持久化、`GET /api/intents/:id`（节点 id 为 `${dagId}::${node}`）仍可读。不重复造一个隔离的执行器。
  - 部分失败的跳过语义在 `DagRunner` 内保持不变（依赖未完成的节点 `skipped`，独立分支继续），与 `refused-*` 同样写进审计事件流。
- **验证**：新增 `tests/http-dag.test.ts` **7 例**（`npx vitest run` 全量 **711 绿 / 74 文件**，typecheck/build exit 0）；其中"两阶段意图 + 节点意图可追溯"用**真进程 inject 冒烟**（真实 HTTP + 真实 orchestrator + dispatcher 管线，不是只测纯函数），覆盖你定的"只有 inject 测试不算已验证"口径。**未做**：CLI 与 MCP 面同样没有 DAG 入口（触发条件②/③未到，且 MCP 暴露侧 actor 判定仍归 #18）；DAG spec/result 在内存，不随内核快照持久化（重启后 `GET /api/intents/:id/dag` 失忆，节点意图仍在）。
- **原登记背景（保留）**：该条曾因编号复用（`#15` 被"支持矩阵与 engines 声明"覆盖）在文件里消失，本文件顶部已立"编号只增不复用"规则。
- **缺口（对账方式：库导出 ↔ 可操作面）**：`src/http/server.ts` 里 `dag` / `criticalPath` / `topolog` **出现 0 次**，CLI 与 MCP 面同样没有。也就是说**操作员今天无法提交一个 DAG 形状的意图，也无法读回它的分层与关键路径**——只能当库函数用。这条与 #21 无关，是"内核有、驾驶员看不见"那一类的又一个实例。
- **为什么现在才记**：它**本来就登记过**。`handoff.md` 顶部状态段写着"C（状态文件进藏宝图）与 F（DAG 驾驶员入口）经实测是设计变更，登记 deferred #13/#15/#14 而非半做"，Active work 39 的"没做的两项"那条也把 F（S3 DAG 驾驶员入口）判为"需要先出设计稿"——三个号对应 C/F/另登记项，#13 归 C、#14 归 `DriverWriteGrant`，剩下 **#15 就是 DAG**。但 `#15` 后来被**"支持矩阵与 engines 声明"复用**，DAG 那条就在文件里消失了（此处按句子内容引用而不按行号：行号会随文件增长漂移，这本身就是这条失物能藏住的原因之一）。已在本文件顶部补"编号只增不复用"规则，防它再发生。
- **触发条件（回顾）**：① 出现一个真实的**多阶段依赖**意图（"B 必须等 A"）时派发从平铺扇出升级为分层执行；② 多阶段编排的关键路径/瓶颈分析；③ 按 DAG 排程做取消或重试。本条不等触发条件——库内"内核有、操作面无"的缺口本身就是可闭环的工作，且前几批一直在补这类。

### #24 墙钟依赖的测试与脚本没有可执行闸门 ✅ 已销项（2026-09-26）
- **原缺口**：`tests/verify-roster.test.ts` 的 fixture 用固定时刻封签（`maxAgeSeconds: 3600`）却不传 `--now`，于是"验得过"依赖真实时间——当天窗口一过 4 例全红而实现一行未改（已在那个文件内修掉：`run()` 缺省注入 `--now`）。但**同类形状没有任何东西挡**：只要新测试再写一次"固定过去时刻 + 让生产代码读墙上时钟"，它就在未来某天自动变红，或更糟——自动变绿。
- **做了什么（可执行闸门）**：新增 `scripts/clock-skew-setup.mjs`（把 JS 时钟整体拨前 2 年，偏移可用 `ZEUS_CLOCK_SKEW_DAYS` 覆盖）+ `vitest.clock-skew.config.ts`（仅比 `vitest.config.ts` 多挂这个 setup），并在 CI 加 `clock-skew` 作业：真实时钟下 `npm ci` + typecheck + build，再用偏置配置跑**全量测试**。凡测试或生产路径偷偷读真实墙钟，这一道作业就红——从"某天自己变红"变成"引入当天即红"。
- **为什么是 JS 级偏移而不是 `sudo date -s`**：GitHub 托管 runner 不给 `CAP_SYS_TIME`，系统级拨钟多半 `Operation not permitted`；且拨动 OS 时钟会让 `npm ci` 访问 npm registry 的 TLS 证书校验跟着错位、连带安装失败。本仓库的墙钟风险**全在 JS 内**（每个生产 `new Date()` 都躲在可注入的 `now` 之后），所以拨 JS 时钟是忠实且无特权的等价代理。**已知边界**：拨钟只覆盖 vitest 进程内代码；`verify-roster.test.ts` 之类 spawn 的子进程跑在真实时钟下，不在本闸门覆盖（若某脚本将来长出依赖墙钟的逻辑，再评估 OS 级拨钟或给子进程也注入偏置）。
- **验证（实证，不是假设）**：本地以 +2 年偏置跑全量，**726 绿 / 76 文件**——证明当前测试集对墙钟零静默依赖；CI 这道作业即此结论的回归护栏。typecheck/build exit 0。
- **触发条件已满足**：本批次即在把闸门立起来的同时确认无残留墙钟依赖；若未来出现"无人改代码却变红/变绿"的时间用例，此作业会第一时间报警。
