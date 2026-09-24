# Realm 数据域设计（D1 契约先行）

> 状态：**现行（契约 v0.2，2026-09-21：传输层与检索实现已拍板，见 §6）**。P0 实现直接落 `src/realm/`（库内只读 personal Realm），不另起实现文档；MCP 暴露在 P1。产品哲学依据见 [product-portrait.md](product-portrait.md) §2.1/§2.2。

## 0. 一句话

Realm 是用户指定的**一个目录**及其纳管数据：先连接、后使用；目录即数据库，一切 Agent（含封臣）经统一接口读它，不直接碰文件系统。

## 1. 核心不变量（违反任何一条即实现错误）

1. **目录是唯一数据来源**：Zeus 对 Realm 之外的用户文件零访问；绝不扫描父目录或兄弟目录。
2. **先连接后使用**：未完成 connect（含 manifest 建立）的 Realm，任何读写一律拒绝。
3. **暴露接口而非文件**：Agent/封臣只见本契约的 API，不见路径、不见原始文件布局。
4. **Realm 有类型**：`personal` / `enterprise`，一经 connect 固定；派发任务时由 Dispatcher 对照 fealty.dataRealms 做数据二极管。
5. **备份是第一公民**：connect 即生成 manifest 备份基线；没有备份能力的 Realm 可以降级为只读。

## 2. 接口契约（TypeScript 形态）

> 传输层决策见 §6：**对外唯一传输为 MCP server；P0 先落库内 `RealmStore`（同进程调用），接口按 MCP 资源语义设计，未来 1:1 包一层 MCP，不做独立 HTTP API。**

```ts
type RealmId = string;
type RealmType = 'personal' | 'enterprise';

interface RealmManifest {
  realmId: RealmId;
  type: RealmType;
  root: string;                 // 绝对路径，仅 connect 时解析，之后不外泄
  createdAt: string;
  contentDigest: string;        // 全量内容指纹，备份与漂移检测的基准
  backup: { strategy: 'none' | 'manifest-only' | 'full'; lastVerifiedAt?: string };
}

interface RealmStore {
  connect(root: string, type: RealmType, opts?: { readOnly?: boolean }): Promise<RealmManifest>;
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

- P0：库内 `RealmStore`：`connect / manifest / search / read`，只读，personal Realm；检索为纯文件系统扫描（可替换后端）。**不启传输**，Zeus 内核同进程调用（dispatcher 的 realmHits 注入即由本层检索供给）。
- P1：**第一件事是把 RealmStore 包成 MCP server 暴露**（streamable HTTP + 鉴权，传输形态立项时定），让 read-realm 封臣与任意 MCP 客户端经授权读取；随后做 `write` 与授权凭证、enterprise Realm。
  - **落地进展（v0.19）**：`write` 的库内部分与授权凭证门已先行落地（不依赖 MCP 触发条件）——`FsRealmStore.write` 与 `src/realm/grant.ts` `verifyDriverWriteGrant`：personal 默认可写、readOnly 拒写、enterprise 写须绑定本域且未过期的驾驶员凭证（形状/域/有效期纯函数校验，签名与传输鉴权仍属 MCP 层 P1）；原子写、路径/symlink/扩展名/尺寸防护、写后快照与 contentDigest 一致性、审计回调齐备。**仍未做**：enterprise realm 的 connect、MCP `tools/write` 暴露与签名凭证签发。
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

## 7. 演进日志

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| v0.1 | 2026-09-21 | 初稿：五条核心不变量、RealmStore 接口契约、数据二极管执行点、藏宝图关系、P0–P2 节奏 |
| v0.2 | 2026-09-21 | 拍板传输层（MCP server 为唯一对外传输，P0 库内先行、P1 包 MCP，不做 HTTP API）与检索实现（P0 文件系统扫描 + 可替换后端，阈值触发升级 → deferred #10） |
