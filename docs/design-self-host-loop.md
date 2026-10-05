# 设计稿：自托管常驻循环（`watch` 触发器 + 有界委托契约）

- 状态：**设计稿 v0.2（2026-10-05）**，`DelegationContract` 的库内原语已实现（见 handoff Active work 128），`watch` 与 HTTP 面未实现。本文是这两个原语的单一事实源；handoff 与 PRD 只索引，不复制全文。
- 关联：deferred **#41**（企业形态：隔离实例 vs 同实例多租户——本文的两个原语在两种形态下形状相同，故先于该决定设计）、deferred **#19**（入站 A2A 面）、deferred **#33**（执行 Agent 凭据代理，见 [design-execution-delegation.md](design-execution-delegation.md)）、deferred **#40**（执行后反思闭环，复用本文的升级通道）；验收清单见 [verify-self-host-pilot.md](verify-self-host-pilot.md)。
- 立项理由（诚实版）：目前 zeus 的**每一条意图都由人发起**。"替我看着这件事"这类需求现在无法表达——这是自托管个人助理与企业自动化两条线**共同**缺的那一层，所以它属于内核而不是任何一侧的外壳。

## 1. 背景与现状（代码级）

| 事实 | 证据 |
| --- | --- |
| 内核里没有任何调度器。全仓计时器调用共 **5 处**（2026-10-05 现测），全部是给一次已经在进行的调用设上限、或界面自刷新：决策请求超时、SSE keepalive、分支超时、派发受理超时、TUI 轮询 | `src/decision/shared.ts:42 #setTimeout`、`src/http/server.ts:2329 #keepalive`、`src/orchestrator/orchestrator.ts:721-727 #setTimeout`、`src/dispatch/client.ts:93 #setTimeout`、`src/tui/cli.ts:95 #setInterval` |
| 意图入口是 HTTP 的一次提交，语义是"人发起了这次编排" | `src/http/server.ts:378 #intents` |
| execute 分支在派发前必须携带**已验签且未消费**的执行授权票据，缺票据是零出站拒绝 | `src/orchestrator/orchestrator.ts:665-682 #verifyAndConsumeExecutionDelegation` |
| 票据结构已经支持能力集、技能绑定、有效期、单次 nonce、签名 key 与验签锚点 | `src/delegation/execution-delegation.ts:10-32 #ExecutionDelegation` |
| 票据默认 TTL 5 分钟、上限 60 分钟——即"签发一次、派发一次"，不是"一段时间内自动放行" | `src/delegation/execution-delegation.ts:35-37 #EXECUTION_DELEGATION_DEFAULT_TTL_MS` |
| 授权不可逆性的另一半靠 nonce 账本，且账本随内核快照持久化并在重启后回灌 | `src/delegation/execution-delegation.ts:156 #ExecutionDelegationNonceLedger`、`src/state/kernel-state.ts:139 #executionDelegationNonces`、`src/state/kernel-state.ts:158-159 #executionDelegationLedger` |
| 人在环是既有能力：冲突升级进 desk，操作者裁决有端点与监督台 | `src/state/boot.ts:46-51 #conflictsToDesk`、`src/http/server.ts:641 #approve` |

结论：**缺的不是安全边界，是"在没有人的时候合法地产生一次意图"的那个入口**，以及"边界内自动、越限回到人"的那层授权。这两件必须一起做——只做前者会得到一个能自主发起不可逆动作的内核，那正是现在的闸门在防的东西。

## 2. 目标与边界

**目标**

1. 让"条件成立时替我办一次"成为可登记、可撤销、可审计、可重启恢复的内核原语。
2. 让自动发起的意图在**没有人在场**时，只能落在一份**预先签名、有上限、可撤销**的委托之内；超出即变成升级项回给人，而不是静默放行或静默失败。
3. 两者都遵守设计约束：外部输入只从三条通道进（不新增私路）、数据主权不动、跨域不回流。

**不做**

- 不做通用工作流引擎 / DSL / DAG 编排语言（E1.4 的 DAG 已覆盖"一次任务内部"的结构，本文只管"什么时候发起一次任务"）。
- 不做常驻人格、对话入口、通知渠道（那是宿主层，不是内核；按约束二，它们没有可执行原语就不进本文）。
- 不做"让 Agent 自己决定要不要办"——发起条件必须是登记时写定的**可求值谓词**。
- 不动 `plan` 与 `execute` 的既有语义；`plan-only` 仍是缺省。

## 3. 原语一：`watch`（触发登记与条件求值）

### 3.1 数据结构

