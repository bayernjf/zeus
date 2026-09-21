# bayjf 名册改造设计（封神榜 Roster）

> 状态：**现行（设计稿 v0.1，2026-09-21）**。实施进度记在 [handoff.md](../handoff.md)，本文只写设计与契约。
> 上游决策：封臣协议为 A2A 超集，名册新角色见 [design-vassal-protocol.md](design-vassal-protocol.md) §6。

## 0. 一句话

bayjf 从「产品陈列馆」升级为 Zeus 的**封神榜**：一份可招募封臣的名册。名册上的每一个字都派生自封臣自己发布的 Agent Card + fealty，**bayjf 只渲染、不手抄、不背书内容本身**；Zeus 注册中心是唯一聚合点。

## 1. 现状与目标

- **现状**：bayjf 是矩阵产品（agent-world / job-agent / agent-dev / pr-helper / atlas / loom）的展示站，内容为人工维护的营销页。
- **目标**：
  1. 对驾驶员/用户：可招募的干将名册——能力域、承诺、SLA、健康状态，一眼看清"谁能干、谁值得托付数据"。
  2. 对 Zeus：注册中心的只读视图——在册状态、探针结果、吊销痕迹。
  3. 名册是**公开的契约，不是宣传页**（design-vassal-protocol.md §4.1）：展示的承诺即封臣 fealty 的原文摘要，改承诺必须改 card，bayjf 无法替封臣美化。

## 2. 设计原则

1. **单一事实源在封臣**：条目字段全部来自 Agent Card 与 `x-zeus-fealty`，经 Zeus 注册中心聚合；bayjf 与 Zeus 之间只传**名册快照（snapshot）**，不传可编辑的条目。
2. **封臣即目录条目**：与"目录即数据库"同构——封臣是事实源，名册是它的只读投影；投影可以缓存、重建、丢弃，随时可从封臣重新派生。
3. **内外双视图，公开版最小裁剪**：内部视图用于调度与治理，公开视图裁掉端点、探针细节与已吊销者（见 §4）。
4. **外客不入榜**：guest（无 fealty）在注册时即被注册中心拒绝，名册天然只含封臣；未来若展示外客，另设"客卿"区，不与封臣混排。
5. **公开即验签**：名册对外公开前，fealty 必须有签名链背书（deferred-items #7）；未验签前只对内可见。

## 3. 名册条目数据模型（字段映射）

每个名册条目都必须能追溯到一个真实字段；没有来源的字段不许上名册。

| 名册字段 | 来源 | 说明 |
| --- | --- | --- |
| `name` | `card.name` | 封臣名，注册主键 |
| `description` | `card.description` | 一句话自我介绍（封臣自述，非名册编辑） |
| `domain` | `fealty.domain` | 能力域，用于路由与分组 |
| `skills[]` | `card.skills[]`（id/name/description/tags） | 可招募的具体技能 |
| `commitments.dataRealms` | `fealty.dataRealms` | 可接触的数据域：personal / enterprise / none |
| `commitments.dataPolicy` | `fealty.dataPolicy` | none / read-task-scope / read-realm / write |
| `commitments.reportBack` | `fealty.reportBack` | 是否承诺战报回流 |
| `commitments.escalationPolicy` | `fealty.escalationPolicy` | none / on-failure / auto |
| `sla.ackSeconds` | `fealty.sla.ackSeconds` | **声明**受理时限（非实测） |
| `health` | 注册中心健康探针 `lastHealthCheck` | `healthy` / `unhealthy` / `unknown`；内部视图附 detail |
| `status` | 注册中心状态 | `active` / `revoked`（listAll 全量视图） |
| `registeredAt` | 注册中心记录 | 在册时间 |
| `cardUrl` / `taskUrl` | 注册中心 | **仅内部视图**；公开版不暴露内部端点 |

快照信封：

```ts
type RosterSnapshot = {
  generatedAt: string;                 // 投影时间
  scope: 'internal' | 'public';
  entries: RosterEntry[];
};
```

## 4. 双视图裁剪

| 内容 | 内部视图（Zeus/驾驶员） | 公开视图（bayjf） |
| --- | --- | --- |
| active 封臣 | ✅ | ✅ |
| revoked 封臣 | ✅（带 `status: revoked` 与吊销痕迹，供治理追溯） | ❌ 直接过滤（封神榜不立叛将） |
| 端点 URL（cardUrl/taskUrl） | ✅ | ❌ |
| 探针 detail（报错原文） | ✅ | ❌，只给健康状态徽标 |
| fealty 承诺摘要 | ✅ | ✅（原文，不改写） |
| 验签状态 | ✅（签名链落地后） | ✅（未验签条目不得上公开版） |

