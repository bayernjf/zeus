# 设计：Vault 藏宝图与恢复协议

- 状态：**现行 v0.2**（2026-09-25）——v0.1（2026-09-23）只把 Realm 当唯一条目源；v0.2 把「宝藏在哪」抽象成 `MapSource`，藏宝图因此能覆盖**内核状态文件 `kernel.json`**（它不在任何 Realm 里），并把 L0 的现盘视图从 `RealmStore` 解耦成 `LiveSource` 端口。变更清单见 §11。
- 对应 PRD：**E8.1 藏宝图（加密 manifest + 恢复协议，P1）**、**E8.2 藏宝图备份与备份思路（P1）**；顺带落 **E3.7 备份策略执行器 + 漂移检测（P2）的库内原语**、**deferred #13（内核状态文件纳入藏宝图）**
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
| **L0 原地校验恢复** | 宝藏本来就在连接的目录里 | 否（图只存引用 + digest） | 「我的东西还在吗、有没有被动过」；换机但目录/盘还在 | 按图的 `source` 取现盘条目 → 逐标记算 digest 比对 |
| **L1 可带走备份包** | 图 + 一个加密内容包 | 是（**仅在 full 包内、整体加密**） | 换新机器、目录被清空、传承给后代 | `packFull` 打包 → 在目标位置 `restoreFromBundle` 写盘 |

L0 是 L1 的子集（L1 包内同时带图，恢复前先做 L0 式校验）。两档备份策略与 Realm 既有词汇对齐：`manifest-only`（= 只发图，L0）与 `full`（= 图 + 内容包，L1）。

## 3. 数据结构

```ts
/** 宝藏在哪。v0.2 起这是可判别的两种源，不再是写死的 Realm。 */
export type MapSource =
  | {
      kind: 'realm';
      realmId: string;
      type: RealmType;
      /** 绝对 realpath；图整体加密保存，open 后用于原地重连。 */
      root: string;
      /** E3.6 租户 scope，必须随图保存：重连时丢掉它 = 对一个健康的语料库报"不可达"。 */
      tenant?: TenantScope;
    }
  | {
      kind: 'files';
      /** 报告用的人类标签，默认取 root 的 basename。 */
      label: string;
      /** 白名单文件解析所用的绝对目录。 */
      root: string;
      /** root 相对的 POSIX 路径，**逐个点名**，永远不是目录遍历。 */
      files: string[];
    };

/** 藏宝图：只存引用，绝不内联宝藏内容（安全红线，见 §8）。 */
export type TreasureMap = {
  format: 'zeus-treasure-map';
  version: 2;
  createdAt: string;
  /** v0.1 这里是 `realm: {realmId,type,root,itemCount}`；读入时归一化成 source。 */
  source: MapSource;
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
  version: 2;
  source: MapSource;
  items: Array<{ itemId: string; content: string; modifiedAt: string }>;
};
```

### 3.1 为什么必须有第二种源（`files`）

`kernel.json`（名册、记忆事实、连接器声明、组织编制、授权台账、岗位卷宗）是**用户可失去、而藏宝图此前恰好够不着**的那一样东西：它在每个已连接 Realm 之外。产品设计哲学第 1 条把「备份是第一公民」写死，所以这不是可选增强——v0.1 的图对这个文件什么都不能说。

`files` 源的三条硬规矩：

1. **白名单，不遍历目录**。指向 `./data` 会把无上限的 `audit.jsonl` 和残留 `.tmp` 一起扫进备份；白名单把备份范围变成一句可审计的声明（它原样密封在图里）。
2. **点名而读不出的文件必须报错，不能被跳过**。"备份成功"而实际漏掉了你要的那个文件，比没有备份更坏。因此 missing / 非普通文件 / symlink / 二进制（utf-8 往返会损坏）/ 超限（默认 64 MiB）一律拒绝出图。
3. **安全性与可读性分开判**。绝对路径、`..`、解析后逃出 root —— 这些是**恶意图**，两种模式下都硬拒；而"文件没了/变成软链了"是**漂移**，只在校验时降级成 `missing`（见 §7.1）。
4.  containment 用 **realpath 之后的 root** 判定：macOS 的 `/var → /private/var`、服务器上挂载的数据目录，都会让"未解析的 root + 已解析的文件"看起来像逃逸。这条是实测踩出来的（早期实现拒绝了每一个白名单文件）。

## 4. 加密与密钥分离