```ts
export type Watch = {
  id: string;
  /** 谁登记的：人（操作者身份）或某次授权的受益主体。自动发起的意图以此人为 actor。 */
  owner: string;
  /** 条件：字段 + 比较符 + 阈值，登记时写定，运行期不求值任意表达式。 */
  predicate: { source: WatchSourceRef; op: 'above' | 'below' | 'present' | 'absent' | 'changed'; field: string; value?: string | number };
  /** 满足时提交的那次意图的模板。 */
  intent: { skill: string; subject: string; mode: 'plan' | 'execute'; maxFanOut: number };
  /** 求值节律与生命周期。 */
  intervalSeconds: number;
  startsAt: string;
  expiresAt: string;
  /** 触发预算：最多触发 N 次、最多 M 次 execute；两者都被消费计数持久化。 */
  budget: { fires: number; executes: number };
  enabled: boolean;
  lastEvaluatedAt?: string;
  lastFiredAt?: string;
  /** 有界委托契约 id；`intent.mode === 'execute'` 时必填且必须覆盖该 capability。 */
  delegationId?: string;
};
```

`predicate.source` 只允许三类，**且各自复用既有通道，不开新路**（约束三）：

| 源 | 允许读什么 | 复用哪条既有路径 |
| --- | --- | --- |
| `metrics` | 本机内核读数（在途、队列深度、失败率） | `src/orchestrator/metrics.ts:52-58 #queueDepth`，纯内存只读 |
| `realm` | 用户自己授权过的数据域里的条目元数据 | 只读面同一套扫描与边界，实时读取语义见 [mcp-integration.md](mcp-integration.md) §1.6 |
| `connector` | 已声明连接器的工具返回值 | 走既有连接器调用与其权限边界（`src/mcp/connectors.ts:286-288 #withinDeclaredBoundary`），**不新增出站面**；出站白名单与域名注入约束一并生效（`src/dispatch/dispatcher.ts:182-196 #diode`） |

求值器**不做**的事：不执行任意 JS、不 eval 用户字符串、不引入表达式语言。比较符是封闭枚举，字段名是白名单——理由和权限词汇封闭同源：一旦能写表达式，边界就转移到求值器里，而那里没有闸门。

### 3.2 生命周期与执行点

1. 登记：`POST /api/watches`（bearer，H2 面），落内核状态。
2. 求值：单个 tick 顺序遍历启用的 watch；**每个 tick 的求值本身不发外部请求**，读数来自上一轮缓存或本 tick 内的只读调用，失败即视为"条件未知"并计数，**不触发**。
3. 触发：满足 → 以 `owner` 为 actor 提交一次意图（`intent` 模板 + 自动 `intentId = watch:<id>:<seq>` 保幂等，命中既有幂等判定，重复触发不会重复派发）。
4. `mode: 'execute'` 的触发**必须**带一个从 `delegationId` 派生的子票据，走 `src/orchestrator/orchestrator.ts:665-682 #verifyAndConsumeExecutionDelegation` 那条完全相同的闸门；拿不到子票据（预算耗尽/契约撤销/能力不覆盖）= **零出站拒绝**，并写一条升级项回给人。
5. 撤销：`enabled: false` 或到期即不再求值；撤销是写状态 + 审计，不删历史。
6. 持久化：watch 集合、`budget` 剩余、`lastFiredAt` 全部进内核快照，与既有 `executionDelegationNonces` 同一套写法（`src/state/kernel-state.ts:139 #executionDelegationNonces`）——**重启后不重置计数**，否则一次重启就是无限次触发。

### 3.3 失败语义（必须写清楚，否则实现会自己发明）

| 情况 | 行为 | 为什么 |
| --- | --- | --- |
| 求值时源不可达 | 记 `watch-eval-unavailable`，不触发，不产生升级项（否则一个连接器抖动会淹掉 desk） | 失败要可看，但"看不见数据"不等于"有事发生" |
| 连续求值失败 ≥ 阈值 | 该 watch 自动停用 + 一条升级项 | 静默死掉的触发器比没有更坏 |
| 触发的意图被闸门拒（无票据/越限） | `execution-delegation-denied` 审计（既有值）+ 升级项 | 与人工发起的拒绝同形，读面不需要区分发起者 |
| 意图幂等命中（重复触发） | 复用既有回放语义，不重派 | 与人工重复提交同形 |
| tick 内单条 watch 抛错 | 记审计、继续下一条 | 一条坏 watch 不能停掉整个求值器 |

## 4. 原语二：有界委托契约（`DelegationContract`）

现状是"签一次、办一次"。要做"限额内自动、越限回人"，需要在其上加一层**父授权**，而不是放松子票据的任何一条约束。

### 4.1 结构与不变式

