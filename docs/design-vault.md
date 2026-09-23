# 设计：Vault 藏宝图与恢复协议

- 状态：**现行 v0.1**（2026-09-23）
- 对应 PRD：**E8.1 藏宝图（加密 manifest + 恢复协议，P1）**、**E8.2 藏宝图备份与备份思路（P1）**；顺带落 **E3.7 备份策略执行器 + 漂移检测（P2）的库内原语**
- 关联：[design-realm.md](design-realm.md)（Realm 数据域）、[design-memory-consolidation.md](design-memory-consolidation.md)（记忆/对账）、[product-portrait.md](product-portrait.md) §2.2 藏宝图
- 一句话：**藏宝图不存宝藏，只存「怎么找到宝藏」；图本身加密、密钥与图分离；给一张图，必须能真实证明宝藏可找回（原地）或把宝藏真恢复出来（跨位）。**

---

## 1. 背景与定位

产品设计哲学第 2 条：**「藏宝图即恢复协议」——叙事化概念必须与真实可执行的工程原语同构。**

Realm 底座已能 `connect / manifest / search / read`，并在连接时算出整体 `contentDigest`；记忆层已能整理、混合检索、遗忘、漂移对账。但还缺最后一公里：

- 没有一样东西把「宝藏在哪、每个宝藏的指纹是什么」固化成一张**可保存、可加密、可交接**的图；
- 「按图恢复」停留在口号，没有可执行原语。

Vault 就是补这一公里。它**不替代备份工具、不做云同步**，只做一件事：产出一张自洽的藏宝图，并提供两种经演练的恢复路径。

## 2. 两层恢复语义（本批次都做，分层实现）

| 层 | 恢复源 | 是否含宝藏内容 | 典型场景 | 工程原语 |
|---|---|---|---|---|
| **L0 原地校验恢复** | 宝藏本来就在连接的目录里 | 否（图只存引用 + digest） | 「我的东西还在吗、有没有被动过」；换机但目录/盘还在 | 重连 root → 逐标记 `read` 现盘 → 算 digest 比对 |
| **L1 可带走备份包** | 图 + 一个加密内容包 | 是（**仅在 full 包内、整体加密**） | 换新机器、目录被清空、传承给后代 | `sealFullBundle` 打包 → 在目标位置 `restoreFromBundle` 写盘 |

L0 是 L1 的子集（L1 包内同时带图，恢复前先做 L0 式校验）。两档备份策略与 Realm 既有词汇对齐：`manifest-only`（= 只发图，L0）与 `full`（= 图 + 内容包，L1）。

## 3. 数据结构

```ts
/** 藏宝图：只存引用，绝不内联宝藏内容（安全红线，见 §7）。 */
export type TreasureMap = {
  format: 'zeus-treasure-map';
  version: 1;
  createdAt: string;
  realm: {
    realmId: string;
    type: RealmType;
    /** 绝对 realpath。图整体加密保存；open 后用于原地重连。
     *  对外/传承导出时可产出「去 root」的相对图（见 §8 非目标的后续项）。 */
    root: string;
    itemCount: number;
  };
  /** 每个宝藏一个标记：相对 itemId + 内容指纹 + 元数据。无内容。 */
  marks: Array<{
    itemId: string;
    digest: string;       // sha256(content)
    modifiedAt: string;
    bytes: number;
  }>;
  /** 整体指纹，与 RealmManifest.contentDigest 同算法，用于整域快速比对。 */
  contentDigest: string;
  /** 可挂载的备份包层引用；manifest-only 时为空。 */
  bundle?: {
    strategy: 'full';
    bundleId: string;
    digest: string;       // 内容包整体指纹
    createdAt: string;
  };
};

/** 加密信封（图与 full 内容包共用同一形态）。 */
export type SealedEnvelope = {
  alg: 'aes-256-gcm';
  kdf: 'scrypt';
  format: string;        // 'zeus-treasure-map' | 'zeus-full-bundle'
  salt: string;          // base64
  iv: string;            // base64
  tag: string;           // base64 (GCM auth tag)
  ciphertext: string;    // base64
};

/** full 备份包的明文：仅在加解密边界内出现，加密后不落明文。 */
export type FullBundle = {
  format: 'zeus-full-bundle';
  version: 1;
  realm: { realmId: string; type: RealmType };
  items: Array<{ itemId: string; content: string; modifiedAt: string }>;
};
```