- **算法**：AES-256-GCM（认证加密，篡改即解密失败）；密钥经 **scrypt** 从口令 + 每信封随机 salt 派生（`scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 })`）。
- **IV**：每信封 12 字节随机；GCM tag 随信封保存。
- **密钥与图分离**：`seal()` 只产出信封，不含口令/密钥；恢复时由持有者另行提供。传承场景下「图」与「密钥」走不同渠道（图可放云端/托管，密钥只在持有人手里）。
- 也接受外部直接传入 32 字节 raw key（跳过 KDF），供未来 KMS / 企业托管对接（接口预留，本批次不实现 KMS）。
- 全部用 `node:crypto`，**零新运行时依赖**。

## 5. 出图：buildVault

`buildVault(inventory)` 是纯函数（I/O 由 inventory 端口承担）：

1. 从 inventory 取**条目源描述**（`MapSource`）与全部条目；
2. 每个条目算 `digest = sha256(content)`，**只把 `{itemId, digest, modifiedAt, bytes}` 放进标记，丢弃 content**；
3. 用与 Realm 相同的 `digestManifest` 算法算整体 `contentDigest`，保证图与 Realm 指纹可互校；
4. 若同时生成了 full 包，挂载 `bundle` 引用。

**inventory 端口**（解耦，便于测试与未来替换）：

```ts
export interface VaultInventory {
  describe(): Promise<MapSource>;
  entries(): Promise<Array<{ itemId: string; content: string; modifiedAt: string; bytes: number }>>;
}
```

两个适配器：`inventoryFromRealm(store, realmId)`（Realm 只读枚举，见 §6；`describe()` 把 E3.6 的 `tenant` 一并带出）、`inventoryFromFiles({root, files, label?, maxBytes?})`（白名单，见 §3.1）。

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

`restoreDryRun(map, live)` 不改任何东西。**现盘视图是一个端口（`LiveSource`），不再是 `RealmStore`**——这个改动有两个理由，都是踩出来的：恢复协议要覆盖内核状态文件（它不是 Realm）；而带租户 scope 的企业 Realm 若重连时丢掉图里自带的 scope，会抛"作用域不匹配"，被 catch-all 吞成 `root unreachable`——**唯一一个负责回答"宝藏还在不在"的工具，对着一个健康的语料库喊狼来了**。

1. `live(map.source)` 取现盘全部条目：
   - `realm` 源 → `store.connect(source.root, source.type, { tenant: source.tenant })` 后 `entries()`（**用图自己的 scope 重连**）；
   - `files` 源 → 按白名单重读，其中"点名而读不出"的文件（缺失/软链/二进制/超限）**降级为不在场**，好让它落进 `missing` 而不是整个源被判不可达；
   - 端口整体抛错 → `rootReachable: false` + `unreachableReason`（原因必须回传：只说"unreachable"就是把操作员推向瞎猜）。
2. 对每个标记：现盘算 `sha256(content)` 与标记 digest 比对：
   - `ok`：存在且 digest 一致；
   - `changed`：存在但 digest 不符（内容被改）；
   - `missing`：不在场；
3. 现盘里图上没有的条目 → `unexpected`（新增文件）。**files 源的白名单就是它的全宇宙**：不在名单里的文件既不算 missing，也不算 unexpected；
4. 用同一 `digestManifest` 对现盘条目重算整体指纹，给出 `contentDigestMatch`。

报告结构：

```ts
export type RestoreReport = {
  /** Realm 源给 realmId；files 源给 `files:<label>`。 */
  sourceId: string;
  sourceKind: MapSource['kind'];
  rootReachable: boolean;
  /** 为什么读不到。只报"unreachable"会逼操作员自己猜，而这次事故正是猜不出来的那种。 */
  unreachableReason?: string;
  contentDigestMatch: boolean;
  total: number;
  ok: string[];
  changed: Array<{ itemId: string; expectedDigest: string; actualDigest: string }>;
  missing: string[];
  unexpected: string[];
  /** 生命线判定：图上每个标记都能在现盘找回且指纹一致。 */
  recoverable: boolean;
  suggestion?: 'restore-from-bundle' | 'reconnect-or-provide-bundle';
};
```

`restorePlan` 返回同样的报告外加「建议动作」（changed/missing 且挂载了 full 包 → 建议 `restoreFromBundle`）。

**两类失败必须分得开**，因为它们指向不同的下一步命令：

| 情形 | 报告 | `vault check` 退出码 |
|---|---|---|
| 源整体读不到（Realm 目录没挂载/不存在） | `rootReachable: false` + `unreachableReason` | **3**（去挂载，或改用 L1） |
| 白名单里某个文件没了 / 变成软链或二进制 | `rootReachable: true`、`missing: […]` | **2**（漂移，建议 `restore-from-bundle`） |

