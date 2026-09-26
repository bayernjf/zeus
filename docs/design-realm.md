# Realm 数据域设计（D1 契约先行）

> 状态：**现行（契约 v0.5，2026-09-25：write、企业域 connect、企业域租户分级与双域授权（§7）、签名且一次性的企业写凭证（§7.7）已落库内；MCP 暴露仍 P1）**。P0 实现直接落 `src/realm/`（库内 RealmStore），不另起实现文档；MCP 暴露在 P1。产品哲学依据见 [product-portrait.md](product-portrait.md) §2.1/§2.2。

## 0. 一句话

Realm 是用户指定的**一个目录**及其纳管数据：先连接、后使用；目录即数据库，一切 Agent（含执行 Agent）经统一接口读它，不直接碰文件系统。

## 1. 核心不变量（违反任何一条即实现错误）

1. **目录是唯一数据来源**：Zeus 对 Realm 之外的用户文件零访问；绝不扫描父目录或兄弟目录。
2. **先连接后使用**：未完成 connect（含 manifest 建立）的 Realm，任何读写一律拒绝。
3. **暴露接口而非文件**：Agent/执行 Agent只见本契约的 API，不见路径、不见原始文件布局。
4. **Realm 有类型**：`personal` / `enterprise`，一经 connect 固定；派发任务时由 Dispatcher 对照 fealty.dataRealms 做数据二极管。企业域再按 **§7 的租户分级**（组织/部门/成员）细分，个人域不是租户。
5. **备份是第一公民**：connect 即生成 manifest 备份基线；没有备份能力的 Realm 可以降级为只读。

## 2. 接口契约（TypeScript 形态）

> 传输层决策见 §6：**对外唯一传输为 MCP server；P0 先落库内 `RealmStore`（同进程调用），接口按 MCP 资源语义设计，未来 1:1 包一层 MCP，不做独立 HTTP API。**

```ts
type RealmId = string;
type RealmType = 'personal' | 'enterprise';
/** E3.6 (§7.1): a position in the enterprise hierarchy. Enterprise realms only. */
type TenantScope = { org: string; department?: string; member?: string };

interface RealmManifest {
  realmId: RealmId;
  type: RealmType;
  tenant?: TenantScope;         // E3.6: set only on enterprise realms
  root: string;                 // 绝对路径，仅 connect 时解析，之后不外泄
  createdAt: string;
  contentDigest: string;        // 全量内容指纹，备份与漂移检测的基准
  backup: { strategy: 'none' | 'manifest-only' | 'full'; lastVerifiedAt?: string };
}

interface RealmStore {
  connect(root: string, type: RealmType, opts?: { readOnly?: boolean; tenant?: string | TenantScope }): Promise<RealmManifest>;
  manifest(realmId: RealmId): Promise<RealmManifest>;

  // 读：检索是主路径，枚举是兜底
  search(realmId: RealmId, query: { text?: string; tags?: string[]; since?: string; limit?: number }): Promise<RealmHit[]>;
  read(realmId: RealmId, itemId: string): Promise<unknown>;

  // 写：个人域默认允许；企业域写必须带操作者授权凭证
  // v0.19 库内已落地：第三参 grant?: DriverWriteGrant。v0.5 起它是签名的一次性凭证（§7.7）；MCP 暴露时由鉴权层注入
  write?(realmId: RealmId, item: { itemId?: string; data: unknown; tags?: string[] }, grant?: DriverWriteGrant): Promise<{ itemId: string }>;
}

interface RealmHit { itemId: string; tags: string[]; snippet: string; modifiedAt: string; }
```

> **§7 增补的两个库内原语（不是 RealmStore 端口的一部分，故不混进上面的契约）**：`decideRealmAccess()`（唯一边界判定，`src/realm/authorization.ts`）与 `resolveRealmSource()`（内核侧取数 + 审计，`src/realm/source.ts`）。端口保持"读写一个已连接 Realm"，边界判断住在它们之上——否则每个 RealmStore 实现都要各自重做一遍安全。

## 3. 数据二极管的执行点

