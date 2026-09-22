# 记忆整理协议设计（Memory Consolidation Protocol）

> 状态：**现行（设计稿 v0.3，2026-09-22，P2 漂移对账）**。实施进度记 [handoff.md](../handoff.md)，本文只写设计与契约。
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
- **手动**：驾驶员或 supervisor 指定整理某段记忆。

### 4.2 整理步骤
1. **归一化**：抽取 subject/predicate/object，统一时间/实体表述。
2. **去重**：同一事实的多个观察合并，provenance 累积，置信度按来源可靠度聚合（非简单平均）。
3. **事实合并**：一致信息并入既有 fact，version 递增，旧版本保留可回放。
4. **矛盾检测**：与既有 fact 冲突时——
   - 可按规则消解（如更新时间更晚且来源可靠度更高）→ 旧 fact 标 `superseded`；
   - 无法自动判定 → 双方标 `disputed`，生成 escalation 进 [监督台](design-vassal-protocol.md)，**不静默选边**。
5. **索引更新**：写 Fact 后异步重建/更新召回索引（P0 无索引，扫描即可）。

### 4.3 置信度聚合（要点）
- 权重来自 Agent 历史可靠度（战报/失败率记忆），不是当前自报 confidence；
- 独立来源相互印证可提升置信度；同源重复不提升；
- 高利害事实（用于不可逆决策）阈值更高，不足即要求复核。

## 5. 与并发决策内核、supervisor 的衔接

- 决策内核 fan-out 前，从 Fact Store 召回相关事实（结构化过滤优先，语义召回为辅）。
- subagent 产出先落 Event Log；supervisor 的汇聚结论与 Critic 意见同样作为带来源事件入库。
- **信任校准**：supervisor 依据各 Agent 的可靠度记忆决定全验或抽查；结果事后回写可靠度（成功/失败/被纠错）。
- 决策回放 = 沿 runId 取出事件 + fact provenance，能区分"执行错"与"监督失察"。

## 6. 安全与边界

- Event Log / Fact Store 均按 realm 隔离；企业→个人记忆禁止，个人→企业需驾驶员授权。
- 记忆注入 Agent 上下文前做注入检查（防被污染数据经记忆跨 Agent 传播，见技术探索地图 S8）。
- 删除/被遗忘权：Fact 可 `retracted`，索引同步移除；因已进入快照/下游的部分须可追溯声明。
- embedding 仅本地/同域；不可得则不引入向量（deferred #10 触发条件）。

### 6.1 混合检索契约（P2）

- 召回索引是**派生物、不持久化**：`RecallIndex.sync(facts)` 随时从 Fact Store 整体重建（验收 #5）。
- 混合得分 = `alpha · 语义余弦 + (1 − alpha) · BM25`（默认 alpha=0.5）；BM25 分量按本批最佳分归一到 0..1，两路可比较可组合。
- 仅 `active` / `disputed` 事实入索引；`superseded` / `retracted` 不召回（争议事实仍可召回且自带 `disputed` 标记，提示驾驶员）。
- Embedding 走 `Embedder` 端口（`embed(text): number[]`），默认实现 `LocalHashingEmbedder` 是确定性 signed-hashing 词袋（无网络、无语义外推，仅离线安全底座）；真实同域模型可注入，仍须满足数据不出域。

### 6.2 遗忘权执行契约（P2）

- `retractFacts(realmId, factIds, {reason, requestedBy})`：事实即刻 `retracted`、索引条目即时摘除，并写一条 **tombstone**（`RetractionRecord`：factId/realmId/subject/reason/requestedBy/at）。
- `forgetSubject(realmId, subject)`：主体身份匹配（trim+小写）下的全部事实一并 retract，对应"删除关于某人的一切"。
- Event Log 保持 append-only 不删除——治理回放所需；被遗忘的事实在任何召回中都不再出现，下游/快照中只以 tombstone 形式可追溯声明。
- tombstone 随 MemoryState 持久化；重复 retract 幂等（已 retracted 不再产生新记录）。

### 6.3 漂移对账契约（P2）

- `reconcileMemoryStates(previous, current)`：两个时点快照的纯 diff，按 realm 输出——事件追加/移除数、事实 added/removed/changed（逐字段标 subject/predicate/object/status/confidence/version/provenance 的 before→after）、新增 correction 与 tombstone 数；`hasDrift` 为总判定。相同快照必报无漂移。
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

## 8. 验收标准（首版）

1. 无 provenance 的事实不得进入 Fact Store；
2. Agent 无法直接写/改 Fact（只能追加事件）；
3. 同事实重复观察只产生一个 fact 且 provenance 累积；
4. 矛盾输入默认 `disputed` 并产生 escalation，不出现静默覆盖；
5. 删除索引后可从事实源完整重建；
6. 置信度聚合不使用作者自报作为唯一权重；
7. 跨 realm 读取记忆一律被拒并审计；
8. 沿 runId 可离线回放任一决策的事件与事实来源。

## 9. 演进日志

| 版本 | 日期 | 变更 |
|---|---|---|
| v0.1 | 2026-09-22 | 首版：记忆分层、Event/Fact 结构、整理流水线、置信度聚合、与并发内核/supervisor 衔接、八条验收 |
| v0.2 | 2026-09-22 | P2 契约：§6.1 混合检索（BM25+语义余弦、可重建索引、Embedder 端口与本地 hashing 默认实现）、§6.2 遗忘权（retract/forgetSubject + tombstone 台账，事件日志保留） |
| v0.3 | 2026-09-22 | §6.3 漂移对账：reconcileMemoryStates 快照间逐字段 diff、verifyMemoryState 横切不变量校验（factId 可重算、provenance 可解析、retract↔tombstone 配对）；P2 三项齐 |