## 4. 加密与密钥分离

- **算法**：AES-256-GCM（认证加密，篡改即解密失败）；密钥经 **scrypt** 从口令 + 每信封随机 salt 派生（`scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 })`）。
- **IV**：每信封 12 字节随机；GCM tag 随信封保存。
- **密钥与图分离**：`seal()` 只产出信封，不含口令/密钥；恢复时由持有者另行提供。传承场景下「图」与「密钥」走不同渠道（图可放云端/托管，密钥只在持有人手里）。
- 也接受外部直接传入 32 字节 raw key（跳过 KDF），供未来 KMS / 企业托管对接（接口预留，本批次不实现 KMS）。
- 全部用 `node:crypto`，**零新运行时依赖**。

## 5. 出图：buildVault

`buildVault(inventory)` 是纯函数（I/O 由 inventory 端口承担）：

1. 从 inventory 取 realm 描述（realmId/type/root）与全部条目；
2. 每个条目算 `digest = sha256(content)`，**只把 `{itemId, digest, modifiedAt, bytes}` 放进标记，丢弃 content**；
3. 用与 Realm 相同的 `digestManifest` 算法算整体 `contentDigest`，保证图与 Realm 指纹可互校；
4. 若同时生成了 full 包，挂载 `bundle` 引用。

**inventory 端口**（解耦，便于测试与未来替换）：

```ts
export interface VaultInventory {
  describe(): { realmId: string; type: RealmType; root: string };
  entries(): Promise<Array<{ itemId: string; content: string; modifiedAt: string; bytes: number }>>;
}
```

提供适配器 `inventoryFromRealm(store, realmId)`，基于 Realm 新增的只读枚举（见 §6）。

## 6. Realm 底座增强：只读 entries()

出图与 full 备份都必须枚举完整内容，而现有 `search()` 有 200 上限且只回 snippet。给 `RealmStore` 增加：

```ts
/** 只读枚举连接快照的全部托管条目（含完整内容），供出图/备份。 */
entries(realmId: string): Promise<Array<{ itemId: string; content: string; modifiedAt: string; bytes: number }>>;
```

- 数据来自 connect 快照（与 `contentDigest` 一致），是只读、owner 已授权数据域内的操作；
- 不改变 Realm 的只读边界，不引入写接口；
- full 备份需要「现盘真实字节」时，恢复包内容以 `read()` 现读为准（保证备份反映当前盘），出图指纹以快照为准——两者在「连接后未改动」时一致，差异由漂移检测暴露。

## 7. 恢复协议与漂移检测

### 7.1 L0 原地：restorePlan / restoreDryRun

`restoreDryRun(map, store)` 不改任何东西：

1. `store.connect(map.realm.root, map.realm.type)` 重连（root 不可达 → 报 `root-unreachable`，此时只能走 L1）；
2. 对每个标记：尝试 `read(itemId)`，现盘算 `sha256(content)` 与标记 digest 比对：
   - `ok`：存在且 digest 一致；
   - `changed`：存在但 digest 不符（内容被改）；
   - `missing`：文件不存在 / 不可读；
3. 枚举现盘全部条目，找出图上没有的 `unexpected`（新增文件）；
4. 比对整体 `contentDigest`，给出整域判定。

报告结构：

```ts
export type RestoreReport = {
  realmId: string;
  rootReachable: boolean;
  contentDigestMatch: boolean;
  total: number;
  ok: string[];
  changed: Array<{ itemId: string; expectedDigest: string; actualDigest: string }>;
  missing: string[];
  unexpected: string[];
  /** 生命线判定：图上每个标记都能在现盘找回且指纹一致。 */
  recoverable: boolean;
};
```

