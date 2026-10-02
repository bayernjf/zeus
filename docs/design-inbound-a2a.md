# 入站 A2A 面设计裁定（deferred #19，v0.1，2026-10-03）

## 0. 一句话

Zeus 发布自己的 agent card 并接收入站 `tasks/send`，落到 H2 意图面（同一内核 fanOut 路径与审计事件流）；本设计裁定固化方向，**实现不启动**（触发条件见 §5）。

## 1. 缺口与现状

- **现状**：Zeus 只有出站 A2A（拉卡片、`tasks/send`、SSE 回读、`tasks/cancel`）。`src/http` 没有 `/.well-known/agent-card.json`，也没有任何 `tasks/*` 路由——别的 Agent 无法把任务派给 Zeus，也不存在一张可供外部校验的 Zeus 卡片。
- **出处**：deferred #19；2026-09-25 复核发现它是"评审说过、没人接"的失物。

## 2. 裁定（方向固化）

1. **卡片形状**：Zeus 发布 `/.well-known/agent-card.json`，形状与要求执行 Agent 的一致（A2A 超集契约，见 [design-vassal-protocol.md](design-vassal-protocol.md)）——以同一契约要求自身，避免出站与入站两套标准。
2. **入口路由**：入站 `tasks/send` 落到 H2 意图面——复用 `POST /api/intents` 的内核 fanOut 路径与同一根审计事件流；不新建传输面、不引入界面私有逻辑（能力接入三通道约束）。
3. **三个必答问题的暂定答案**：
   - **谁能派给我**：上游持有在册身份（fealty 验签通过、在信任锚/名册内）才被接受，否则拒绝——与出站侧对执行 Agent 的要求镜像；
   - **落在哪个域**：请求显式声明 `realmSource`，缺省个人域；企业域派发走 DomainGrant 现行规则与 `decideRealmAccess`（[design-realm.md](design-realm.md) §7.2/§7.3）；
   - **谁为结果负责**：审计责任链延伸（intent → branch → 上游 agentId 记账），与 Org 编制 `traceAccountability`（E9.3）衔接。
4. **不做**：入站 SSE 流——H3 服务端 SSE 是出站合并流；入站回执 = `tasks/send` 响应 + 结果查询，与出站对称。

## 3. 契约落点

- JSON-RPC 面与错误码：对齐出站执行 Agent 既有契约（design-vassal-protocol），不重复定义。
- 审计：新增入站相关 audit decision 取值时，先扩 `AUDIT_DECISIONS` 单一来源（deferred #27 旧账不重犯），审计查询白名单与 TUI token 跟随。
- 卡片 fealty 字段：与签名链 v1.2 一致（载荷含 `schemaVersion`，验签前置三道版本闸，见 [design-fealty-signing.md](design-fealty-signing.md) §4.1）。

## 4. 不做什么（避免下次重新讨论）

- 不为入站面新建第二套身份体系（仍走 fealty 验签与名册/信任锚）。
- 不在没有真实上游调用者时写实现（deferred #19 原文：现在做只会得到没人用的空壳）。

## 5. 触发条件（照 deferred #19 原文）

① Zeus↔loom 真机联调时 loom 需要反向派任务给 Zeus；② bayjf 想让公开签名目录上的其它执行 Agent 调用 Zeus 的聚合能力；③ 出现多 Zeus 实例协作的需求。

## 6. 演进日志

- v0.1（2026-10-03）：裁定入库，方向固化；实现待触发条件。