| 场景 | 规则 |
| --- | --- |
| Zeus 派发任务给执行 Agent | Dispatcher 对照 `fealty.dataRealms` 与任务 Realm 类型，不符即拒绝并记审计 |
| Realm 内容注入任务参数 | 检索结果按执行 Agent `dataPolicy` 裁剪：`none` 不注入；`read-task-scope` 只注入任务命中的条目；`read-realm` 放行 |
| 个人域 → 企业域 | 未经操作者显式授权，禁止（企业合规） |
| 企业域 → 个人域 | 禁止，无例外 |

## 4. 与备份清单（Map）的关系

Map 不在本契约内，但依赖它：Map 的 manifest 条目引用 `realmId + itemId`，恢复协议（recovery protocol）通过本契约的 `read` 取回数据条目。**Map 永远只存引用与指引，不存数据本体**。

## 5. 交付节奏

- P0（已落，后续批次扩到写与企业域）：库内 `RealmStore`：`connect / manifest / search / read`；检索为纯文件系统扫描（可替换后端）。**不启传输**，Zeus 内核同进程调用（dispatcher 的 realmHits 注入即由本层检索供给）。
- P1：**第一件事是把 RealmStore 包成 MCP server 暴露**（streamable HTTP + 鉴权，传输形态立项时定），让 read-realm 执行 Agent与任意 MCP 客户端经授权读取；随后做 `write` 与授权凭证、enterprise Realm。
  - **落地进展（v0.19）**：`write` 的库内部分与授权凭证门已先行落地（不依赖 MCP 触发条件）——`FsRealmStore.write` 与 `src/realm/grant.ts` `verifyDriverWriteGrant`：personal 默认可写、readOnly 拒写、enterprise 写须绑定本域且未过期的操作者凭证（形状/域/有效期纯函数校验；**签名、签发与一次性自 v0.5 起在库内**，见 §7.7）；原子写、路径/symlink/扩展名/尺寸防护、写后快照与 contentDigest 一致性、审计回调齐备。
  - **落地进展（2026-09-25，E3.5 收口）**：`connect` 不再拒 enterprise，且**存储的类型如实记录**（此前 `realms.set` 把 type 硬编码成 `personal`，于是企业域写闸门在真实 store 上永远走不到、凭证门只在纯函数测试里被 mock 打过桩——是死代码）。现在企业域 connect→写授权→写后读回→审计记 `grantedBy` 全链路有测试；`readOnly` 连接即使持有效凭证仍拒写。二极管制仍然只在写侧与派发/决策/记忆层落地：本层不存在跨 realm 写入路径（每次读写都以单一 realmId 定址），所以"企业域→个人域禁止"在 RealmStore 层无执行点，其真实约束在 Dispatcher `dataRealms` / decision `prepareState` / MemoryStore 边界。**仍未做**：MCP `tools/write` 暴露（签发/验签/防重放已于同日补上，见 §7.7 与 deferred #14 销项）。
  - **E3.6 多租户分级（2026-09-25 落地，见 §7）**：本层原有的 personal/enterprise 两型标记只是"域"，不是"租户"；`connect(root, 'enterprise')` 打开的是"企业域可挂载 + 写须授权"，不等于多租户隔离。§7 补上组织/部门/成员三级、边界判定与授权生命周期。
- P2：备份策略执行器（full / manifest-only）与漂移检测（contentDigest 对账）；检索后端按需升级（见 §6 决策与 deferred #10）。

## 6. 决策记录（2026-09-21 决定，P0 动工前）

### 6.1 传输层：MCP server 为唯一对外传输，HTTP API 不做

- **决策**：Realm 对外只以 **MCP server** 暴露；P0 只实现库内 `RealmStore`（同进程、无传输）；P1 第一件事包 MCP（resources 对应 read/search，tools 对应 write）。不单独建设 HTTP REST API。
- **理由**：
  1. MCP 是三条能力接入通道之"连接世界"，数据域接入走 MCP 是强制姿势（product-portrait.md §2.3）；自造 HTTP API 等于在标准之外另立一堵墙。
  2. MCP 自带资源模型、鉴权中间件与生态，"任意 MCP 客户端经授权读 Realm"正是不变量 3（暴露接口而非文件）的目标形态。
  3. 少维护一套传输即少一个攻击面——Realm 是数据主权底座，安全敏感。
  4. P0 的风险在五条不变量与检索/备份语义，不在传输；库内接口先行不阻塞验证，且按 MCP 资源语义设计，未来包壳不改契约。
