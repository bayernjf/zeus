# fealty 签名链设计（Roster Attestation & Signing）

> 状态：**现行（设计稿 v0.1，2026-09-21）**。实施进度记 [handoff.md](../handoff.md)，本文只写设计与契约，不记进度。
> 上游：[deferred-items.md](deferred-items.md) #7（触发条件：bayjf 名册对外公开前）；[design-bayjf-roster.md](design-bayjf-roster.md) §7 信任闸门、§8 交付阶段 R2；[design-vassal-protocol.md](design-vassal-protocol.md) §4.1 fealty、§4.5 治理。
> 本文给出 v1 裁决与可实现的数据结构；**v1 实现随 R1（签名/验签纯函数）与 R2（bayjf 验签展示）落地，设计本身不触发「名册公开」**。

## 0. 一句话

公开名册上的每一个字都派生自执行 Agent 的 Agent Card + fealty；签名链让任何拿到名册条目的人都能密码学地验证两件事——**这份 card（含承诺）确实经过 Zeus 核验在册**，且**它此刻仍在有效期内、未被吊销、未被篡改或重放**。

## 1. 威胁模型与边界

### 1.1 必须防住

| 编号 | 攻击 | 后果 |
| --- | --- | --- |
| T1 | 伪造名册条目：攻击者发布假 card + 假 fealty，诱使第三方相信其为在册执行 Agent | 假执行 Agent冒名招募/接单 |
| T2 | 篡改在册执行 Agent承诺：中间人改写 fealty（如 `dataPolicy: none` → `read-realm`）或 card 内容 | 名册替假承诺背书；调度方误判数据权限 |
| T3 | 重放已吊销执行 Agent：`revoke()` 后拿历史有效快照/签名继续冒充 | 叛将不下榜 |
| T4 | 伪造/裁剪整份快照：虚构在榜名单、增删条目、隐瞒吊销、重放旧快照 | 名册整体不可信 |

### 1.2 明确不解决（边界）

- **不防 Zeus 自身**：Zeus 是名册唯一聚合点与信任根（design-bayjf-roster §2.1）；RSK 私钥泄露属最高等级运行事故，靠密钥管理与轮换缓解，不在协议内解决。
- **不解决 card 通道的传输保密/鉴权**：那是 HTTPS / mTLS / A2A 认证方案的职责（design-vassal-protocol §3.5）。
- **不做签名的数学撤销**：数字签名签发后无法「撤回」；吊销靠**状态 + 时间维度**让旧签名不再被接受（见 §6）。
- **不担保执行 Agent行为或 SLA**：签名只证明「某时刻在册、承诺原文如此」，不是履约担保；健康与 SLA 仍由探针与结果回传体现。

## 2. 方案裁决

design-bayjf-roster §7 给了两个候选，本文决定：

### 2.1 v1 基线：**Zeus 单签背书（方向 1）**

注册时 Zeus 核验 fealty，用 **Zeus 名册签名密钥（RSK, Roster Signing Key）** 对「执行 Agent身份 + card/fealty 摘要 + 在册状态 + 有效期」签名，签名随名册快照分发；验签方只需信任一个 Zeus 根公钥。

裁决理由：

1. 架构上 Zeus 本就是唯一聚合点和信任根，名册要防的是「替假承诺背书」，Zeus 对自己注册时核验过的 card 签名，语义恰好闭合。
2. **执行 Agent零改造**：矩阵产品只需按既有超集协议发 card，不必各自管理签名密钥——符合「超集而非闭墙、矩阵改造成本最低」的总原则（design-vassal-protocol §0）。
3. 吊销立即反映在 Zeus 下一份签名里，不依赖执行 Agent配合（与 §4.5「吊销不需要执行 Agent配合」一致）。

### 2.2 v2 增强：**执行 Agent自签 + Zeus 交叉背书（方向 2），作为 v1 的超集**

执行 Agent自持密钥对 card 自签（不可否认性），Zeus 再对「执行 Agent公钥指纹 + 在册状态」交叉签名。v1 数据结构预留 `vassalSig` 位置，v2 叠加而非推翻。

