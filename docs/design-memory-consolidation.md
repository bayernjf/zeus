# 记忆整理协议设计（Memory Consolidation Protocol）

> 状态：**现行（设计稿 v0.5，2026-09-27，§8 的生产者契约已采纳并落地，deferred #27 销项）**。实施进度记 [handoff.md](../handoff.md)，本文只写设计与契约。
> 上游：[product-portrait.md](product-portrait.md) §2.1（数据主权）、[prd.md](prd.md) E1（并发决策内核）；与 [design-realm.md](design-realm.md) 同构（事实在原位、索引可重建）。
> 本文先于 memory 模块存在，是其首份契约。

## 0. 一句话

多 Agent 高并发执行时会产生大量事件与候选结论。本协议规定：**事件人人可追加，事实须经独立"整理"作业沉淀**；整理负责去重、合并、矛盾标记与置信度管理，冲突不静默覆盖、可升级；记忆的唯一事实源在 Realm，一切索引（含向量）都是可重建的派生物。

## 1. 设计原则（不可违反）

1. **事实在原位，索引可重建**：记忆本体存在 Realm（追加日志 + 规范化事实）；向量/倒排索引随时可从事实源重建，索引损坏不丢记忆。
2. **追加与修改分离**：Agent 只能追加观察/事件（append-only），不能直接改事实表；改事实由整理器（Consolidator）执行。
3. **来源必带**：每条记忆携带作者 Agent、runId、realm、时间、置信度、来源引用，支撑决策回放。
4. **矛盾不静默**：冲突结论标记共存或升级，后者不得覆盖前者。
5. **数据不出域**：embedding 需本地/同域；个人与企业记忆分域，数据二极管同样约束记忆。
6. **私有 vs 共享**：任务级 scratch 是 Agent 私有、可丢弃；值得沉淀者才经本协议写入共享记忆。

## 2. 记忆分层

| 层 | 内容 | 载体 | 生命周期 |
|---|---|---|---|
| 工作记忆 | 当前轮 context / scratchpad | 上下文窗口 + 临时状态 | 任务内 |
| 情景记忆（Event Log） | 发生了什么：观察、动作、事件、过程 | Realm 内 append-only 日志 | 长期 |
| 语义记忆（Fact Store） | 沉淀的事实/偏好/知识 | 规范化事实记录 | 长期，可版本化 |
| 召回索引 | 语义/关键词联想 | 向量/倒排（派生物） | 可重建 |

> LLM KV Cache / prompt cache 是推理加速，非记忆；Redis 形态 KV 仅存会话态与热缓存（带 TTL），不是事实的家。

## 3. 核心数据结构（TypeScript 形态）

```ts
type MemoryKind = 'observation' | 'action' | 'decision' | 'claim';

interface MemoryEvent {           // append-only，Agent 写
  eventId: string;
  realmId: string;
  runId: string;                 // 关联决策/任务链
  source: { agentId: string; taskId?: string };
  kind: MemoryKind;
  content: unknown;
  refs: string[];                // 来源引用（itemId / 证据指针）
  confidence: number;            // 0..1，作者自报
  occurredAt: string;
}

type FactStatus = 'active' | 'superseded' | 'disputed' | 'retracted';

interface FactRecord {           // 仅 Consolidator 写
  factId: string;
  realmId: string;
  subject: string;
  predicate: string;
  object: unknown;
  status: FactStatus;
  provenance: string[];          // eventId 列表，可回放
  confidence: number;            // 整理后置信度
  version: number;
  updatedAt: string;
}

interface ConsolidationResult {
  ingested: string[];            // eventId
  added: string[];               // factId
  merged: Array<{ factId: string; with: string[] }>;
  superseded: string[];
  disputes: Array<{ factId: string; conflicting: string[]; reason: string }>;
  escalations: string[];         // 进监督台的冲突
}
```

## 4. 整理流水线

```
Agent ──append──▶ Event Log（实时，人人可写）
                        │
                  Consolidator（独立作业，可批量/触发）
        ┌───────────────┼────────────────────────┐
   归一化/去重      事实合并/版本化          矛盾检测
        └───────────────┼────────────────────────┘
                   Fact Store（仅整理器可写）
                        │
              索引重建（向量/倒排，派生物）
                        │
              disputes/escalations ──▶ OversightDesk
```

### 4.1 触发方式
- **大小/时间**：事件达批量阈值或定时窗口；
- **任务收束**：一个 runId 的任务进入终态时触发；
- **手动**：操作者或 supervisor 指定整理某段记忆。

