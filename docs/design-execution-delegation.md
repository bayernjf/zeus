# 执行授权（Execution Delegation）设计

> 状态：**现行 v0.1（2026-09-30）——纯函数安全原语已落地，派发链路与对端协议未接线**。对应 deferred **#33**。本文是该机制的单一事实源；A1 真机验收（2026-09-29）确认 pr-helper 的 execute 模式回 `input-required: "Credential delegation is not implemented yet"`，即执行 Agent 期待 Zeus 侧代理"操作者已批准这次外部写"的凭证。
>
> 硬边界：**Zeus 不托管执行 Agent 的长期外部凭据**（如 GitHub token）。v1 原语签发的是"操作者对一次有界外部写的显式批准"，执行 Agent 仍用自己的下游凭据真正发起写操作。

## 1. 问题与设计抉择

执行型 Agent 的不可逆操作（merge / production rollback）需要操作者授权。两条路线：

| 路线 | 形态 | 裁决 |
|---|---|---|
| 内核托管凭据 | Zeus 存长期外部 token，按技能代发 | **否决**：长期密钥落内核状态文件即成为最高价值目标，违反"数据主权 + 最小权限"，且重启/备份面扩大 |
| **操作者一次性短时授权** | 每次不可逆写由操作者签发一张有界、签名、单次的授权票据 | **采纳**：与 design-realm §7 的 `DriverWriteGrant`（一次性企业域写授权）同构，凭据不落盘，授权即审计事件 |

这与设计约束第 4 条一致：跨边界动作需要**显式、签名、一次性**的授权。

## 2. 票据结构

`src/delegation/execution-delegation.ts` 的 `ExecutionDelegation`：

| 字段 | 含义 |
|---|---|
| `kind` | 固定 `zeus-execution-delegation` |
| `version` | `1`；不识别版本 fail-closed |
| `grantedBy` | 批准的操作者身份（人读标识，非 keyId） |
| `skill` | 绑定技能；不同技能不可消费 |
| `vassal` | 可选；缺省则同一 fan-out 中**第一个**合格分支消费后即失效 |
| `capabilities` | 显式外部能力白名单，如 `github:pull-request:merge`；去重、裁剪、排序后入签名 |
| `reason` | 可选，供审计展示 |
| `issuedAt` / `expiresAt` | ISO 时间；默认 TTL 5 分钟，硬上限 1 小时，超限拒签 |
| `nonce` | 单次消费标识（默认 UUID，可注入以便测试） |
| `keyId` / `sig` | 驱动钥 keyId + 对"除 sig 外规范化票据"的 Ed25519 base64url 签名（复用 `canonicalJson`） |

能力词建议分层（`<system>:<resource>:<action>`，如 `github:pull-request:merge`）；正式词表随第一个真实技能的对接定义，v1 只把它当不透明字符串做**精确匹配**，不做前缀放行（前缀会让 `merge` 被 `merge` 的超集骗到）。

## 3. 签发、验签与单次消费

- **签发** `issueExecutionDelegation(input, { signer })`：校验 `grantedBy/skill/capabilities` 非空、TTL 为正且不超上限；规范化 capabilities；用注入的 `RosterSigner`（与名册封签同一驱动钥家族）签名。
- **验签 + 消费** `verifyAndConsumeExecutionDelegation(d, ctx)`，顺序刻意为：
  1. `missing` / `malformed`（含版本号、字段类型）
  2. 绑定：`wrong-vassal` → `wrong-skill` → `capability-not-covered`
  3. 签名存在性 `unsigned`、keyId 白名单 `unknown-key`、**无信任锚 `no-trust-anchor`**（execute 永远 fail-closed，不接受"只验形状"）、`bad-signature`
  4. `no-expiry` / `expired`
  5. `ledger.consume(nonce)` 失败 → `replayed`