**v2 触发条件**（满足其一才立项，登记为开放问题）：出现承诺不可否认性/法律追责需求；执行 Agent要求其承诺可脱离 Zeus 独立验证；或首个矩阵外外部 Agent 生态需要自证身份（联动 deferred #5）。

## 3. 签名对象与规范化

### 3.1 签什么

- **主签名覆盖整张 Agent Card 的摘要 `cardDigest`**：名册条目每个字段都派生自 card（roster §3），公开版连 skills/description 一并展示，故签名覆盖整张 card，任何字段被改即验签失败（防 T2 的全部面，而不只是 fealty）。
- **显式冗余 `fealtyDigest`**：治理承诺（dataRealms/dataPolicy/reportBack/escalationPolicy/swornTo/version）单独列摘要，便于审计日志、调度侧快速比对与告警，不必反查整张 card。
- card 任何无害改动（改 typo）也会使 cardDigest 变化——这是**有意为之**：card 变更本就应触发重新拉取与重签（注册侧自动化，成本在 Zeus 不在执行 Agent）；承诺变更史另见 roster §9.2（R1）。

### 3.2 规范化（Canonicalization）

摘要前必须对 JSON 做**确定性规范化**，否则不同序列化/键序/空白会导致验签不稳定：

- 采用 **RFC 8785 JSON Canonicalization Scheme（JCS）**：UTF-8、对象键按 UTF-16 码元排序、无多余空白、数字确定性表示。不自造规范化规则。
- `cardDigest = "sha256:" + hex(sha256(JCS(card)))`；`fealtyDigest` 同法作用于 `card["x-zeus-fealty"]`。

### 3.3 算法

- 签名算法：**Ed25519**（RFC 8032）。实现简单、无曲线参数陷阱、签名短、验证快；Node `crypto` 原生支持。
- 编码：签名为 **base64url（无填充）**；摘要 hex。
- **不引入 JWS/JWT 全家桶**：避免算法协商攻击面与依赖膨胀；信封是下文 §4 的扁平结构（TUF/Sigstore 式的简单封装）。

## 4. 信封结构（两层签名）

```jsonc
// 第一层：条目级 attestation——单条目可独立验证（防 T1/T2/T3）
{
  "v": 1,
  "alg": "Ed25519",
  "keyId": "zeus-rsk-2026-09",
  "issuer": "zeus",
  "vassal": { "name": "pr-helper", "cardUrl": "https://.../agent-card.json" },
  "cardDigest": "sha256:…",
  "fealtyDigest": "sha256:…",
  "status": "active",
  "issuedAt": "2026-09-21T10:00:00Z",
  "expiresAt": "2026-09-22T10:00:00Z",
  "sig": "base64url…"            // 对上述除 sig 外字段的 JCS 规范化字节签名
  // v2 预留："vassalSig": { "jwkThumbprint": "…", "sig": "…" }
}
```

```jsonc
// 第二层：快照级封签——包在现有 RosterSnapshot 外层（防 T4）
{
  "snapshot": { /* 现有 RosterSnapshot 原样，结构不改 */ },
  "attestations": { "<vassalName>": <Attestation> },
  "seal": {
    "v": 1, "alg": "Ed25519", "keyId": "zeus-rsk-2026-09",
    "snapshotDigest": "sha256:…",   // JCS(snapshot)，含 generatedAt/scope/entries 及其顺序
    "issuedAt": "…", "maxAgeSeconds": 3600,
    "sig": "base64url…"
  }
}
```

设计要点：

1. **R0 的 `RosterSnapshot` / `projectInternalRoster` / `projectPublicRoster` 结构与纯函数性完全不动**；签名是外层信封，投影器保持「只重塑不造字段」的纯净。
2. **条目级**让第三方拿到单个条目也能验真伪与有效期；**快照级**防增删、重排、隐瞒吊销与整份重放。公开页的根证据是 seal。
3. internal / public 两份快照各自封签；**public 信封只含 active 条目**（投影层已过滤 revoked，attestations 不为 revoked 出条）。