- **Zeus 内部组件**（监督台、名册、未来 UI）：同进程调用库接口，不经网络。
- **遗留**：MCP transport 选型（stdio vs streamable HTTP）、跨机执行 Agent 的 OAuth/mTLS 形态在 P1 暴露立项时定；契约保持传输无关。

### 6.2 检索实现：P0 纯文件系统扫描，后端可替换，按阈值升级

- **决策**：P0 检索 = **纯文件系统扫描 + 大小写不敏感子串匹配**，无索引、无外部依赖；检索器定义为可替换接口（SearchBackend），P0 提供 `ScanSearchBackend`。
- **扫描纪律**（也是安全边界）：
  - 只扫已 connect 的 root 之内，绝不越父目录/兄弟目录（不变量 1）；
  - 默认排除 `.git`、`node_modules`、隐藏目录与二进制文件；文本类型走白名单（md/txt/json/csv/源码常见文本后缀）；
  - 单文件大小设上限（默认 1 MiB），超限跳过并计入 manifest 的 skipped 清单；
  - `itemId` = 相对 root 的 POSIX 路径；`read` 对 `..`、绝对路径、符号链接越界一律拒绝（路径穿越防护，测试必覆盖）。
- **理由**：零索引、零外部依赖、数据不出域（向量方案若调云端 embedding 直接违背数据主权；本地模型对 P0 过重）；个人 Realm 万级文件内扫描延迟可接受；P0 只读，没有索引一致性问题。
- **升级触发条件**（登记 deferred #10）：单 Realm 文件数 > 2 万 或 P50 检索 > 500ms 或语义检索成为明确需求（且本地 embedding 可行）→ 上倒排索引 / 向量检索，SearchBackend 接口不变。

### 6.3 仍开放（不阻塞 P0）

- 一人多个 Realm 与 Realm 继承的关系（联动 deferred #3 传承；多 Realm 连接本身 P0 接口已允许，继承语义后定）。

### 6.4 操作者面与 Realm 内容的边界（2026-09-25，随 E6.4 重新表述）

§6.1 拍的是"**Realm 内容**对外只有 MCP"。E6.4 落了 `/api/domains*` 与 `POST /api/intents` 的 `realmSource` 之后，这句话需要精确化，否则代码与决策互相打脸：

- **仍然禁止**：把 Realm 的条目内容做成 HTTP 读接口（没有 `GET /api/realm/items/...` 这种东西；执行 Agent要读内容只能走 MCP）。
- **允许并且已落**：操作者 bearer 面上暴露 Realm 的**治理元数据**（挂载了哪个域、哪级租户、是否只读、条目数、内容指纹）与**授权记录**。理由与 `GET /api/state` 同源：这些是"边界长什么样"，不是"边界里装什么"。
- **`realmSource` 不是新传输面**：它不向客户端返回命中，只让**内核代替调用方去取**，然后把命中送进派发链路。方向上它是在收窄 §6.1 想防的东西——内容来源从"调用方自报"变成"内核亲自解析并核对声明"。
- 一句话规则：**对外（执行 Agent/其他 Agent）→ MCP；对内（操作者自己）→ bearer HTTP，且只到元数据与授权为止。**

## 7. 企业域分级与双域授权（E3.6 / E6.4，2026-09-25 落地）

> 一句话：**层级是结构边界（不可授权放宽），域边界才是授权的对象**。把这两件事分开，是为了避免"一张凭证溶解整个租户模型"。

### 7.1 分级形态：TenantScope

- 企业 Realm 挂一个层级位置：`{org, department?, member?}`（1–3 段，写法 `acme` / `acme/eng` / `acme/eng/张三`）。
- **个人域不是租户**：`connect(root, 'personal', { tenant })` 直接抛错而不是忽略——让"这是个人域"成为类型层面的陈述，靠调用方自觉不算实现。
- 段名逐字保留（非 ASCII 可用，承袭中文名那次教训）；**匹配按大小写折叠**，所以 `ACME/Eng` 与 `acme/eng` 是同一个租户。
- 同一 root 重连但给了不同 tenant → 拒（`would change its tenant scope`）：不允许把一次重连当成静默改写已挂载数据域边界的手段。
- tenant **可选**。没声明租户的企业 Realm = 只有操作者可达（任何带租户的主体一律拒）。这不是漏洞而是默认收紧：没有边界可匹配时不放行。

