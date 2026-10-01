# 执行 Agent 协议设计（Vassal Protocol）— 基于 A2A 超集

> 状态：**现行（设计稿 v0.2，2026-09-29）**。实施进度记在 [handoff.md](../handoff.md)，本文只写设计。
> 决策：已确定「直接复用 A2A 标准做超集，不自造最小协议」（deferred-items #1 已销项）。

## 0. 一句话定位

执行 Agent 协议 = **标准 A2A 协议 + 一层「执行 Agent 契约」扩展**：矩阵产品（agent-world、job-agent、agent-dev、pr-helper、atlas、loom 等）保持独立仓库与独立部署，通过标准 A2A 被 Zeus 发现与调用，再通过超集扩展满足「向 Zeus 负责」的结果回传、升级与治理要求。

**为什么是超集而不是子集**：
- Zeus 需要与任意外部 Agent 互操作（A2A 是三条能力接入通道之一），自己先遵守标准才有资格要求别人。
- 超集意味着：**只懂标准 A2A 的调用方仍能调用执行 Agent**（降级为基础 Agent），Zeus 的增强能力（结果回传、治理）是可选的增量，不是新的闭墙。
- 矩阵产品的改造成本最低：先跑通标准 A2A（Agent Card + tasks/send），再逐步叠加扩展字段。

## 1. 角色与术语

| 角色 | 说明 |
| --- | --- |
| **Zeus（宗主）** | 唯一面向用户的门面；发现、派遣、监督执行 Agent 与外部 Agent |
| **执行 Agent（Vassal）** | 矩阵产品中以 headless 形态提供能力的 Agent，实现 A2A + 执行 Agent 扩展 |
| **外客（Guest Agent）** | 矩阵之外的外部 Agent，仅实现标准 A2A，无执行 Agent 义务 |
| **操作者（Driver）** | 人类用户/员工：派发、监督、中断、人工裁决的最高权限持有者 |

执行 Agent 与外客的唯一区别：执行 Agent 签署执行 Agent 契约（§4），外客不需要。

## 2. 分层：标准 A2A 层 + 执行 Agent 扩展层

```
┌──────────────────────────────────────────┐
│ 执行 Agent 扩展层（Zeus 超集，可选实现）           │
│  · agent-card 扩展字段（fealty 契约声明）   │
│  · tasks/report-back 结果回传              │
│  · escalation 升级人类                      │
│  · 治理：审计、权限回收、背压               │
├──────────────────────────────────────────┤
│ 标准 A2A 层（所有 Agent 必须实现）          │
│  · Agent Card 发现（/.well-known/...）      │
│  · tasks/send / sendSubscribe             │
│  · message / part / artifact 数据模型      │
│  · push notification / session            │
└──────────────────────────────────────────┘
```

规则：**扩展字段一律放独立命名空间（`x-zeus-*`）**，标准字段不覆盖、不改语义。标准 A2A 客户端忽略它们，互不破坏。

## 3. 标准 A2A 层要求（执行 Agent 必做）

1. **Agent Card**：发布在约定的 well-known 路径，包含 `name`、`description`、`url`、`capabilities`（streaming/push）`defaultInputModes`/`defaultOutputModes`、`skills`（每个 skill 带 id/name/description/tags）。
2. **任务模型**：支持 `tasks/send`（同步）与 `tasks/sendSubscribe`（SSE 流式）；执行 Agent 的每个能力映射为一个 skill + 一个任务语义。
3. **状态机**：遵循 A2A 标准 task lifecycle（submitted → working → input-required / completed / failed / canceled）。
4. **产物（Artifacts）**：结果以 artifact 返回，不塞进 message 文本；大文件走引用（URL/文件句柄），不内联。
5. **认证**：支持标准 A2A 认证方案（建议 OAuth2 client credentials 或 mTLS起步，同机部署可降级为 bearer token）。

## 4. 执行 Agent 扩展层（`x-zeus-*` 超集）

### 4.1 Agent Card 扩展：fealty（执行 Agent 契约声明）

```json
{
  "name": "pr-helper",
  "url": "https://vassals.internal/pr-helper/a2a",
  "skills": [ ... ],
  "x-zeus-fealty": {
    "version": "1",
    "swornTo": "zeus",              // 归属对象，发布期由 bayjf 名册分配
    "domain": "code-review",          // 能力域，用于路由
    "dataRealms": ["enterprise"],    // 需要访问的 Realm 类型：personal / enterprise / none
    "dataPolicy": "read-task-scope", // none / read-task-scope / read-realm / write
    "reportBack": true,              // 是否承诺结果回传
    "escalationPolicy": "auto",      // none / on-failure / auto（风险即升级）
    "sla": { "ackSeconds": 5 }       // 可选：受理时限声明
  }
}
```

Zeus 在注册时校验 fealty 与实测行为一致；名册（bayjf）展示的承诺即来自此处——**名册是公开的契约，不是宣传页**。

### 4.2 任务受理（Intake）

