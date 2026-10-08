# 外部 Agent 信任分级与沙箱设计（deferred #5 → PRD E9.4）

## 0. 一句话

把执行 Agent 协议的既有声明——「未注册外部方按最低信任处理（沙箱、脱敏、不可逆操作一律升级）」（[design-vassal-protocol.md](design-vassal-protocol.md) §5）——落实为**可判档、可审计、可执行**的信任分级：调用方身份按验证锚定档，每档绑定能力面、数据面、资源面与操作面的上限，未注册外部方在最低档上被限流、隔离并留痕。机制入库为纯函数 + 装配点，不在没有真实调用方时把阈值拍死（阈值调参沿用 deferred #9 同口径：真实负载数据到了再定数）。

## 1. 缺口与现状

- **声明有、机制无**：设计文档写明了「外客按最低信任处理（沙箱、脱敏、不可逆操作一律升级）」，但 `src/` 全库搜索 `sandbox` 零命中——该声明从未变成代码。现状是：**任何过了入站形状闸的调用方，与注册执行 Agent 享有同一套派发能力**（realm 缺省 personal、可触发 fanOut），没有档位差异。
- **入站面已建立判档挂钩**：`src/http/serve.ts` 的入站 A2A 面（Active work 144）对 `x-zeus-caller-card` 跑 `fealtyOathProblem` 形状闸——**只验形状（版本闸 + 必填字段），不验签名锚**（真实信任锚 = bayjf 签名目录，R2 未公开）。无卡或形状不过 → fail-closed 403 + 审计，已实现。
- **既有信任原语可复用**：`DomainGrant`/`decideRealmAccess`（E6.4，realm 级授权）、`dataPolicy` 四档判（E4.5，出站内容边界）、执行授权票据（#33，execute 能力钉）、注册表 active/revoked 状态、`AUDIT_DECISIONS` 单一来源。
- **PRD 出处**：E9.4（P2）「外部 Agent 信任分级与沙箱」，触发条件「首个矩阵外 Agent 接入**前**完成」——措辞是前置守卫而非后续增强（同 #6「个人/企业双域授权粒度」先例：等外部方到了再补边界，等于先把门装歪再拆）。

## 2. 信任分级模型（档位判定）

判档是**纯函数**，输入 = 调用方携带的 agent card 派生事实，输出 = `TrustTier`。验证强度按锚递增：

| 档位 | 判定依据 | 含义 |
| --- | --- | --- |
| `tier-0` 拒绝 | 无卡 / 无 fealty 字段 / `fealtyOathProblem` 非空 | 不可信，fail-closed 拒绝 + 审计（现状已如此，本设计固化） |
| `tier-1` 形状信任 | fealty 形状通过，但**验签不可达**（签名目录未公开 / 公钥未取到） | 信任 = 声明信任：卡片自述 + 形状合法。给最低可用能力，全部上限最低档 |
| `tier-2` 注册执行者 | fealty 形状通过 **且** 已在注册表 active（现行出站协作方，如 pr-helper / loom / atlas） | 信任 = 注册时卡片深比对 + active 状态；沿用现行派发规则 |
| `tier-3` 签名在册 | fealty 形状通过 **且** 签名验证通过（bayjf 签名目录在册、公钥验签成功——R2 公开后才可达） | 信任 = 密码学验证；最高档，与注册执行者同权或略高（附签名档案） |

**判档不跨域判定内容**：realm 可见性与数据边界**不在本模型内**——仍由 `decideRealmAccess` 与 `dataPolicy` 现行规则单独判定（跨域授权面不得被信任档位旁路）。

## 3. 沙箱边界（每档上限）

沙箱 = 四个正交面的上限，随档位单调放宽。`tier-0` 无沙箱（直接拒绝）。

| 面 | 维度 | tier-1（形状信任） | tier-2（注册执行者） | tier-3（签名在册） |
| --- | --- | --- | --- | --- |
| 能力面 | 可派发技能域 | **只读类技能白名单**（skill tags 含 `read-only` = `READ_ONLY_TAG`；tier-1 只放行只读 tag 技能，缺 registry / 未注册 / 非只读均拒绝） | 注册声明的技能域 | 同 tier-2 |
| 数据面 | 出站内容边界 | `dataPolicy` 强制最严档（`none`：realmHits 不入出站载荷） | 现行 dataPolicy 声明档 | 现行 dataPolicy 声明档 |
| 数据面 | realm 可见性 | 仅个人域、且无出站凭证注入 | 注册声明 + DomainGrant 现行规则 | 同 tier-2 |
| 资源面 | 并发分支上限 / 超时 / 回传字节 | 全局默认的 1/3（数值在启用时按实测定，不凭空拍） | 现行全局上限 | 现行全局上限 |
| 操作面 | 不可逆操作 | **一律升级**：`execute` 能力不可达（只 `plan`），凭证代理不注入 | 现行执行授权票据规则（#33） | 同 tier-2 |