### 7.2 三条边界，各自只有一个负责人

| 边界 | 规则 | 可被授权放宽？ |
| --- | --- | --- |
| 企业层级内部（org ⊇ department ⊇ member） | 主体 scope 必须是 realm tenant 的**前缀或相等**（可下探，不可上望、不可旁视） | **否**，结构性 |
| 个人域 → 企业域 | 默认拒 | **是**：`DomainGrant(subject × realmId × access)` |
| 企业域 → 个人域 | **永远拒** | **否**——连能表达它的凭证形状都不存在 |

与 E3.5 的分工（两层不合并，否则一个凭证要回答两个问题）：`DriverWriteGrant` 管"**这一次**企业写被操作者授权了"（绑定 realmId + 有效期，写在 store 里）；`DomainGrant` 管"**这个主体**能不能碰那个域"（读与写分别授）。

### 7.3 判定与凭证生命周期

- `decideRealmAccess()` 是**唯一**判定函数：派发取数、操作者探针都走它，物理上不可能出现两处答案不一致。返回 `{ok, via:'same-domain'|'tenant-hierarchy'|'grant'}` 或 `{ok:false, reason}`。
- reason 精确到 `grant-expired` / `access-not-granted` / `no-grant`：**"从来没授权过"和"授权过期了"要求操作员做两件不同的事**，合并成一个 `no-grant` 会逼人去翻记录，而记录其实就在眼前。
- `DomainGrantRegistry` 另管两件事：**nonce 一次性**（吊销后原 nonce 仍算已用——否则"撤销"会变相成为重放入口）、**随 KernelSnapshot 持久化**（重启既不静默放宽、也不静默丢失授权）。

### 7.4 取数路径：内核自己进 Realm（本轮真正的安全增量）

在这之前 `realmHits` 是**调用方自报**的：意图可以声明 `realm:"personal"`，同时塞进从企业域挖来的内容，内核无从分辨——因为它自己从没进过任何 Realm。`resolveRealmSource()` 现在：

1. 按 realmId 取 manifest，拿到**真实** type/tenant；
2. 与意图声明的 `realm` 交叉核对，不符即拒（`realm-type-mismatch`）——**这是自报路径永远做不到的断言**；
3. 过 §7.2 的判定；
4. 才执行 search，命中连同 realmId 一起写进派发请求（provenance 由此可查）；
5. 放行与拒绝**都落审计**（`domain-read` / `domain-refused`，reason 作为前缀，走同一根 audit spine）。

`onBehalfOf` 让"替执行 Agent取数"按**被执行 Agent 的边界**判定，而不是持 token 者的边界；且只接受 `vassal|agent`——**不接受再声称一次 `driver`**，因为 driver 恰是不受域门约束的身份，允许冒充等于给自己开后门。

操作者仍可自报 `realmHits`（用户是自己数据的主权者，这是产品底座不是漏洞），但两者**互斥**：一份意图只能有一个内容来源，否则 provenance 说不清。

### 7.5 运维面（"授权界面"在无 UI 产品里的形态）

- `GET /api/domains`：挂载了什么、哪一级、是否只读、条目数、内容指纹；**响应里绝不含绝对路径**（不变量 3）。
- `POST /api/domains/grants` / `DELETE /api/domains/grants/:id`：签发与吊销；对 personal 域要授权 → 400（那个方向不卖）；nonce 重用 → 409。
- `GET /api/domains/access?realmId&subject&kind&tenant&access`：**干跑探针**，回答"现在这样会被允许吗"而不读任何内容。
- `GET /api/audit?decision=domain-refused`（以及 `domain-read` / `domain-grant-issued` / `domain-grant-revoked`）：边界穿越与授权生命周期的呈现，复用 E4.7 那根审计事件流，不另造一套日志。
- env：`ZEUS_REALM_ENTERPRISE="<root>::<tenant>"`（`::` 因为 Windows 盘符已占用单冒号）。tenant 缺失或非法 → **拒启**，因为"企业域无边界地挂载"正是这层要防的事。
- `GET /api/state` 增计数：`enterpriseRealms` / `tenantScopedRealms` / `domainGrants`——**没标租户的企业域数量**是操作员最该一眼看到的风险位。