```ts
export type DelegationContract = {
  id: string;
  kind: 'zeus-delegation-contract';
  version: 1;
  grantedBy: string;          // 与子票据同一身份语义
  skill: string;              // 绑技能，与子票据同规则
  vassal?: string;            // 绑定时子票据只能用同一个执行 Agent；不变式 1 点了 vassal，结构里就得有它
  capabilities: string[];     // 允许派生子票据的能力全集；子票据必须是其子集
  limits: {
    maxChildTickets: number;      // 总次数上限
    maxConcurrent: number;        // 同时在途上限
    windowEndsAt: string;         // 有效期末（可长于子票据 TTL）
  };
  used: { childTickets: number; inFlight: number };   // 内核记账，不进签名
  revokedAt?: string;                                  // 同上：撤销是一次写
  issuedAt: string;
  keyId: string;
  sig: string;                // Ed25519，规范同子票据：签名覆盖除去 sig/used/revokedAt 的规范化 claim
};
```

**签名的边界就是授权的边界**：claim 里只放操作者一次批准、之后不再变的东西（技能、能力全集、两条上限、有效期、发起人、执行 Agent），`used` 与 `revokedAt` 是内核在花费这份批准时写的账。把它们签进去的后果是**第一次派生就让自己的签名失效**，所以它们必须留在 claim 之外；"派生不放大"因此不是靠签名，而是靠下面那条不变式的断言守着（有一条专门用例：改了 `used` 之后契约仍然验签通过，正是为了钉住这个切分是有意的）。

`limits.perFireBudget` / `used.spent` 本版**不做**：金额口径要接企业侧成本台账（deferred **#8**）才有意义，而一个没有生产者的计数字段就是装饰。次数与并发两条上限先把自主发起卡住，额度等 #8 立项时再加结构。

四条不变式，每条都对应一条断言（没有断言的不变式等于没有）：

1. **派生只缩短不放大**：子票据的 `skill`、`vassal`、`capabilities` 必须被契约覆盖，`expiresAt` 必须不晚于 `limits.windowEndsAt`（实现里取 `min(请求的 TTL, 窗口剩余)`，再交给子票据自己的 TTL 上限）。
2. **消费即计数、计数即持久**：一次派生同时 `used.childTickets += 1` 并写入内核快照；越限派生返回拒绝，不产生票据。
3. **撤销即刻生效且可证**：`revokedAt` 置位后派生一律拒绝；已发出的子票据仍受自己的 TTL 与单次 nonce 约束，**不需**额外的"吊销传播"（这保留了现有"重启后 nonce 不复活"的性质）。
4. **自动发起永远拿不到契约之外的能力**：`watch` 只能引用 `delegationId`，不能自带票据，也不能提高上限。提高上限的唯一动作是**再签一份新契约**，而签名者是人。

### 4.2 与人在环的接法

- 越限（次数/并发/额度任一）→ 不拒绝即静默：写一条**升级项**进 desk，携带"哪个 watch、哪个契约、撞到哪条上限"，操作者在既有裁决端点批准 = 签一份新契约（或改 watch 意图为 `plan`）。
- 因此本文不引入第二种"问人"的机制，全部复用升级队列与监督台，读面也不变。
- 与 #40（执行后反思）的接法：同一 `(watch, contract, 越限)` 组合反复出现，正是"该由人调整契约或降级为 plan"的稳定信号——反思闭环将来读的就是这条数据，所以这里必须**先把它结构化留下**。

### 4.3 审计值（新增，命名沿用既有风格）

| 动作 | decision 值 |
| --- | --- |
| 登记 / 停用 / 撤销 watch | `watch-registered` / `watch-disabled` / `watch-revoked` |
| 求值失败、自动停用 | `watch-eval-unavailable` / `watch-auto-disabled` |
| 触发提交意图 | `watch-fired` |
| 契约签发 / 撤销 | `delegation-contract-issued` / `delegation-contract-revoked` |
| 派生子票据 / 越限拒绝 | `delegation-child-issued` / `delegation-limit-exceeded` |

## 5. 与设计约束的关系

| 约束（[product-portrait.md](product-portrait.md)） | 本文怎么守 |
| --- | --- |
| 数据主权在用户 | watch 求值不新增出站面；连接器读数走既有声明边界，正文仍只在 stdio MCP 出入 |
| 每个概念必须可执行 | 上面每个原语都落到：数据结构 + 执行点 + 审计值 + §7 的断言与冒烟；没有一条只用形容词描述 |
| 能力接入只有三条通道 | `predicate.source` 三类全部映射到既有 MCP / Skill / A2A 路径；不新增第四种，不放开求值表达式 |
| 个人域与企业域不互通 | watch 与契约都归属**单一域**（登记时写定 `owner` 与 `realm` 归属）；跨域触发的唯一路径是既有 grant 形状，不回流。因此 #41 选哪条形态，本文两个原语都不改——这是故意先设计它的原因 |