## 5. 密钥归属、分发与轮换

### 5.1 Zeus 名册签名密钥（RSK）

- **私钥**：Zeus 部署侧持有，经环境/密钥管理注入，**绝不入库、绝不下发、绝不进快照**。
  - 个人版：用户本机密钥链或本地密钥文件（具体存放联动 deferred #2 备份清单加密托管，见 §9）。
  - 企业版：KMS / HSM；签名动作留审计。
- **公钥（Zeus 根公钥）**：随名册公开，供 bayjf 与第三方验签。分发渠道见 §9（v1 建议 well-known + 带外固定）。
- 纯库阶段只定义 `RosterSigner` / `RosterVerifier` 接口（§7.3），不实现私钥存储。

### 5.2 执行 Agent密钥（v2）

执行 Agent自签私钥自持；公钥以 JWK 置于 card 扩展字段（建议 `x-zeus-key`），Zeus 注册时把 JWK 指纹（RFC 7638）绑进交叉背书。v1 不要求、不校验该字段。

### 5.3 轮换

- `keyId` 标识密钥版本（建议 `zeus-rsk-YYYY-MM`）。
- 轮换设**重叠期**：新钥签发新签名，旧钥仅用于验证历史签名、不再签发；重叠期内条目随快照刷新逐步用新钥重签。
- seal 始终用当前 RSK。
- **根公钥轮换是最高治理动作**：须人工执行 + 带外公告，不做库内自动化（运行手册项）。

## 6. 吊销与签名链失效语义

区分四层，缺一不可：

| 层 | 机制 | 生效时机 | 防 |
| --- | --- | --- | --- |
| 治理移除 | `revoke()` 后下一份 public 快照不含该条目（R0 投影已实现），internal 留痕 | 下一次投影/发布 | T1/T3 的常态路径 |
| 条目硬过期 | attestation `expiresAt`；验签方拒绝过期条目，**不依赖 bayjf 及时重建** | TTL 到达即失效 | T3（缓存旧页） |
| 快照时效 | seal `maxAgeSeconds`；拒绝超龄快照，即使签名本身有效 | maxAge 到达 | T4（整份旧快照重放） |
| 内容绑定 | cardDigest/fealtyDigest 不符即拒 | 实时 | T2 |

关键语义：

1. **吊销不是「撤销签名」，而是让签名在状态/时间维度不再被接受**。被吊销执行 Agent在 TTL 窗口内的旧静态缓存，最坏可见时间 = 其 attestation 的剩余有效期；**故 R2 必须把 TTL 压到可接受上限**（roster §7 已要求 R2 定义缓存 TTL 上限，本设计把它升级为密码学硬过期，而非仅靠重建）。
2. v1 **不设在线 CRL/OCSP**：公开名册是 SSG/只读 JSON 产物，验签应离线可完成；实时吊销以「短 TTL + 下一份快照移除」覆盖。在线吊销清单端点列为 v2（R1 之后），用于需要「TTL 窗口内立即作废」的场景。
3. **fealty/card 变更**：cardDigest 变化 → 旧 attestation 对新 card 验签失败 → 必须重新注册重签；`fealty.version` 不匹配仍按 §4.5 拒绝注册、不静默兼容。
4. 签名的自然语言语义固定为：**「Zeus 于 issuedAt 核验并认可：此 card（含 fealty）持有者在 expiresAt 前为在册 active 执行 Agent」**——不含永久可信、不含履约担保。

## 7. 与现有代码的衔接

### 7.1 不改的部分

- `VassalRegistry`（register/revoke/listAll/asVassalLookup）、`projectInternalRoster`/`projectPublicRoster`、`RosterSnapshot` 类型：全部保持现状。
- 投影器不碰密钥、不产生签名，维持纯函数可测。

### 7.2 新增的发布管线（概念）

```
listAll() → project(internal/public) → canonicalize → digest
        → attestEntries(signer) → sealSnapshot(signer) → SignedRosterSnapshot 分发
验签侧：verifySeal(publicKey) → 逐条目 verifyAttestation → 比对实时拉取的 cardDigest（可选）
```