### 4.2 整理步骤
1. **归一化**：抽取 subject/predicate/object，统一时间/实体表述。
2. **去重**：同一事实的多个观察合并，provenance 累积，置信度按来源可靠度聚合（非简单平均）。
3. **事实合并**：一致信息并入既有 fact，version 递增，旧版本保留可回放。
4. **矛盾检测**：与既有 fact 冲突时——
   - 可按规则消解（如更新时间更晚且来源可靠度更高）→ 旧 fact 标 `superseded`；
   - 无法自动判定 → 双方标 `disputed`，生成 escalation 进 [监督台](design-vassal-protocol.md)，**不静默选边**。
5. **索引更新**：写 Fact 后异步重建/更新召回索引（P0 无索引，扫描即可）。

### 4.3 置信度聚合（要点）
- 权重来自 Agent 历史可靠度（结果回传/失败率记忆），不是当前自报 confidence；
- 独立来源相互印证可提升置信度；同源重复不提升；
- 高利害事实（用于不可逆决策）阈值更高，不足即要求复核。

## 5. 与并发决策内核、supervisor 的衔接

- 决策内核 fan-out 前，从 Fact Store 召回相关事实（结构化过滤优先，语义召回为辅）。
- subagent 产出先落 Event Log；supervisor 的汇聚结论与 Critic 意见同样作为带来源事件入库。
- **信任校准**：supervisor 依据各 Agent 的可靠度记忆决定全验或抽查；结果事后回写可靠度（成功/失败/被纠错）。
- 决策回放 = 沿 runId 取出事件 + fact provenance，能区分"执行错"与"监督失察"。

## 6. 安全与边界

- Event Log / Fact Store 均按 realm 隔离；企业→个人记忆禁止，个人→企业需操作者授权。
- 记忆注入 Agent 上下文前做注入检查（防被污染数据经记忆跨 Agent 传播，见技术探索地图 S8）。
- 删除/被遗忘权：Fact 可 `retracted`，索引同步移除；因已进入快照/下游的部分须可追溯声明。
- embedding 仅本地/同域；不可得则不引入向量（deferred #10 触发条件）。

### 6.1 混合检索契约（P2）

- 召回索引是**派生物、不持久化**：`RecallIndex.sync(facts)` 随时从 Fact Store 整体重建（验收 #5）。
- 混合得分 = `alpha · 语义余弦 + (1 − alpha) · BM25`（默认 alpha=0.5）；BM25 分量按本批最佳分归一到 0..1，两路可比较可组合。
- 仅 `active` / `disputed` 事实入索引；`superseded` / `retracted` 不召回（争议事实仍可召回且自带 `disputed` 标记，提示操作者）。
- Embedding 走 `Embedder` 端口（`embed(text): number[]`），默认实现 `LocalHashingEmbedder` 是确定性 signed-hashing 词袋（无网络、无语义外推，仅离线安全底座）；真实同域模型可注入，仍须满足数据不出域。

### 6.2 遗忘权执行契约（P2）

- `retractFacts(realmId, factIds, {reason, requestedBy})`：事实即刻 `retracted`、索引条目即时摘除，并写一条 **tombstone**（`RetractionRecord`：factId/realmId/subject/reason/requestedBy/at）。
- `forgetSubject(realmId, subject)`：主体身份匹配（trim+小写）下的全部事实一并 retract，对应"删除关于某人的一切"。
- Event Log 保持 append-only 不删除——治理回放所需；被遗忘的事实在任何召回中都不再出现，下游/快照中只以 tombstone 形式可追溯声明。
- tombstone 随 MemoryState 持久化；重复 retract 幂等（已 retracted 不再产生新记录）。

### 6.3 漂移对账契约（P2）

- `reconcileMemoryStates(previous, current)`：两个时点快照的纯 diff，按 realm 输出——事件追加/移除数、事实 added/removed/changed（逐字段标 subject/predicate/object/status/confidence/version/provenance 的 before→after）、新增 correction 与 tombstone 数；`hasDrift` 为总判定。相同快照必报无漂移。
  - **操作者面（2026-09-27）**：`GET /api/memory/snapshot` 取得可留存的时点快照，`POST /api/memory/reconcile {previous, current?}` 做 diff（current 缺省为运行态）。**两侧都只读**——被传入的快照不会被导入内核，因此拿备份比对不会覆盖活数据；快照形状不合时拒绝并点名到字段与下标。