**两处显式不做**：
- 不做进程隔离（容器/子进程沙箱）——那是部署形态的事（E10.2 真机部署批），库里做的是**权限与资源沙箱**（能力、数据、并发、凭证四个面）。
- 不建第二套身份体系——档位判定复用既有 fealty 形状闸与注册表，签名锚等 R2。

## 4. 契约落点

1. **纯函数**：`src/trust/tier.ts` —— `trustTierOf(callerCard, { registry, rosterPubKey? })` 返回 `TrustTier`；`tierConstraints(tier)` 返回该档四个面的上限对象（能力白名单谓词 / dataPolicy 强制档 / 资源上限 / 凭证策略）。不持有状态，可单测。
2. **装配点（入站面）**：`src/http/serve.ts` 入站 A2A 判档处（现 `fealtyOathProblem` 之后）加档位解析；`tasks/send` 处理按 `tierConstraints` 收窄——tier-1 只放行白名单技能、强制最严 dataPolicy、走 1/3 资源上限、execute 不可达。
3. **审计**：新 decision 值 `external-agent-admitted`（带 tier）/ `external-agent-refused`（带 reason）入 `AUDIT_DECISIONS` 单一来源 + TUI 语义 token；档位逐请求判定并记账，不做会话级缓存（对端身份可随时吊销，与执行 Agent 吊销同语义）。
4. **出站侧不动**：注册执行 Agent 的派发路径零改动（tier-2 即现行规则）；签名目录（bayjf R2）公开后，`rosterPubKey` 接入档位判定即可升 tier-3，不重写。

## 5. 不做什么（避免下次重新讨论）

- 不做进程级沙箱/容器隔离（部署形态）。
- 不建第二套身份体系、不加新协议字段（复用 `x-zeus-caller-card` 与 fealty 形状闸）。
- 不把资源阈值拍死——tier-1 的 1/3 系数是占位，接入真实调用方后按负载数据调参（deferred #9 同口径）。
- 不做外部 Agent 间的互相调用（星型拓扑：所有协作经 Zeus 编排，无 P2P）。

## 6. 触发条件与分期

- **触发条件（原）**：首个矩阵外 Agent 接入时。**本设计按 #6 先例提前实施**——判档 + 审计 + 资源上限是守卫性质，库内可闭环；tier-1 的"只读白名单"依赖技能 tag 体系（V1 时无），故 V1 以「plan 模式 + 最严 dataPolicy + 1/3 资源 + execute 不可达」为最小闭环。
- **分期**：
  - **V1（已实施）**：`trustTierOf` / `tierConstraints` 纯函数 + 入站面装配 + 审计值 + 测试。tier-2/3 档位**先存在**（判定函数完整），但 tier-1 是唯一立即生效的收窄。
  - **V2（已实施，2026-10-08）**：技能只读 tag 体系（能力面白名单的正式形态）——`READ_ONLY_TAG` + `isReadOnlyTagged` 纯函数（src/trust/tier.ts）+ 入站 A2A 面 tier-1 能力面闸：缺 registry / 技能未注册 / 技能非只读 → `inbound-task-refused` 审计（带 tier-1）fail-closed 403，零出站；tier-2/3 保持现行规则。
  - **V3**：bayjf R2 公开后接 `rosterPubKey` 升 tier-3（仓库外，随 E5.4）。

## 7. 演进日志

- v0.2（2026-10-08）：V2 落地——tag 体系正式化（`read-only` = `READ_ONLY_TAG`），tier-1 能力面收窄为只读技能白名单（缺 registry/未注册/非只读 fail-closed），§3 能力面行与 §6 分期同步。
- v0.1（2026-10-08）：设计稿入库（deferred #5 前置守卫裁定，V1 实施范围 = 判档 + 审计 + 资源上限）。