执行 Agent 收到任务后必须在 `ackSeconds` 内转入 `working` 并回传首个状态事件，事件带扩展字段：

```json
{
  "kind": "status-update",
  "x-zeus": { "runId": "zeus-run-123", "intent": "review-pr", "acceptedAt": "..." }
}
```

Zeus 注入 `x-zeus.runId` 实现全程追踪；执行 Agent 透传回传，不解释。

### 4.3 结果回传（Report-Back）

任务完成/失败时，artifact 之外附带一份**结果回传（report）**：

```json
{
  "kind": "artifact",
  "x-zeus-report": {
    "summary": "3 个 review 意见，1 个阻塞",
    "cost": { "llmTokens": 125000, "wallSeconds": 92 },
    "evidence": ["PR#42 comment 3", "..."],
    "followUps": [ { "skill": "job-agent/research", "reason": "需要确认作者意图" } ]
  }
}
```

- 结果回传 v1 契约字段为 `summary` / `evidence` / `cost` / `followUps`（以 `src/a2a/types.ts` 的 `ZeusReport` 与验收 #3 为准）；模型自评置信度（confidence）不是 v1 字段，需要时走升级通道由操作者判断，不进结构化结果回传。
- `summary`：给操作者的一句人话，直接进 Zeus 对用户的统一呈现。
- `evidence`：可点开的证据链，结果回传不许"只给结论"。
- `followUps`：执行 Agent 可推荐后续任务，但**只有 Zeus 有权决定是否派遣**——执行 Agent 不得私联其他执行 Agent（无 P2P，星型拓扑）。

### 4.4 升级人类（Escalation）

`escalationPolicy: auto` 的执行 Agent 在风险场景（不可逆操作、低置信度、越权请求）通过标准 A2A 的 `input-required` 状态 + 扩展字段升级：

```json
{
  "state": "input-required",
  "x-zeus-escalation": { "level": "driver", "reason": "irreversible: force-push", "options": ["approve", "reject"] }
}
```

Zeus 汇聚所有执行 Agent 的升级请求到**监督台**，按 Realm 与权限路由给正确的操作者。

### 4.5 治理（Governance）

- **审计**：fealty 声明 `dataPolicy: none` 的执行 Agent，Zeus 不向其派发任何含 Realm 数据的任务；派发时脱敏。
- **背压**：执行 Agent 可在 status-update 中回传 `x-zeus: { "backpressure": "saturated" }`，Zeus 转为向其他执行 Agent/队列分流。
- **权限回收**：Zeus 可随时吊销某执行 Agent 的 access token（标准 A2A 认证机制），吊销即降级为外客或拉黑，不需要执行 Agent 配合。
- **版本协商**：fealty.version 不匹配时 Zeus 拒绝注册并提示名册更新，不静默兼容。

## 5. 星型拓扑与信任边界

```
        用户（唯一门面）
             │
           Zeus ────── 监督台 / 名册(bayjf)
        ┌────┼────┬─────────┐
     执行 AgentA  执行 AgentB  执行 AgentC   外客X
```

- **无执行 Agent 间 P2P**：所有协作经 Zeus 编排（A2A 的发起方永远是 Zeus 或操作者）。理由：数据域治理需要唯一汇合点，避免执行 Agent 链式越权。
- **外客走同一协议**：外客不签 fealty，Zeus 按最低信任处理（沙箱、脱敏、不可逆操作一律升级）。
- **数据二极管落地**：fealty.dataRealms 是静态声明；Zeus 派发时做动态校验，个人/企业 Realm 混洄在派发前被拦截。

## 6. bayjf 名册的新角色

bayjf 从产品陈列馆升级为**对外发布的已签名 Agent 目录**：

1. 每个执行 Agent 一行：能力域、承诺（fealty 摘要）、SLA、健康状态（探针）。
2. 对外是「可招募的干将名册」；对 Zeus 是注册中心视图。
3. 名册数据来源即 Agent Card + fealty，**单一事实源在执行 Agent 自己身上**，bayjf 不手抄。

## 7. 首个执行 Agent：pr-helper 验收清单

> 验收状态（2026-09-29）：**六条全部有真机结果**。① 卡片与 skills：2026-09-25/29 标准客户端与内核注册两轮实拉确认（well-known rewrite 到 `/api/a2a/agent-card`，5 个 skills，fealty 声明在卡上）；② `tasks/sendSubscribe` 全流程：2026-09-29 真机扇出受理 → `state=completed`；③ 结果回传：`x-zeus-report.summary` 随 artifact 原样回传（`evidence`/`cost` 字段按执行 Agent 实际产物为准）；④ escalation：execute 模式与缺参数场景以 `input-required` 返回（凭据代理未实现、`Missing required parameters: owner, repo`），plan 模式为默认；⑤ Zeus 派发侧：脱敏、吊销、审计三条在 2026-09-27/29 真机验收中演示（审计 `dispatched` ×2 + `vassal-revoked`）；⑥ 纯标准客户端验收 2026-09-25 首次 PASS。**第 6 条守护通过，超集而非闭墙的设计在真机上成立。** 范围：以上均为 plan 模式 / 只读技能，不含对 GitHub 的不可逆写。
>
> 补记（2026-09-30）：④ 中的"凭据代理未实现"在 Zeus 侧已落地一半——一次性执行授权原语入库（签发 / 校验 / 消费、nonce 台账、失败即拒，见 [design-execution-delegation.md](design-execution-delegation.md)，对应 deferred #33 的库内原语部分）；但端到端仍未打通：execute/plan 裁决点、派发器闸门、A2A 字段、HTTP 签发面与台账持久化均未接线，等待 pr-helper 的凭据接口定型，故对 GitHub 的不可逆写仍不在已验证范围内。2026-09-29 的验收结论本身不变。