### 7.2 L1 跨位：restoreFromBundle

1. `open(sealedMap, key)`、`openBundle(sealedBundle, key)` 解密并校验 GCM tag；
2. **先校验图的 `source` 形态再写盘**（`assertSource`）：按一个畸形描述符去分发恢复，要么写一半失败，要么写到图从未指认过的位置；
3. 校验包内整体 digest 与图 `bundle.digest` 一致（包被调换即拒）；
4. 经 **RestoreSink** 写到目标位置（默认实现 `FsRestoreSink`）：逐 item `mkdir -p` 所属目录 → `writeFile` → `utimes` 还原修改时间；
5. 把图的 `source.root` 换成目标位置，在目标上跑一次 7.1 校验，确认每个标记 `ok`，返回报告。

**为什么恢复写盘放在 vault 而非 Realm**：Realm P0 契约是**只读**数据域（write 是 P1）。「按图重建宝藏」是 vault 的恢复职责，`RestoreSink` 是它专属的工程原语；Realm 仍保持只读，边界不被打通。

```ts
export interface RestoreSink {
  writeItem(targetRoot: string, item: { itemId: string; content: string; modifiedAt: string }): Promise<void>;
}
```

### 7.3 v1 图的读取兼容

`assertMap` 接受 v1（带 `realm` 描述符）与 v2（带 `source`）：v1 在读入时归一化成 `{kind:'realm', realmId, type, root}`（v1 从不含 tenant，因此不需要臆造），并升 `version: 2`。**写出不存在兼容分支**——新图一律 v2。

### 7.4 CLI（`src/vault/cli.ts`）

`build | backup | check | restore` 四条命令的源选择：`--root [--type] [--tenant org/dept/member]`（Realm）或 `--files-root <dir> --files a.json,b.json`（白名单）；`check`/`restore` **不需要任何挂载参数**——图自己声明源与 scope，这正是 §7.1 那个误报的根因所在。`kernel.json` 的完整演练（备份 → 校验 → 删除 → 校验退出码 2 → 恢复到新目录 → 用恢复出的文件 boot 内核）记在 `tests/vault-files.test.ts`。

## 8. 安全红线（测试必须逐条断言）

1. **图不含内容**：`buildVault` 产出的 `TreasureMap` 序列化后，任一原始内容片段都不得出现（用真实正文反搜断言）。
2. **图加密静态落盘**：`seal()` 输出不含明文 JSON 标记字段；错误口令/被篡改 ciphertext、iv、tag、salt 一律解密失败。
3. **密钥不进信封**：`SealedEnvelope` 无 key/password 字段。
4. **按图真能恢复**：L0 对未改动目录 `recoverable === true`；L1 清空/换新目录后 `restoreFromBundle` 再校验，全部 `ok`。
5. **漂移必报**：改一个文件 → `changed`；删一个 → `missing`；加一个 → `unexpected`；整体 `contentDigestMatch === false`、`recoverable === false`。
6. **包调换/损坏拒绝**：full 包 digest 与图引用不符即拒。
7. itemId 沿用 Realm 的路径穿越防护；RestoreSink 写盘前校验 itemId 不得逃逸目标根。
8. **白名单不容静默**（v0.2）：出图时点名而读不出的文件一律拒绝；绝对路径、`..`、解析后逃出 root 在**备份与校验两条路径上都硬拒**（恶意图不是漂移）。
9. **scope 随图走**（v0.2）：租户级企业 Realm 的图必须带 `tenant`，且校验时用它重连——对着已挂载的 scoped store 报 `recoverable: true`，是本条唯一的断言方式。
10. **误报即缺陷**（v0.2）：源能读到却报 `rootReachable: false` 视为 bug；报告必须带 `unreachableReason`，让"为什么不可达"可核对。

## 9. 非目标 / 边界（登记，不在本批次）

- 不做自动/云端备份与调度（备份动作由用户或脚本触发；自动化归后续）。
- 不做企业 KMS / 生产密钥托管（deferred：生产 RSK 密钥托管）。
- 不做法律意义的继承框架（deferred #2/#3：继承法律/税务）。
- 不把 vault 纳入 `KernelSnapshot`：藏宝图是**用户持有的独立产物**，不是内核运行态。
- 暂不做「去 root 的可外发图」「多 Realm 合图」「增量/差异备份包」；需要时按本文档版本号演进。
- **files 源不做目录通配/递归，也不做二进制内容的备份**：名单是显式的、文本的（utf-8 往返）。二进制需要按字节备份与还原，那是一个独立的设计（避免用"半个可用的备份"糊弄过去）。
- **不做"备份哪些内核文件"的默认名单**：`--files kernel.json` 由用户点名。给一套内置默认，等于替用户决定他的数据目录里什么是宝藏，而目录布局是部署方的事实，不是内核的事实。
- E8.3 日记（记忆叙事化）、E8.4 传承（叙事/法律层）为后续 P2/P3。