签名发生在**发布/投影之后**，属于 R1（HTTP 只读端点产出签名快照）与 R2（bayjf 构建期验签）；P0/R0 无传输层，不产生签名。

### 7.3 接口草案（实现期落地，本文不编码）

```ts
// 纯函数（无密钥依赖，R1 可在库内实现并单测）
declare function canonicalJson(value: unknown): string;          // RFC 8785 JCS
declare function digestCard(card: AgentCard): { cardDigest: string; fealtyDigest?: string };

// 密钥边界（实现由部署侧注入）
interface RosterSigner {
  readonly keyId: string;
  sign(canonicalBytes: string): Promise<string>;                  // base64url Ed25519
}
interface RosterVerifier {
  verify(keyId: string, canonicalBytes: string, sig: string): Promise<boolean>;
}

// 组装与验证
declare function sealSnapshot(snapshot: RosterSnapshot, signer: RosterSigner, opts: { maxAgeSeconds: number }): Promise<SignedRosterSnapshot>;
declare function verifySignedSnapshot(envelope: unknown, verifier: RosterVerifier, now?: Date): Promise<{ ok: true; snapshot: RosterSnapshot } | { ok: false; reason: string }>;
```

## 8. 阶段与验收

### 8.1 v1（R2 公开闸门，deferred #7 销项标准）

Ed25519 + RFC 8785；条目 attestation（cardDigest + fealtyDigest + status + issuedAt/expiresAt）+ 快照 seal；Zeus 单签；短 TTL 硬过期；离线可验。

验收用例（实现期测试，逐条必过）：

1. 正常签名快照验签通过，能取回原 snapshot。
2. 篡改 fealty 任一字段（dataRealms/dataPolicy/reportBack/escalationPolicy/swornTo/version）→ 摘要不符 → 失败。
3. 篡改 skills / description / name → cardDigest 不符 → 失败。
4. 增删条目、调整 entries 顺序、改 scope/generatedAt → seal 失败。
5. revoked 执行 Agent不出现在 public 信封；构造含该条目的旧信封 → expiresAt/maxAge 过期拒绝。
6. 篡改 sig 本体、用错误公钥验签 → 失败。
7. keyId 轮换重叠期：新钥签的新信封、旧钥签的历史信封各自验证结论正确；旧钥签的「超 maxAge」信封被拒。
8. 规范化稳定性：同一对象不同键序/空白输入，digest 一致（JCS）。

### 8.2 v2（触发条件见 §2.2，不早做）

执行 Agent自签 + Zeus 交叉背书（`vassalSig`/`x-zeus-key`/JWK 指纹）；在线吊销清单端点；fealty 变更史（roster §9.2）；根公钥分发的多方治理。

## 9. 开放问题（立项时决定，不在本文锁死）

1. **TTL 具体值**：建议条目 attestation 24h、seal maxAge 与 bayjf SSG 重建周期一致（如 1h）；R2 结合重建频率与吊销最坏可见时间定。
2. **个人版 RSK 存放**：钥匙链 vs 本地加密密钥文件，与 deferred #2（备份清单加密与托管）统一方案。
3. **根公钥分发**：well-known 端点 + 带外固定（TOFU 升级）vs 仅带外；R1 定。
4. **是否要时间戳权威（TSA）**：v1 不需要（Zeus 即信任根，issuedAt 由其签名背书）；v2 若有多方争议再议。
5. **在线吊销清单**是否提前到 v1：仅当出现「TTL 窗口不可接受」的业务要求时（默认不做）。

## 10. 演进日志

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| v0.1 | 2026-09-21 | 初稿：威胁模型；裁决 Zeus 单签为 v1 基线、执行 Agent自签为 v2 超集；Ed25519 + RFC 8785；条目 attestation + 快照 seal 两层信封；RSK 密钥归属与轮换；吊销四层失效语义；发布管线与接口草案；v1 八条验收用例 |