| # | 验收项 |
| --- | --- |
| 1 | Agent Card 发布在 well-known 路径，含 review/merge 等 skills 与 fealty 声明 |
| 2 | `tasks/sendSubscribe` 全流程：受理 → working → completed/failed |
| 3 | 结果回传：summary + evidence + cost 三字段齐备 |
| 4 | escalation：force-push 等不可逆场景走 input-required 升级 |
| 5 | Zeus 派发侧：脱敏（dataPolicy 校验）、吊销 token、审计日志三条全部可演示 |
| 6 | 一个纯标准 A2A 客户端（不认 x-zeus-*）调用 pr-helper 成功——验证超集兼容性 |

第 6 条是整个「超集而非闭墙」决策的守护测试，**不通过则协议设计失败**。

## 7A. 第二个执行 Agent：loom 协议级真机联调

> 联调状态（2026-10-01）：**协议级通过，W2 不关账**。loom 后端 `app/core/a2a/`（其自身 Q150 第一阶段，先于本次对账存在）与 Zeus 真实客户端在本机端到端跑通，**loom 侧零代码改动**——这是协议对「一个不是照 Zeus 模板写、而是独立实现的 A2A 服务」的第一次超集守护。
>
> 取证形状：Zeus 侧用真实 `VassalRegistry.register` + `dispatch/client`（非自造夹具）；loom 侧挂**真实** a2a router（`card.py`/`rpc.py`/`router.py` 原样），最小 uvicorn 服务只 override 了鉴权（`require_agent_key`）与审计（`append_audit`）两个 DB 依赖，任务逻辑/SSE/fealty 全部是生产代码。
>
> 逐条结果：① 注册闸——well-known 卡片经 fealty 校验通过（`version:"1"`、`swornTo:"zeus"`、`dataRealms:["enterprise"]`、`dataPolicy:"read-task-scope"`、`escalationPolicy:"auto"`、`sla.ackSeconds:10` 全部落在 Zeus 受控词表内），卡片声明的 `url` 被直接解析为任务端点（与 #29「卡片 url 优先于约定」一致，无需 `TASK_URL` 覆盖）；② sendSubscribe——SSE 四帧 `submitted → working → artifact-update → completed(final)` 被 Zeus `consumeSseStream` 正确拆解，收尾帧是整个 JSON-RPC 响应（`{result:task}`），与事件帧 `{result:event}` 同构；③ 结果回传——`x-zeus-report` 含 summary/evidence/cost（plan 模式 `llmTokens:0`）；④ escalation——缺必填参数（`compliance-check` 只给 tenant_id 缺 content_id）回终态 `input-required`，Zeus 不当作错误抛出；⑤ 非流式 `tasks/send` 与流式结果等价（同报告、同终态）。
>
> **诚实边界（为什么 W2 不关账）**：本次是本机协议级验证，不是 loom 生产栈验收——没有真实 PostgreSQL、Agent Key 由 override 放行、审计未落库、未走网关/TLS；loom 三个 skill 都是 plan-only（不触链、不花 token、不改 Gate）。仍待：loom 生产部署上的同口径回归、atlas 同波接入、纯标准 A2A 客户端（不认 x-zeus-*）对 loom 的第 6 条式守护复验。

## 8. 开放问题（登记到 deferred-items）

- fealty 的发布与吊销是否需要签名链（防伪造名册条目）→ 触发条件：名册对外公开前。
- 结果回传的成本字段单位与结算口径（跨执行 Agent 可比性）→ 触发条件：企业版计费立项时（联动 deferred #4）。
- 执行 Agent 饱和背压与 Zeus 任务队列的降级顺序 → 触发条件：≥3 个执行 Agent 在线后压测。

## 9. 演进日志

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| v0.2 | 2026-09-29 | §7 pr-helper 验收清单六条补真机结果：标准客户端 2026-09-25 PASS、真机扇出 2026-09-29 15/15 exit 0（A1 销项）；不改协议设计——清单只记验收状态。详见 review v0.20 / handoff Active work 75 |
| v0.1 | 2026-09-21 | 初稿：A2A 超集决策落地；fealty / intake / report-back / escalation / 治理 / 星型拓扑 / pr-helper 验收清单 |