## 5. 数据流

```
封臣仓库（发布 Agent Card + x-zeus-fealty）
        │  拉取注册 / 健康探针
        ▼
Zeus VassalRegistry（A1，唯一聚合点；listAll 全量视图）
        │  RosterProjector（纯函数投影，R0 落地）
        ├─► internal snapshot（含 revoked / 端点 / 探针明细）
        └─► public snapshot（裁剪 + 仅 active）
                 │  构建期拉取 / 定时缓存（只读 JSON）
                 ▼
             bayjf 静态渲染（封神榜页面）
```

- bayjf **不直接**拉各封臣 card：那会让健康探针、吊销状态、fealty 校验在 bayjf 侧再实现一遍，制造第二个事实源。
- 快照是不可变产物：bayjf 构建时拉取（SSG）或短时缓存，不提供任何名册写接口；条目有误改封臣 card 重新发布，下一轮投影自然更正。

## 6. 封臣生命周期与名册呈现

| 注册中心状态 | 名册呈现（内部） | 名册呈现（公开） |
| --- | --- | --- |
| 注册成功、探针通过 | active · healthy | 在册·健康 |
| 注册成功、探针未跑/失败 | active · unknown / unhealthy | 在册·状态未知/异常（保留在榜，不擅自下架） |
| 已吊销 `revoke()` | revoked（保留行与时间，治理可追溯） | 不出现在快照中 |
| 无 fealty（guest） | 不进入注册中心，无行 | 不入榜 |

吊销是治理动作（见 [design-vassal-protocol.md](design-vassal-protocol.md) §4.5）：公开版即时下架，内部版"追夺功名"但留痕。

## 7. 信任闸门：fealty 签名链（deferred #7）

公开名册的风险：card 端点若被伪造或篡改，名册会替假承诺背书。

- **闸门**：bayjf 公开发布前，必须完成 fealty 签名链（deferred-items #7 的触发条件即"名册对外公开前"）。
- 签名链落地前：名册仅对内可见；公开页若提前上线，必须对每个条目展示"未验签"标记且不提供接入入口。
- 候选方向（签名链立项时拍板，本文不锁死）：
  1. Zeus 背书：注册时 Zeus 用名册私钥对 fealty 摘要签名，快照携带签名，bayjf 展示验签结果；
  2. 封臣自签 + Zeus 交叉背书：封臣持自己的签名密钥，Zeus 记录"在册即背书"。
- 吊销与签名联动：`revoke()` 后下一份公开快照即移除条目；已被 bayjf 静态页缓存的旧快照靠重新构建失效（R2 定义缓存 TTL 上限）。

## 8. 交付阶段

- **R0（Zeus 内核，纯库）**：`RosterProjector` 把 `VassalRegistry.listAll()` 投影为 internal / public 两份 `RosterSnapshot`（JSON 可序列化），配单测。**无 HTTP、无 bayjf 改动**。
- **R1（Zeus HTTP 层就绪后）**：只读端点 `/roster`（internal，鉴权）与 `/roster/public`（public 裁剪）；探针定时刷新。
- **R2（bayjf 仓库改造）**：构建期拉 public snapshot 静态生成封神榜；fealty 承诺原文展示、健康徽标、验签标记；定义快照缓存 TTL 与吊销下架时效。
- **闸门**：R2 公开访问前必须完成 §7 签名链（deferred #7 销项）。

## 9. 开放问题

1. 外客是否设"客卿"专区（标准 A2A 可调用但非封臣）？默认不做，触发条件同 deferred #5（首个外部 Agent 接入）。
2. 名册是否展示 fealty 变更史（承诺改朝换代的审计轨迹）？依赖注册中心留存 card 版本，R1 再定。
3. bayjf 现有产品营销内容与封神榜的共存：营销页保留为"产品介绍"，名册页只认快照，两者互链但不混编。
4. 健康探针的公开粒度：是否展示历史可用率（SLA 实测值）而非单点徽标？R2 结合背压/成本口径（deferred #8/#9）再定。

## 10. 演进日志

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| v0.1 | 2026-09-21 | 初稿：单一事实源原则、条目字段映射、内外双视图裁剪、数据流、生命周期、签名链闸门、R0–R2 阶段 |
