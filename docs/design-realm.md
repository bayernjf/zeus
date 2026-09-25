# Realm 数据域设计（D1 契约先行）

> 状态：**现行（契约 v0.4，2026-09-25：write、企业域 connect、**企业域租户分级与双域授权（§7）**已落库内；MCP 暴露仍 P1）**。P0 实现直接落 `src/realm/`（库内 RealmStore），不另起实现文档；MCP 暴露在 P1。产品哲学依据见 [product-portrait.md](product-portrait.md) §2.1/§2.2。

## 0. 一句话

Realm 是用户指定的**一个目录**及其纳管数据：先连接、后使用；目录即数据库，一切 Agent（含封臣）经统一接口读它，不直接碰文件系统。

## 1. 核心不变量（违反任何一条即实现错误）

1. **目录是唯一数据来源**：Zeus 对 Realm 之外的用户文件零访问；绝不扫描父目录或兄弟目录。
2. **先连接后使用**：未完成 connect（含 manifest 建立）的 Realm，任何读写一律拒绝。
3. **暴露接口而非文件**：Agent/封臣只见本契约的 API，不见路径、不见原始文件布局。
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

  // 写：个人域默认允许；企业域写必须带驾驶员授权凭证
  // v0.19 库内已落地：第三参 grant?: DriverWriteGrant（MCP 暴露时由鉴权层注入签名凭证）
  write?(realmId: RealmId, item: { itemId?: string; data: unknown; tags?: string[] }, grant?: DriverWriteGrant): Promise<{ itemId: string }>;
}