## 10. 验收清单

### v0.1（已验收，2026-09-23）

- [x] `RealmStore.entries()` 落地，旧测试不回归。
- [x] `buildVault`：标记齐全、指纹正确、**正文零泄漏**。
- [x] `seal/open`：往返一致；错误口令与四类篡改（ciphertext/iv/tag/salt）均失败。
- [x] L0：未改动目录 `recoverable=true`；改/删/增三种漂移分别被检出。
- [x] L1：打包；清空原目录或换新目录后 `restoreFromBundle` 写盘，重连校验全部 `ok`。
- [x] 损坏/调换的 full 包被拒；RestoreSink 路径穿越被拒。
- [x] 全量 `vitest` 绿、`tsc --noEmit` 绿、`npm run build` 过。
- [x] PRD E8.1/E8.2 升状态（E3.7 标注库内原语已备）、README 模块表、handoff 与 docs/README 同步。

### v0.2（已验收，2026-09-25）

- [x] `MapSource` 两态 + `VaultInventory.describe(): Promise<MapSource>`；v2 图写出、v1 图读入归一化。
- [x] `inventoryFromFiles`：白名单枚举 + 七类拒绝（缺失 / 绝对路径 / `..` 逃逸 / 非普通文件 / 软链 / 二进制 / 超限）。
- [x] `LiveSource` 端口：`realmLiveSource` 带图自带 scope 重连；`fileLiveSource` 把"读不出的点名文件"降成 `missing`。
- [x] E3.6 回归：租户级 Realm 图对**已挂载**的 scoped store 报 `rootReachable: true, recoverable: true`（改动前是 `false` + 一条吞掉的 `scope-mismatch`）。
- [x] `kernel.json` 毁库演练走真 CLI：`backup`→`check` 0→删除→`check` 2→`restore`→**字节级 sha256 相同**→用恢复出的文件 `bootKernel`，`restoredFromSnapshot: true`。
- [x] 真实进程冒烟（`dist/vault/cli.js`）逐条核对退出码与输出文本。
- [x] 全量 `vitest` 绿、`npm run typecheck` 绿、`npm run build` 过。

## 11. v0.2 变更清单（2026-09-25，deferred #13）

| 变更 | 动机（不写清就会被回退） |
|---|---|
| `TreasureMap.realm` → `source: MapSource`（`version: 2`） | 内核状态文件不在任何 Realm 里，v0.1 的图对它什么都不能说 |
| 新增 `files` 源（白名单，`inventoryFromFiles`） | 「备份是第一公民」；同时不能把 `./data` 整个扫进备份 |
| `VaultInventory.describe()` 改异步并返回 `MapSource` | Realm 的 scope 只能从 `manifest()` 读出来；同步端口拿不到 |
| `restoreDryRun/restorePlan` 第二参 `RealmStore` → `LiveSource` | L0 被硬编码成"Realm 专属"，非 Realm 条目源无法校验 |
| realm 源重连携带 `source.tenant` | 修一个真实误报：scoped store + 无 scope 重连 → 健康语料库被判"root 不可达" |
| `RestoreReport` 增 `sourceId`/`sourceKind`/`unreachableReason` | 只报"unreachable"把责任推给操作员猜 |
| files 源校验时"读不出即视为不在场" | 让"你的 kernel.json 没了"停在退出码 2（可用 bundle 恢复），而不是 3（去挂载） |
| containment 用 realpath 后的 root | macOS `/var→/private/var`：未解析 root + 已解析文件 = 每个白名单文件都被判逃逸 |
| `restoreFromBundle` 写盘前 `assertSource(map.source)` | 按畸形描述符分发恢复，要么写一半失败，要么写到图从未指认的位置 |
| CLI `check`/`restore` 去掉挂载参数 | 图自己声明源与 scope；要求操作员重述一遍就是再制造一次误报 |
| v1 图读入归一化（写出不兼容） | 用户手里的旧图必须还能 `check`/`restore`，否则这次升级本身就成了数据风险 |