- `verifyMemoryState(state)`：横切不变量校验，是记忆版 digest 对账，静默损坏显形为 violation：
  - `bad-fact-id`：factId 无法从 realm+subject+predicate+object 重算（内容被篡改）；
  - `unresolved-provenance` / `provenance-realm-mismatch`：provenance 指向缺失或跨域事件；
  - `retracted-without-tombstone` / `tombstone-without-retraction`：retract 状态与 tombstone 必须一一对应；
  - `duplicate-fact` / `fact-realm-mismatch`：事实重复或所在桶域不符。
- 返回空 violation 才允许安全重建一切派生索引；`MemoryStore.verifyIntegrity()` 是对当前事实源的便捷入口。

## 7. 交付节奏

- **P0**：Event Log（append）+ 库内规范化整理纯函数（去重/合并/disputed），无索引、personal realm。
- **P1**：Fact Store 持久化 + 任务收束自动触发 + 可靠度权重；与监督台打通冲突升级。
- **P2**：本地 embedding + 混合检索、漂移对账、retracted/遗忘权执行。

## 8. 记忆事件生产者契约（deferred #27；**已按 P1 采纳并落地**）

> 触发背景：2026-09-27 把 `GET /api/memory/snapshot` 与 `GET /api/diary/export` 带进真进程冒烟，第一次实跑就得到 `state.events.length = 0`、日记 `entries = []`——在真实派发三次、审计落盘 13 行之后。代码级复跑：`MemoryEvent` 只在 `src/memory/` 内部构造，模块之外 `.append(` 零命中。
> **本节回答一个问题：谁在什么时刻、以什么形状往记忆里写。** 2026-09-27 按建议采纳 P1 并落地（`src/memory/producer.ts` + `boot.ts` 装配），四个决策问题的答案见 §8.3 每条之后；P2/P3/P4 未做，理由仍然成立。

### 8.1 先划清边界：什么进记忆，什么只进审计链

判据（一条即可检验）：**「对某个域为真的一句陈述」才进记忆；动作与过程的事实进审计链。**

| | 进记忆事件 | 只进审计链 |
|---|---|---|
| 语义 | 有人对某对象作了某个可反驳的陈述 | 内核做了一次判断/放行/拒绝/超时 |
| 形状要求 | `kind:'claim'` 且 `content = {subject, predicate, object}`（`consolidate.ts:31-35` `isClaimContent`，**别的形状不会被折叠成事实**：`consolidate.ts:109` 只吃 claim） | 已有 `AuditDecision` 枚举（`dispatch/dispatcher.ts:6-20`：`dispatched`/`refused-*`/`dispatch-failed`/`sla-ack-breached`/`domain-*`/`driver-grant-*`/`realm-write`/`commission-*`） |
| 需要分歧 | 需要（同一 `(realm, subject, predicate)` 出现不同 `object` 才产生 dispute，`consolidate.ts:111-115` factKey 分组） | 不需要 |
| 可擦除 | 是（`retractFacts`/`forgetSubject`，§6.2） | 否（治理留痕优先，轮转由 `ZEUS_AUDIT_*` 管） |

推论：**不要为了"让记忆看起来有数据"把审计事件复制一份进记忆**——那只会得到"事件很多、事实恒空"，并污染遗忘权的语义（用户要求擦除一个主题时，不该同时擦掉治理留痕，也不该擦不掉）。

### 8.2 四条候选触点（成本与后果逐条对齐）

**P1 分支结论 → claim（建议只做这条）**