### 7.6 未做（诚实边界，已登记）

- **MCP 侧尚未接 actor**：`createRealmMcpHandler` 的隔离单位仍是"宿主给某个 server 预连接哪些 `realmIds`"。把 §7.2 的判定接进去需要真实 read-realm 执行 Agent触发（否则规则只能被 mock 打桩）→ deferred **#18**。
- **没有 disconnect / 显式改边界**：改租户只能重启，而重启又会被 §7.1 的漂移检查拒启 → 缺一个显式操作 → deferred **#17**。
- 企业域→个人域在**决策/记忆注入侧**仍按 realm type 粗粒度约束（`prepareState` / MemoryStore 边界），未接 DomainGrant 粒度。

### 7.7 企业写凭证：签发、验签与一次性（E3.5 / deferred #14，2026-09-25）

**修掉的洞**：`verifyDriverWriteGrant` 此前只做形状/绑定/有效期校验，也就是说它**相信"拿到的这坨 JSON 就是操作者给的"**。而任何能摸到 `store.write()` 的代码（执行 Agent适配器、连接器、未来的 MCP handler）都能自己拼一坨——那不是凭证检查，是装饰。

**凭证是什么**：一张**签名过的一次性写授权**——"密钥 K 授权向 realm R 写一次，T 时刻前有效"。

| 组成 | 落点 | 为什么在那儿 |
|---|---|---|
| 签发 `issueDriverWriteGrant` | `src/realm/grant.ts` | nonce 由内核铸造（调用方不能预授权一批写）；`grantedAt/expiresAt` 由注入时钟盖章；签名走 `canonicalJson`（RFC 8785 子集）+ Ed25519，**复用 `src/registry/signing.ts` 的 `RosterSigner`，不另造一套信封** |
| 验签 `verifyDriverWriteGrant`（改为 async） | 同上 | 判定顺序：形状 → realm 绑定 → **签名**（`unsigned` / `unknown-key` / `bad-signature`）→ 有效期（`expired` / `no-expiry`）。失败**不消费** nonce，否则一次被拒的尝试能烧掉别人的凭证 |
| 一次性 | `DriverGrantLedger`（有界窗口，默认 10 000） | store 在真正落盘前 `consume(nonce)`；已被消费的 → `replayed` |
| 持久化 | `KernelSnapshot.writeGrantNonces` | 内存里的账本等于没有账本：崩溃重启后那张 grant 还能用一次。消费即触发状态落盘（`onChange`），不等优雅退出 |
| 时钟 | `FsRealmStoreOptions.now` | 此前 `write` 用墙上时钟判过期，测试里"仍然有效"的凭证只能写成 `expiresAt: 2099-…`——那条注释本身就是"这个门从没被真正测过"的自白 |

**两种权威模式，必须可观测**：