interface RealmHit { itemId: string; tags: string[]; snippet: string; modifiedAt: string; }
```

> **§7 增补的两个库内原语（不是 RealmStore 端口的一部分，故不混进上面的契约）**：`decideRealmAccess()`（唯一边界判定，`src/realm/authorization.ts`）与 `resolveRealmSource()`（内核侧取数 + 审计，`src/realm/source.ts`）。端口保持"读写一个已连接 Realm"，边界判断住在它们之上——否则每个 RealmStore 实现都要各自重做一遍安全。

## 3. 数据二极管的执行点

| 场景 | 规则 |
| --- | --- |
| Zeus 派发任务给封臣 | Dispatcher 对照 `fealty.dataRealms` 与任务 Realm 类型，不符即拒绝并记审计 |
| Realm 内容注入任务参数 | 检索结果按封臣 `dataPolicy` 裁剪：`none` 不注入；`read-task-scope` 只注入任务命中的条目；`read-realm` 放行 |
| 个人域 → 企业域 | 未经驾驶员显式授权，禁止（企业合规） |
| 企业域 → 个人域 | 禁止，无例外 |

## 4. 与藏宝图（Map）的关系

Map 不在本契约内，但依赖它：Map 的 manifest 条目引用 `realmId + itemId`，恢复协议（recovery protocol）通过本契约的 `read` 取回宝藏。**Map 永远只存引用与指引，不存数据本体**。

## 5. 交付节奏

- P0（已落，后续批次扩到写与企业域）：库内 `RealmStore`：`connect / manifest / search / read`；检索为纯文件系统扫描（可替换后端）。**不启传输**，Zeus 内核同进程调用（dispatcher 的 realmHits 注入即由本层检索供给）。
- P1：**第一件事是把 RealmStore 包成 MCP server 暴露**（streamable HTTP + 鉴权，传输形态立项时定），让 read-realm 封臣与任意 MCP 客户端经授权读取；随后做 `write` 与授权凭证、enterprise Realm。
  - **落地进展（v0.19）**：`write` 的库内部分与授权凭证门已先行落地（不依赖 MCP 触发条件）——`FsRealmStore.write` 与 `src/realm/grant.ts` `verifyDriverWriteGrant`：personal 默认可写、readOnly 拒写、enterprise 写须绑定本域且未过期的驾驶员凭证（形状/域/有效期纯函数校验，签名与传输鉴权仍属 MCP 层 P1）；原子写、路径/symlink/扩展名/尺寸防护、写后快照与 contentDigest 一致性、审计回调齐备。
  - **落地进展（2026-09-25，E3.5 收口）**：`connect` 不再拒 enterprise，且**存储的类型如实记录**（此前 `realms.set` 把 type 硬编码成 `personal`，于是企业域写闸门在真实 store 上永远走不到、凭证门只在纯函数测试里被 mock 打过桩——是死代码）。现在企业域 connect→写授权→写后读回→审计记 `grantedBy` 全链路有测试；`readOnly` 连接即使持有效凭证仍拒写。二极管制仍然只在写侧与派发/决策/记忆层落地：本层不存在跨 realm 写入路径（每次读写都以单一 realmId 定址），所以"企业域→个人域禁止"在 RealmStore 层无执行点，其真实约束在 Dispatcher `dataRealms` / decision `prepareState` / MemoryStore 边界。**仍未做**：MCP `tools/write` 暴露与签发（签名）凭证。
  - **E3.6 多租户分级（2026-09-25 落地，见 §7）**：本层原有的 personal/enterprise 两型标记只是"域"，不是"租户"；`connect(root, 'enterprise')` 打开的是"企业域可挂载 + 写须授权"，不等于多租户隔离。§7 补上组织/部门/成员三级、边界判定与授权生命周期。
- P2：备份策略执行器（full / manifest-only）与漂移检测（contentDigest 对账）；检索后端按需升级（见 §6 决策与 deferred #10）。

## 6. 决策记录（2026-09-21 拍板，P0 动工前）

### 6.1 传输层：MCP server 为唯一对外传输，HTTP API 不做

- **决策**：Realm 对外只以 **MCP server** 暴露；P0 只实现库内 `RealmStore`（同进程、无传输）；P1 第一件事包 MCP（resources 对应 read/search，tools 对应 write）。不单独建设 HTTP REST API。
- **理由**：
  1. MCP 是立国三纲之"连接世界"，数据域接入走 MCP 是强制姿势（product-portrait.md §2.3）；自造 HTTP API 等于在标准之外另立一堵墙。
  2. MCP 自带资源模型、鉴权中间件与生态，"任意 MCP 客户端经授权读 Realm"正是不变量 3（暴露接口而非文件）的目标形态。
  3. 少维护一套传输即少一个攻击面——Realm 是数据主权底座，安全敏感。
  4. P0 的风险在五条不变量与检索/备份语义，不在传输；库内接口先行不阻塞验证，且按 MCP 资源语义设计，未来包壳不改契约。
- **Zeus 内部组件**（监督台、名册、未来 UI）：同进程调用库接口，不经网络。
- **遗留**：MCP transport 选型（stdio vs streamable HTTP）、跨机封臣的 OAuth/mTLS 形态在 P1 暴露立项时定；契约保持传输无关。

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

### 6.4 驾驶员面与 Realm 内容的边界（2026-09-25，随 E6.4 重新表述）

§6.1 拍的是"**Realm 内容**对外只有 MCP"。E6.4 落了 `/api/domains*` 与 `POST /api/intents` 的 `realmSource` 之后，这句话需要精确化，否则代码与决策互相打脸：

- **仍然禁止**：把 Realm 的条目内容做成 HTTP 读接口（没有 `GET /api/realm/items/...` 这种东西；封臣要读内容只能走 MCP）。
- **允许并且已落**：驾驶员 bearer 面上暴露 Realm 的**治理元数据**（挂载了哪个域、哪级租户、是否只读、条目数、内容指纹）与**授权记录**。理由与 `GET /api/state` 同源：这些是"边界长什么样"，不是"边界里装什么"。
- **`realmSource` 不是新传输面**：它不向客户端返回命中，只让**内核代替调用方去取**，然后把命中送进派发链路。方向上它是在收窄 §6.1 想防的东西——内容来源从"调用方自报"变成"内核亲自解析并核对声明"。
- 一句话规则：**对外（封臣/其他 Agent）→ MCP；对内（驾驶员自己）→ bearer HTTP，且只到元数据与授权为止。**

## 7. 企业域分级与双域授权（E3.6 / E6.4，2026-09-25 落地）

> 一句话：**层级是结构边界（不可授权放宽），域边界才是授权的对象**。把这两件事分开，是为了避免"一张凭证溶解整个租户模型"。

### 7.1 分级形态：TenantScope

- 企业 Realm 挂一个层级位置：`{org, department?, member?}`（1–3 段，写法 `acme` / `acme/eng` / `acme/eng/张三`）。
- **个人域不是租户**：`connect(root, 'personal', { tenant })` 直接抛错而不是忽略——让"这是个人域"成为类型层面的陈述，靠调用方自觉不算实现。
- 段名逐字保留（非 ASCII 可用，承袭中文名那次教训）；**匹配按大小写折叠**，所以 `ACME/Eng` 与 `acme/eng` 是同一个租户。
- 同一 root 重连但给了不同 tenant → 拒（`would change its tenant scope`）：不允许把一次重连当成静默改写已挂载数据域边界的手段。
- tenant **可选**。没声明租户的企业 Realm = 只有驾驶员可达（任何带租户的主体一律拒）。这不是漏洞而是默认收紧：没有边界可匹配时不放行。

### 7.2 三条边界，各自只有一个负责人

| 边界 | 规则 | 可被授权放宽？ |
| --- | --- | --- |
| 企业层级内部（org ⊇ department ⊇ member） | 主体 scope 必须是 realm tenant 的**前缀或相等**（可下探，不可上望、不可旁视） | **否**，结构性 |
| 个人域 → 企业域 | 默认拒 | **是**：`DomainGrant(subject × realmId × access)` |
| 企业域 → 个人域 | **永远拒** | **否**——连能表达它的凭证形状都不存在 |

与 E3.5 的分工（两层不合并，否则一个凭证要回答两个问题）：`DriverWriteGrant` 管"**这一次**企业写被驾驶员授权了"（绑定 realmId + 有效期，写在 store 里）；`DomainGrant` 管"**这个主体**能不能碰那个域"（读与写分别授）。

### 7.3 判定与凭证生命周期

- `decideRealmAccess()` 是**唯一**判定函数：派发取数、驾驶员探针都走它，物理上不可能出现两处答案不一致。返回 `{ok, via:'same-domain'|'tenant-hierarchy'|'grant'}` 或 `{ok:false, reason}`。
- reason 精确到 `grant-expired` / `access-not-granted` / `no-grant`：**"从来没授权过"和"授权过期了"要求操作员做两件不同的事**，合并成一个 `no-grant` 会逼人去翻记录，而记录其实就在眼前。
- `DomainGrantRegistry` 另管两件事：**nonce 一次性**（吊销后原 nonce 仍算已用——否则"撤销"会变相成为重放入口）、**随 KernelSnapshot 持久化**（重启既不静默放宽、也不静默丢失授权）。

### 7.4 取数路径：内核自己进 Realm（本轮真正的安全增量）

在这之前 `realmHits` 是**调用方自报**的：意图可以声明 `realm:"personal"`，同时塞进从企业域挖来的内容，内核无从分辨——因为它自己从没进过任何 Realm。`resolveRealmSource()` 现在：

1. 按 realmId 取 manifest，拿到**真实** type/tenant；
2. 与意图声明的 `realm` 交叉核对，不符即拒（`realm-type-mismatch`）——**这是自报路径永远做不到的断言**；
3. 过 §7.2 的判定；
4. 才执行 search，命中连同 realmId 一起写进派发请求（provenance 由此可查）；
5. 放行与拒绝**都落审计**（`domain-read` / `domain-refused`，reason 作为前缀，走同一根 audit spine）。

`onBehalfOf` 让"替封臣取数"按**被封臣的边界**判定，而不是持 token 者的边界；且只接受 `vassal|agent`——**不接受再声称一次 `driver`**，因为 driver 恰是不受域门约束的身份，允许冒充等于给自己开后门。

驾驶员仍可自报 `realmHits`（用户是自己数据的主权者，这是产品底座不是漏洞），但两者**互斥**：一份意图只能有一个内容来源，否则 provenance 说不清。

### 7.5 运维面（"授权界面"在无 UI 产品里的形态）

- `GET /api/domains`：挂载了什么、哪一级、是否只读、条目数、内容指纹；**响应里绝不含绝对路径**（不变量 3）。
- `POST /api/domains/grants` / `DELETE /api/domains/grants/:id`：签发与吊销；对 personal 域要授权 → 400（那个方向不卖）；nonce 重用 → 409。
- `GET /api/domains/access?realmId&subject&kind&tenant&access`：**干跑探针**，回答"现在这样会被允许吗"而不读任何内容。
- `GET /api/audit?decision=domain-refused`（以及 `domain-read` / `domain-grant-issued` / `domain-grant-revoked`）：边界穿越与授权生命周期的呈现，复用 E4.7 那根审计脊，不另造一套日志。
- env：`ZEUS_REALM_ENTERPRISE="<root>::<tenant>"`（`::` 因为 Windows 盘符已占用单冒号）。tenant 缺失或非法 → **拒启**，因为"企业域无边界地挂载"正是这层要防的事。
- `GET /api/state` 增计数：`enterpriseRealms` / `tenantScopedRealms` / `domainGrants`——**没标租户的企业域数量**是操作员最该一眼看到的风险位。

### 7.6 未做（诚实边界，已登记）

- **MCP 侧尚未接 actor**：`createRealmMcpHandler` 的隔离单位仍是"宿主给某个 server 预连接哪些 `realmIds`"。把 §7.2 的判定接进去需要真实 read-realm 封臣触发（否则规则只能被 mock 打桩）→ deferred **#18**。
- **没有 disconnect / 显式改边界**：改租户只能重启，而重启又会被 §7.1 的漂移检查拒启 → 缺一个显式操作 → deferred **#17**。
- 企业域→个人域在**决策/记忆注入侧**仍按 realm type 粗粒度约束（`prepareState` / MemoryStore 边界），未接 DomainGrant 粒度。

## 8. 演进日志

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| v0.1 | 2026-09-21 | 初稿：五条核心不变量、RealmStore 接口契约、数据二极管执行点、藏宝图关系、P0–P2 节奏 |
| v0.2 | 2026-09-21 | 拍板传输层（MCP server 为唯一对外传输，P0 库内先行、P1 包 MCP，不做 HTTP API）与检索实现（P0 文件系统扫描 + 可替换后端，阈值触发升级 → deferred #10） |
| v0.3 | 2026-09-25 | §5 交付节奏补写实现进展：write + 凭证门（v0.19）；**enterprise connect 放开且存储类型如实记录**（修掉 `realms.set` 硬编码 personal 导致 E3.5 写闸门成死代码的问题），E3.5 收口、MCP write 暴露与签发凭证仍待 E3.4 触发；明确 §3 "企业域→个人域禁止" 在 RealmStore 层无执行点（本层无跨 realm 写路径），约束落在 Dispatcher / decision / MemoryStore；E3.6 多租户分级显式区别于"企业域可挂载"，仍未立项 |
| v0.4 | 2026-09-25 | **E3.6 + E6.4 落地**：新增 §7（企业域三级 `TenantScope`、"层级是结构边界 / 域边界才是授权对象"的分工、`decideRealmAccess` 单一判定与精确 reason、nonce 一次性 + 快照持久化、`resolveRealmSource` 让内核自己进 Realm 从而能核对"声明的域 vs 内容真实的域"、驾驶员面与 `ZEUS_REALM_ENTERPRISE`）；§6.4 把 §6.1 的"Realm 对外只有 MCP"精确化为**内容 vs 治理元数据**；§1 不变量 4 补租户一层；§2 契约加 `tenant` 与新原语的位置说明。仍未做（§7.6，登记 deferred #17/#18）：MCP 侧 actor 判定、显式改边界（disconnect）。 |
