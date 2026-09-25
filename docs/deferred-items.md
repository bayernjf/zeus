# Deferred Items

缓做/低优事项登记表。每条挂起项必须带**触发条件**；触发条件满足后移回 `handoff.md` Active work 并标注重启日期。

## 架构决策待定（非缓做，但需先拍板）

（#1 封臣协议形态已拍板：A2A 超集，2026-09-21，见 [design-vassal-protocol.md](design-vassal-protocol.md)——已销项）

## 缓做项

### #2 藏宝图加密与托管方案 ✅ 已销项（2026-09-23）
- 原议题：纯本地密钥 vs 可恢复托管的取舍；密钥丢失 = 宝藏永久丢失。
- **触发条件**：Realm 数据层与备份机制进入实施阶段。
- **销项结论**：触发条件已满足（Vault E8.1/E8.2 + E3.7 已落地）；方案在 [design-vault.md](design-vault.md) v0.1 §9 拍板为**纯本地、密钥分离**（AES-256-GCM，scrypt 口令或 raw key，信封不含密钥），**KMS 托管/自动云备份明确列为非目标**；CLI（`src/vault/cli.ts`）只提供用户/外部脚本触发的 build/check/backup/restore。密钥丢失无后门是显式接受的产品语义。传承场景（dead-man's switch、法律框架）仍归 #3，不随本条销项。

### #3 传承（Inheritance）
- 继承协议、密钥托管（dead-man's switch）、法律框架。
- **触发条件**：藏宝图备份的情感闭环得到验证；产品进入 P3。

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
- **销项结论**：`src/realm/authorization.ts`（`DomainGrant` + `decideRealmAccess` 单一判定 + `DomainGrantRegistry` 的 nonce 一次性与快照持久化）、`src/realm/source.ts`（内核代取内容并核对声明、放行/拒绝同脊审计）、驾驶员面 `/api/domains*` 与 `GET /api/audit?decision=domain-*`，设计见 design-realm §7。**个人域→企业域**已可显式授权并留痕，**企业域→个人域**在类型层面就没有可表达的凭证。
- **仍不在本条范围内**（不因销项而消失）：MCP 暴露侧的 actor 判定 → **#18**；改租户边界的显式操作 → **#17**。

### #7 fealty 签名链
- Agent Card / fealty 的发布与吊销是否需要签名链，防止伪造名册条目。
- **触发条件**：bayjf 名册对外公开前。
- **进展（2026-09-24 更新）**：设计定稿 v0.1，见 [design-fealty-signing.md](design-fealty-signing.md)（v1 Zeus 单签：Ed25519 + RFC 8785，条目 attestation + 快照 seal，TTL 硬过期；v2 封臣自签交叉背书）。**v1 纯函数已库内实现**（`src/registry/signing.ts`，`tests/signing.test.ts` 24 项：覆盖设计稿 §8.1 八条验收 + 签名链 v1.1 两态封签 5 项）。**R1 已完整接线**：H1 `GET /api/roster/public` 与 bearer `GET /api/roster`（internal，含 revoked 行）均实时投影并 sealSnapshot 封签、离线可验——签名链 **v1.1（2026-09-24）** 把 attestation 扩为 `active|revoked` 两态，revoked attestation 证永久吊销事实、不带硬过期（快照新鲜度仍由 seal maxAge 绑定），验签要求状态与条目精确匹配（防提升/掩盖）、缺 source 或状态矛盾 fail-loud（public 封签 commit 3190a11）；**生产密钥已硬化**：`src/http/rsk.ts` 支持内联/文件注入，production 无密钥拒启（commit 4d99f43），生成脚本 `scripts/gen-rsk-key.mjs`。本条**仍未销项**：只剩 **R2（bayjf 构建期客户端公钥验签展示）+ 生产 RSK 托管/轮换与公钥发布的部署动作**，触发条件「bayjf 名册对外公开前」未到点。

### #8 战报成本口径
- `x-zeus-report.cost` 的单位与结算口径，跨封臣可比性。
- **触发条件**：企业版计费立项时（联动 #4）。

### #9 封臣背压降级顺序
- 封臣饱和时 Zeus 任务队列向其他封臣/队列分流的降级顺序。
- **进展（2026-09-25）**：**闸门本身已落地**——`Orchestrator` 的 `maxConcurrentBranches` + `branchQueueLimit`（进程内在途分支上界、FIFO 等待、满则拒绝并把原因记进分支结果），见 handoff Active work 39 与 tests/orchestrator-backpressure.test.ts；`GET /api/metrics` 的 `queueDepth` 从此是真实值。**本条仍未销项**：剩下的问题是"该把溢出分流给谁"——拒绝顺序 / 按可靠度或延迟重排候选 / 有界排队 vs 立即降级的策略选择，需要真实封臣的行为数据才能定，凭空拍一个顺序没有依据。
- **触发条件**：≥3 个封臣在线压测（同一台机器上的 mock 不算：mock 的延迟分布与失败模式是编的，只会把一个猜测变成锁定的猜测）。