- **触点**：`orchestrator` 收齐 `FanOutResult.branches[]` 之后、发 `intent-finished` 之前（同一处即 `boot.ts:388-392` 已监听的 seam 上游一步）。**消费端已经接好**：`intent-finished` 且带 `realmId` → `consolidateFinishedMemory()`（`boot.ts:422-437`）→ `consolidateRealm(realmId, {now, reliability})` → disputes → `oversight.ingestMemoryDispute()`。所以这条一改，事件→事实→分歧→监督台整条链立刻有输入。
- **事件形状**：`kind:'claim'`；`source.agentId = 分支的 vassal 名`（可靠度加权与 `reliabilityScore` 正是按 agentId 索引，`boot.ts:425-429`）；`source.taskId = task.id`；`runId`/`realmId` 沿用请求；`refs = [runId, intentId]`（+ 若带 `realmSource` 则加命中 itemId）；`occurredAt` 用分支结束时刻；`confidence` = 分支自带或 0.5 默认（注释已声明"作者自报置信度不是唯一权重"）。
- **幂等**：`eventId = sha256(`${runId}:${vassal}:${stableStringify(object)}`)`；`memory-store.ts:56-59` 按 `eventId` 去重，因此**重放同一 run 不会产生第二份事实**。
- **写入方式**：走 `appendFromRealm(writerRealmId, event)`（`memory-store.ts:62-75`），跨域一律 `MemoryBoundaryError` 并审计——**不能直接 `append`**，否则 §6.3/§6.2 的域边界不变量在这条新路径上形同虚设。
- **风险（必须决策）**：这是第一次让**第三方产出的文本常驻** `kernel-state.json`；自 deferred #13 起该文件已进备份清单（`docs/design-vault.md`），所以第三方文本会进用户的加密备份包。约束：只存结论与短 snippet（建议 ≤512 字符，超出截断并标注，沿用 diary 的截断先例），不存原始 artifact 全文。

**P2 内核聚合决定 → decision 事件**：`decision` 不是 claim，**不会被折叠成事实**（§8.1），只增加可回放条目；而裁决语义在审计链与决议回写（E6.2）里已完整存在。收益低、重叠高 → **建议不做**。

**P3 域内容变化 → observation 事件**：触点是 `realm-write` 成功路径（`server.ts` 的 write-grant 消费处与 diary generate）。`observation` 同样不参与折叠，只喂检索。**它是最低风险也最低收益的一条**：做了不会让事实源长出任何东西，若采纳必须明确"只为 recall 服务"。

**P4 操作者纠错 → 事件**：`recordCorrections`（`boot.ts:240-241`）现在只改可靠度。把人工裁决写成 claim 会破坏 `source.agentId` 的可归因性（操作者不是执行 Agent，可靠度模型会被污染）→ **建议不产事件**，改为在离线回放里读审计（E1.6 已可做）。

### 8.3 需要决策的四个问题（不定就写不出代码）

1. **`subject` 由谁给？** 分歧能否产生，完全取决于同一 `(realm, subject, predicate)` 是否可能被多次陈述。选项：① 请求方显式 `params.subject`（必填，最干净，但把语义成本推给调用方）；② 由 `intentId` 派生（每次意图一个新主题 → **永远不会分歧**，等于白做）；③ `params.subject` 缺省时回退到 ①/② 的组合。建议 ③，并请确认回退顺序。 → **已定 ③，回退键 = `topic:sha256(skill ␟ 去掉 subject/predicate 后的 params)`**，绝不用 intentId（`producer.ts` `claimSubject`）。
2. **`predicate` 用什么？** ① `skill` 名（零新契约，但 `research` 一次会同时陈述多件事时会互相覆盖）；② `params.predicate` 显式给；③ `skill + params.key`。建议 ① 起步，需要细分时由请求带 ②。 → **已定：`params.predicate` 优先，缺省用 skill 名**（`claimPredicate`）。
3. **第三方结论文本能否常驻状态文件与备份？** 若否，改为只存 `sha256(object)` + snippet；若是，长度上限定多少（建议 512）。 → **已定：存结论本身、上限 512 字符（`MAX_STANCE_CHARS`），超出截断并加省略号**；rationale 不进 object，避免同一立场因措辞不同被算成分歧。
4. **要不要开关？** 建议**默认开**（「每个概念必须可执行」，默认关等于默认空转），不新增 env。 → **已定：默认开、无 env**。要退路时按 #26 的闸门补：新增变量必须同时进 `.env.example` 与 deployment §2，否则 CI 直接红。

### 8.4 选定后的最小落地形状（含验收，不在本节实施）

1. 生产者：`src/memory/producer.ts` 纯函数 `branchVerdictsToEvents(result): MemoryEvent[]`（无时钟无 IO，与 `aggregate`/`selectTargets` 同形，便于确定性断言）；装配点接到 orchestrator 的 `onBranchResult`/结束回调，写入走 `appendFromRealm`。
2. 单测：① 一次三分支意图 → `snapshot.state.events.length === 3` 且 `facts > 0`；② 同一 run 重放 → 事件数不变（幂等）；③ 两分支对同一 `(subject, predicate)` 给出不同 object → 出现 dispute 并生成 `memory-dispute` 升级；④ 跨域写入被 `MemoryBoundaryError` 拒并审计；⑤ 超长结论被截断并标注。
3. **真进程验收（关键，别只靠 inject 测试）**：`npm run smoke:core` 增加一步，断言 `snapshot.state.events.length > 0` 且 `facts` 非空、日记导出非空数组。这一条把"恒空转"从**看不见的状态**变成**会红的断言**——本轮之所以能发现它，正是因为先把读数接口接上了。
4. 文档同步：PRD E8.5 状态列回 ✅ 并把边界写回本节；deferred #27 销项；handoff 记一条 Active work。

