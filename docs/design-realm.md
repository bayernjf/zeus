# Realm 数据域设计（D1 契约先行）

> 状态：**现行（契约 v0.1，2026-09-21）**。本文只定**接口契约**，实现立项后另起 design-realm-implementation.md。产品哲学依据见 [product-portrait.md](product-portrait.md) §2.1/§2.2。

## 0. 一句话

Realm 是用户指定的**一个目录**及其纳管数据：先连接、后使用；目录即数据库，一切 Agent（含封臣）经统一接口读它，不直接碰文件系统。

## 1. 核心不变量（违反任何一条即实现错误）

1. **目录是唯一数据来源**：Zeus 对 Realm 之外的用户文件零访问；绝不扫描父目录或兄弟目录。
2. **先连接后使用**：未完成 connect（含 manifest 建立）的 Realm，任何读写一律拒绝。
3. **暴露接口而非文件**：Agent/封臣只见本契约的 API，不见路径、不见原始文件布局。
4. **Realm 有类型**：`personal` / `enterprise`，一经 connect 固定；派发任务时由 Dispatcher 对照 fealty.dataRealms 做数据二极管。
5. **备份是第一公民**：connect 即生成 manifest 备份基线；没有备份能力的 Realm 可以降级为只读。

## 2. 接口契约（TypeScript 形态，传输层 HTTP/MCP 二选一，后定）

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
  write?(realmId: RealmId, item: { itemId?: string; data: unknown; tags?: string[] }): Promise<{ itemId: string }>;
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

- P0：`connect / manifest / search / read`，只读，personal Realm
- P1：`write` 与授权凭证；enterprise Realm
- P2：备份策略执行器（full / manifest-only）与漂移检测（contentDigest 对账）

## 6. 开放问题（移交 deferred-items）

- 传输层选型：HTTP API vs 直接作为 MCP server 暴露（后者可让任意 MCP 客户端读 Realm）→ P0 动工前拍板。
- 检索实现：倒排/向量/纯文件系统扫描 → P0 动工前拍板。
- 一人多个 Realm 与 Realm 继承的关系。