### #10 Realm 检索后端升级（倒排 / 向量）
- P0 检索为纯文件系统扫描（design-realm.md §6.2），后端接口可替换；倒排索引或向量检索的立项条件。
- **触发条件**：单 Realm 文件数 > 2 万，或 P50 检索 > 500ms，或语义检索成为明确需求（且本地 embedding 可行、数据不出域）。

### #11 测试超时根治（全局 testTimeout / 低并发池） ✅ 已销项（2026-09-25）
- 原议题：仓库无 vitest 配置文件，所有用例吃 5s 默认超时；scrypt 全量打包、RSA-2048 keygen 这类 CPU 密集用例在并行 fork 争抢下会飘红（成因见 handoff Active work 38）。
- **销项结论**：新增 `vitest.config.ts` 设全局 `testTimeout` / `hookTimeout` = 20s，并删掉三处逐套件 20s 补丁。根治过程中发现放宽救不了那一例：RSA-2048 同步 keygen 在满载下冲破 20s，改为生成 EC 密钥（同样证明"不是 Ed25519"，成本约 1ms），见 commit `db98a3b`。

### #12 CI action 版本升级（Node 20 弃用注解） ✅ 已销项（2026-09-25）
- 原议题：首次真机 CI（run 36024156638）注解提示 `actions/checkout@v4` / `actions/setup-node@v4` 仍 target Node 20、被强制跑在 Node 24；另有 `ubuntu-latest` 将于 2026-10-19 迁 Ubuntu 26。
- **销项结论**：两者升到当前 major `@v7`（查过 release notes：setup-node v5/v6 的破坏性变更集中在自动缓存与非 npm 管理器，本仓库显式 `cache: npm`；checkout v7 只阻断 `pull_request_target`/`workflow_run` 的 fork 检出，本 workflow 用 push/pull_request）。**测试矩阵保持 20.x/22.x**：本机开发 shell 实测是 Node 20.20.2，此时删掉 20 会砍掉唯一与本地一致的覆盖；矩阵该不该换成 22/24、要不要声明 `engines`，留作下面 #15 的立项问题。

### #15 支持矩阵与 engines 声明
- CI 现在测 20.x/22.x，但 Node 20 上游已 EOL（2026-04），仓库 `package.json` **没有 `engines`**，Dockerfile 跑 node:22-slim，本机 dev 在 20.20.2。三者不一致，且没有任何地方写明"这个库支持哪些 Node"。
- **触发条件**：决定结束对 Node 20 的验证时（例如本地 shell 升到 22+），或对外发布为可安装依赖之前。届时一并定：`engines.node` 写什么、矩阵换成哪两档、CI 注解是否要求 runner 版本固定。

### #13 内核状态文件纳入藏宝图（非 Realm 条目源）
- **缺口**：`ZEUS_STATE_FILE` 里现在有封臣名册（含已吊销）、记忆事实+provenance、部门编制、Skill 目录与加固、带教台账、MCP 连接器声明（**含上游 bearer token**）。藏宝图却盖不到它：`src/vault/inventory.ts` 唯一条目源是 `inventoryFromRealm`，对 `src/vault/` 与 `docs/deployment.md` grep `stateFile|kernel.json` 零命中。**"备份是第一公民"目前只覆盖 Realm 目录**，用户最容易丢的恰恰是这份。
- **为什么不是接线就能完（2026-09-25 实测阻塞点）**：
  1. `src/vault/restore.ts:16` 的 L0 原地校验直接 `store.connect(map.realm.root, map.realm.type)`——恢复协议硬绑 `RealmStore`，不是绑 `VaultInventory` 端口。要盖非 Realm 源，先得让 L0 接受"可重连的条目源"。
  2. `TreasureMap.realm: {realmId, type, root, itemCount}` 字段语义是"一个 Realm"。把文件集塞进去要么谎报（合成 `realmId` + `type:'personal'`），要么动格式（加 source 判别位 → 涉及 `VAULT_VERSION` 与既有图的兼容读取）。design-vault §9 只把"多 Realm 合图"列为非目标，没否决这件事，但也没为它留位置。
  3. 条目纪律：状态文件是**单个已知文件**，而 Realm 侧是目录扫描。直接扫 `./data` 会把无界增长的 `audit.jsonl` 和 `*.tmp` 卷进备份——需要显式白名单语义，不是复用扫描。