### 8.5 我的建议

**只做 P1，按 8.3 的 Q1③ / Q2① / Q3 存结论+512 上限 / Q4 默认开无 env** 落地，落地即带 8.4 的第 3 条真进程断言。理由：它是一次改动就能让"事件→事实→分歧→监督台→遗忘权"整条既有链路从空转变成立的最小闭环；P2/P4 与审计链重叠，P3 不产生事实。



## 9. 验收标准（首版）

- 首版八条，逐条可判定：
1. 无 provenance 的事实不得进入 Fact Store；
2. Agent 无法直接写/改 Fact（只能追加事件）；
3. 同事实重复观察只产生一个 fact 且 provenance 累积；
4. 矛盾输入默认 `disputed` 并产生 escalation，不出现静默覆盖；
5. 删除索引后可从事实源完整重建；
6. 置信度聚合不使用作者自报作为唯一权重；
7. 跨 realm 读取记忆一律被拒并审计；
8. 沿 runId 可离线回放任一决策的事件与事实来源。

## 10. 演进日志

| 版本 | 日期 | 变更 |
|---|---|---|
| v0.1 | 2026-09-22 | 首版：记忆分层、Event/Fact 结构、整理流水线、置信度聚合、与并发内核/supervisor 衔接、八条验收 |
| v0.2 | 2026-09-22 | P2 契约：§6.1 混合检索（BM25+语义余弦、可重建索引、Embedder 端口与本地 hashing 默认实现）、§6.2 遗忘权（retract/forgetSubject + tombstone 台账，事件日志保留） |
| v0.3 | 2026-09-22 | §6.3 漂移对账：reconcileMemoryStates 快照间逐字段 diff、verifyMemoryState 横切不变量校验（factId 可重算、provenance 可解析、retract↔tombstone 配对）；P2 三项齐 |
| v0.4 | 2026-09-27 | **§8 生产者契约提案（deferred #27）**：先划边界（「对某域为真的一句陈述」进记忆、动作与过程进审计链；只有 `kind:claim` 且 `{subject,predicate,object}` 会被折叠成事实——`consolidate.ts:109`、`:31-35`），再列四条触点与后果。**建议只做 P1（分支结论→claim）**：消费端 `boot.ts:388-392` → `consolidateRealm` → disputes → `ingestMemoryDispute` 已经接好，缺的只是输入；幂等靠 `memory-store.ts:56-59` 的 eventId 去重；写入必须走 `appendFromRealm`（`:62-75`）才不破域边界。P2 裁决事件、P4 纠错事件因与审计链重叠、且会污染 `source.agentId` 的可靠度归因而建议不做；P3 observation 不产事实。四个待决策问题（subject 由谁给／predicate 粒度／第三方结论文本能否常驻状态文件与备份／要不要开关）不定就写不出代码。§9 验收与 §10 演进日志为插入本节而顺延；外部引用只涉及旧 §7，未受影响 |
| v0.5 | 2026-09-27 | **§8 采纳并落地（deferred #27 销项）**：新增 `src/memory/producer.ts`（`branchVerdictClaims`：每个不同 `(作者, 立场)` 一条 claim，object 只放立场、超 512 截断；`claimSubject` 显式优先、缺省派生自 skill+问题，**绝不用 intentId**）+ `boot.ts` 在 `intent-finished` 装配（**先写 claim 再 consolidate**，同一次意图当场成事实）；写入走 `appendFromRealm`，realm 已被下线（#17）时丢弃并审计 `memory-claim-skipped`。`AUDIT_DECISIONS` 改为**单一来源数组派生类型**（此前 server 侧另有一份手工白名单，5 个决策值无法过滤查询）。测试 10 例含**真进程断言**：`smoke:core` 现在要求快照非空，实测 `events=6 facts=1`、日记 `entries=1`（**同一断言在本改动前打印 0**，即它的可失效性证明）。 |