`restorePlan` 返回同样的报告外加「建议动作」（changed/missing 且挂载了 full 包 → 建议 `restoreFromBundle`）。

### 7.2 L1 跨位：restoreFromBundle

1. `open(sealedMap, key)`、`openFullBundle(sealedBundle, key)` 解密并校验 GCM tag；
2. 校验包内整体 digest 与图 `bundle.digest` 一致（包被调换即拒）；
3. 经 **RestoreSink** 写到目标位置（默认实现 `FsRestoreSink`）：逐 item `mkdir -p` 所属目录 → `writeFile` → `utimes` 还原修改时间；
4. 写完在目标位置重连并跑一次 7.1 校验，确认每个标记 `ok`，返回报告。

**为什么恢复写盘放在 vault 而非 Realm**：Realm P0 契约是**只读**数据域（write 是 P1）。「按图重建宝藏」是 vault 的恢复职责，`RestoreSink` 是它专属的工程原语；Realm 仍保持只读，边界不被打通。

```ts
export interface RestoreSink {
  writeItem(targetRoot: string, item: { itemId: string; content: string; modifiedAt: string }): Promise<void>;
}
```

## 8. 安全红线（测试必须逐条断言）

1. **图不含内容**：`buildVault` 产出的 `TreasureMap` 序列化后，任一原始内容片段都不得出现（用真实正文反搜断言）。
2. **图加密静态落盘**：`seal()` 输出不含明文 JSON 标记字段；错误口令/被篡改 ciphertext、iv、tag、salt 一律解密失败。
3. **密钥不进信封**：`SealedEnvelope` 无 key/password 字段。
4. **按图真能恢复**：L0 对未改动目录 `recoverable === true`；L1 清空/换新目录后 `restoreFromBundle` 再校验，全部 `ok`。
5. **漂移必报**：改一个文件 → `changed`；删一个 → `missing`；加一个 → `unexpected`；整体 `contentDigestMatch === false`、`recoverable === false`。
6. **包调换/损坏拒绝**：full 包 digest 与图引用不符即拒。
7. itemId 沿用 Realm 的路径穿越防护；RestoreSink 写盘前校验 itemId 不得逃逸目标根。

## 9. 非目标 / 边界（登记，不在本批次）

- 不做自动/云端备份与调度（备份动作由用户或脚本触发；自动化归后续）。
- 不做企业 KMS / 生产密钥托管（deferred：生产 RSK 密钥托管）。
- 不做法律意义的继承框架（deferred #2/#3：继承法律/税务）。
- 不把 vault 纳入 `KernelSnapshot`：藏宝图是**用户持有的独立产物**，不是内核运行态。
- 暂不做「去 root 的可外发图」「多 Realm 合图」「增量/差异备份包」；需要时按本文档版本号演进。
- E8.3 日记（记忆叙事化）、E8.4 传承（叙事/法律层）为后续 P2/P3。

## 10. 验收清单

- [ ] `RealmStore.entries()` 落地，旧测试不回归。
- [ ] `buildVault`：标记齐全、指纹正确、**正文零泄漏**。
- [ ] `seal/open`：往返一致；错误口令与四类篡改（ciphertext/iv/tag/salt）均失败。
- [ ] L0：未改动目录 `recoverable=true`；改/删/增三种漂移分别被检出。
- [ ] L1：`sealFullBundle` 打包；清空原目录或换新目录后 `restoreFromBundle` 写盘，重连校验全部 `ok`。
- [ ] 损坏/调换的 full 包被拒；RestoreSink 路径穿越被拒。
- [ ] 全量 `vitest` 绿、`tsc --noEmit` 绿、`npm run build` 过。
- [ ] PRD E8.1/E8.2 升状态（E3.7 标注库内原语已备）、README 模块表、handoff 与 docs/README 同步。