- **建议做法（拍板后）**：`VaultInventory` 加 `inventoryFromFiles({ root, files })`（itemId=相对路径、digest/bytes/modifiedAt 复用现算法）；L0 改为依赖端口的 `reconnect()` 而非 `RealmStore`；图格式加 `source: { kind:'realm'|'files', ... }` 并保持 v1 图可读；CLI `vault build|backup --files-root <dir> --files a.json,b.json`。
- **触发条件**：① 出现真实用户数据丢失事故或灾备演练要求覆盖内核状态；② E8.4 传承（P3）立项——继承协议必须能交出名册与记忆，届时"图盖不到状态文件"直接堵死该需求；③ 下一次 `VAULT_VERSION` 因别的原因升版时顺手并入，避免两次兼容负担。

### #14 驱动凭证的签发与校验时钟
- E3.5 的 `DriverWriteGrant` 只有**校验**端（形状/绑定域/有效期），没有任何签发路径，也没有签名——`verifyDriverWriteGrant` 信的是"拿到的 JSON 就是驾驶员给的"。且 `FsRealmStore.write` 内部用 `new Date()` 判过期，端口层没有注入时钟，测试里"仍然有效"的凭证只能写成 `expiresAt: '2099-...'`（见 tests/realm-write.test.ts 注释）。
- **触发条件**：MCP `tools/write` 暴露（E3.4/E3.5 剩余半边）立项时一并定：凭证签发与签名、防重放（nonce 目前不比对）、write 路径的可注入时钟。

### #16 CI runner 镜像钉版（ubuntu-latest 于 2026-10-19 自动迁 Ubuntu 26）
- **事实**：`.github/workflows/ci.yml` 的 `runs-on` 是浮动标签 `ubuntu-latest`。2026-09-25 的每一次 run（36024156638 / 36045209815 / 36061395015）都带同一条注解：该标签将于 **2026-10-19** 起指向 Ubuntu 26.04（actions/runner-images#14748）。迁移不需要我们改任何代码，但它会**在没人批准的情况下换掉整台构建机**——系统库、预装 Node、npm 与工具链版本一起变。
- **为什么单列（不并进 #12）**：#12 管的是"action 自己跑在哪个 Node 运行时上"，已随 `@v7` 升级销项；runner 的 **OS 层**从来没人决定过。本项目刚拿到连续三次云端 CI 结论，此时最大的非代码回归面就是这条浮动标签。
- **触发条件**：① 2026-10-19 之前做一次决定——钉 `ubuntu-24.04`（换确定性，代价是要记得升），或接受迁移并在切换后立刻复验一次全绿；② 任何一次 run 出现与本仓库代码无关的环境类失败（apt/预装工具/Node 解析）。
- **与 #15 的边界**：#15 决定"测哪些 Node"，本条决定"在谁的机器上测"。

### #17 数据域边界的显式变更操作（disconnect / 改租户）
- **缺口**：`FsRealmStore` 只有 `connect`，没有 `disconnect`；而同一 root 带不同 tenant 重连会被拒（`would change its tenant scope`，这条本身是对的）。合起来的效果是：**调整一个企业域的租户级没有可执行路径**——只能改 env 重启，而重启时快照里存的仍是旧 tenant，照样撞上同一道漂移检查；剩下唯一的"办法"是手工编辑 `kernel.json` 或删状态文件，而对一个装着名册、记忆与连接器 token 的文件做手改不算运维方案。
- **触发条件**：① 第一次真实的组织结构调整（部门合并 / 改名 / 员工换部门）；② 需要下线某个 Realm（员工离职、目录迁移）。
- **建议做法（拍板后）**：`disconnect(realmId)`（显式确认 + 写审计）与 `retargetTenant(realmId, from, to)`（要求携带旧值做比较交换，防误改），或把启动期的"租户变更"识别为一次**显式声明的迁移**而不是静默漂移。

### #18 MCP 暴露侧的主体（actor）判定
- **缺口**：`createRealmMcpHandler` 的隔离单位仍是"宿主给这个 server 预连接了哪些 `realmIds`"，handler 内部没有主体概念——因此 design-realm §7.2 的租户/域规则在 **MCP 资源读取路径上没有执行点**，只在 `realmSource`（内核代取）与访问探针上生效。
- **为什么不在本批一起做**：接一个假 actor 进去只能证明"这段代码能被调用"，证不了真实封臣会带什么身份形态（会话级？条目级？），那是猜。
- **触发条件**：E3.4 正式 MCP 暴露立项（首个 read-realm 封臣出现）时一并定：主体身份如何随 MCP 会话传入（stdio 环境 / header / OAuth subject）、`zeus-realm:` URI 是否编码租户、以及与 #14 的**签发（签名）凭证**合并考虑。
