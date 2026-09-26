# 设计：Diary 日记（记忆叙事化）

- 状态：**现行 v0.1**（2026-09-24）
- 对应 PRD：**E8.3 Diary 日记：记忆叙事化备份（P2）**
- 关联：[design-memory-consolidation.md](design-memory-consolidation.md)（事件/事实）、[design-realm.md](design-realm.md)（Realm 数据域与 write）、[design-vault.md](design-vault.md)（备份清单/备份）、[product-portrait.md](product-portrait.md) §2.2 备份清单与记忆
- 一句话：**把已经记录下来的事件，按天叙事成一篇人能读、句句能回溯到源事件、并能经 Realm 写回用户目录的日记；不编造、不跨域、不另建存储。**

---

## 1. 背景与定位

记忆层已有 append-only 事件日志（`MemoryEvent`）与整理出的事实（`FactRecord`），Realm 已具备 read 与 E3.5 write。但这些记忆对人是"结构化记录"，不是"能读的经历"：

- 事件散在日志里，没有按时间组织成一段叙事；
- 想把"某天发生了什么"留存、回看、导出，没有工程原语。

Diary 补这一层。它是**叙事化的人类可读记忆**，与 Vault 分工明确：

| | 关心什么 | 形态 | 能恢复数据吗 |
|---|---|---|---|
| **Vault** | 全量数据在哪、指纹、可恢复 | 加密图 + 备份包 | 能（恢复协议） |
| **Diary** | 某天经历了什么、人能读 | 按天 markdown | 否（叙事层，不是备份） |

Diary 不替代 Vault，也不做全量备份；它让记忆"可读、可回溯、可导出"。

## 2. 设计原则（不可违反）

1. **句句可回溯**：每条叙事行必锚定源 `eventId`；整篇 `provenance` 覆盖全部行，不丢证据链。
2. **只呈现、不编造**：叙事文本只能由 `event.content` 经确定性渲染得到；不做情绪推断、不生成"今天感觉如何"这类内容里没有的句子。空内容显式占位，不虚构。
3. **底层走 Realm**：持久化只经 `RealmStore.write` 写回用户目录，Diary 自身不碰文件系统、不另建存储。
4. **单一数据域**：一篇日记只属一个 realm；跨 realm 输入直接拒绝（数据二极管）。
5. **确定性 + 幂等**：同输入必得同 `id`/`digest`；同一天重写落同一 `itemId`，不产生重复文件。

## 3. 数据结构

```ts
/** 确定性日记 id：diary:{realmId}:{date}。 */
export type DiaryId = string;

/** 一条叙事行：由一个 MemoryEvent 渲染而来，保留回溯锚点。 */
export interface DiaryLine {
  eventId: string;          // 回溯锚点（必填）
  runId: string;
  agentId: string;
  taskId?: string;
  kind: MemoryKind;         // observation | action | decision | claim
  text: string;             // 由 content 确定性渲染，不臆造
  refs: string[];
  confidence: number;
  occurredAt: string;       // ISO
}

/** 当天沉淀进叙事的事实（可选）。 */
export interface DiaryFact {
  factId: string;
  subject: string;
  predicate: string;
  object: unknown;
  status: FactStatus;
  confidence: number;
  version: number;
}

/** 一天一篇日记。 */
export interface DiaryEntry {
  format: 'zeus-diary';
  version: 1;
  id: DiaryId;
  realmId: string;
  date: string;             // YYYY-MM-DD
  windowStart: string;      // 当天首/末事件时间
  windowEnd: string;
  lines: DiaryLine[];       // 按 occurredAt 升序、同刻按 eventId
  facts: DiaryFact[];       // 可空
  provenance: string[];     // 去重 eventId + factId
  markdown: string;         // 渲染产物
  digest: string;           // sha256(规范化内容)，不含 markdown/digest 自身
}
```

## 4. 叙事化：纯函数

### 4.1 内容渲染 `renderEventContent`

`event.content` 是 `unknown`，必须有确定、安全的呈现规则；默认实现：

| content 形态 | 渲染结果 |
|---|---|
| `string` | 原样 |
| `ClaimContent { subject, predicate, object }` | `${subject} ${predicate} ${renderObject(object)}` |
| 其他对象 | 稳定 JSON（键排序），超过 `maxJsonLength`（默认 500）截断并标注 `…(truncated)` |
| `null`/`undefined`/空串 | 占位 `(no content)`，**不虚构** |

`object` 渲染：标量原样；对象走稳定 JSON。允许调用方注入自定义 `renderContent(content, event)`（例如把某领域结构渲染成专用句式）；**默认不接 LLM 润色**——LLM 改写会破坏"句句可回溯"，需要时由调用方显式注入并自行负责。

### 4.2 分天 `dayBucket`

- 默认按事件 `occurredAt` 的 **UTC 日历天**分桶（确定性、无环境依赖）；
- 可传 `timeZone`（IANA，如 `Asia/Shanghai`），经 `Intl.DateTimeFormat` 取该时区日期；
- 日期格式 `YYYY-MM-DD`。

### 4.3 构建 `buildDiary`

`buildDiary(events, options?)` 是**纯函数、零 I/O**：