- **失败不烧 nonce**：绑定/形状/签名/过期任一失败都在消费 nonce 之前返回，一次被拒的尝试不会让合法重试失效；只有全部通过才消费。
- **单次账本** `ExecutionDelegationNonceLedger`：有界（默认 10000，超出淘汰最旧），可 `exportState/importState` 随内核状态重启恢复，防止崩溃窗口内重放。

## 4. 与 DriverWriteGrant 的区别

| | DriverWriteGrant（E3.5） | ExecutionDelegation（#33） |
|---|---|---|
| 授权对象 | 内核 `Realm.write()` 写**企业域** | 执行 Agent 对**外部系统**做写 |
| 绑定目标 | `realmId` | `skill` + 可选 `vassal` + `capabilities` |
| 消费方 | Zeus 内核自己 | 下游执行 Agent（跨进程） |
| 状态 | 已接 HTTP + write 闸门 | **仅原语，未接线** |

两者复用同一签名/规范化/nonce 原语，但是两张语义不同的票据，不互相替代。

## 5. 接线状态（Zeus 侧四项已接；对端协议项留待）

deferred #33 的六项接线中五项已在 Zeus 侧完成，唯一剩余项撞对端未定义协议：

1. **execute/plan 模式** ✅ 已接（2026-10-03，Active work 107）：`FanOutRequest` 新增 `mode?: 'plan' | 'execute'`，缺省 'plan'，向后兼容；execute 无票据即不发起外部写。
2. **派发闸门** ✅ 已接（2026-10-03，Active work 107）：`Orchestrator.runBranch` 出站前调用 `verifyAndConsumeExecutionDelegation`，capability 固定 `'execute'`（票据 capabilities 须覆盖该能力）；无授权/验签失败/过期/重放一律 fail-closed **不发出站请求**，拒绝写审计 decision `execution-delegation-denied`（入 `AUDIT_DECISIONS` 与 TUI 语义 token）。
3. **票据投递的 A2A 字段** ⬜ 未接：经哪个 `x-zeus-*` 字段或消息头把票据交给执行 Agent——必须与 pr-helper 实际读取的字段对齐，**不臆造**；仍挂 deferred #33 触发条件②（pr-helper 凭据代理接口就绪）。
4. **HTTP 签发端点 + 审计** ✅ 已接（2026-10-03 早批，Active work 104）：`POST /api/execution-delegations`（bearer，无 signer 不挂载）+ 审计 decision `execution-delegation-issued`（`AUDIT_DECISIONS`、审计查询白名单、TUI token 跟随）。
5. **nonce 账本接入 bootKernel 持久化** ✅ 已接（2026-10-03 早批，Active work 104/105 落盘修复）：`KernelSnapshot.executionDelegationNonces` collect/apply + `FileKernelStateStore.save()` 补写（否则 spent nonce 从未落盘、重启即重放窗口）。

## 6. 验收

**v0.1 已满足（纯原语，8 项单测 `tests/execution-delegation.test.ts`）**：

- 无授权 → `missing`，不发起任何外部写（fail-closed）；
- 一张授权只成功一次，重放 → `replayed`；
- vassal / skill / capability 任一不匹配分别拒绝，且不消耗 nonce；
- 篡改签名字段 → `bad-signature`；非信任 keyId 签名 → `bad-signature`/`unknown-key`；无信任锚 → `no-trust-anchor`；
- 过期 → `expired`；TTL ≤0 或超 1h 上限拒签；
- capabilities 去重/裁剪/排序确定化；malformed payload 拒绝；
- nonce 账本可随重启导出恢复。

**接线阶段追加（触发条件满足后）**：授权一次 → 恰好一次外部写成功，审计含"授权签发"与"外部写"两条记录；plan 默认不带票据；execute 无票据零出站。

## 变更记录

| 版本 | 日期 | 内容 |
|---|---|---|
| v0.1 | 2026-09-30 | 纯函数安全原语落地：签发/验签/单次消费/fail-closed/nonce 账本 + 8 项测试；派发闸门、HTTP 签发、A2A 投递字段留待 #33 触发条件② |