## 6. 明确不做（以及为什么不是偷懒）

- **不做事件总线 / webhook 接收端。** 外部信号要进内核，合法入口是连接器（MCP，我方主动拉）或入站 A2A（deferred **#19**）。自建一条"谁都能 POST 一下"的路，等于把鉴权、限流、审计、数据边界全绕过一遍。
- **不做条件表达式语言。** 一旦有表达式，谓词就能读任意上下文、拼接任意源，边界从"封闭枚举"退化为"实现者记得住多少条禁令"。
- **不做"模型自己判断该不该办"。** 决策后端在本文位置不变（只在一次已发起的编排内部仲裁）。把发起权交给模型 = 把不可逆动作的触发条件从可审计谓词变成不可审计推理。
- **不放松子票据。** 新原语全部加在子票据**之外**（谁能拿到一张票），不改子票据之内（一张票能干什么、只能干一次）。
- **不在本文做额度型预算的默认启用。** `perFireBudget.amount` 缺省关闭：金额口径要接企业侧成本台账（deferred **#8**）才有意义，个人侧先用次数上限，避免把一个猜测写进结构。

## 7. 实现拆分与每步的退出条件

| 步 | 范围 | 可验证退出条件（顺序不能颠倒） |
| --- | --- | --- |
| 1 | `DelegationContract`：签发 / 验签 / 派生子票据 / 计数与持久化 / 撤销 | 单测覆盖四条不变式各一条正例 + 一条反例；缺陷注入：把"派生不放大"检查摘掉 → 用能力超集的契约仍能派生 → 用例必须红；重启恢复用例断言 `used` 不回退 |
| 2 | `watch` 的 `metrics` 与 `realm` 两个源（无出站） | 真进程用例：条件满足一次 → 恰好一次 `plan` 意图 + 一条 `watch-fired`；重复满足不重派（幂等命中）；SIGTERM 重启后 `budget` 与 `lastFiredAt` 一致 |
| 3 | `watch` 的 `connector` 源 | 出站只走既有白名单与声明边界；未声明工具不可读；连接器抖动 → 只记 `watch-eval-unavailable` 不触发（正控：健康上游必须真的触发一次，否则这条断言证明不了任何事） |
| 4 | `execute` 触发 + 越限回落升级 | 无契约 → 零出站；额度耗尽 → 零出站 + desk 有一条能读懂"撞了哪条上限"的升级项；批准（签新契约）→ 下一 tick 真跑通 |
| 5 | HTTP/H2 面与监督台、TUI 视图 | 每条新端点一次真进程冒烟；操作者能在两处读到同一份证据（审计与台账读数字段一致） |
| 6 | `npm run smoke:core` 增加 watch + 契约两步 | 冒烟步数从 37 起增，活基线六处站点随之现测同步 |

**待补的原始缺口**：第 4 步之后，`docs/verify-self-host-pilot.md` 的 P2 阶段才可能真跑；在那之前，试点只能停在"人发起 + 一次性票据"的形态（即当前可实现范围）。

## 8. 演进日志

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| v0.1 | 2026-10-05 | 初稿。立项动因来自对市场的核对：常驻、独立执行环境、"关掉窗口仍在干活"已是该品类 2026 年的默认形态（OpenAI Dots 2026-09-29、Meta Muse 2026-09-09），而 zeus 缺的恰好是"合法地无人生成一次意图"这一层，且它必须与"有界授权"同批设计，否则等于给内核装上自主发起不可逆动作的能力。两个原语在 #41 的两种形态下形状相同，故先于该决定成文。 |
| v0.2 | 2026-10-05 | 写实现时改了三处形状，都是设计稿的错而不是实现的偏离：① `used` 与 `revokedAt` **移出签名 claim**——原结构把它们和静态授权一起签，则第一次派生就让签名失效；现规定 claim 只覆盖操作者批准后不再变的那组字段，"派生不放大"改由断言守（并有专门用例钉住"改了 `used` 仍验签通过"是有意的）。② 补 `vassal?: string`——不变式 1 点名 vassal 必须被契约覆盖，而 v0.1 的类型里没有这个字段，那句不变式当时无法执行。③ 删掉 `perFireBudget` 与 `used.spent`——金额口径要 deferred **#8** 的成本台账才有意义，没有生产者的计数字段是装饰；次数与并发两条上限已足以卡住自主发起的总量。另把子票据 TTL 写成 `min(请求 TTL, 窗口剩余)` 再交子票据自身上限，使"不晚于窗口"成为结构而不是约定。 |