1. 空输入 → `[]`；校验所有事件同属一个 `realmId`，混域即抛 `DiaryBoundaryError`；
2. 按 `dayBucket` 分桶；桶内按 `occurrendedAt` 升序、同刻按 `eventId` 稳定排序；
3. 每事件经 `renderEventContent` 生成 `DiaryLine`；
4. `options.facts`（`FactRecord[]`）提供时，把 `provenance` 命中当天事件、或 `updatedAt` 落在当天的事实纳入 `facts`；
5. 组装确定性 `id`、`windowStart/End`、去重 `provenance`；
6. `digest = sha256(规范化 JSON（id/date/lines/facts，不含 markdown/digest）)`；
7. 渲染 `markdown`（见 §5）。

```ts
export interface BuildDiaryOptions {
  timeZone?: string;                       // 默认 UTC
  facts?: FactRecord[];                    // 可选事实
  renderContent?: (content: unknown, event: MemoryEvent) => string;
  maxJsonLength?: number;                  // 默认 500
}
export declare function buildDiary(events: MemoryEvent[], options?: BuildDiaryOptions): DiaryEntry[];
```

## 5. Markdown 渲染 `renderDiaryMarkdown`

确定性模板（示例）：

```markdown
# Diary · 2026-09-24

> realm: r-abcdef · 6 events · window 09:12–17:40

## Timeline

- `09:12` **observation** · agent-a
  检索到 3 份与"恢复协议"相关的文档
  (`event:evt-001`, confidence 0.8)
- `14:03` **decision** · agent-b
  approve
  (`event:evt-002`, confidence 0.95)

## Facts

- `fact:fct-009` (active, v3, 0.9) Zeus 内核扇出 ≤16 为舒适区间
```

- 时间从 `occurredAt` 按 §4.2 的同一时区格式化为 `HH:mm`；
- 每行末尾标注源 `eventId` 与置信度，保证 markdown 本身也可回溯；
- 无事实时省略 `## Facts`；无事件的天不会生成日记。

## 6. 持久化与导出

### 6.1 写回用户目录 `persistDiary`

经 Realm，不直接碰文件系统：

```ts
export interface PersistDiaryOptions {
  /** enterprise realm 必填的操作者写授权；personal 省略。 */
  grant?: DriverWriteGrant;
  /** 目录前缀，默认 'diary'；最终 itemId = `${dir}/${date}.md`。 */
  dir?: string;
}
export declare function persistDiary(
  store: RealmStore,
  entry: DiaryEntry,
  options?: PersistDiaryOptions,
): Promise<{ itemId: string }>;
```

- 写 `data = entry.markdown`（字符串原样），`itemId = diary/${date}.md`；
- `store.write` 不存在 → 抛 `DiaryUnsupportedError`；
- enterprise 无有效 grant / readOnly realm → 由 Realm E3.5 拒绝（错误上抛，不在 Diary 内绕过）；
- 确定性 itemId 使同日重写为覆盖，幂等不重复。

### 6.2 结构化导出 `exportDiary`

`exportDiary(entries)` → 稳定序列化的 JSON 字符串（键排序、含 provenance/digest），供用户另存或迁移；不内置 zip/云上传（与 Vault §9 边界一致）。

## 7. 安全红线（测试必须逐条断言）

1. **可回溯**：每条 line 有 `eventId`；`provenance` 恰好覆盖全部 lines（+facts）；不丢事件。
2. **不臆造**：markdown/line 文本中除模板与 `content` 渲染结果外无新增叙述；空内容为 `(no content)`。
3. **跨域拒绝**：混入不同 `realmId` 的事件抛 `DiaryBoundaryError`，不产出跨域日记。
4. **确定性/幂等**：同输入两次 `buildDiary` 得逐字段相等结果（同 id/digest）；`persistDiary` 同日写同一 itemId。
5. **排序稳定**：lines 按 occurredAt、同刻按 eventId 升序。
6. **落盘只走 Realm**：`persistDiary` 仅调用 `store.write`；store 无 write 能力时报错；enterprise 无 grant 被拒。
7. **digest 敏感**：改动任一 line 文本/事件，digest 改变；digest 不含 markdown/digest 自身以免自指。
8. 内容渲染对超长对象截断并标注，不抛异常、不无限增长。

## 8. 非目标 / 边界（登记，不在本批次）

- 不做情绪分析、总结性感想或 LLM 自动润色（默认渲染是确定性呈现；LLM 改写须显式注入并自担可回溯责任）。
- 不做自动调度（何时生成日记由调用方或外部 cron 触发，与 Vault 一致）。
- 不把 Diary 纳入 `KernelSnapshot`：产物落进用户 Realm、由用户持有，且可随时从事件重建（派生物）。
- 不替代 Vault、不保证全量恢复；不跨 realm 汇编、不做多语言/富媒体/图片。
- E8.4 传承（dead-man switch、法律框架）仍为 P3，见 deferred #3。

## 9. 验收清单

- [ ] `buildDiary`：分天/排序正确、每行可回溯、`provenance` 齐全、digest 确定且对改动敏感。
- [ ] 内容渲染：string / ClaimContent / 对象 / 空内容四类形态符合 §4.1，超长截断标注。
- [ ] `renderDiaryMarkdown`：模板与时间格式正确，行内含 eventId；无 facts 时省略该段。
- [ ] `persistDiary`：经 `store.write` 写到 `diary/YYYY-MM-DD.md`，同日重写幂等；无 write 能力、enterprise 无 grant 均报错。
- [ ] `exportDiary`：稳定 JSON，含 provenance/digest。
- [ ] 跨 realm 输入抛 `DiaryBoundaryError`。
- [ ] 全量 `vitest` 绿、`tsc --noEmit` 绿、`npm run build` 过。
- [ ] PRD E8.3 升状态、README 模块表、handoff 与 docs/README 同步。