- `signed`：内核持有操作者密钥（serve 进程 = RSK，`ZEUS_RSK_KEY*`）。未签名 / 别的密钥签的 / 改过一个字段的凭证一律拒。
- `shape-only`：没配密钥（纯库内调用、开发态）。凭证仍受形状/绑定/**一次性**约束，但签名无从校验。
- 模式不是秘密：`GET /api/state` 出 `driverGrants: { authority, keyId }`，启动日志明说当前是哪种。**"我们验签了"永远不需要靠猜。**
- 有 verifier 时**强制要求有效期**（`no-expiry` 直接拒）：没有到期时间的写凭证是常驻权限，而常驻权限是 `DomainGrant`（§7.2）的语义，不是这一层的。
- nonce 账本是**窗口**不是全量历史：只要窗口 ≥ 最长存活凭证被重复提交的窗口即可，而签发侧已经把 ttl 钉死在 ≤ 24h（`DRIVER_GRANT_MAX_TTL_MS`），10 000 条远远够。

**运维面**：

- `POST /api/realm/write-grants`（bearer）：`{realmId, grantedBy, reason?, ttlSeconds?}` → 201 返回签名凭证。对 personal 域要凭证 → 400（personal 域本来就可写，说明你指错了 realm）；realm 不存在 → 404；只读连接 → 409（任何凭证都救不了它）；ttl 越界 → 400。
- `POST /api/diary/generate` 增 `body.grant`：企业域的日记落盘必须带凭证；缺/错 → **403**（不是 400、不是 500——请求没问题，缺的是授权）。
- 审计事件流新增两个 decision：`driver-grant-issued`（签发，含 realmId/grantedBy/keyId/到期/reason）与 `realm-write`（**被凭证放行**的写）。personal 域的日常写不进审计事件流：那是用户在自己目录里写文件，把它们记下来只会把真正关于授权的事件埋掉。

**诚实边界**：单 owner 部署里签发方与验签方是同一把密钥，因此这条链证明的是**"这张凭证出自内核的签发路径（受 bearer 保护、留审计），不是调用方自己拼的"**，而不是"某个第三方操作者签的字"。真出现独立操作者时，改动只是把对方的公钥加进 `acceptedKeyIds` 与 verifier——判定与账本都不用动。MCP `tools/write` 暴露时由鉴权层注入凭证，见 deferred **#18**（actor 判定）。


## 8. 演进日志

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| v0.1 | 2026-09-21 | 初稿：五条核心不变量、RealmStore 接口契约、数据二极管执行点、备份清单关系、P0–P2 节奏 |
| v0.2 | 2026-09-21 | 决定传输层（MCP server 为唯一对外传输，P0 库内先行、P1 包 MCP，不做 HTTP API）与检索实现（P0 文件系统扫描 + 可替换后端，阈值触发升级 → deferred #10） |
| v0.3 | 2026-09-25 | §5 交付节奏补写实现进展：write + 凭证门（v0.19）；**enterprise connect 放开且存储类型如实记录**（修掉 `realms.set` 硬编码 personal 导致 E3.5 写闸门成死代码的问题），E3.5 收口、MCP write 暴露与签发凭证仍待 E3.4 触发；明确 §3 "企业域→个人域禁止" 在 RealmStore 层无执行点（本层无跨 realm 写路径），约束落在 Dispatcher / decision / MemoryStore；E3.6 多租户分级显式区别于"企业域可挂载"，仍未立项 |
| v0.4 | 2026-09-25 | **E3.6 + E6.4 落地**：新增 §7（企业域三级 `TenantScope`、"层级是结构边界 / 域边界才是授权对象"的分工、`decideRealmAccess` 单一判定与精确 reason、nonce 一次性 + 快照持久化、`resolveRealmSource` 让内核自己进 Realm 从而能核对"声明的域 vs 内容真实的域"、操作者面与 `ZEUS_REALM_ENTERPRISE`）；§6.4 把 §6.1 的"Realm 对外只有 MCP"精确化为**内容 vs 治理元数据**；§1 不变量 4 补租户一层；§2 契约加 `tenant` 与新原语的位置说明。仍未做（§7.6，登记 deferred #17/#18）：MCP 侧 actor 判定、显式改边界（disconnect）。 |
| v0.5 | 2026-09-25 | **deferred #14 销项（新增 §7.7）**：`DriverWriteGrant` 从"形状校验"升级为**签名且一次性的凭证**——`issueDriverWriteGrant`（内核铸 nonce、盖时间戳、用 RSK 的 Ed25519 签 JCS，复用 `registry/signing.ts` 的 `RosterSigner`）、`verifyDriverWriteGrant` 改 async 且按 形状→realm 绑定→**验签**→有效期 判定（`unsigned` / `unknown-key` / `bad-signature` / `no-expiry`）、`DriverGrantLedger` 在落盘前消费 nonce 且**随内核快照持久化**（`writeGrantNonces`，否则重启即重放）、`FsRealmStoreOptions.now` 注入时钟（此前"仍然有效"的测试凭证只能写成 `expiresAt: 2099-…`）。运维面：`POST /api/realm/write-grants`、日记写凭证透传（缺授权 → **403**，不是 400/500）、审计事件流 `driver-grant-issued` + `realm-write`、`GET /api/state` 报 `driverGrants.authority`（`signed` / `shape-only` 不靠猜）。§5 两处"签发仍未做"与 §2 契约注释同步收口。三个守卫各做过缺陷植入验证（见 handoff Active work 45）。 |
